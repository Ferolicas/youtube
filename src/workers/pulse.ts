import cron from "node-cron";
import { env } from "@/config/env";
import { query } from "@/lib/db/pool";
import { createLogger } from "@/lib/utils/logger";
import { hasConnection } from "@/lib/auth/tokens";
import { getVideosByIds, getMyChannel } from "@/lib/youtube/data-api";
import { quotaSummary } from "@/lib/youtube/quota";
import { withJobLock } from "@/lib/jobs/lock";
import { notify } from "@/lib/alerts/notify";
import { renewSubscriptions } from "@/lib/websub/subscribe";
import { isMain } from "@/lib/utils/is-main";

const log = createLogger("worker:pulse");

/**
 * PULSO del catálogo: snapshot de statistics cada CRON_PULSE (default 30 min).
 * Coste: 1 unidad por cada 50 vídeos (~5-10u por pulso en un canal típico):
 * trivial frente a las 10.000 diarias. Habilita:
 *   - vistas/hora (VPH) por vídeo en tiempo casi real
 *   - detección de BREAKOUT (alerta Telegram/BD)
 *   - seguimiento fino de las primeras 48h de cada estreno
 * Una vez al día además: renovación WebSub + chequeo de cuota.
 */
export async function runPulse(): Promise<void> {
  if (!(await hasConnection())) {
    log.warn("sin conexión OAuth; pulso omitido");
    return;
  }
  const result = await withJobLock("pulse", async () => {
    const t0 = Date.now();

    // 1) snapshot de todos los vídeos propios
    const rows = await query<{ video_id: string }>(
      `SELECT video_id FROM videos WHERE channel_id IS NOT NULL`
    );
    const ids = rows.map((r) => r.video_id);
    if (ids.length === 0) {
      log.info("sin vídeos en catálogo; pulso vacío");
      return;
    }
    const videos = await getVideosByIds(ids);
    for (const v of videos) {
      await query(
        `INSERT INTO video_stats_snapshot (video_id, captured_at, view_count, like_count, comment_count, favorite_count)
         VALUES ($1, now(), $2,$3,$4,$5)
         ON CONFLICT (video_id, captured_at) DO NOTHING`,
        [
          v.id,
          v.statistics?.viewCount ? Number(v.statistics.viewCount) : null,
          v.statistics?.likeCount ? Number(v.statistics.likeCount) : null,
          v.statistics?.commentCount ? Number(v.statistics.commentCount) : null,
          v.statistics?.favoriteCount ? Number(v.statistics.favoriteCount) : null,
        ]
      );
    }

    // 2) subs del canal en vivo (1u)
    try {
      const ch = await getMyChannel();
      if (ch?.statistics) {
        await query(
          `UPDATE channels SET subscriber_count=$2, view_count=$3, video_count=$4, fetched_at=now()
           WHERE channel_id=$1`,
          [
            ch.id,
            ch.statistics.subscriberCount ? Number(ch.statistics.subscriberCount) : null,
            ch.statistics.viewCount ? Number(ch.statistics.viewCount) : null,
            ch.statistics.videoCount ? Number(ch.statistics.videoCount) : null,
          ]
        );
      }
    } catch (e) {
      log.warn(`refresh canal: ${String(e).slice(0, 160)}`);
    }

    // 3) breakout: ganancia de la última hora vs ritmo mediano 7d
    await detectBreakouts();

    // 4) housekeeping diario (solo en el primer pulso después de las 08:00)
    const hour = Number(
      new Intl.DateTimeFormat("en-US", { hour: "2-digit", hour12: false, timeZone: env.TZ })
        .format(new Date())
    );
    const minute = new Date().getMinutes();
    if (hour === 8 && minute < 35) {
      await renewSubscriptions().catch((e) => log.warn(`websub renew: ${String(e)}`));
      await checkQuotaAlert().catch(() => undefined);
    }

    log.info(`pulso OK: ${videos.length} vídeos en ${Math.round((Date.now() - t0) / 1000)}s`);
  });
  if (result === "busy") log.warn("pulso omitido: ya hay un pulso en curso");
}

/**
 * Breakout = en ~1h el vídeo ganó >= BREAKOUT_MIN_GAIN vistas Y >= BREAKOUT_FACTOR ×
 * su ritmo horario de los últimos 7 días. Dedupe 24h por vídeo.
 */
