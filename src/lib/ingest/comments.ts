import { query, queryOne } from "@/lib/db/pool";
import { createLogger } from "@/lib/utils/logger";
import { listCommentThreads } from "@/lib/youtube/data-api";
import { longOnlySql } from "@/lib/analysis/scope";

const log = createLogger("ingest:comments");

/**
 * Minería de comentarios propios (1 unidad/página de 100): la voz literal de la
 * audiencia. Incremental: solo pide comentarios de vídeos cuyo comment_count del
 * último snapshot supera lo que ya tenemos guardado; corta en cuanto la página
 * llega a comentarios ya conocidos (order=time -> de nuevo a viejo).
 */
export async function ingestAllComments(): Promise<number> {
  const rows = await query<{ video_id: string; api_comments: string; stored: string; newest: string | null }>(`
    WITH snap AS (
      SELECT DISTINCT ON (video_id) video_id, comment_count
      FROM video_stats_snapshot ORDER BY video_id, captured_at DESC
    ),
    stored AS (
      SELECT video_id, count(*) AS n, MAX(published_at) AS newest
      FROM video_comments GROUP BY video_id
    )
    SELECT v.video_id,
           COALESCE(snap.comment_count, 0)::text AS api_comments,
           COALESCE(stored.n, 0)::text AS stored,
           stored.newest::text AS newest
    FROM videos v
    LEFT JOIN snap ON snap.video_id = v.video_id
    LEFT JOIN stored ON stored.video_id = v.video_id
    WHERE ${longOnlySql("v")}
      AND COALESCE(snap.comment_count, 0) > COALESCE(stored.n, 0)
    ORDER BY COALESCE(snap.comment_count, 0) - COALESCE(stored.n, 0) DESC
    LIMIT 100
  `);

  let total = 0;
  for (const r of rows) {
    try {
      const newest = r.newest ? new Date(r.newest).getTime() : 0;
      // primera carga: hasta 3 páginas (300 comentarios); incremental: 1-2
      const maxPages = Number(r.stored) === 0 ? 3 : 2;
      const threads = await listCommentThreads(r.video_id, { maxPages, order: "time" });
      let inserted = 0;
      for (const t of threads) {
        const s = t.snippet?.topLevelComment?.snippet;
        const publishedAt = s?.publishedAt ?? null;
        // si ya llegamos a comentarios conocidos, los upserts siguientes serán no-ops;
        // no cortamos el bucle (los likes/replies se actualizan), pero sí evitamos
        // contar como nuevos los ya vistos.
        const res = await query<{ inserted: boolean }>(
          `INSERT INTO video_comments (comment_id, video_id, author, text, like_count, reply_count, published_at, fetched_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7, now())
           ON CONFLICT (comment_id) DO UPDATE SET
             like_count=EXCLUDED.like_count, reply_count=EXCLUDED.reply_count, fetched_at=now()
           RETURNING (xmax = 0) AS inserted`,
          [
            t.id,
            r.video_id,
            (s?.authorDisplayName ?? "").slice(0, 200),
            (s?.textOriginal ?? s?.textDisplay ?? "").slice(0, 4000),
            s?.likeCount ?? 0,
            t.snippet?.totalReplyCount ?? 0,
            publishedAt,
          ]
        );
        if (res[0]?.inserted) inserted++;
        if (publishedAt && new Date(publishedAt).getTime() <= newest) {
          // página ya solapa con lo guardado: suficiente para este vídeo
          break;
        }
      }
      total += inserted;
    } catch (e) {
      // comentarios desactivados en el vídeo -> 403; esperado, no es error
      const msg = String(e);
      if (msg.includes("commentsDisabled") || msg.includes("403")) {
        log.info(`comentarios desactivados/limitados en ${r.video_id}`);
      } else {
        log.warn(`comments ${r.video_id}: ${msg.slice(0, 200)}`);
      }
    }
  }
  log.info(`comentarios: ${total} hilos procesados en ${rows.length} vídeos`);
  return total;
}

/** ¿Hay algún comentario guardado? (para diagnósticos de UI) */
export async function hasComments(): Promise<boolean> {
  const r = await queryOne(`SELECT 1 FROM video_comments LIMIT 1`);
  return r !== null;
}
