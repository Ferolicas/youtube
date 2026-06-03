import { query } from "@/lib/db/pool";
import { saveSnapshot } from "@/lib/analysis/queries";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("analysis:audience");

const LATAM = [
  "MX", "CO", "AR", "PE", "CL", "EC", "VE", "GT", "BO", "DO",
  "HN", "PY", "SV", "NI", "CR", "PA", "UY", "PR", "ES",
];

/** Perfil de audiencia separando vídeos largos vs Shorts. */
export async function computeAudience() {
  for (const fmt of ["long", "short"] as const) {
    const isShort = fmt === "short";

    const geography = await query<{ country_code: string; views: string; emw: string }>(
      `SELECT g.country_code, SUM(g.views)::text AS views, SUM(g.estimated_minutes_watched)::text AS emw
       FROM video_geography g JOIN videos v ON v.video_id=g.video_id
       WHERE v.is_short=$1 GROUP BY g.country_code ORDER BY SUM(g.views) DESC LIMIT 30`,
      [isShort]
    );

    const demographics = await query<{ age_group: string; gender: string; pct: string }>(
      `SELECT d.age_group, d.gender, AVG(d.viewer_percentage)::numeric(6,2)::text AS pct
       FROM video_demographics d JOIN videos v ON v.video_id=d.video_id
       WHERE v.is_short=$1 GROUP BY d.age_group, d.gender ORDER BY AVG(d.viewer_percentage) DESC`,
      [isShort]
    );

    const devices = await query<{ device_type: string; views: string }>(
      `SELECT dv.device_type, SUM(dv.views)::text AS views
       FROM video_devices dv JOIN videos v ON v.video_id=dv.video_id
       WHERE v.is_short=$1 GROUP BY dv.device_type ORDER BY SUM(dv.views) DESC`,
      [isShort]
    );

    const traffic = await query<{ source_type: string; views: string }>(
      `SELECT ts.source_type, SUM(ts.views)::text AS views
       FROM video_traffic_sources ts JOIN videos v ON v.video_id=ts.video_id
       WHERE v.is_short=$1 GROUP BY ts.source_type ORDER BY SUM(ts.views) DESC`,
      [isShort]
    );

    const retention = await query<{ avg_ret: string | null; n: string }>(
      `SELECT AVG(d.average_view_percentage)::numeric(6,2)::text AS avg_ret, count(DISTINCT v.video_id)::text AS n
       FROM videos v JOIN video_stats_daily d ON d.video_id=v.video_id
       WHERE v.is_short=$1`,
      [isShort]
    );

    const totalGeoViews = geography.reduce((a, r) => a + Number(r.views), 0) || 1;
    const latamShare = geography
      .filter((r) => LATAM.includes(r.country_code))
      .reduce((a, r) => a + Number(r.views), 0) / totalGeoViews;

    await saveSnapshot("audience", fmt, {
      format: fmt,
      latam_share_pct: Number((latamShare * 100).toFixed(1)),
      top_countries: geography.map((r) => ({
        country: r.country_code, views: Number(r.views), is_latam: LATAM.includes(r.country_code),
      })),
      demographics: demographics.map((r) => ({ age: r.age_group, gender: r.gender, pct: Number(r.pct) })),
      devices: devices.map((r) => ({ device: r.device_type, views: Number(r.views) })),
      traffic_sources: traffic.map((r) => ({ source: r.source_type, views: Number(r.views) })),
      avg_retention_pct: retention[0]?.avg_ret ? Number(retention[0].avg_ret) : null,
      videos_with_data: Number(retention[0]?.n ?? 0),
    });
  }
  log.info("audiencia perfilada (long + short)");
}
