/**
 * reclassify:shorts — Re-clasifica is_short de TODOS los vídeos ya ingestados usando
 * el método autoritativo /shorts/{id} (200=Short, 303→/watch=largo), SIN re-sync completo.
 * No vuelve a llamar a la API de YouTube Data: solo resuelve la URL pública de cada vídeo.
 *
 *   npm run reclassify:shorts
 */
import { query } from "@/lib/db/pool";
import { detectShort } from "@/lib/youtube/shorts";
import { sleep } from "@/lib/youtube/rate-limiter";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("reclassify:shorts");

async function counts(): Promise<{ longs: number; shorts: number; indet: number; total: number }> {
  const r = await query<{ longs: string; shorts: string; indet: string; total: string }>(`
    SELECT
      count(*) FILTER (WHERE is_short = false)::text AS longs,
      count(*) FILTER (WHERE is_short = true)::text  AS shorts,
      count(*) FILTER (WHERE is_short IS NULL)::text  AS indet,
      count(*)::text AS total
    FROM videos
  `);
  const row = r[0];
  return {
    longs: Number(row?.longs ?? 0),
    shorts: Number(row?.shorts ?? 0),
    indet: Number(row?.indet ?? 0),
    total: Number(row?.total ?? 0),
  };
}

export async function reclassifyShorts(): Promise<void> {
  const before = await counts();
  log.info(`ANTES → largos=${before.longs} shorts=${before.shorts} indeterminados=${before.indet} (total ${before.total})`);

  const rows = await query<{ video_id: string; is_short: boolean | null }>(
    `SELECT video_id, is_short FROM videos ORDER BY published_at DESC NULLS LAST`
  );

  let changed = 0;
  let indeterminate = 0;
  let i = 0;
  for (const v of rows) {
    const { isShort, method } = await detectShort(v.video_id);
    if (isShort === null) {
      indeterminate++;
      // No sobreescribimos una clasificación previa válida con un fallo puntual.
      log.warn(`indeterminado (${method}); se conserva valor previo para ${v.video_id}`);
    } else {
      if (isShort !== v.is_short) changed++;
      await query(
        `UPDATE videos SET is_short=$2, short_detection_method=$3, updated_at=now() WHERE video_id=$1`,
        [v.video_id, isShort, method]
      );
    }
    if (++i % 25 === 0) log.info(`procesados ${i}/${rows.length}`);
    await sleep(120); // cortés con youtube.com
  }

  const after = await counts();
  log.info(`DESPUÉS → largos=${after.longs} shorts=${after.shorts} indeterminados=${after.indet} (total ${after.total})`);
  log.info(`reclasificación completa: ${changed} cambios, ${indeterminate} indeterminados (sin tocar)`);
  // Salida explícita del conteo final
  console.log(`\n=== CONTEO FINAL ===`);
  console.log(`Largos:          ${after.longs}`);
  console.log(`Shorts:          ${after.shorts}`);
  console.log(`Indeterminados:  ${after.indet}`);
  console.log(`Total:           ${after.total}`);
  console.log(`Cambios aplicados: ${changed}`);
}

reclassifyShorts()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    log.error("reclassify falló", String(e));
    process.exit(1);
  });
