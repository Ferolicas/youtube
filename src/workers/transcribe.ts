import { createLogger } from "@/lib/utils/logger";
import { hasConnection } from "@/lib/auth/tokens";
import { processOne } from "@/lib/transcription/runner";
import { enqueueAllMissing, queueStats } from "@/lib/transcription/queue";
import { sleep } from "@/lib/youtube/rate-limiter";

const log = createLogger("worker:transcribe");
const IDLE_MS = 60_000;

/**
 * Drena la cola de transcripción de forma continua, 1 vídeo a la vez
 * (baja presión sobre CPU). Idempotente y reanudable: el estado vive en BD.
 */
async function loop(): Promise<void> {
  log.info("worker de transcripción activo");
  for (;;) {
    try {
      if (!(await hasConnection())) {
        log.warn("sin conexión OAuth; reintento en 60s");
        await sleep(IDLE_MS);
        continue;
      }
      await enqueueAllMissing();
      const did = await processOne();
      if (!did) {
        const stats = await queueStats();
        log.info(`cola vacía. Estado: ${JSON.stringify(stats)}. Reposo ${IDLE_MS / 1000}s`);
        await sleep(IDLE_MS);
      }
    } catch (e) {
      log.error("error en loop, reintento en 30s", String(e));
      await sleep(30_000);
    }
  }
}

void loop();
