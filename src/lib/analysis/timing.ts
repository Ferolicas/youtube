import { query } from "@/lib/db/pool";
import { env } from "@/config/env";
import { saveSnapshot } from "@/lib/analysis/queries";
import { mean, median } from "@/lib/analysis/stats";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("analysis:timing");
const WEEKDAYS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];

/** Hora y día de la semana en la TZ del canal (env.TZ), no UTC. */
function localHourWeekday(iso: string): { hour: number; weekday: number } {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: env.TZ, hour12: false, hour: "2-digit", weekday: "short",
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const wdShort = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wdShort);
  return { hour, weekday: weekday < 0 ? 0 : weekday };
}

/**
 * Horas/días óptimos de publicación DERIVADOS DE TUS DATOS (no mitos):
 * cruza la hora/día de publicación de cada vídeo (en TZ del canal) con su
 * rendimiento temprano (vistas 0-48h vía serie diaria). Nota honesta: la API
 * no expone "cuándo están online tus suscriptores"; esto usa rendimiento real
 * por franja. Los vídeos sin serie temprana usan vistas de vida (marcado).
 */
export async function computeTiming() {
  const rows = await query<{
    video_id: string; published_at: string; is_short: boolean; views: number; early: number;
  }>(`
    WITH early AS (
      SELECT d.video_id, SUM(d.views) AS early_views
      FROM video_stats_daily d JOIN videos v ON v.video_id=d.video_id
      WHERE d.date <= (v.published_at::date + interval '2 day')
      GROUP BY d.video_id
    ),
    snap AS (
      SELECT DISTINCT ON (video_id) video_id, view_count FROM video_stats_snapshot
      ORDER BY video_id, captured_at DESC
    )
    SELECT v.video_id, v.published_at::text, v.is_short,
           COALESCE(snap.view_count,0)::float AS views,
           COALESCE(early.early_views,0)::float AS early
    FROM videos v
    LEFT JOIN snap ON snap.video_id=v.video_id
    LEFT JOIN early ON early.video_id=v.video_id
    WHERE v.published_at IS NOT NULL AND v.channel_id IS NOT NULL
  `);

  for (const fmt of ["long", "short"] as const) {
    const isShort = fmt === "short";
    const vids = rows.filter((r) => r.is_short === isShort && r.published_at);
    if (vids.length === 0) continue;

    const byHour = new Map<number, number[]>();
    const byWeekday = new Map<number, number[]>();
    let lifetimeFallbacks = 0;
    for (const v of vids) {
      const { hour, weekday } = localHourWeekday(v.published_at);
      const score = v.early > 0 ? v.early : v.views;
      if (v.early <= 0) lifetimeFallbacks++;
      (byHour.get(hour) ?? byHour.set(hour, []).get(hour)!).push(score);
      (byWeekday.get(weekday) ?? byWeekday.set(weekday, []).get(weekday)!).push(score);
    }

    const hours = [...byHour.entries()]
      .map(([h, xs]) => ({ hour_local: h, n: xs.length, median_score: Math.round(median(xs)), avg_score: Math.round(mean(xs)) }))
      .sort((a, b) => b.median_score - a.median_score);
    const weekdays = [...byWeekday.entries()]
      .map(([wd, xs]) => ({ weekday: WEEKDAYS[wd], idx: wd, n: xs.length, median_score: Math.round(median(xs)) }))
      .sort((a, b) => b.median_score - a.median_score);

    await saveSnapshot("timing", fmt, {
      note: `Derivado del rendimiento real por franja (vistas tempranas 0-48h). Horas en ${env.TZ}. ${lifetimeFallbacks} vídeos sin serie temprana usan vistas de vida (sesgo a favor de vídeos viejos).`,
      timezone: env.TZ,
      best_hours_local: hours.slice(0, 5),
      best_weekdays: weekdays.slice(0, 3),
      all_hours: hours,
      all_weekdays: weekdays,
    });
  }
  log.info(`timing calculado (TZ=${env.TZ})`);
}
