import type { PoolClient } from "pg";
import { pool, query } from "@/lib/db/pool";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("jobs:lock");

/**
 * Lock de exclusión por job vía pg_advisory_lock (sesión). Evita que el cron y
 * el botón del dashboard (o dos clics) corran el mismo pipeline a la vez:
 * doble gasto de cuota y carreras en los patrones DELETE+INSERT.
 *
 * Namespace fijo (classid) + hashtext(jobName) como objid. El lock vive en una
 * conexión DEDICADA del pool que se retiene mientras corre el job (los advisory
 * locks son por sesión); job_state es el espejo legible para la UI/SSE.
 */
const LOCK_NS = 7_421_001; // namespace arbitrario de esta app

export type JobName =
  | "sync"
  | "analysis"
  | "trends"
  | "ideas"
  | "pulse"
  | "daily_pipeline";

export interface JobLease {
  job: JobName;
  release: (error?: string) => Promise<void>;
}

/**
 * Intenta adquirir el lock. Devuelve null si el job ya está corriendo.
 * `silent: true` no toca job_state (para probes efímeros de la API).
 */
export async function acquireJobLock(
  job: JobName,
  opts: { silent?: boolean } = {}
): Promise<JobLease | null> {
  const client: PoolClient = await pool.connect();
  try {
    const res = await client.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_lock($1, hashtext($2)) AS ok`,
      [LOCK_NS, job]
    );
    if (!res.rows[0]?.ok) {
      client.release();
      return null;
    }
  } catch (e) {
    client.release();
    throw e;
  }

  if (!opts.silent) {
    await query(
      `INSERT INTO job_state (job_name, running, started_at, last_error, updated_at)
       VALUES ($1, true, now(), NULL, now())
       ON CONFLICT (job_name) DO UPDATE SET
         running=true, started_at=now(), last_error=NULL, updated_at=now()`,
      [job]
    ).catch((e) => log.warn(`job_state start ${job}: ${String(e)}`));
  }

  let released = false;
  return {
    job,
    release: async (error?: string) => {
      if (released) return;
      released = true;
      if (!opts.silent) {
        await query(
          `UPDATE job_state SET running=false, finished_at=now(), last_error=$2, updated_at=now()
           WHERE job_name=$1`,
          [job, error ?? null]
        ).catch((e) => log.warn(`job_state end ${job}: ${String(e)}`));
      }
      try {
        await client.query(`SELECT pg_advisory_unlock($1, hashtext($2))`, [LOCK_NS, job]);
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Ejecuta fn bajo el lock del job. Si ya está corriendo, devuelve 'busy' sin
 * ejecutar. Los workers la usan directamente; la API usa acquireJobLock para
 * poder responder 409 y correr en background.
 */
export async function withJobLock(
  job: JobName,
  fn: () => Promise<void>
): Promise<"done" | "busy"> {
  const lease = await acquireJobLock(job);
  if (!lease) {
    log.warn(`job '${job}' ya está corriendo; se omite esta ejecución`);
    return "busy";
  }
  try {
    await fn();
    await lease.release();
    return "done";
  } catch (e) {
    await lease.release(String(e).slice(0, 500));
    throw e;
  }
}

/** Estado actual de todos los jobs (para la UI/SSE). */
export async function getJobStates(): Promise<
  { job_name: string; running: boolean; started_at: string | null; finished_at: string | null; last_error: string | null }[]
> {
  return query(
    `SELECT job_name, running, started_at::text, finished_at::text, last_error
     FROM job_state ORDER BY job_name`
  );
}
