import cron from "node-cron";
import { env } from "@/config/env";
import { createLogger } from "@/lib/utils/logger";
import { hasConnection } from "@/lib/auth/tokens";
import { discoverYoutubeTrends } from "@/lib/trends/youtube-trends";
import { generateDailyIdeas } from "@/lib/ideas/generate";
import { isMain } from "@/lib/utils/is-main";

const log = createLogger("worker:trends");

export async function runTrends(): Promise<void> {
  if (!(await hasConnection())) {
    log.warn("sin conexión OAuth; trends abortado");
    return;
  }
  log.info("=== TRENDS + IDEAS ===");
  try {
    await discoverYoutubeTrends({ maxSearches: 8 });
  } catch (e) {
    log.error("descubrimiento de tendencias falló", String(e));
  }
  try {
    await generateDailyIdeas();
  } catch (e) {
    log.error("generación de ideas falló", String(e));
  }
  log.info("=== TRENDS FIN ===");
}

if (isMain(import.meta.url)) {
  if (process.argv.includes("--once")) {
    runTrends().then(() => process.exit(0));
  } else {
    log.info(`worker trends activo. Cron: '${env.CRON_TRENDS}' TZ=${env.TZ}`);
    cron.schedule(env.CRON_TRENDS, () => { void runTrends(); }, { timezone: env.TZ });
  }
}
