import { query } from "@/lib/db/pool";
import { saveSnapshot } from "@/lib/analysis/queries";
import { pearson } from "@/lib/analysis/stats";
import { longOnlySql } from "@/lib/analysis/scope";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("analysis:thumbnails");

/**
 * Correlaciona features visuales de miniatura con rendimiento.
 * IMPORTANTE: el CTR real de impresiones NO existe en la API; si hay datos en
 * thumbnail_ctr_import (CSV de Studio) los usa como objetivo; si no, usa proxies
 * (vistas, retención) y lo marca explícitamente.
 */
export async function computeThumbnailAnalysis() {
  const rows = await query<{
    video_id: string; title: string | null;
    brightness: number | null; contrast: number | null; saturation: number | null; colorfulness: number | null;
    has_face: boolean | null; detected_text: string | null;
    views: number; retention: number | null; ctr: number | null; impressions: number | null;
  }>(`
    WITH snap AS (
      SELECT DISTINCT ON (video_id) video_id, view_count FROM video_stats_snapshot
      ORDER BY video_id, captured_at DESC
    ),
    ret AS (SELECT video_id, AVG(average_view_percentage) AS r FROM video_stats_daily GROUP BY video_id),
    ctr AS (SELECT video_id, AVG(ctr) AS ctr, SUM(impressions) AS imp FROM thumbnail_ctr_import GROUP BY video_id)
    SELECT t.video_id, v.title,
           t.brightness::float AS brightness, t.contrast::float AS contrast,
           t.saturation::float AS saturation, t.colorfulness::float AS colorfulness,
           t.has_face, t.detected_text,
           COALESCE(snap.view_count,0)::float AS views, ret.r::float AS retention,
           ctr.ctr::float AS ctr, ctr.imp::float AS impressions
    FROM thumbnails t JOIN videos v ON v.video_id=t.video_id
    LEFT JOIN snap ON snap.video_id=t.video_id
    LEFT JOIN ret ON ret.video_id=t.video_id
    LEFT JOIN ctr ON ctr.video_id=t.video_id
    WHERE ${longOnlySql("v")}
  `);

  const hasCtr = rows.some((r) => r.ctr !== null);
  const target = (r: (typeof rows)[number]) => (hasCtr ? (r.ctr ?? 0) : r.views);

  const features: { key: string; pick: (r: (typeof rows)[number]) => number }[] = [
    { key: "brightness", pick: (r) => r.brightness ?? 0 },
    { key: "contrast", pick: (r) => r.contrast ?? 0 },
    { key: "saturation", pick: (r) => r.saturation ?? 0 },
    { key: "colorfulness", pick: (r) => r.colorfulness ?? 0 },
  ];

  const ys = rows.map(target);
  const correlations = features.map((f) => ({
    feature: f.key,
    correlation_with: hasCtr ? "ctr_real" : "views_proxy",
    r: Number(pearson(rows.map(f.pick), ys).toFixed(3)),
  }));

  // texto en miniatura (si hay OCR): comparar con/sin texto
  const withText = rows.filter((r) => (r.detected_text ?? "").trim().length > 0);
  const withoutText = rows.filter((r) => !(r.detected_text ?? "").trim().length);
  const avg = (g: typeof rows) => (g.length ? g.reduce((a, r) => a + target(r), 0) / g.length : 0);

  await saveSnapshot("thumbnails", "all", {
    ctr_data_available: hasCtr,
    note: hasCtr
      ? "Correlaciones contra CTR real importado de YouTube Studio."
      : "CTR de miniatura NO disponible vía API. Correlaciones contra vistas (proxy). Importa el CSV de Studio para CTR real.",
    sample_size: rows.length,
    correlations,
    text_overlay: {
      with_text_avg: Number(avg(withText).toFixed(2)),
      without_text_avg: Number(avg(withoutText).toFixed(2)),
      ocr_available: rows.some((r) => r.detected_text !== null),
    },
  });
  log.info(`miniaturas correlacionadas (ctr_real=${hasCtr})`);
}
