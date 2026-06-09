import cron from "node-cron";
import { env } from "@/config/env";
import { createLogger } from "@/lib/utils/logger";
import { assertCorrectDatabase } from "@/lib/db/guard";
import { runSync } from "@/workers/sync";
import { runAnalysis } from "@/workers/analysis";
import { runTrends } from "@/workers/trends";
import { isMain } from "@/lib/utils/is-main";

const log = createLogger("worker:daily");

/**
 * Pipeline diario único. Ejecuta en orden y ESPERANDO a que cada paso termine
 * antes del siguiente: sync -> analysis -> trends (que incluye la generación de
 * ideas diarias). Cada paso va en su propio try/catch para que un fallo no corte
 * el resto, con log de inicio/fin. Usa las funciones in-process (las mismas que
 * dispara el botón del dashboard), no los entrypoints de terminal.
 */
export async function runDailyPipeline(): Promise<void> {
  log.info("=== PIPELINE DIARIO ===");
  await assertCorrectDatabase(log); // si la BD no es la correcta, lanza y NO continúa

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
    assertCorrectDatabase(log)
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
