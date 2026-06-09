import { queryOne } from "@/lib/db/pool";
import { env } from "@/config/env";
import type { Logger } from "@/lib/utils/logger";

/**
 * Guardia de base de datos: verifica que la BD a la que el pool está REALMENTE
 * conectado coincide con la declarada en DATABASE_URL (.env). Si no coinciden,
 * lanza un error claro para ABORTAR antes de escribir nada.
 *
 * Convierte en código la lección del incidente: un proceso heredó una
 * DATABASE_URL de otro proyecto (vía PM2) y escribió en la base equivocada.
 * El nombre esperado se PARSEA del DATABASE_URL del .env (dinámico, sin literal
 * hardcodeado). La usan pk-daily (worker:daily) y el runner de migraciones.
 */
export async function assertCorrectDatabase(log: Logger): Promise<void> {
  let expected: string | null = null;
  try {
    expected = new URL(env.DATABASE_URL).pathname.replace(/^\//, "") || null;
  } catch {
    expected = null;
  }
  const row = await queryOne<{ db: string; usr: string }>(
    `SELECT current_database() AS db, current_user AS usr`
  );
  const actual = row?.db ?? "(desconocida)";
  log.info(`conectado a DB '${actual}' como '${row?.usr ?? "?"}' (esperada por .env: '${expected ?? "?"}')`);
  if (expected && actual !== expected) {
    throw new Error(
      `GUARDIA DB: conectado a '${actual}' pero el .env espera '${expected}'. ` +
        `Abortando para NO escribir en la base equivocada.`
    );
  }
}
