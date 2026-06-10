import cron from "node-cron";
import { env } from "@/config/env";
import { createLogger } from "@/lib/utils/logger";
import { hasConnection } from "@/lib/auth/tokens";
import { discoverYoutubeTrends } from "@/lib/trends/youtube-trends";
import { runCompetitorRadar } from "@/lib/trends/competitor-radar";
import { trackKeywordRanks } from "@/lib/trends/rank-tracking";
import { generateDailyIdeas } from "@/lib/ideas/generate";
import { withJobLock } from "@/lib/jobs/lock";
import { isMain } from "@/lib/utils/is-main";

const log = createLogger("worker:trends");

export async function runTrends(): Promise<void> {
  if (!(await hasConnection())) {
    log.warn("sin conexión OAuth; trends abortado");
    return;
  }
  const result = await withJobLock("trends", async () => {
    log.info("=== TRENDS + IDEAS ===");

    // Descubrimiento por search.list (100u/búsqueda): solo el día configurado
    // (default lunes). El resto de días, el radar de playlists (1u) cubre el
    // seguimiento de competidores ya conocidos.
    const today = new Date().getDay(); // 0=domingo
    if (today === env.TRENDS_SEARCH_DOW) {
      try {
        await discoverYoutubeTrends({ maxSearches: 8 });
      } catch (e) {
        log.error("descubrimiento de tendencias falló", String(e));
      }
    } else {
      log.info(`search discovery solo el día ${env.TRENDS_SEARCH_DOW} (hoy=${today}); radar diario en su lugar`);
    }

    try {
      await runCompetitorRadar();
    } catch (e) {
      log.error("radar de competidores falló", String(e));
    }

    try {
      await trackKeywordRanks();
    } catch (e) {
      log.error("rank tracking falló", String(e));
    }

    try {
      await generateDailyIdeas();
    } catch (e) {
      log.error("generación de ideas falló", String(e));
    }
    log.info("=== TRENDS FIN ===");
  });
  if (result === "busy") log.warn("trends omitido: ya hay un trends en curso");
}

if (isMain(import.meta.url)) {
  if (process.argv.includes("--once")) {
    runTrends().then(() => process.exit(0));
  } else {
    log.info(`worker trends activo. Cron: '${env.CRON_TRENDS}' TZ=${env.TZ}`);
    cron.schedule(env.CRON_TRENDS, () => { void runTrends(); }, { timezone: env.TZ });
  }
}
