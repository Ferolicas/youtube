/**
 * audios-to-srt — transcribe mp3 -> .srt (español) con OpenAI whisper-1.
 *
 * Tarea puntual (one-off). Lee ./audios y escribe ./subtitles; en el VPS, con
 * cwd=/apps/youtube, eso es /apps/youtube/audios -> /apps/youtube/subtitles.
 *
 * Por cada audio:
 *   1) Preprocesa a MONO 16 kHz 48 kbps (lo que Whisper usa internamente: sin
 *      pérdida real de calidad) -> encoge el fichero por debajo de los 25 MB de
 *      la API, así no hace falta trocear (tus 5 grandes caben tras esto).
 *   2) whisper-1 con response_format="srt", language="es" y un prompt con tu
 *      vocabulario keto para sesgar la ortografía en origen.
 *   3) Si AÚN supera ~24 MB (haría falta >~100 min; no es tu caso) -> trocea por
 *      tiempo y recompone el SRT con offsets reales (fallback automático).
 *   4) Corrige el texto (queto/ceto->keto, quetogénic*->cetogénic*, normaliza
 *      "recetas keto"/"dieta keto") SIN tocar los timestamps.
 *   5) Guarda ./subtitles/<videoId>.srt
 *
 * Uso (desde /apps/youtube, tras git pull):
 *   npm run audios:srt -- --cost                # solo suma duraciones y coste (NO transcribe)
 *   npm run audios:srt -- --file <videoId>      # un audio (prueba); imprime el SRT
 *   npm run audios:srt -- --all [--force]       # lote completo (--force reescribe los ya hechos)
 */
import { createReadStream, existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import OpenAI from "openai";
import { env } from "@/config/env";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("audios:srt");

const AUDIOS_DIR = process.env.AUDIOS_DIR ?? join(process.cwd(), "audios");
const SUBS_DIR = process.env.SUBTITLES_DIR ?? join(process.cwd(), "subtitles");
const RATE_PER_MIN = 0.006; // USD/min, whisper-1
const MAX_BYTES = 24 * 1024 * 1024; // margen bajo el límite duro de 25 MB de OpenAI
const SEGMENT_SEC = 1200; // 20 min por trozo (solo fallback)
const FFMPEG = env.FFMPEG_BIN;
const FFPROBE = process.env.FFPROBE_BIN ?? FFMPEG.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
const PROMPT =
  "Transcripción de un vídeo de cocina keto en español. Vocabulario: keto, dieta keto, " +
  "recetas keto, dieta cetogénica, eritritol, psyllium, harina de almendra, aguacate.";

// ---------- utilidades de proceso ----------
function run(bin: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", (e) => resolve({ code: -1, stdout, stderr: stderr + String(e) }));
    p.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function probeDurationSec(path: string): Promise<number> {
  const r = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]);
  const sec = parseFloat(r.stdout.trim());
  return Number.isFinite(sec) ? sec : 0;
}

async function preprocess(input: string, output: string): Promise<void> {
  // mono, 16 kHz, 48 kbps mp3
  const r = await run(FFMPEG, ["-y", "-i", input, "-ac", "1", "-ar", "16000", "-b:a", "48k", "-f", "mp3", output]);
  if (r.code !== 0) throw new Error(`ffmpeg preprocess falló (${r.code}): ${r.stderr.slice(-300)}`);
}

// ---------- SRT: parseo, formateo, merge ----------
interface Cue { start: number; end: number; lines: string[] } // ms

