import { query } from "@/lib/db/pool";
import { env } from "@/config/env";
import { createLogger } from "@/lib/utils/logger";
import { isoDurationToSeconds } from "@/lib/utils/duration";
import {
  getChannelsByIds,
  getVideosByIds,
  listRecentUploads,
} from "@/lib/youtube/data-api";

const log = createLogger("trends:radar");

/**
 * Radar de competidores 2.0: en vez de pagar 100u por search.list a diario,
 * sigue los canales YA conocidos por su playlist de uploads (1u por canal):
 *  1) adopta canales nuevos detectados por search en competitor_channels
 *  2) hidrata sus stats (1u/50) -> velocidad de subs/vistas (serie diaria)
 *  3) revisa los últimos uploads de los top N -> nuevos vídeos a competitor_videos
 * El search.list queda solo para DESCUBRIR canales (1 día/semana).
 */
export async function runCompetitorRadar(): Promise<{ channels: number; newVideos: number }> {
  // 1) adopción: channel_ids vistos por search que aún no están en el radar
  await query(`
    INSERT INTO competitor_channels (channel_id, title, source)
    SELECT DISTINCT cv.channel_id, MAX(cv.channel_title), 'search'
    FROM competitor_videos cv
    WHERE cv.channel_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM competitor_channels cc WHERE cc.channel_id = cv.channel_id)
      AND NOT EXISTS (SELECT 1 FROM channels c WHERE c.channel_id = cv.channel_id)
    GROUP BY cv.channel_id
  `);

  // 2) hidratar stats de los top N activos (por subs; los nuevos sin stats van primero)
  const tracked = await query<{ channel_id: string }>(
    `SELECT channel_id FROM competitor_channels
     WHERE active
     ORDER BY (subscriber_count IS NULL) DESC, subscriber_count DESC NULLS LAST
     LIMIT $1`,
    [env.COMPETITOR_RADAR_SIZE]
  );
  if (tracked.length === 0) {
    log.info("radar vacío: aún no hay canales competidores (corre el discovery por search)");
    return { channels: 0, newVideos: 0 };
  }

  const channels = await getChannelsByIds(tracked.map((t) => t.channel_id));
  const today = new Date().toISOString().slice(0, 10);
  for (const ch of channels) {
    const subs = ch.statistics?.subscriberCount ? Number(ch.statistics.subscriberCount) : null;
    const views = ch.statistics?.viewCount ? Number(ch.statistics.viewCount) : null;
    const nvids = ch.statistics?.videoCount ? Number(ch.statistics.videoCount) : null;
    await query(
      `UPDATE competitor_channels SET
         title=$2, uploads_playlist_id=$3, subscriber_count=$4, video_count=$5,
         view_count=$6, country=$7, last_checked=now()
       WHERE channel_id=$1`,
      [
        ch.id, ch.snippet?.title ?? null,
        ch.contentDetails?.relatedPlaylists?.uploads ?? null,
        subs, nvids, views, ch.snippet?.country ?? null,
      ]
    );
    await query(
      `INSERT INTO competitor_channel_stats_daily (channel_id, date, subscribers, views, videos)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (channel_id, date) DO UPDATE SET
         subscribers=EXCLUDED.subscribers, views=EXCLUDED.views, videos=EXCLUDED.videos`,
      [ch.id, today, subs, views, nvids]
    );
  }

  // 3) últimos uploads de cada canal seguido (1u por canal)
  const uploads = await query<{ channel_id: string; uploads_playlist_id: string }>(
    `SELECT channel_id, uploads_playlist_id FROM competitor_channels
     WHERE active AND uploads_playlist_id IS NOT NULL
     ORDER BY subscriber_count DESC NULLS LAST LIMIT $1`,
    [env.COMPETITOR_RADAR_SIZE]
  );
  const candidateIds: string[] = [];
  for (const u of uploads) {
    try {
      const ids = await listRecentUploads(u.uploads_playlist_id, 5);
      candidateIds.push(...ids);
    } catch (e) {
      log.warn(`uploads ${u.channel_id}: ${String(e).slice(0, 160)}`);
    }
  }

  // solo los que no conocemos aún
  const known = await query<{ video_id: string }>(
    `SELECT video_id FROM competitor_videos WHERE video_id = ANY($1::text[])`,
    [candidateIds]
  );
  const knownSet = new Set(known.map((k) => k.video_id));
  const newIds = [...new Set(candidateIds)].filter((id) => !knownSet.has(id));

  let newVideos = 0;
  if (newIds.length > 0) {
    const videos = await getVideosByIds(newIds);
    for (const v of videos) {
      const views = Number(v.statistics?.viewCount ?? 0);
      const published = v.snippet?.publishedAt;
      const hours = published ? Math.max(1, (Date.now() - new Date(published).getTime()) / 3_600_000) : 1;
      const dur = isoDurationToSeconds(v.contentDetails?.duration);
      await query(
        `INSERT INTO competitor_videos (video_id, channel_id, channel_title, title, description,
           view_count, like_count, comment_count, duration_seconds, is_short, published_at, region, vph, captured_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,$12, now())
         ON CONFLICT (video_id) DO UPDATE SET view_count=EXCLUDED.view_count,
           like_count=EXCLUDED.like_count, comment_count=EXCLUDED.comment_count,
           vph=EXCLUDED.vph, captured_at=now()`,
        [
          v.id, v.snippet?.channelId ?? null, v.snippet?.channelTitle ?? null,
          v.snippet?.title ?? null, (v.snippet?.description ?? "").slice(0, 1000),
          views, Number(v.statistics?.likeCount ?? 0), Number(v.statistics?.commentCount ?? 0),
          dur, dur !== null && dur <= 180, published ?? null,
          Number((views / hours).toFixed(1)),
        ]
      );
      newVideos++;
    }
  }

  log.info(`radar: ${channels.length} canales actualizados, ${newVideos} vídeos nuevos`);
  return { channels: channels.length, newVideos };
}
