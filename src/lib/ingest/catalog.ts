import { query, withTransaction } from "@/lib/db/pool";
import { createLogger } from "@/lib/utils/logger";
import { isoDurationToSeconds } from "@/lib/utils/duration";
import { detectShort } from "@/lib/youtube/shorts";
import {
  getMyChannel,
  listAllUploadIds,
  getVideosByIds,
  listPlaylists,
  listChannelSections,
} from "@/lib/youtube/data-api";
import type { YtVideo } from "@/types/youtube";

const log = createLogger("ingest:catalog");

/** Upsert del canal + branding/keywords. Devuelve channelId y uploads playlist. */
export async function ingestChannel(): Promise<{
  channelId: string;
  uploadsPlaylistId: string;
}> {
  const ch = await getMyChannel();
  if (!ch) throw new Error("No se pudo obtener el canal (¿OAuth válido?).");

  const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) throw new Error("Canal sin playlist de uploads.");

  await query(
    `INSERT INTO channels (channel_id, title, description, custom_url, published_at,
       country, default_language, keywords, topic_ids, uploads_playlist_id, thumbnails,
       subscriber_count, view_count, video_count, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
     ON CONFLICT (channel_id) DO UPDATE SET
       title=EXCLUDED.title, description=EXCLUDED.description, custom_url=EXCLUDED.custom_url,
       country=EXCLUDED.country, default_language=EXCLUDED.default_language,
       keywords=EXCLUDED.keywords, topic_ids=EXCLUDED.topic_ids,
       uploads_playlist_id=EXCLUDED.uploads_playlist_id, thumbnails=EXCLUDED.thumbnails,
       subscriber_count=EXCLUDED.subscriber_count, view_count=EXCLUDED.view_count,
       video_count=EXCLUDED.video_count, fetched_at=now()`,
    [
      ch.id,
      ch.snippet?.title ?? null,
      ch.snippet?.description ?? null,
      ch.snippet?.customUrl ?? null,
      ch.snippet?.publishedAt ?? null,
      ch.snippet?.country ?? null,
      ch.brandingSettings?.channel?.defaultLanguage ?? ch.snippet?.defaultLanguage ?? null,
      ch.brandingSettings?.channel?.keywords ?? null,
      ch.topicDetails?.topicIds ?? null,
      uploads,
      ch.snippet?.thumbnails ?? null,
      ch.statistics?.subscriberCount ? Number(ch.statistics.subscriberCount) : null,
      ch.statistics?.viewCount ? Number(ch.statistics.viewCount) : null,
      ch.statistics?.videoCount ? Number(ch.statistics.videoCount) : null,
    ]
  );
  log.info(`canal '${ch.snippet?.title}' (${ch.id}) actualizado`);
  return { channelId: ch.id, uploadsPlaylistId: uploads };
}

