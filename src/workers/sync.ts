import cron from "node-cron";
import { env } from "@/config/env";
import { query } from "@/lib/db/pool";
import { createLogger } from "@/lib/utils/logger";
import { hasConnection } from "@/lib/auth/tokens";
import { ingestCatalog } from "@/lib/ingest/catalog";
import { ingestAllAnalytics } from "@/lib/ingest/analytics-ingest";
import { ingestReporting } from "@/lib/ingest/reporting-ingest";
import { ingestAllThumbnails } from "@/lib/ingest/thumbnails";
import { ingestAllComments } from "@/lib/ingest/comments";
import { enqueueAllMissing } from "@/lib/transcription/queue";
import { QuotaExceededError } from "@/lib/youtube/quota";
import { withJobLock } from "@/lib/jobs/lock";
import { isMain } from "@/lib/utils/is-main";

const log = createLogger("worker:sync");

async function recordRun(jobType: string, fn: () => Promise<void>) {
  const res = await query<{ id: string }>(
    `INSERT INTO sync_runs (job_type, status) VALUES ($1,'running') RETURNING id`,
    [jobType]
  );
  const id = res[0]!.id;
  try {
    await fn();
    await query(`UPDATE sync_runs SET status='done', finished_at=now() WHERE id=$1`, [id]);
  } catch (e) {
    const status = e instanceof QuotaExceededError ? "paused_quota" : "failed";
    await query(`UPDATE sync_runs SET status=$2, error=$3, finished_at=now() WHERE id=$1`,
      [id, status, String(e).slice(0, 1000)]);
    log.error(`${jobType}: ${status}`, String(e));
  }
}

export async function runSync(opts: { full?: boolean } = {}): Promise<void> {
  if (!(await hasConnection())) {
    log.warn("sin conexión OAuth: conéctate en la web primero. Sync abortado.");
    return;
  }
  const result = await withJobLock("sync", async () => {
    log.info(`=== SYNC ${opts.full ? "COMPLETO" : "INCREMENTAL"} ===`);
    await recordRun("catalog", async () => { await ingestCatalog(); });
    await recordRun("transcription_enqueue", async () => { await enqueueAllMissing(); });
    await recordRun("reporting", async () => { await ingestReporting(); });
    await recordRun("analytics", async () => { await ingestAllAnalytics({ onlyRecent: !opts.full }); });
    await recordRun("comments", async () => { await ingestAllComments(); });
    await recordRun("thumbnails", async () => { await ingestAllThumbnails(); });
    log.info("=== SYNC FIN ===");
  });
  if (result === "busy") log.warn("sync omitido: ya hay un sync en curso");
}

if (isMain(import.meta.url)) {
  const isFull = process.argv.includes("--full");
  const runOnce = process.argv.includes("--once") || isFull;
  if (runOnce) {
    runSync({ full: isFull }).then(() => process.exit(0)).catch((e) => {
      log.error("sync once falló", String(e));
      process.exit(1);
    });
  } else {
    log.info(`worker sync activo. Cron: '${env.CRON_SYNC}' TZ=${env.TZ}`);
    cron.schedule(env.CRON_SYNC, () => { void runSync({ full: false }); }, { timezone: env.TZ });
  }
}
