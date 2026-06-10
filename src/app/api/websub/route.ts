import { NextResponse, type NextRequest } from "next/server";
import { query, queryOne } from "@/lib/db/pool";
import { verifySignature } from "@/lib/websub/subscribe";
import { getVideosByIds } from "@/lib/youtube/data-api";
import { upsertVideo } from "@/lib/ingest/catalog";
import { isoDurationToSeconds } from "@/lib/utils/duration";
import { notify } from "@/lib/alerts/notify";
import { createLogger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";
const log = createLogger("websub:endpoint");

/**
 * Verificación de suscripción del hub (hub.challenge). Pública (sin sesión):
 * Google la llama al suscribir/renovar. Solo confirmamos topics de YouTube.
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const mode = p.get("hub.mode");
  const topic = p.get("hub.topic") ?? "";
  const challenge = p.get("hub.challenge");
  if (!challenge || !topic.startsWith("https://www.youtube.com/xml/feeds/videos.xml")) {
    return new NextResponse("bad request", { status: 400 });
  }
  log.info(`hub verify: ${mode} ${topic.slice(0, 120)}`);
  return new NextResponse(challenge, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

/**
 * Notificación push: YouTube envía Atom XML cuando un canal suscrito publica
 * (o actualiza) un vídeo. Verificamos HMAC y hacemos ingesta dirigida:
 *  - canal propio  -> upsert completo + alerta "nuevo vídeo"
 *  - competidor    -> alta en competitor_videos + alerta
 */
export async function POST(req: NextRequest) {
  const body = Buffer.from(await req.arrayBuffer());
  const sig = req.headers.get("x-hub-signature");
  if (!verifySignature(body, sig)) {
    log.warn("notificación con firma inválida; descartada");
    // 2xx igualmente para que el hub no reintente en bucle
    return new NextResponse(null, { status: 204 });
  }

  const xml = body.toString("utf8");
  const videoId = xml.match(/<yt:videoId>([\w-]{11})<\/yt:videoId>/)?.[1];
  const channelId = xml.match(/<yt:channelId>([\w-]+)<\/yt:channelId>/)?.[1];
  const title = xml.match(/<title>([^<]+)<\/title>/g)?.slice(-1)[0]?.replace(/<\/?title>/g, "") ?? "";
  if (!videoId || !channelId) {
    // notificaciones de borrado (<at:deleted-entry>) u otros: ignorar
    return new NextResponse(null, { status: 204 });
  }

  try {
    await query(
      `UPDATE websub_subscriptions SET last_notification=now() WHERE channel_id=$1`,
      [channelId]
    );

    const own = await queryOne<{ channel_id: string }>(`SELECT channel_id FROM channels LIMIT 1`);
    const isOwn = own?.channel_id === channelId;

    if (isOwn) {
      const known = await queryOne(`SELECT 1 FROM videos WHERE video_id=$1`, [videoId]);
      const [v] = await getVideosByIds([videoId]);
      if (v) await upsertVideo(channelId, v);
      if (!known) {
        await notify({
          kind: "new_video",
          title: `Nuevo vídeo publicado: ${title || videoId}`,
          detail: "Ingesta dirigida hecha; el pulso seguirá sus primeras 48h.",
          payload: { video_id: videoId },
          dedupeKey: `own:${videoId}`,
        });
      }
    } else {
      const [v] = await getVideosByIds([videoId]);
      if (v) {
        const dur = isoDurationToSeconds(v.contentDetails?.duration);
        await query(
          `INSERT INTO competitor_videos (video_id, channel_id, channel_title, title, description,
             view_count, like_count, comment_count, duration_seconds, is_short, published_at, region, vph, captured_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,NULL, now())
           ON CONFLICT (video_id) DO UPDATE SET view_count=EXCLUDED.view_count, captured_at=now()`,
          [
            v.id, channelId, v.snippet?.channelTitle ?? null, v.snippet?.title ?? null,
            (v.snippet?.description ?? "").slice(0, 1000),
            Number(v.statistics?.viewCount ?? 0), Number(v.statistics?.likeCount ?? 0),
            Number(v.statistics?.commentCount ?? 0), dur, dur !== null && dur <= 180,
            v.snippet?.publishedAt ?? null,
          ]
        );
        await notify({
          kind: "competitor_video",
          title: `Competidor publicó: ${v.snippet?.channelTitle ?? channelId}`,
          detail: v.snippet?.title ?? videoId,
          payload: { video_id: videoId, channel_id: channelId },
          dedupeKey: `comp:${videoId}`,
        });
      }
    }
  } catch (e) {
    log.error(`procesando notificación ${videoId}: ${String(e)}`);
  }
  return new NextResponse(null, { status: 204 });
}
