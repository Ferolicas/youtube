import { query } from "@/lib/db/pool";
import { createLogger } from "@/lib/utils/logger";
import { getVideoMetrics, saveSnapshot, type VideoMetrics } from "@/lib/analysis/queries";
import { mean, median, stdev } from "@/lib/analysis/stats";

const log = createLogger("analysis:outliers");
const OUTLIER_VIEWS = 10_000;
const OUTLIER_Z = 2;

function publishHour(iso: string | null): number | null {
  if (!iso) return null;
  return new Date(iso).getUTCHours();
}
function publishWeekday(iso: string | null): number | null {
  if (!iso) return null;
  return new Date(iso).getUTCDay(); // 0=domingo
}
function titleLen(t: string | null): number {
  return t?.length ?? 0;
}
function hasNumber(t: string | null): boolean {
  return /\d/.test(t ?? "");
}
function hasQuestion(t: string | null): boolean {
  return /\?|¿/.test(t ?? "");
}

/**
 * Análisis de outliers: compara los vídeos de alto rendimiento (>10K o z>2)
 * contra la mediana del canal (por formato) e identifica qué variables los explican.
 */
export async function computeOutliers() {
  const all = await getVideoMetrics();
  const byFormat = {
    long: all.filter((v) => v.is_short === false),
    short: all.filter((v) => v.is_short === true),
  };

  const results: Record<string, unknown> = {};
  await query(`TRUNCATE outlier_analysis`);

  for (const [fmt, vids] of Object.entries(byFormat)) {
    if (vids.length === 0) continue;
    const views = vids.map((v) => v.views);
    const med = median(views);
    const mu = mean(views);
    const sd = stdev(views) || 1;

    const outliers: VideoMetrics[] = [];
    const normals: VideoMetrics[] = [];
    for (const v of vids) {
      const z = (v.views - mu) / sd;
      const isOut = v.views >= OUTLIER_VIEWS || z >= OUTLIER_Z;
      (isOut ? outliers : normals).push(v);
      await query(
        `INSERT INTO outlier_analysis (video_id, is_outlier, views, z_score, performance_ratio, drivers)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (video_id) DO UPDATE SET is_outlier=EXCLUDED.is_outlier, views=EXCLUDED.views,
           z_score=EXCLUDED.z_score, performance_ratio=EXCLUDED.performance_ratio,
           drivers=EXCLUDED.drivers, computed_at=now()`,
        [
          v.video_id, isOut, Math.round(v.views), Number(z.toFixed(3)),
          med > 0 ? Number((v.views / med).toFixed(2)) : null,
          JSON.stringify(videoFeatures(v)),
        ]
      );
    }

    results[fmt] = {
      count: vids.length,
      outlier_count: outliers.length,
      median_views: Math.round(med),
      mean_views: Math.round(mu),
      drivers: compareGroups(outliers, normals),
      outliers: outliers
        .sort((a, b) => b.views - a.views)
        .slice(0, 10)
        .map((v) => ({
          video_id: v.video_id,
          title: v.title,
          views: Math.round(v.views),
          ratio_vs_median: med > 0 ? Number((v.views / med).toFixed(1)) : null,
          retention: v.avg_view_percentage,
        })),
    };
  }

  await saveSnapshot("outliers", "all", results);
  log.info("outliers calculados", {
    long: (results.long as { outlier_count?: number })?.outlier_count,
    short: (results.short as { outlier_count?: number })?.outlier_count,
  });
  return results;
}

function videoFeatures(v: VideoMetrics) {
  return {
    title_length: titleLen(v.title),
    has_number: hasNumber(v.title),
    has_question: hasQuestion(v.title),
    duration_sec: v.duration_seconds,
    publish_hour_utc: publishHour(v.published_at),
    publish_weekday: publishWeekday(v.published_at),
    retention_pct: v.avg_view_percentage,
    tags_count: v.tags_count,
    cpm: v.cpm,
  };
}

/** Compara medias de features entre outliers y normales -> "drivers" del éxito. */
function compareGroups(out: VideoMetrics[], norm: VideoMetrics[]) {
  const f = (g: VideoMetrics[], pick: (v: VideoMetrics) => number | null) =>
    mean(g.map((v) => pick(v) ?? 0).filter((x) => !Number.isNaN(x)));

  const metrics: { key: string; pick: (v: VideoMetrics) => number | null }[] = [
    { key: "title_length", pick: (v) => titleLen(v.title) },
    { key: "duration_sec", pick: (v) => v.duration_seconds },
    { key: "retention_pct", pick: (v) => v.avg_view_percentage },
    { key: "tags_count", pick: (v) => v.tags_count },
    { key: "cpm", pick: (v) => v.cpm },
  ];

  const drivers = metrics.map((m) => {
    const o = f(out, m.pick);
    const n = f(norm, m.pick);
    const lift = n !== 0 ? Number(((o - n) / Math.abs(n)).toFixed(2)) : null;
    return { feature: m.key, outliers_avg: Number(o.toFixed(1)), normal_avg: Number(n.toFixed(1)), lift };
  });

  // categóricos: % con número/pregunta en título
  const pct = (g: VideoMetrics[], test: (v: VideoMetrics) => boolean) =>
    g.length ? Number(((g.filter(test).length / g.length) * 100).toFixed(0)) : 0;
  drivers.push({
    feature: "title_has_number_%",
    outliers_avg: pct(out, (v) => hasNumber(v.title)),
    normal_avg: pct(norm, (v) => hasNumber(v.title)),
    lift: null,
  });
  drivers.push({
    feature: "title_has_question_%",
    outliers_avg: pct(out, (v) => hasQuestion(v.title)),
    normal_avg: pct(norm, (v) => hasQuestion(v.title)),
    lift: null,
  });

  return drivers.sort((a, b) => Math.abs(b.lift ?? 0) - Math.abs(a.lift ?? 0));
}