async function detectBreakouts(): Promise<void> {
  const rows = await query<{
    video_id: string; title: string | null; gain_1h: string; hours_1h: string; rate_7d: string;
  }>(`
    WITH latest AS (
      SELECT DISTINCT ON (video_id) video_id, captured_at, view_count
      FROM video_stats_snapshot ORDER BY video_id, captured_at DESC
    ),
    hour_ago AS (
      SELECT DISTINCT ON (s.video_id) s.video_id, s.captured_at, s.view_count
      FROM video_stats_snapshot s
      WHERE s.captured_at <= now() - interval '45 minutes'
        AND s.captured_at >= now() - interval '3 hours'
      ORDER BY s.video_id, s.captured_at DESC
    ),
    week_ago AS (
      SELECT DISTINCT ON (s.video_id) s.video_id, s.captured_at, s.view_count
      FROM video_stats_snapshot s
      WHERE s.captured_at <= now() - interval '6 days'
        AND s.captured_at >= now() - interval '9 days'
      ORDER BY s.video_id, s.captured_at DESC
    )
    SELECT v.video_id, v.title,
           (l.view_count - h.view_count)::text AS gain_1h,
           (EXTRACT(EPOCH FROM (l.captured_at - h.captured_at)) / 3600)::text AS hours_1h,
           (CASE WHEN w.view_count IS NOT NULL AND l.captured_at > w.captured_at
                 THEN (l.view_count - w.view_count)
                      / NULLIF(EXTRACT(EPOCH FROM (l.captured_at - w.captured_at)) / 3600, 0)
                 ELSE NULL END)::text AS rate_7d
    FROM videos v
    JOIN latest l ON l.video_id = v.video_id
    JOIN hour_ago h ON h.video_id = v.video_id
    LEFT JOIN week_ago w ON w.video_id = v.video_id
    WHERE v.channel_id IS NOT NULL
      AND l.view_count IS NOT NULL AND h.view_count IS NOT NULL
      AND l.view_count > h.view_count
  `);

  for (const r of rows) {
    const hours = Math.max(0.25, Number(r.hours_1h) || 1);
    const vph = (Number(r.gain_1h) || 0) / hours;
    const base = Number(r.rate_7d) || 0;
    const factorOk = base > 0 ? vph >= base * env.BREAKOUT_FACTOR : vph >= env.BREAKOUT_MIN_GAIN;
    if (vph >= env.BREAKOUT_MIN_GAIN && factorOk) {
      await notify({
        kind: "breakout",
        title: `🚀 Breakout: "${r.title ?? r.video_id}"`,
        detail: `${Math.round(vph)} vistas/hora (ritmo 7d: ${Math.round(base)}/h). Considera apoyarlo: comparte, fija comentario, revisa mid-rolls.`,
        payload: { video_id: r.video_id, vph: Math.round(vph), base_7d: Math.round(base) },
        dedupeKey: `breakout:${r.video_id}`,
        dedupeHours: 24,
      });
    }
  }
}

/** Alerta (1×/día) si alguna API supera el 80% de su cuota diaria. */
async function checkQuotaAlert(): Promise<void> {
  const summary = await quotaSummary();
  for (const [api, q] of Object.entries(summary)) {
    if (q.limit > 0 && q.used / q.limit >= 0.8) {
      await notify({
        kind: "quota",
        title: `Cuota '${api}' al ${Math.round((q.used / q.limit) * 100)}%`,
        detail: `${q.used}/${q.limit} unidades usadas hoy.`,
        dedupeKey: `quota:${api}:${new Date().toISOString().slice(0, 10)}`,
        dedupeHours: 24,
      });
    }
  }
}

if (isMain(import.meta.url)) {
  if (process.argv.includes("--once")) {
    runPulse().then(() => process.exit(0)).catch((e) => {
      log.error("pulso falló", String(e));
      process.exit(1);
    });
  } else {
    log.info(`worker pulse activo. Cron: '${env.CRON_PULSE}' TZ=${env.TZ}`);
    cron.schedule(env.CRON_PULSE, () => { void runPulse(); }, { timezone: env.TZ });
  }
}