function hmsToMs(h: string, m: string, s: string, ms: string): number {
  return ((+h * 60 + +m) * 60 + +s) * 1000 + +ms;
}
function msToHms(t: number): string {
  const ms = t % 1000;
  const s = Math.floor(t / 1000) % 60;
  const m = Math.floor(t / 60000) % 60;
  const h = Math.floor(t / 3600000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}
function parseSrt(srt: string): Cue[] {
  const blocks = srt.replace(/\r/g, "").split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
  const cues: Cue[] = [];
  for (const b of blocks) {
    const ls = b.split("\n");
    let i = 0;
    if (/^\d+$/.test((ls[0] ?? "").trim())) i = 1; // saltar el índice numérico
    const m = (ls[i] ?? "").match(
      /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/
    );
    if (!m) continue;
    cues.push({
      start: hmsToMs(m[1]!, m[2]!, m[3]!, m[4]!),
      end: hmsToMs(m[5]!, m[6]!, m[7]!, m[8]!),
      lines: ls.slice(i + 1),
    });
  }
  return cues;
}
function formatSrt(cues: Cue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${msToHms(c.start)} --> ${msToHms(c.end)}\n${c.lines.join("\n")}`)
    .join("\n\n") + "\n";
}

// ---------- corrección de ortografía (solo texto) ----------
function withCase(matched: string, repl: string): string {
  if (matched.length > 1 && matched === matched.toUpperCase() && matched !== matched.toLowerCase()) {
    return repl.toUpperCase();
  }
  if (matched[0] === matched[0]?.toUpperCase()) return repl.charAt(0).toUpperCase() + repl.slice(1);
  return repl;
}
function fixText(line: string): string {
  let t = line;
  // adjetivo: quetogénic(o/a/os/as) -> cetogénic(...)  (preserva terminación y acento)
  t = t.replace(/\bqueto(g[eé]nic[oa]s?)\b/gi, (m, suf: string) => withCase(m, "ceto" + suf));
  // palabra suelta queto/ceto -> keto (\b evita tocar "cetogénica")
  t = t.replace(/\bqueto\b/gi, (m) => withCase(m, "keto"));
  t = t.replace(/\bceto\b/gi, (m) => withCase(m, "keto"));
  // normaliza "recetas keto" / "dieta keto" (keto en minúscula tras esas palabras)
  t = t.replace(/\b(recetas?|dieta)(\s+)keto\b/gi, (_m, w: string, sp: string) => `${w}${sp}keto`);
  return t;
}

// ---------- transcripción ----------
async function transcribeSrt(client: OpenAI, path: string): Promise<string> {
  const res = await client.audio.transcriptions.create({
    model: "whisper-1",
    file: createReadStream(path),
    response_format: "srt",
    language: "es",
    prompt: PROMPT,
  });
  return res as unknown as string;
}

async function transcribeChunked(client: OpenAI, preprocessed: string, work: string): Promise<string> {
  const pattern = join(work, "chunk_%03d.mp3");
  const r = await run(FFMPEG, ["-y", "-i", preprocessed, "-f", "segment", "-segment_time", String(SEGMENT_SEC), "-c", "copy", pattern]);
  if (r.code !== 0) throw new Error(`ffmpeg segment falló (${r.code}): ${r.stderr.slice(-300)}`);
  const chunks = (await readdir(work)).filter((f) => /^chunk_\d+\.mp3$/.test(f)).sort();
  const all: Cue[] = [];
  let offset = 0;
  for (const c of chunks) {
    const cp = join(work, c);
    const srt = await transcribeSrt(client, cp);
    for (const cue of parseSrt(srt)) all.push({ start: cue.start + offset, end: cue.end + offset, lines: cue.lines });
    offset += Math.round((await probeDurationSec(cp)) * 1000);
  }
  return formatSrt(all);
}

async function processOne(client: OpenAI, input: string): Promise<{ srt: string; durationSec: number }> {
  const work = await mkdtemp(join(tmpdir(), "a2srt-"));
  try {
    const pre = join(work, "audio.mp3");
    await preprocess(input, pre);
    const durationSec = await probeDurationSec(pre);
    const { size } = await stat(pre);
    const raw = size <= MAX_BYTES ? await transcribeSrt(client, pre) : await transcribeChunked(client, pre, work);
    const cues = parseSrt(raw).map((c) => ({ ...c, lines: c.lines.map(fixText) }));
    return { srt: formatSrt(cues), durationSec };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------- main ----------
async function main(): Promise<void> {
  if (!env.OPENAI_API_KEY) {
    log.error("Falta OPENAI_API_KEY en el .env");
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const costOnly = args.includes("--cost");
  const all = args.includes("--all");
  const force = args.includes("--force");
  const fi = args.indexOf("--file");
  const fileArg = fi >= 0 ? args[fi + 1] : undefined;

  if (!existsSync(AUDIOS_DIR)) {
    log.error(`No existe el directorio de audios: ${AUDIOS_DIR}`);
    process.exit(1);
  }
  const mp3s = (await readdir(AUDIOS_DIR)).filter((f) => f.toLowerCase().endsWith(".mp3"));

  // --cost: solo suma duraciones y estima coste, sin transcribir
  if (costOnly) {
    let sec = 0;
    for (const f of mp3s) sec += await probeDurationSec(join(AUDIOS_DIR, f));
    const min = sec / 60;
    log.info(`${mp3s.length} audios | ${min.toFixed(1)} min totales | coste estimado API: $${(min * RATE_PER_MIN).toFixed(2)}`);
    return;
  }

  let targets: string[];
  if (fileArg) {
    targets = [fileArg.toLowerCase().endsWith(".mp3") ? fileArg : `${fileArg}.mp3`];
  } else if (all) {
    targets = mp3s;
  } else {
    log.error("uso: --cost | --file <videoId> | --all [--force]");
    process.exit(1);
  }

  await mkdir(SUBS_DIR, { recursive: true });
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });

  let totalMin = 0;
  let totalCost = 0;
  let done = 0;
  let skipped = 0;
  let failed = 0;

  for (const name of targets) {
    const id = basename(name, extname(name));
    const input = join(AUDIOS_DIR, name);
    const out = join(SUBS_DIR, `${id}.srt`);
    if (!existsSync(input)) {
      log.error(`no encontrado: ${input}`);
      failed++;
      continue;
    }
    if (!force && existsSync(out)) {
      log.info(`= ${id}: ya existe SRT, omitido (usa --force para rehacer)`);
      skipped++;
      continue;
    }
    try {
      const { srt, durationSec } = await processOne(client, input);
      await writeFile(out, srt, "utf8");
      const min = durationSec / 60;
      const cost = min * RATE_PER_MIN;
      totalMin += min;
      totalCost += cost;
      done++;
      log.info(`✓ ${id}: ${min.toFixed(1)} min, $${cost.toFixed(3)} -> ${out}`);
      // En modo prueba (un solo --file) imprime el SRT para revisarlo aquí mismo.
      if (fileArg && !all) {
        console.log(`\n===== ${id}.srt =====\n`);
        console.log(srt);
        console.log("===== fin =====\n");
      }
    } catch (e) {
      failed++;
      log.error(`✗ ${id}: ${String(e)}`);
    }
  }

  log.info(
    `Resumen: ${done} hechos, ${skipped} omitidos, ${failed} fallidos | ${totalMin.toFixed(1)} min | $${totalCost.toFixed(2)}`
  );
}

main().catch((e) => {
  log.error("audios-to-srt falló", String(e));
  process.exit(1);
});
