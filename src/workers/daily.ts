import cron from "node-cron";
import { env } from "@/config/env";
import { query, queryOne } from "@/lib/db/pool";
import { createLogger } from "@/lib/utils/logger";
import { assertCorrectDatabase } from "@/lib/db/guard";
import { runSync } from "@/workers/sync";
import { runAnalysis } from "@/workers/analysis";
import { runTrends } from "@/workers/trends";
import { withJobLock } from "@/lib/jobs/lock";
import { notify } from "@/lib/alerts/notify";
import { isMain } from "@/lib/utils/is-main";

const log = createLogger("worker:daily");

/**
 * Pipeline diario único. Ejecuta en orden y ESPERANDO a que cada paso termine
 * antes del siguiente: sync -> analysis -> trends (que incluye la generación de
 * ideas diarias). Cada paso va en su propio try/catch para que un fallo no corte
 * el resto; los fallos generan ALERTA (BD + Telegram). Exclusión global vía
 * advisory lock 'daily_pipeline' (cada paso lleva además su propio lock).
 */
export async function runDailyPipeline(): Promise<void> {
  const result = await withJobLock("daily_pipeline", async () => {
    log.info("=== PIPELINE DIARIO ===");
    await assertCorrectDatabase(log); // si la BD no es la correcta, lanza y NO continúa

    const steps: [string, () => Promise<unknown>][] = [
      ["sync", () => runSync({ full: false })],
      ["analysis", () => runAnalysis()],
      ["trends+ideas", () => runTrends()],
    ];

    const failures: string[] = [];
    for (const [name, fn] of steps) {
      const t0 = Date.now();
      log.info(`▶ ${name}: inicio`);
      try {
        await fn();
        log.info(`✓ ${name}: fin (${Math.round((Date.now() - t0) / 1000)}s)`);
      } catch (e) {
        failures.push(`${name}: ${String(e).slice(0, 200)}`);
        log.error(`✗ ${name}: falló`, String(e));
      }
    }

    // marca de ejecución del día (para el catch-up al arrancar)
    await query(
      `INSERT INTO sync_runs (job_type, status, finished_at)
       VALUES ('daily_pipeline', $1, now())`,
      [failures.length === 0 ? "done" : "failed"]
    ).catch(() => undefined);

    if (failures.length > 0) {
      await notify({
        kind: "pipeline_failed",
        title: `Pipeline diario con ${failures.length} fallo(s)`,
        detail: failures.join("\n"),
        dedupeKey: `pipeline:${new Date().toISOString().slice(0, 10)}`,
        dedupeHours: 12,
      }).catch(() => undefined);
    }
    log.info("=== PIPELINE DIARIO FIN ===");
  });
  if (result === "busy") log.warn("pipeline omitido: ya hay un pipeline en curso");
}

/**
 * Catch-up: si el proceso arranca DESPUÉS de la hora del cron y hoy aún no corrió
 * el pipeline (reinicio del VPS, deploy a mediodía...), lo ejecuta una vez.
 * Sin esto, un reinicio a las 06:55 dejaba el día sin datos.
 */
async function catchUpIfMissed(): Promise<void> {
  const m = env.CRON_DAILY.trim().match(/^(\d{1,2})\s+(\d{1,2})\s/);
  if (!m) return; // expresión no estándar: no intentamos adivinar
  const cronMinute = Number(m[1]);
  const cronHour = Number(m[2]);

  const nowParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: env.TZ, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => nowParts.find((p) => p.type === t)?.value ?? "0";
  const localDate = `${get("year")}-${get("month")}-${get("day")}`;
  const localMinutes = Number(get("hour")) * 60 + Number(get("minute"));

  if (localMinutes < cronHour * 60 + cronMinute) return; // aún no toca hoy

  const ranToday = await queryOne(
    `SELECT 1 FROM sync_runs
      WHERE job_type='daily_pipeline'
        AND (started_at AT TIME ZONE $1)::date = $2::date
      LIMIT 1`,
    [env.TZ, localDate]
  );
  if (ranToday) return;

  log.warn(`catch-up: hoy (${localDate}) no corrió el pipeline y ya pasó la hora del cron; ejecutando ahora`);
  await runDailyPipeline();
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
      .then(async () => {
        log.info(`worker daily activo. Cron: '${env.CRON_DAILY}' TZ=${env.TZ}`);
        cron.schedule(env.CRON_DAILY, () => { void runDailyPipeline(); }, { timezone: env.TZ });
        await catchUpIfMissed().catch((e) => log.error("catch-up falló", String(e)));
      })
      .catch((e) => {
        log.error("guardia DB falló al arranque; pk-daily NO se programa", String(e));
        process.exit(1);
      });
  }
}
