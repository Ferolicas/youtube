import { query, queryOne } from "@/lib/db/pool";
import { saveSnapshot } from "@/lib/analysis/queries";
import { longOnlySql } from "@/lib/analysis/scope";
import { hasMonetaryScope } from "@/lib/auth/tokens";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("analysis:monetization");

/**
 * Análisis enfocado SOLO en AdSense: RPM/CPM por vídeo, duración y país LATAM,
 * + densidad de mid-rolls en vídeos >8 min. RPM = estimated_revenue / views * 1000.
 */
export async function computeMonetization() {
  const monetary = await hasMonetaryScope();
  const hasData = await queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM video_revenue_daily`
  );
  if (!monetary || Number(hasData?.n ?? 0) === 0) {
    await saveSnapshot("monetization", "all", {
      available: false,
      reason: monetary
        ? "Scope monetario concedido pero aún sin datos de ingresos (espera al primer sync de Analytics)."
        : "Sin scope monetario o canal no monetizado. Reconecta concediendo yt-analytics-monetary.readonly.",
    });
    log.warn("monetización no disponible");
    return;
  }

  // por vídeo
  const byVideo = await query<{
    video_id: string; title: string | null; duration_seconds: number | null;
    revenue: string; views: string; cpm: string | null; pb_cpm: string | null;
  }>(`
    WITH snap AS (
      SELECT DISTINCT ON (video_id) video_id, view_count FROM video_stats_snapshot
      ORDER BY video_id, captured_at DESC
    )
    SELECT v.video_id, v.title, v.duration_seconds,
           SUM(r.estimated_revenue)::numeric(12,2)::text AS revenue,
           COALESCE(MAX(snap.view_count),0)::text AS views,
           AVG(NULLIF(r.cpm,0))::numeric(8,2)::text AS cpm,
           AVG(NULLIF(r.playback_based_cpm,0))::numeric(8,2)::text AS pb_cpm
    FROM videos v JOIN video_revenue_daily r ON r.video_id=v.video_id
    LEFT JOIN snap ON snap.video_id=v.video_id
    WHERE ${longOnlySql("v")}
    GROUP BY v.video_id, v.title, v.duration_seconds
    ORDER BY SUM(r.estimated_revenue) DESC NULLS LAST
  `);

  const videoRpm = byVideo.map((v) => {
    const views = Number(v.views) || 0;
    const revenue = Number(v.revenue) || 0;
    return {
      video_id: v.video_id, title: v.title, duration_sec: v.duration_seconds,
      revenue, views, rpm: views > 0 ? Number(((revenue / views) * 1000).toFixed(2)) : null,
      cpm: v.cpm ? Number(v.cpm) : null, playback_cpm: v.pb_cpm ? Number(v.pb_cpm) : null,
    };
  });

  // por bucket de duración (clave para mid-rolls: >8 min permite varios mid-rolls)
  const buckets = [
    { key: "0-1m (Short)", min: 0, max: 60 },
    { key: "1-8m", min: 60, max: 480 },
    { key: "8-15m (mid-roll)", min: 480, max: 900 },
    { key: "15m+ (multi mid-roll)", min: 900, max: 99999 },
  ];
  const byDuration = buckets.map((b) => {
    const grp = videoRpm.filter((v) => (v.duration_sec ?? 0) >= b.min && (v.duration_sec ?? 0) < b.max);
    const rev = grp.reduce((a, v) => a + v.revenue, 0);
    const views = grp.reduce((a, v) => a + v.views, 0);
    return {
      bucket: b.key, videos: grp.length, revenue: Number(rev.toFixed(2)),
      avg_rpm: views > 0 ? Number(((rev / views) * 1000).toFixed(2)) : null,
    };
  });

  // por país LATAM
  const byCountry = await query<{ country_code: string; revenue: string; cpm: string | null; mp: string }>(`
    SELECT g.country_code, SUM(g.estimated_revenue)::numeric(12,2)::text AS revenue,
           AVG(NULLIF(g.cpm,0))::numeric(8,2)::text AS cpm,
           SUM(g.monetized_playbacks)::text AS mp
    FROM video_revenue_geo g JOIN videos v ON v.video_id=g.video_id
    WHERE ${longOnlySql("v")}
    GROUP BY g.country_code ORDER BY SUM(g.estimated_revenue) DESC NULLS LAST LIMIT 25
  `);

  // vídeos >8min sin haber capitalizado bien (RPM bajo vs mediana del bucket)
  const longVids = videoRpm.filter((v) => (v.duration_sec ?? 0) >= 480 && v.rpm !== null);
  const midRpm = longVids.length
    ? [...longVids].sort((a, b) => (a.rpm ?? 0) - (b.rpm ?? 0))[Math.floor(longVids.length / 2)]?.rpm ?? 0
    : 0;
  const underMonetized = longVids
    .filter((v) => (v.rpm ?? 0) < midRpm * 0.7)
    .slice(0, 15)
    .map((v) => ({ video_id: v.video_id, title: v.title, rpm: v.rpm, duration_sec: v.duration_sec }));

  await saveSnapshot("monetization", "all", {
    available: true,
    // Conteo REAL de vídeos largos con ingresos (todo el histórico); top_earners es
    // solo una lista recortada a 15, no debe usarse como "nº de vídeos con ingresos".
    videos_with_revenue: videoRpm.length,
    total_revenue: Number(videoRpm.reduce((a, v) => a + v.revenue, 0).toFixed(2)),
    channel_rpm: (() => {
      const rev = videoRpm.reduce((a, v) => a + v.revenue, 0);
      const views = videoRpm.reduce((a, v) => a + v.views, 0);
      return views > 0 ? Number(((rev / views) * 1000).toFixed(2)) : null;
    })(),
    by_duration: byDuration,
    by_country_latam: byCountry.map((c) => ({
      country: c.country_code, revenue: Number(c.revenue), cpm: c.cpm ? Number(c.cpm) : null,
      monetized_playbacks: Number(c.mp),
    })),
    top_earners: videoRpm.slice(0, 15),
    under_monetized_long: underMonetized,
    recommendations: buildMonetizationRecs(byDuration, underMonetized.length),
  });
  log.info("monetización AdSense calculada");
}

function buildMonetizationRecs(byDuration: { bucket: string; avg_rpm: number | null; videos: number }[], underCount: number): string[] {
  const recs: string[] = [];
  const mid = byDuration.find((b) => b.bucket.includes("8-15m"));
  const short8 = byDuration.find((b) => b.bucket === "1-8m");
  if (short8 && mid && (mid.avg_rpm ?? 0) > (short8.avg_rpm ?? 0)) {
    recs.push("Los vídeos >8 min tienen mayor RPM: prioriza alargar contenidos de valor por encima de 8 min para habilitar mid-rolls.");
  }
  if (underCount > 0) {
    recs.push(`${underCount} vídeos largos están por debajo del RPM mediano: revisa la colocación manual de mid-rolls en picos de retención.`);
  }
  recs.push("Inserta mid-rolls en valles de abandono naturales (cambios de sección), no a intervalos fijos, para no romper retención.");
  recs.push("Refuerza tráfico desde países LATAM de mayor CPM con miniaturas/títulos localizados.");
  return recs;
}
