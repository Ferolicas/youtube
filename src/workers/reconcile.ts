/**
 * reconcile — adopta o limpia vídeos SIN dueño (channel_id NULL).
 *
 * Estos vídeos entran por el import de Studio (filas mínimas, sin channel_id) y
 * pueden ser tuyos (huérfanos que la enumeración de uploads no devuelve) o
 * fantasmas ajenos (p. ej. targets de tarjetas/pantallas finales). Para cada uno
 * se consulta videos.list:
 *   - propio (snippet.channelId === tu canal)  -> ADOPTAR (rellena metadatos).
 *   - ajeno  (otro canal)                       -> BORRAR (solo con --apply).
 *   - no encontrado (borrado/privado/ID inválido) -> se informa, NO se borra.
 *
 * Por defecto es DRY-RUN: solo informa. Con --apply ejecuta adopción + borrado.
 *
 *   npm run reconcile             # dry-run (no cambia nada)
 *   npm run reconcile -- --apply  # adopta los tuyos y borra los ajenos
 */
import { query, queryOne, pool } from "@/lib/db/pool";
import { createLogger } from "@/lib/utils/logger";
import { hasConnection } from "@/lib/auth/tokens";
import { getVideosByIds } from "@/lib/youtube/data-api";
import { upsertVideo } from "@/lib/ingest/catalog";

const log = createLogger("reconcile");

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  log.info(apply ? "modo APPLY: se adoptarán y borrarán filas" : "modo DRY-RUN: solo informa (usa --apply para ejecutar)");

  if (!(await hasConnection())) {
    log.error("sin conexión OAuth: conéctate en la web primero. Reconcile abortado.");
    process.exit(1);
  }

  const ch = await queryOne<{ channel_id: string }>(`SELECT channel_id FROM channels WHERE channel_id IS NOT NULL LIMIT 1`);
  if (!ch?.channel_id) {
    log.error("no hay canal en la BD; ejecuta un Sync primero.");
    process.exit(1);
  }
  const myChannelId = ch.channel_id;

  const ownerless = await query<{ video_id: string; title: string | null }>(
    `SELECT video_id, title FROM videos WHERE channel_id IS NULL`
  );
  if (ownerless.length === 0) {
    log.info("no hay vídeos sin channel_id. Nada que reconciliar.");
    return;
  }
  log.info(`vídeos sin channel_id: ${ownerless.length}`);

  const ids = ownerless.map((r) => r.video_id);
  const refetched = await getVideosByIds(ids);
  const byId = new Map(refetched.map((v) => [v.id, v]));

  const mine = refetched.filter((v) => v.snippet?.channelId === myChannelId);
  const foreign = refetched.filter((v) => v.snippet?.channelId && v.snippet.channelId !== myChannelId);
  const notFound = ownerless.filter((r) => !byId.has(r.video_id));

  // Informe
  log.info(`-> propios (adoptar): ${mine.length}`);
  for (const v of mine) log.info(`   + ${v.id}  "${v.snippet?.title ?? ""}"`);
  log.info(`-> ajenos (borrar): ${foreign.length}`);
  for (const v of foreign) log.info(`   - ${v.id}  "${v.snippet?.title ?? ""}"  [${v.snippet?.channelTitle ?? "?"}]`);
  log.info(`-> no encontrados (NO se borran; revísalos a mano): ${notFound.length}`);
  for (const r of notFound) log.info(`   ? ${r.video_id}  "${r.title ?? ""}"`);

  if (!apply) {
    log.info("DRY-RUN: no se ha cambiado nada. Repite con --apply para ejecutar.");
    return;
  }

  // Adoptar los propios (rellena channel_id + metadatos completos)
  let adopted = 0;
  for (const v of mine) {
    await upsertVideo(myChannelId, v);
    adopted++;
  }

  // Borrar los ajenos (ON DELETE CASCADE limpia filas dependientes)
  let deleted = 0;
  if (foreign.length > 0) {
    const res = await query<{ video_id: string }>(
      `DELETE FROM videos WHERE video_id = ANY($1::text[]) RETURNING video_id`,
      [foreign.map((v) => v.id)]
    );
    deleted = res.length;
  }

  log.info(`APPLY hecho: adoptados ${adopted}, borrados ${deleted}, no encontrados (intactos) ${notFound.length}`);
}

main()
  .catch((e) => {
    log.error("reconcile falló", String(e));
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
