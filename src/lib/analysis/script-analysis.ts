import { query } from "@/lib/db/pool";
import { createLogger } from "@/lib/utils/logger";
import { saveSnapshot } from "@/lib/analysis/queries";
import { mean } from "@/lib/analysis/stats";

const log = createLogger("analysis:guion");

// Por debajo de estas vistas la retención de YouTube es estadísticamente poco fiable.
const LOW_VIEW_THRESHOLD = 1000;
// Mínimo de puntos de curva para buscar valles con sentido.
const MIN_RETENTION_POINTS = 5;
const HOOK_SEC = 30; // primeros 30s
const MID_FROM = 0.4, MID_TO = 0.65; // zona media (fracción de duración)
const CLOSE_FROM = 0.85; // cierre/CTA
const MIN_COHORT = 6; // mínimo de vídeos por cohorte para que el contraste tenga sentido

// ---------- texto ----------
const STOP = new Set(
  ("de la que el en y a los del se las por un para con no una su al lo como mas pero sus le ya o este si " +
    "porque esta entre cuando muy sin sobre tambien me hasta hay donde quien desde todo nos durante todos uno " +
    "les ni contra otros ese eso ante ellos esto antes algunos unos yo otro otras otra tanto esa estos mucho " +
    "quienes nada muchos cual poco ella estar estas algunas algo nosotros mis tus te ti os mio es son fue ser " +
    "asi vamos aqui ahi va van ir hace hacer bien entonces pues tan cada solo va ya vais voy van eh ah oh ok " +
    "este esta esto estos estas mi tu su sus nos les un una unos unas el la lo los las")
    .split(/\s+/)
);

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ");
}
function contentTokens(s: string): string[] {
  return normalize(s)
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}
function ngrams(toks: string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= toks.length; i++) out.push(toks.slice(i, i + n).join(" "));
  return out;
}

// ---------- tipos ----------
interface BaseRow {
  video_id: string;
  title: string | null;
  duration_seconds: number | null;
  is_short: boolean | null;
  views: number;
  retention: number | null; // avg average_view_percentage
  n_points: number;
  has_transcript: boolean;
}
interface Seg { s: number; e: number; t: string; }
interface Curve { r: number; w: number; }

interface ContrastTerm { term: string; high_pct: number; low_pct: number; lift: number; }
interface Example { video_id: string; title: string | null; text: string; retention: number | null; views: number; reliable: boolean; }

// ---------- helpers de texto temporal ----------
function windowText(segs: Seg[], from: number, to: number): string {
  return segs.filter((g) => g.s >= from && g.s < to).map((g) => g.t).join(" ").trim();
}
function phraseAt(segs: Seg[], sec: number): string {
  let best: Seg | undefined;
  for (const g of segs) {
    if (sec >= g.s && sec <= g.e) return g.t.trim();
    if (!best || Math.abs((g.s + g.e) / 2 - sec) < Math.abs((best.s + best.e) / 2 - sec)) best = g;
  }
  return (best?.t ?? "").trim();
}

/** Contraste por frecuencia-de-documento (vídeo) de términos entre cohorte alta y baja. */
function cohortContrast(highDocs: string[], lowDocs: string[]): ContrastTerm[] {
  const df = (docs: string[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const doc of docs) {
      const toks = contentTokens(doc);
      const terms = new Set<string>([...toks, ...ngrams(toks, 2)]);
      for (const t of terms) m.set(t, (m.get(t) ?? 0) + 1);
    }
    return m;
  };
  const hi = df(highDocs), lo = df(lowDocs);
  const nH = Math.max(1, highDocs.length), nL = Math.max(1, lowDocs.length);
  const terms = new Set<string>([...hi.keys(), ...lo.keys()]);
  const out: ContrastTerm[] = [];
  for (const term of terms) {
    const h = hi.get(term) ?? 0, l = lo.get(term) ?? 0;
    if (h + l < 2) continue; // ruido
    const high_pct = Math.round((h / nH) * 100);
    const low_pct = Math.round((l / nL) * 100);
    out.push({ term, high_pct, low_pct, lift: high_pct - low_pct });
  }
  return out.sort((a, b) => Math.abs(b.lift) - Math.abs(a.lift));
}

