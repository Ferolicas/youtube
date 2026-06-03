import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { withTransaction } from "@/lib/db/pool";
import { env } from "@/config/env";
import { createLogger } from "@/lib/utils/logger";
import { claimNext, setStatus } from "@/lib/transcription/queue";

const log = createLogger("transcription");

interface Segment { idx: number; start: number; end: number; text: string }

function run(cmd: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("error", (e) => resolve({ code: -1, stdout, stderr: stderr + String(e) }));
    p.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Intenta descargar subtítulos en español con yt-dlp (0 cuota API). */
async function tryYoutubeCaptions(videoId: string, dir: string): Promise<Segment[] | null> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const out = join(dir, videoId);
  const args = [
    "--skip-download", "--write-subs", "--write-auto-subs",
    "--sub-langs", `${env.WHISPER_LANG}.*,${env.WHISPER_LANG}`,
    "--sub-format", "vtt", "--convert-subs", "vtt",
    "-o", `${out}.%(ext)s`, url,
  ];
  const res = await run(env.YT_DLP_BIN, args);
  if (res.code !== 0) {
    log.warn(`yt-dlp subs ${videoId} code ${res.code}: ${res.stderr.slice(-300)}`);
  }
  const files = (await readdir(dir)).filter(
    (f) => f.startsWith(videoId) && f.endsWith(".vtt")
  );
  if (files.length === 0) return null;
  const vtt = await readFile(join(dir, files[0]!), "utf8");
  return parseVtt(vtt);
}

/** Descarga audio y transcribe con faster-whisper (script python). */
async function whisperTranscribe(videoId: string, dir: string): Promise<Segment[] | null> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const audioPath = join(dir, `${videoId}.mp3`);
  const dl = await run(env.YT_DLP_BIN, [
    "-x", "--audio-format", "mp3", "--audio-quality", "5",
    "--ffmpeg-location", env.FFMPEG_BIN,
    "-o", join(dir, `${videoId}.%(ext)s`), url,
  ]);
  if (dl.code !== 0 || !existsSync(audioPath)) {
    throw new Error(`yt-dlp audio falló: ${dl.stderr.slice(-300)}`);
  }
  await setStatus(videoId, "transcribing", { audio_path: audioPath });

  const script = join(process.cwd(), "scripts", "whisper_transcribe.py");
  const py = await run(env.PYTHON_BIN, [
    script, audioPath,
    "--model", env.WHISPER_MODEL,
    "--compute", env.WHISPER_COMPUTE_TYPE,
    "--lang", env.WHISPER_LANG,
    "--threads", String(env.WHISPER_THREADS),
  ]);
  // limpiamos el audio para no llenar disco
  await rm(audioPath, { force: true }).catch(() => undefined);

  if (py.code !== 0) throw new Error(`whisper falló: ${py.stderr.slice(-400)}`);
  const jsonStart = py.stdout.indexOf("{");
  if (jsonStart < 0) throw new Error("whisper sin salida JSON");
  const parsed = JSON.parse(py.stdout.slice(jsonStart)) as {
    segments: { start: number; end: number; text: string }[];
  };
  return parsed.segments.map((s, i) => ({
    idx: i, start: s.start, end: s.end, text: s.text.trim(),
  }));
}

async function persist(videoId: string, segments: Segment[], source: "youtube_caption" | "whisper", model: string) {
  const fullText = segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
  await withTransaction(async (c) => {
    await c.query(
      `INSERT INTO transcripts (video_id, language, source, model, full_text, created_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (video_id) DO UPDATE SET language=EXCLUDED.language, source=EXCLUDED.source,
         model=EXCLUDED.model, full_text=EXCLUDED.full_text, created_at=now()`,
      [videoId, env.WHISPER_LANG, source, model, fullText]
    );
    await c.query(`DELETE FROM transcript_segments WHERE video_id=$1`, [videoId]);
    for (const s of segments) {
      await c.query(
        `INSERT INTO transcript_segments (video_id, idx, start_sec, end_sec, text)
         VALUES ($1,$2,$3,$4,$5)`,
        [videoId, s.idx, s.start, s.end, s.text]
      );
    }
  });
}

/** Procesa un vídeo: subtítulos primero, Whisper de fallback. */
export async function processOne(): Promise<boolean> {
  const claimed = await claimNext();
  if (!claimed) return false;
  const { video_id } = claimed;
  const dir = join(process.cwd(), env.DATA_DIR, "transcription");
  await mkdir(dir, { recursive: true });

  try {
    log.info(`transcribiendo ${video_id} (subtítulos primero)`);
    let segs = await tryYoutubeCaptions(video_id, dir);
    if (segs && segs.length > 0) {
      await persist(video_id, segs, "youtube_caption", "yt-dlp");
      await setStatus(video_id, "done");
      log.info(`${video_id}: subtítulos oficiales (${segs.length} segmentos)`);
      return true;
    }
    log.info(`${video_id}: sin subtítulos, usando Whisper ${env.WHISPER_MODEL}`);
    segs = await whisperTranscribe(video_id, dir);
    if (!segs || segs.length === 0) {
      await setStatus(video_id, "skipped", { last_error: "sin audio/segmentos" });
      return true;
    }
    await persist(video_id, segs, "whisper", env.WHISPER_MODEL);
    await setStatus(video_id, "done");
    log.info(`${video_id}: Whisper OK (${segs.length} segmentos)`);
    return true;
  } catch (e) {
    log.error(`${video_id} falló`, String(e));
    await setStatus(video_id, "failed", { last_error: String(e).slice(0, 500) });
    return true;
  } finally {
    // limpieza de VTT temporales
    try {
      const files = (await readdir(dir)).filter((f) => f.startsWith(video_id));
      await Promise.all(files.map((f) => rm(join(dir, f), { force: true })));
    } catch { /* noop */ }
  }
}

function parseVtt(vtt: string): Segment[] {
  const segs: Segment[] = [];
  const blocks = vtt.replace(/\r/g, "").split("\n\n");
  let idx = 0;
  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    const timeLine = lines.find((l) => l.includes("-->"));
    if (!timeLine) continue;
    const m = timeLine.match(/(\d+:\d{2}:\d{2}\.\d{3}).*-->.*(\d+:\d{2}:\d{2}\.\d{3})/);
    if (!m) continue;
    const text = lines
      .filter((l) => !l.includes("-->") && !/^\d+$/.test(l) && !l.startsWith("WEBVTT") && !l.startsWith("Kind") && !l.startsWith("Language"))
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .trim();
    if (!text) continue;
    segs.push({ idx: idx++, start: toSec(m[1]!), end: toSec(m[2]!), text });
  }
  return dedupe(segs);
}

function toSec(t: string): number {
  const [h, m, s] = t.split(":");
  return Number(h) * 3600 + Number(m) * 60 + parseFloat(s ?? "0");
}

/** Auto-subs repiten líneas (rolling captions); deduplicamos consecutivos. */
function dedupe(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  let last = "";
  for (const s of segs) {
    if (s.text === last) continue;
    out.push({ ...s, idx: out.length });
    last = s.text;
  }
  return out;
}
