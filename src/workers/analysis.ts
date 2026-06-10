import cron from "node-cron";
import { env } from "@/config/env";
import { query } from "@/lib/db/pool";
import { createLogger } from "@/lib/utils/logger";
import { computeOutliers } from "@/lib/analysis/outliers";
import { computeClusters } from "@/lib/analysis/clusters";
import { computeAudience } from "@/lib/analysis/audience";
import { computeTiming } from "@/lib/analysis/timing";
import { computeThumbnailAnalysis } from "@/lib/analysis/thumbnails-analysis";
import { computeSeoAudit } from "@/lib/analysis/seo-audit";
import { computeSeoScores } from "@/lib/analysis/seo-score";
import { computeMonetization } from "@/lib/analysis/monetization";
import { computeScriptAnalysis } from "@/lib/analysis/script-analysis";
import { computeCommentInsights } from "@/lib/analysis/comment-insights";
import { computeEmbeddings } from "@/lib/analysis/embeddings";
import { generateRecommendations } from "@/lib/recommendations/engine";
import { withJobLock } from "@/lib/jobs/lock";
import { isMain } from "@/lib/utils/is-main";

const log = createLogger("worker:analysis");

export async function runAnalysis(): Promise<void> {
  const result = await withJobLock("analysis", async () => {
    log.info("=== ANÁLISIS ===");
    const steps: [string, () => Promise<unknown>][] = [
      ["outliers", computeOutliers],
      ["embeddings", computeEmbeddings],
      ["clusters", computeClusters],
      ["audience", computeAudience],
      ["timing", computeTiming],
      ["thumbnails", computeThumbnailAnalysis],
      ["seo", computeSeoAudit],
      ["seo_scores", computeSeoScores],
      ["monetization", computeMonetization],
      ["guion", computeScriptAnalysis],
      ["comments", computeCommentInsights],
      ["recommendations", generateRecommendations],
    ];
    for (const [name, fn] of steps) {
      try {
        await fn();
      } catch (e) {
        log.error(`paso '${name}' falló`, String(e));
      }
    }
    // higiene: los snapshots crecen sin límite (JSONB por corrida); purga >90 días
    await query(`DELETE FROM analysis_snapshots WHERE computed_at < now() - interval '90 days'`)
      .catch((e) => log.warn(`purga snapshots: ${String(e)}`));
    log.info("=== ANÁLISIS FIN ===");
  });
  if (result === "busy") log.warn("análisis omitido: ya hay un análisis en curso");
}

if (isMain(import.meta.url)) {
  if (process.argv.includes("--once")) {
    runAnalysis().then(() => process.exit(0));
  } else {
    log.info(`worker analysis activo. Cron: '${env.CRON_ANALYSIS}' TZ=${env.TZ}`);
    cron.schedule(env.CRON_ANALYSIS, () => { void runAnalysis(); }, { timezone: env.TZ });
  }
}
