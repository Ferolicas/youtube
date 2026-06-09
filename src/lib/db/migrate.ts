import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "@/lib/db/pool";
import { assertCorrectDatabase } from "@/lib/db/guard";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("migrate");
const MIGRATIONS_DIR = join(process.cwd(), "migrations");

/**
 * Runner de migraciones SQL versionadas. Aplica en orden lexicográfico los
 * archivos *.sql no aplicados, cada uno dentro de una transacción.
 * Idempotente: se apoya en la tabla _migrations.
 */
export async function runMigrations(): Promise<void> {
  // Guardia: aborta si la BD conectada no coincide con la del .env (DATABASE_URL),
  // igual que pk-daily. Evita aplicar migraciones en la base equivocada aunque el
  // shell del operador tenga una DATABASE_URL exportada o herede otra.
  await assertCorrectDatabase(log);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const appliedRows = await pool.query<{ filename: string }>(
    `SELECT filename FROM _migrations`
  );
  const applied = new Set(appliedRows.rows.map((r) => r.filename));

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO _migrations (filename) VALUES ($1)`, [file]);
      await client.query("COMMIT");
      log.info(`aplicada: ${file}`);
      count++;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      log.error(`falló migración ${file}`, String(err));
      throw err;
    } finally {
      client.release();
    }
  }
  if (count === 0) log.info("sin migraciones pendientes");
  else log.info(`${count} migración(es) aplicada(s)`);
}
