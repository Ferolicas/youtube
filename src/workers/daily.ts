import cron from "node-cron";
import { env } from "@/config/env";
import { queryOne } from "@/lib/db/pool";
import { createLogger } from "@/lib/utils/logger";
import { runSync } from "@/workers/sync";
import { runAnalysis } from "@/workers/analysis";
import { runTrends } from "@/workers/trends";
import { isMain } from "@/lib/utils/is-main";

const log = createLogger("worker:daily");

/**
 * Guardia de base de datos (Capa 3 del aislamiento de DATABASE_URL).
 * Compara la BD a la que realmente está conectado el pool con la que el .env
 * declara en DATABASE_URL. Si no coinciden, ABORTA sin escribir: evita repetir
 * el incidente de heredar una DATABASE_URL de otro proyecto vía PM2.
 * También deja en el log a qué BD/usuario se conectó (sin password) para auditar.
 */
async function assertCorrectDatabase(): Promise<void> {
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

/**
 * Pipeline diario único. Ejecuta en orden y ESPERANDO a que cada paso termine
 * antes del siguiente: sync -> analysis -> trends (que incluye la generación de
 * ideas diarias). Cada paso va en su propio try/catch para que un fallo no corte
 * el resto, con log de inicio/fin. Usa las funciones in-process (las mismas que
 * dispara el botón del dashboard), no los entrypoints de terminal.
 */
export async function runDailyPipeline(): Promise<void> {
  log.info("=== PIPELINE DIARIO ===");
  await assertCorrectDatabase(); // si la BD no es la correcta, lanza y NO continúa

  const steps: [string, () => Promise<unknown>][] = [
    ["sync", () => runSync({ full: false })],
    ["analysis", () => runAnalysis()],
    ["trends+ideas", () => runTrends()],
  ];

  for (const [name, fn] of steps) {
    const t0 = Date.now();
    log.info(`▶ ${name}: inicio`);
    try {
      await fn();
      log.info(`✓ ${name}: fin (${Math.round((Date.now() - t0) / 1000)}s)`);
    } catch (e) {
      log.error(`✗ ${name}: falló`, String(e));
    }
  }
  log.info("=== PIPELINE DIARIO FIN ===");
}

if (isMain(import.meta.url)) {
  if (process.argv.includes("--once")) {
    runDailyPipeline()
      .then(() => process.exit(0))
      .catch((e) => {
        log.error("pipeline once falló", String(e));
        process.exit(1);
      });
  } else {
    // Guardia AL ARRANQUE: verifica la BD y deja constancia en el log antes de
    // programar el cron. Si falla, el proceso no se programa (PM2 lo reintentará).
    assertCorrectDatabase()
      .then(() => {
        log.info(`worker daily activo. Cron: '${env.CRON_DAILY}' TZ=${env.TZ}`);
        cron.schedule(env.CRON_DAILY, () => { void runDailyPipeline(); }, { timezone: env.TZ });
      })
      .catch((e) => {
        log.error("guardia DB falló al arranque; pk-daily NO se programa", String(e));
        process.exit(1);
      });
  }
}
