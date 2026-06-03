import { ytCall, REPORTING_BASE } from "@/lib/youtube/client";
import { getValidAccessToken } from "@/lib/auth/tokens";
import { throttle, withBackoff } from "@/lib/youtube/rate-limiter";

/**
 * YouTube Reporting API: jobs de informes masivos (CSV diarios) para backfill
 * histórico barato (no consume cuota de Analytics). Cada reporte queda ~60 días.
 */

export interface ReportType {
  id: string;
  name: string;
}

export async function listReportTypes(): Promise<ReportType[]> {
  const res = await ytCall<{ reportTypes?: ReportType[] }>(
    `${REPORTING_BASE}/reportTypes`,
    { api: "reporting", endpoint: "reportTypes.list", cost: 1 }
  );
  return res.reportTypes ?? [];
}

export async function listJobs(): Promise<{ id: string; reportTypeId: string }[]> {
  const res = await ytCall<{ jobs?: { id: string; reportTypeId: string }[] }>(
    `${REPORTING_BASE}/jobs`,
    { api: "reporting", endpoint: "jobs.list", cost: 1 }
  );
  return res.jobs ?? [];
}

export async function createJob(reportTypeId: string, name: string) {
  return ytCall<{ id: string; reportTypeId: string }>(`${REPORTING_BASE}/jobs`, {
    api: "reporting",
    endpoint: "jobs.create",
    cost: 1,
    method: "POST",
    body: { reportTypeId, name },
  });
}

export async function listReports(jobId: string) {
  const out: {
    id: string;
    startTime: string;
    endTime: string;
    downloadUrl: string;
  }[] = [];
  let pageToken: string | undefined;
  do {
    const res = await ytCall<{
      reports?: {
        id: string;
        startTime: string;
        endTime: string;
        downloadUrl: string;
      }[];
      nextPageToken?: string;
    }>(`${REPORTING_BASE}/jobs/${jobId}/reports`, {
      api: "reporting",
      endpoint: "jobs.reports.list",
      cost: 1,
      query: { pageToken },
    });
    out.push(...(res.reports ?? []));
    pageToken = res.nextPageToken;
  } while (pageToken);
  return out;
}

/** Descarga el CSV de un reporte (downloadUrl es un recurso de la API, requiere auth). */
export async function downloadReport(downloadUrl: string): Promise<string> {
  return withBackoff("reporting.download", async () => {
    await throttle("reporting");
    const token = await getValidAccessToken();
    const res = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const err = new Error(`download ${res.status}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    return res.text();
  });
}

/** Tipos de informe que nos interesan para backfill por vídeo. */
export const WANTED_REPORT_TYPES = [
  "channel_basic_a2",
  "channel_province_a2",
  "channel_demographics_a1",
  "channel_device_os_a2",
  "channel_traffic_source_a2",
  // ingresos (solo si el canal está monetizado; pueden no existir si no hay YPP)
  "channel_estimated_revenue_a1",
];
