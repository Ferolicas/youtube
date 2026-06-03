import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { env } from "@/config/env";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("db");

/**
 * Pool de Postgres compartido. En dev con HMR usamos globalThis para no
 * abrir un pool por recarga.
 */
const globalForPool = globalThis as unknown as { __pgPool?: Pool };

export const pool =
  globalForPool.__pgPool ??
  new Pool({
    connectionString: env.DATABASE_URL,
    ssl: env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

pool.on("error", (err) => log.error("pool idle client error", err.message));

if (env.NODE_ENV !== "production") globalForPool.__pgPool = pool;

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const res = await pool.query<T>(text, params as never[]);
  return res.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Ejecuta fn dentro de una transacción; rollback ante error. */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
