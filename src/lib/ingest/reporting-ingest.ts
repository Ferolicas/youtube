import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { query, queryOne } from "@/lib/db/pool";
import { env } from "@/config/env";
import { createLogger } from "@/lib/utils/logger";
import {
  listJobs,
  createJob,
  listReports,
  downloadReport,
  WANTED_REPORT_TYPES,
} from "@/lib/youtube/reporting-api";

const log = createLogger("ingest:reporting");

/** Asegura que existen los reporting jobs deseados (idempotente). */
export async function ensureReportingJobs(): Promise<void> {
  const existing = await listJobs();
  const existingTypes = new Set(existing.map((j) => j.reportTypeId));
  for (const j of existing) {
    await query(
      `INSERT INTO reporting_jobs (job_id, report_type) VALUES ($1,$2)
       ON CONFLICT (job_id) DO NOTHING`,
      [j.id, j.reportTypeId]
    );
  }
  for (const type of WANTED_REPORT_TYPES) {
    if (existingTypes.has(type)) continue;
    try {
      const job = await createJob(type, `pk_${type}`);
      await query(
        `INSERT INTO reporting_jobs (job_id, report_type) VALUES ($1,$2)
         ON CONFLICT (job_id) DO NOTHING`,
        [job.id, type]
      );
      log.info(`job creado: ${type} (${job.id})`);
    } catch (e) {
      // p. ej. revenue no disponible si no hay YPP visible para reporting
      log.warn(`no se pudo crear job ${type}: ${String(e)}`);
    }
  }
}

/** Parser CSV simple (sin comillas embebidas complejas; formato de YouTube Reporting). */
function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.trim().split(/\r?\n/);
  const headers = (lines.shift() ?? "").split(",");
  const rows = lines.filter(Boolean).map((l) => l.split(","));
  return { headers, rows };
}

/** Backfill: descarga reportes nuevos y vuelca channel_basic a video_stats_daily. */
export async function ingestReporting(): Promise<{ downloaded: number }> {
  await ensureReportingJobs();
  const jobs = await query<{ job_id: string; report_type: string }>(
    `SELECT job_id, report_type FROM reporting_jobs`
  );
  const dir = join(process.cwd(), env.DATA_DIR, "reporting");
  await mkdir(dir, { recursive: true });

  let downloaded = 0;
  for (const job of jobs) {
    let reports;
    try {
      reports = await listReports(job.job_id);
    } catch (e) {
      log.warn(`listReports ${job.report_type}: ${String(e)}`);
      continue;
    }
    for (const rep of reports) {
      const already = await queryOne(
        `SELECT 1 FROM reporting_downloads WHERE report_id=$1`,
        [rep.id]
      );
      if (already) continue;
      try {
        const csv = await downloadReport(rep.downloadUrl);
        await writeFile(join(dir, `${job.report_type}_${rep.id}.csv`), csv);
        if (job.report_type.startsWith("channel_basic")) {
          await loadChannelBasic(csv);
        }
        await query(
          `INSERT INTO reporting_downloads (report_id, job_id, start_date, end_date, status, downloaded_at)
           VALUES ($1,$2,$3,$4,'done', now())
           ON CONFLICT (report_id) DO NOTHING`,
          [rep.id, job.job_id, rep.startTime.slice(0, 10), rep.endTime.slice(0, 10)]
        );
        downloaded++;
      } catch (e) {
        log.warn(`descarga reporte ${rep.id}: ${String(e)}`);
      }
    }
  }
  log.info(`reporting: ${downloaded} reportes nuevos descargados`);
  return { downloaded };
}

/** Vuelca channel_basic (día×vídeo) agregando a video_stats_daily con source='reporting'. */
async function loadChannelBasic(csv: string): Promise<void> {
  const { headers, rows } = parseCsv(csv);
  const idx = (name: string) => headers.indexOf(name);
  const iDate = idx("date");
  const iVideo = idx("video_id");
  const iViews = idx("views");
  const iWatch = idx("watch_time_minutes");
  const iAvgDur = idx("average_view_duration_seconds");
  if (iDate < 0 || iVideo < 0) return;

  // Agregamos por (video_id, date) porque el reporte desglosa por país/estado.
  const agg = new Map<string, { date: string; video: string; views: number; watch: number; avgDur: number; n: number }>();
  for (const row of rows) {
    const video = row[iVideo];
    const date = row[iDate];
    if (!video || !date) continue;
    const key = `${video}|${date}`;
    const cur = agg.get(key) ?? { date: fmtDate(date), video, views: 0, watch: 0, avgDur: 0, n: 0 };
    cur.views += iViews >= 0 ? Number(row[iViews] ?? 0) : 0;
    cur.watch += iWatch >= 0 ? Number(row[iWatch] ?? 0) : 0;
    cur.avgDur += iAvgDur >= 0 ? Number(row[iAvgDur] ?? 0) : 0;
    cur.n += 1;
    agg.set(key, cur);
  }

  for (const v of agg.values()) {
    // Solo si el vídeo existe en nuestro catálogo (evita FK errors)
    const exists = await queryOne(`SELECT 1 FROM videos WHERE video_id=$1`, [v.video]);
    if (!exists) continue;
    await query(
      `INSERT INTO video_stats_daily (video_id, date, views, estimated_minutes_watched, average_view_duration, source)
       VALUES ($1,$2,$3,$4,$5,'reporting')
       ON CONFLICT (video_id, date) DO UPDATE SET
         views = COALESCE(video_stats_daily.views, EXCLUDED.views),
         estimated_minutes_watched = COALESCE(video_stats_daily.estimated_minutes_watched, EXCLUDED.estimated_minutes_watched)`,
      [v.video, v.date, v.views, v.watch, v.n > 0 ? v.avgDur / v.n : null]
    );
  }
}

function fmtDate(yyyymmdd: string): string {
  // Reporting usa YYYYMMDD
  if (/^\d{8}$/.test(yyyymmdd)) {
    return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
  }
  return yyyymmdd;
}