export async function upsertVideo(channelId: string, v: YtVideo): Promise<void> {
  const durationSec = isoDurationToSeconds(v.contentDetails?.duration);
  const { isShort, method } = await detectShort(v.id);

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO videos (video_id, channel_id, title, description, published_at,
         duration_seconds, is_short, short_detection_method, category_id,
         default_language, default_audio_language, definition, dimension,
         caption_available, licensed_content, made_for_kids, privacy_status,
         thumbnails, topic_ids, fetched_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19, now(), now())
       ON CONFLICT (video_id) DO UPDATE SET
         title=EXCLUDED.title, description=EXCLUDED.description,
         duration_seconds=EXCLUDED.duration_seconds, is_short=EXCLUDED.is_short,
         short_detection_method=EXCLUDED.short_detection_method,
         category_id=EXCLUDED.category_id, default_language=EXCLUDED.default_language,
         default_audio_language=EXCLUDED.default_audio_language,
         definition=EXCLUDED.definition, dimension=EXCLUDED.dimension,
         caption_available=EXCLUDED.caption_available, licensed_content=EXCLUDED.licensed_content,
         made_for_kids=EXCLUDED.made_for_kids, privacy_status=EXCLUDED.privacy_status,
         thumbnails=EXCLUDED.thumbnails, topic_ids=EXCLUDED.topic_ids, updated_at=now()`,
      [
        v.id,
        channelId,
        v.snippet?.title ?? null,
        v.snippet?.description ?? null,
        v.snippet?.publishedAt ?? null,
        durationSec,
        isShort,
        method,
        v.snippet?.categoryId ?? null,
        v.snippet?.defaultLanguage ?? null,
        v.snippet?.defaultAudioLanguage ?? null,
        v.contentDetails?.definition ?? null,
        v.contentDetails?.dimension ?? null,
        v.contentDetails?.caption === "true",
        v.contentDetails?.licensedContent ?? null,
        v.status?.madeForKids ?? null,
        v.status?.privacyStatus ?? null,
        v.snippet?.thumbnails ?? null,
        v.topicDetails?.topicIds ?? null,
      ]
    );

    // tags
    await client.query(`DELETE FROM video_tags WHERE video_id = $1`, [v.id]);
    const tags = v.snippet?.tags ?? [];
    for (let i = 0; i < tags.length; i++) {
      await client.query(
        `INSERT INTO video_tags (video_id, tag, position) VALUES ($1,$2,$3)
         ON CONFLICT DO NOTHING`,
        [v.id, tags[i], i]
      );
    }

    // snapshot acumulado de statistics
    await client.query(
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

    // encolar transcripción si es nuevo
    await client.query(
      `INSERT INTO transcription_queue (video_id, status) VALUES ($1, 'pending')
       ON CONFLICT (video_id) DO NOTHING`,
      [v.id]
    );
  });
}

/** Ingesta del catálogo completo de vídeos + listas + secciones. */
export async function ingestCatalog(): Promise<{ total: number }> {
  const { channelId, uploadsPlaylistId } = await ingestChannel();
  const ids = await listAllUploadIds(uploadsPlaylistId);
  log.info(`${ids.length} vídeos en el canal`);

  const videos = await getVideosByIds(ids);
  let n = 0;
  for (const v of videos) {
    await upsertVideo(channelId, v);
    n++;
    if (n % 25 === 0) log.info(`procesados ${n}/${videos.length}`);
  }

  // Reconciliación: vídeos que están en la BD (p. ej. creados por el import de
  // Studio sin channel_id) pero que la enumeración de uploads NO devuelve. Se
  // repescan por ID con videos.list y, SOLO si son del propio canal, se adoptan
  // (rellena channel_id, título, privacy_status, is_short...). Los ajenos se dejan
  // para el comando `reconcile` (no se borra nada aquí).
  const known = await query<{ video_id: string }>(`SELECT video_id FROM videos`);
  const uploadSet = new Set(ids);
  const orphanIds = known.map((r) => r.video_id).filter((id) => !uploadSet.has(id));
  if (orphanIds.length > 0) {
    const refetched = await getVideosByIds(orphanIds);
    const returned = new Set(refetched.map((v) => v.id));
    let adopted = 0;
    let foreign = 0;
    for (const v of refetched) {
      if (v.snippet?.channelId === channelId) {
        await upsertVideo(channelId, v);
        adopted++;
      } else {
        foreign++;
      }
    }
    const missing = orphanIds.filter((id) => !returned.has(id)).length;
    n += adopted;
    log.info(`reconciliación: ${orphanIds.length} huérfanos -> adoptados ${adopted}, ajenos ${foreign}, no encontrados ${missing}`);
  }

  // listas y secciones
  const playlists = await listPlaylists(channelId);
  for (const p of playlists) {
    await query(
      `INSERT INTO playlists (playlist_id, channel_id, title, description, item_count, fetched_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (playlist_id) DO UPDATE SET title=EXCLUDED.title,
         description=EXCLUDED.description, item_count=EXCLUDED.item_count, fetched_at=now()`,
      [p.id, channelId, p.title ?? null, p.description ?? null, p.itemCount ?? null]
    );
  }
  const sections = await listChannelSections(channelId);
  for (const s of sections) {
    await query(
      `INSERT INTO channel_sections (section_id, channel_id, type, style, position, content)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (section_id) DO UPDATE SET type=EXCLUDED.type, style=EXCLUDED.style,
         position=EXCLUDED.position, content=EXCLUDED.content`,
      [
        s.id,
        channelId,
        s.snippet?.type ?? null,
        s.snippet?.style ?? null,
        s.snippet?.position ?? null,
        s.contentDetails ?? null,
      ]
    );
  }

  log.info(`catálogo completo: ${n} vídeos, ${playlists.length} listas, ${sections.length} secciones`);
  return { total: n };
}
