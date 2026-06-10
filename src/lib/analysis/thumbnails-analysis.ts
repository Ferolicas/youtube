import { query } from "@/lib/db/pool";
import { saveSnapshot } from "@/lib/analysis/queries";
import { pearson } from "@/lib/analysis/stats";
import { longOnlySql } from "@/lib/analysis/scope";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("analysis:thumbnails");

// Palabras "de impacto" típicas de packaging ES (heurística contrastable con datos).
const POWER_WORDS = [
  "secreto", "error", "errores", "nunca", "nadie", "increible", "increíble", "facil", "fácil",
  "rapido", "rápido", "sin", "mejor", "peor", "gratis", "ya", "hoy", "definitivo", "real",
  "verdad", "cuidado", "alerta", "nuevo", "prohibido", "milagro",
];

interface Row {
  video_id: string; title: string | null;
  brightness: number | null; contrast: number | null; saturation: number | null; colorfulness: number | null;
  has_face: boolean | null; detected_text: string | null;
  views: number; retention: number | null;
  ctr: number | null; impressions: number | null;
}

/**
 * Inteligencia de CTR/packaging: correlaciona features visuales de miniatura Y
 * patrones de título contra el CTR REAL (thumbnail_ctr_import o el import de
 * Studio studio_content_stats, lo que haya). Sin CTR usa vistas como proxy y
 * lo marca. Incluye top/bottom de CTR para inspeccionar patrones a ojo.
 */
export async function computeThumbnailAnalysis() {
  const rows = await query<Row>(`
    WITH snap AS (
      SELECT DISTINCT ON (video_id) video_id, view_count FROM video_stats_snapshot
      ORDER BY video_id, captured_at DESC
    ),
    ret AS (SELECT video_id, AVG(average_view_percentage) AS r FROM video_stats_daily GROUP BY video_id),
    ctr_imp AS (SELECT video_id, AVG(ctr) AS ctr, SUM(impressions) AS imp FROM thumbnail_ctr_import GROUP BY video_id)
    SELECT t.video_id, v.title,
           t.brightness::float AS brightness, t.contrast::float AS contrast,
           t.saturation::float AS saturation, t.colorfulness::float AS colorfulness,
           t.has_face, t.detected_text,
           COALESCE(snap.view_count,0)::float AS views, ret.r::float AS retention,
           COALESCE(ctr_imp.ctr, s.impressions_ctr)::float AS ctr,
           COALESCE(ctr_imp.imp, s.impressions)::float AS impressions
    FROM thumbnails t JOIN videos v ON v.video_id=t.video_id
    LEFT JOIN snap ON snap.video_id=t.video_id
    LEFT JOIN ret ON ret.video_id=t.video_id
    LEFT JOIN ctr_imp ON ctr_imp.video_id=t.video_id
    LEFT JOIN studio_content_stats s ON s.video_id=t.video_id
    WHERE ${longOnlySql("v")}
  `);

  // Con CTR: solo vídeos con muestra mínima de impresiones (CTR de 50 impresiones es ruido)
  const withCtr = rows.filter((r) => r.ctr !== null && (r.impressions ?? 0) >= 500);
  const hasCtr = withCtr.length >= 8;
  const sample = hasCtr ? withCtr : rows;
  const target = (r: Row) => (hasCtr ? (r.ctr ?? 0) : r.views);

  // --- features visuales ---
  const visualFeatures: { key: string; pick: (r: Row) => number }[] = [
    { key: "brightness", pick: (r) => r.brightness ?? 0 },
    { key: "contrast", pick: (r) => r.contrast ?? 0 },
    { key: "saturation", pick: (r) => r.saturation ?? 0 },
    { key: "colorfulness", pick: (r) => r.colorfulness ?? 0 },
  ];
  const ys = sample.map(target);
  const visual = visualFeatures.map((f) => ({
    feature: f.key,
    correlation_with: hasCtr ? "ctr_real" : "views_proxy",
    r: Number(pearson(sample.map(f.pick), ys).toFixed(3)),
  }));

  // --- features de TÍTULO vs CTR ---
  const titleFeatures: { key: string; pick: (r: Row) => number }[] = [
    { key: "title_length", pick: (r) => (r.title ?? "").length },
    { key: "has_number", pick: (r) => (/\d/.test(r.title ?? "") ? 1 : 0) },
    { key: "has_question", pick: (r) => (/[?¿]/.test(r.title ?? "") ? 1 : 0) },
    { key: "has_brackets", pick: (r) => (/[([]/.test(r.title ?? "") ? 1 : 0) },
    { key: "has_emoji", pick: (r) => (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(r.title ?? "") ? 1 : 0) },
    {
      key: "caps_ratio",
      pick: (r) => {
        const t = (r.title ?? "").replace(/[^a-zA-ZÁÉÍÓÚÑáéíóúñ]/g, "");
        if (!t.length) return 0;
        return t.replace(/[^A-ZÁÉÍÓÚÑ]/g, "").length / t.length;
      },
    },
    {
      key: "power_words",
      pick: (r) => {
        const low = (r.title ?? "").toLowerCase();
        return POWER_WORDS.filter((w) => low.includes(w)).length;
      },
    },
  ];
  const titleCorr = titleFeatures.map((f) => ({
    feature: f.key,
    correlation_with: hasCtr ? "ctr_real" : "views_proxy",
    r: Number(pearson(sample.map(f.pick), ys).toFixed(3)),
  }));

  // texto en miniatura (si hay OCR): comparar con/sin texto
  const withText = sample.filter((r) => (r.detected_text ?? "").trim().length > 0);
  const withoutText = sample.filter((r) => !(r.detected_text ?? "").trim().length);
  const avg = (g: Row[]) => (g.length ? g.reduce((a, r) => a + target(r), 0) / g.length : 0);

  // top / bottom CTR para inspección manual de patrones
  const ranked = [...withCtr].sort((a, b) => (b.ctr ?? 0) - (a.ctr ?? 0));
  const pack = (r: Row) => ({
    video_id: r.video_id, title: r.title,
    ctr: r.ctr !== null ? Number(r.ctr.toFixed(2)) : null,
    impressions: r.impressions, views: Math.round(r.views),
    brightness: r.brightness !== null ? Number(r.brightness.toFixed(2)) : null,
    saturation: r.saturation !== null ? Number(r.saturation.toFixed(2)) : null,
  });

  await saveSnapshot("thumbnails", "all", {
    ctr_data_available: hasCtr,
    ctr_source: hasCtr ? "studio_import" : null,
    note: hasCtr
      ? `Correlaciones contra CTR real (${withCtr.length} vídeos con ≥500 impresiones).`
      : "CTR real insuficiente. Correlaciones contra vistas (proxy). Importa el CSV de Studio (npm run import:studio) para CTR real.",
    sample_size: sample.length,
    correlations: visual,
    title_correlations: titleCorr,
    text_overlay: {
      with_text_avg: Number(avg(withText).toFixed(2)),
      without_text_avg: Number(avg(withoutText).toFixed(2)),
      ocr_available: rows.some((r) => r.detected_text !== null),
    },
    top_ctr: ranked.slice(0, 8).map(pack),
    bottom_ctr: ranked.slice(-8).reverse().map(pack),
  });
  log.info(`packaging analizado (ctr_real=${hasCtr}, muestra=${sample.length})`);
}