export async function computeScriptAnalysis() {
  // 1) base por vídeo
  const base = await query<BaseRow>(`
    WITH snap AS (
      SELECT DISTINCT ON (video_id) video_id, view_count
      FROM video_stats_snapshot ORDER BY video_id, captured_at DESC
    ),
    dstat AS (SELECT video_id, AVG(average_view_percentage) AS avp FROM video_stats_daily GROUP BY video_id),
    ret AS (SELECT video_id, count(*) AS n FROM video_retention GROUP BY video_id),
    tr AS (SELECT video_id FROM transcripts)
    SELECT v.video_id, v.title, v.duration_seconds, v.is_short,
           COALESCE(snap.view_count,0)::float AS views,
           dstat.avp::float AS retention,
           COALESCE(ret.n,0)::int AS n_points,
           (tr.video_id IS NOT NULL) AS has_transcript
    FROM videos v
    LEFT JOIN snap ON snap.video_id=v.video_id
    LEFT JOIN dstat ON dstat.video_id=v.video_id
    LEFT JOIN ret ON ret.video_id=v.video_id
    LEFT JOIN tr ON tr.video_id=v.video_id
  `);

  // 2) curvas de retención
  const retRows = await query<{ video_id: string; r: string; w: string | null }>(
    `SELECT video_id, elapsed_ratio::text AS r, audience_watch_ratio::text AS w
     FROM video_retention ORDER BY video_id, elapsed_ratio`
  );
  const curves = new Map<string, Curve[]>();
  for (const row of retRows) {
    const arr = curves.get(row.video_id) ?? [];
    arr.push({ r: Number(row.r), w: row.w === null ? NaN : Number(row.w) });
    curves.set(row.video_id, arr);
  }

  // 3) segmentos de transcripción
  const segRows = await query<{ video_id: string; s: string; e: string; t: string }>(
    `SELECT video_id, start_sec::text AS s, end_sec::text AS e, text AS t
     FROM transcript_segments ORDER BY video_id, idx`
  );
  const segs = new Map<string, Seg[]>();
  for (const row of segRows) {
    const arr = segs.get(row.video_id) ?? [];
    arr.push({ s: Number(row.s) || 0, e: Number(row.e) || 0, t: row.t ?? "" });
    segs.set(row.video_id, arr);
  }

  // ---------- DIAGNÓSTICO de granularidad ----------
  const withRetention = base.filter((b) => b.n_points > 0);
  const pts = withRetention.map((b) => b.n_points);
  const longForm = base.filter((b) => b.is_short === false);
  const diagnostics = {
    videos_total: base.length,
    long_form: longForm.length,
    with_retention: withRetention.length,
    with_transcript: base.filter((b) => b.has_transcript).length,
    with_both: base.filter((b) => b.n_points > 0 && b.has_transcript).length,
    retention_points: {
      avg: pts.length ? Math.round(mean(pts)) : 0,
      min: pts.length ? Math.min(...pts) : 0,
      max: pts.length ? Math.max(...pts) : 0,
    },
    low_view_threshold: LOW_VIEW_THRESHOLD,
    reliable_with_both: base.filter((b) => b.n_points > 0 && b.has_transcript && b.views >= LOW_VIEW_THRESHOLD).length,
  };

  // Conjunto de trabajo: vídeos LARGOS con transcripción (el "guion" aplica a largos).
  const longTr = longForm.filter((b) => b.has_transcript && (segs.get(b.video_id)?.length ?? 0) > 0);

  // ---------- 1) PUNTOS DE ABANDONO ----------
  const abandonItems: {
    video_id: string; title: string | null; at_pct: number; at_sec: number;
    drop: number; phrase: string; views: number; reliable: boolean;
  }[] = [];
  const hotBins = new Array(10).fill(0).map(() => ({ drop: 0, n: 0 }));
  for (const b of longTr) {
    const c = curves.get(b.video_id);
    if (!c || c.length < MIN_RETENTION_POINTS || !b.duration_seconds) continue;
    const sgs = segs.get(b.video_id) ?? [];
    const drops: { i: number; drop: number }[] = [];
    for (let i = 1; i < c.length; i++) {
      const prev = c[i - 1]!, cur = c[i]!;
      if (Number.isNaN(prev.w) || Number.isNaN(cur.w)) continue;
      const drop = prev.w - cur.w; // caída de retención
      if (drop > 0) drops.push({ i, drop });
    }
    drops.sort((a, z) => z.drop - a.drop);
    const reliable = b.views >= LOW_VIEW_THRESHOLD;
    for (const d of drops.slice(0, 2)) {
      const pt = c[d.i]!;
      const atSec = pt.r * b.duration_seconds;
      const atPct = Math.round(pt.r * 100);
      abandonItems.push({
        video_id: b.video_id, title: b.title, at_pct: atPct, at_sec: Math.round(atSec),
        drop: Number(d.drop.toFixed(3)), phrase: phraseAt(sgs, atSec).slice(0, 200),
        views: Math.round(b.views), reliable,
      });
      const bin = Math.min(9, Math.floor(pt.r * 10));
      hotBins[bin]!.drop += d.drop;
      hotBins[bin]!.n += 1;
    }
  }
  abandonItems.sort((a, z) => z.drop - a.drop);
  const abandonment = {
    items: abandonItems.slice(0, 25),
    hotspots: hotBins.map((b, i) => ({
      bucket_pct: i * 10,
      avg_drop: b.n ? Number((b.drop / b.n).toFixed(3)) : 0,
      n: b.n,
    })),
  };

  // ---------- cohortes alta vs baja retención (largos, fiables si hay suficientes) ----------
  const ranked = longTr.filter((b) => b.retention !== null);
  const reliableRanked = ranked.filter((b) => b.views >= LOW_VIEW_THRESHOLD);
  const usable = reliableRanked.length >= MIN_COHORT ? reliableRanked : ranked;
  const cohortReliable = reliableRanked.length >= MIN_COHORT;
  usable.sort((a, b) => (b.retention ?? 0) - (a.retention ?? 0));
  const third = Math.max(1, Math.floor(usable.length / 3));
  const high = usable.slice(0, third);
  const low = usable.slice(-third);

  const buildZone = (cohort: BaseRow[], from: (b: BaseRow) => number, to: (b: BaseRow) => number): string[] =>
    cohort.map((b) => windowText(segs.get(b.video_id) ?? [], from(b), to(b))).filter(Boolean);

  const examples = (cohort: BaseRow[], from: (b: BaseRow) => number, to: (b: BaseRow) => number, n: number): Example[] =>
    cohort.slice(0, n).map((b) => ({
      video_id: b.video_id, title: b.title,
      text: windowText(segs.get(b.video_id) ?? [], from(b), to(b)).slice(0, 240),
      retention: b.retention === null ? null : Number(b.retention.toFixed(1)),
      views: Math.round(b.views), reliable: b.views >= LOW_VIEW_THRESHOLD,
    }));

  const hookFrom = () => 0, hookTo = () => HOOK_SEC;
  const midFrom = (b: BaseRow) => (b.duration_seconds ?? 0) * MID_FROM;
  const midTo = (b: BaseRow) => (b.duration_seconds ?? 0) * MID_TO;
  const closeFrom = (b: BaseRow) => (b.duration_seconds ?? 0) * CLOSE_FROM;
  const closeTo = (b: BaseRow) => (b.duration_seconds ?? 1e9);

  const hooks = {
    contrast: cohortContrast(buildZone(high, hookFrom, hookTo), buildZone(low, hookFrom, hookTo)).slice(0, 15),
    examples_high: examples(high, hookFrom, hookTo, 4),
    examples_low: examples([...low].reverse(), hookFrom, hookTo, 4),
  };
  const middle = {
    contrast: cohortContrast(buildZone(high, midFrom, midTo), buildZone(low, midFrom, midTo)).slice(0, 12),
    examples_high: examples(high, midFrom, midTo, 3),
    examples_low: examples([...low].reverse(), midFrom, midTo, 3),
  };
  const closing = {
    contrast: cohortContrast(buildZone(high, closeFrom, closeTo), buildZone(low, closeFrom, closeTo)).slice(0, 12),
    examples_high: examples(high, closeFrom, closeTo, 3),
    examples_low: examples([...low].reverse(), closeFrom, closeTo, 3),
  };

  // ---------- 4) FRASES RECURRENTES correlacionadas con retención ----------
  const phraseVideos = new Map<string, Set<string>>(); // trigrama -> set videoIds
  const retById = new Map<string, number>();
  for (const b of ranked) if (b.retention !== null) retById.set(b.video_id, b.retention);
  for (const b of ranked) {
    const full = (segs.get(b.video_id) ?? []).map((g) => g.t).join(" ");
    const tris = new Set(ngrams(contentTokens(full), 3));
    for (const tri of tris) {
      const set = phraseVideos.get(tri) ?? new Set<string>();
      set.add(b.video_id);
      phraseVideos.set(tri, set);
    }
  }
  const allRet = [...retById.values()];
  const recurring = [...phraseVideos.entries()]
    .filter(([, set]) => set.size >= 3)
    .map(([phrase, set]) => {
      const withR = [...set].map((id) => retById.get(id)).filter((x): x is number => x !== undefined);
      const withoutR = [...retById.entries()].filter(([id]) => !set.has(id)).map(([, r]) => r);
      const aw = withR.length ? mean(withR) : 0;
      const ao = withoutR.length ? mean(withoutR) : 0;
      const delta = Number((aw - ao).toFixed(1));
      return {
        phrase, videos: set.size,
        avg_ret_with: Number(aw.toFixed(1)),
        avg_ret_without: Number(ao.toFixed(1)),
        delta,
        verdict: delta > 1.5 ? "ayuda" : delta < -1.5 ? "perjudica" : "neutral",
      };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 20);

  // ---------- 5) RECOMENDACIONES accionables (derivadas de la evidencia) ----------
  const recommendations: { type: "conservar" | "cambiar" | "añadir"; text: string; evidence: string }[] = [];
  const topHookKeep = hooks.contrast.filter((t) => t.lift >= 25).slice(0, 3);
  for (const t of topHookKeep)
    recommendations.push({
      type: "conservar",
      text: `Mantén el gancho con «${t.term}» en los primeros ${HOOK_SEC}s.`,
      evidence: `Aparece en ${t.high_pct}% de tus aperturas de ALTA retención vs ${t.low_pct}% de las de baja.`,
    });
  const topHookDrop = hooks.contrast.filter((t) => t.lift <= -25).slice(0, 3);
  for (const t of topHookDrop)
    recommendations.push({
      type: "cambiar",
      text: `Replantea aperturas con «${t.term}».`,
      evidence: `Aparece en ${t.low_pct}% de aperturas de BAJA retención vs ${t.high_pct}% de las de alta.`,
    });
  for (const p of recurring.filter((r) => r.verdict === "perjudica").slice(0, 3))
    recommendations.push({
      type: "cambiar",
      text: `Reduce la muletilla recurrente «${p.phrase}».`,
      evidence: `En ${p.videos} vídeos; retención media con ella ${p.avg_ret_with}% vs ${p.avg_ret_without}% sin ella.`,
    });
  for (const p of recurring.filter((r) => r.verdict === "ayuda").slice(0, 2))
    recommendations.push({
      type: "conservar",
      text: `Sigue usando «${p.phrase}».`,
      evidence: `En ${p.videos} vídeos; retención media con ella ${p.avg_ret_with}% vs ${p.avg_ret_without}% sin ella.`,
    });
  // abandono: bucket con mayor caída media
  const worstBin = [...abandonment.hotspots].filter((h) => h.n >= 2).sort((a, b) => b.avg_drop - a.avg_drop)[0];
  if (worstBin)
    recommendations.push({
      type: "añadir",
      text: `Refuerza el guion en torno al ${worstBin.bucket_pct}–${worstBin.bucket_pct + 10}% del vídeo (re-gancho / cambio de ritmo).`,
      evidence: `Es la franja con mayor caída media de retención (${worstBin.n} momentos detectados).`,
    });
  if (topHookKeep.length === 0 && topHookDrop.length === 0)
    recommendations.push({
      type: "añadir",
      text: "Aún no hay patrones de gancho estadísticamente separables.",
      evidence: "Faltan vídeos con transcripción + retención fiables para contrastar cohortes.",
    });

  const caveats = [
    "Correlación ≠ causalidad: estos patrones describen lo que coincide con tu retención, no garantizan causa.",
    `Los vídeos con menos de ${LOW_VIEW_THRESHOLD} vistas tienen retención poco fiable y van marcados; el contraste de cohortes ${cohortReliable ? "usa solo vídeos fiables" : "incluye vídeos de pocas vistas por falta de muestra (poco fiable)"}.`,
    "El análisis estructural (gancho/medio/cierre) se calcula sobre vídeos LARGOS con transcripción; los Shorts se excluyen.",
    `Granularidad de retención disponible: ~${diagnostics.retention_points.avg} puntos por vídeo (mín ${diagnostics.retention_points.min}, máx ${diagnostics.retention_points.max}). El cruce por timestamp es tan fino como esa granularidad.`,
  ];

  const payload = {
    generated_at: new Date().toISOString(),
    diagnostics,
    cohort: { size_high: high.length, size_low: low.length, reliable: cohortReliable },
    abandonment,
    hooks,
    middle,
    closing,
    recurring_phrases: recurring,
    recommendations,
    caveats,
  };

  await saveSnapshot("guion", "all", payload);
  log.info("análisis de guion calculado", {
    with_both: diagnostics.with_both,
    abandonment: abandonment.items.length,
    recurring: recurring.length,
  });
  return payload;
}
