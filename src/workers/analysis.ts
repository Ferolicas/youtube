import cron from "node-cron";
import { env } from "@/config/env";
import { createLogger } from "@/lib/utils/logger";
import { computeOutliers } from "@/lib/analysis/outliers";
import { computeClusters } from "@/lib/analysis/clusters";
import { computeAudience } from "@/lib/analysis/audience";
import { computeTiming } from "@/lib/analysis/timing";
import { computeThumbnailAnalysis } from "@/lib/analysis/thumbnails-analysis";
import { computeSeoAudit } from "@/lib/analysis/seo-audit";
import { computeMonetization } from "@/lib/analysis/monetization";
import { computeScriptAnalysis } from "@/lib/analysis/script-analysis";
import { generateRecommendations } from "@/lib/recommendations/engine";
import { isMain } from "@/lib/utils/is-main";

const log = createLogger("worker:analysis");

export async function runAnalysis(): Promise<void> {
  log.info("=== ANÁLISIS ===");
  const steps: [string, () => Promise<unknown>][] = [
    ["outliers", computeOutliers],
    ["clusters", computeClusters],
    ["audience", computeAudience],
    ["timing", computeTiming],
    ["thumbnails", computeThumbnailAnalysis],
    ["seo", computeSeoAudit],
    ["monetization", computeMonetization],
    ["guion", computeScriptAnalysis],
    ["recommendations", generateRecommendations],
  ];
  for (const [name, fn] of steps) {
    try {
      await fn();
    } catch (e) {
      log.error(`paso '${name}' falló`, String(e));
    }
  }
  log.info("=== ANÁLISIS FIN ===");
}

if (isMain(import.meta.url)) {
  if (process.argv.includes("--once")) {
    runAnalysis().then(() => process.exit(0));
  } else {
    log.info(`worker analysis activo. Cron: '${env.CRON_ANALYSIS}' TZ=${env.TZ}`);
    cron.schedule(env.CRON_ANALYSIS, () => { void runAnalysis(); }, { timezone: env.TZ });
  }
}
