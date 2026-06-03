import { ytCall, ANALYTICS_BASE } from "@/lib/youtube/client";
import type { AnalyticsResponse } from "@/types/youtube";

/**
 * Wrapper de youtubeAnalytics.reports.query.
 * Devuelve filas como objetos {columna: valor}.
 */
export async function analyticsQuery(params: {
  startDate: string; // YYYY-MM-DD
  endDate: string;
  metrics: string;
  dimensions?: string;
  filters?: string;
  sort?: string;
  maxResults?: number;
  endpoint: string;
}): Promise<Record<string, string | number>[]> {
  const res = await ytCall<AnalyticsResponse>(ANALYTICS_BASE, {
    api: "analytics",
    endpoint: params.endpoint,
    cost: 1,
    query: {
      ids: "channel==MINE",
      startDate: params.startDate,
      endDate: params.endDate,
      metrics: params.metrics,
      dimensions: params.dimensions,
      filters: params.filters,
      sort: params.sort,
      maxResults: params.maxResults,
    },
  });
  const headers = res.columnHeaders.map((h) => h.name);
  return (res.rows ?? []).map((row) => {
    const obj: Record<string, string | number> = {};
    headers.forEach((h, i) => {
      const v = row[i];
      if (v !== undefined) obj[h] = v;
    });
    return obj;
  });
}

const DEFAULT_START = "2005-01-01"; // cubre toda la historia del canal

export function videoFilter(videoId: string): string {
  return `video==${videoId}`;
}

// ---- Consultas específicas ----

export function dailyVideoStats(videoId: string, start = DEFAULT_START, end = today()) {
  return analyticsQuery({
    startDate: start,
    endDate: end,
    dimensions: "day",
    metrics:
      "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained,subscribersLost,cardImpressions,cardClicks,cardClickRate",
    filters: videoFilter(videoId),
    sort: "day",
    endpoint: "analytics.dailyVideoStats",
  });
}

export function retentionCurve(videoId: string, start = DEFAULT_START, end = today()) {
  return analyticsQuery({
    startDate: start,
    endDate: end,
    dimensions: "elapsedVideoTimeRatio",
    metrics: "audienceWatchRatio,relativeRetentionPerformance",
    filters: videoFilter(videoId),
    endpoint: "analytics.retention",
  });
}

export function trafficSources(videoId: string, start = DEFAULT_START, end = today()) {
  return analyticsQuery({
    startDate: start,
    endDate: end,
    dimensions: "insightTrafficSourceType",
    metrics: "views,estimatedMinutesWatched",
    filters: videoFilter(videoId),
    endpoint: "analytics.traffic",
  });
}

export function demographics(videoId: string, start = DEFAULT_START, end = today()) {
  return analyticsQuery({
    startDate: start,
    endDate: end,
    dimensions: "ageGroup,gender",
    metrics: "viewerPercentage",
    filters: videoFilter(videoId),
    endpoint: "analytics.demographics",
  });
}

export function geography(videoId: string, start = DEFAULT_START, end = today()) {
  return analyticsQuery({
    startDate: start,
    endDate: end,
    dimensions: "country",
    metrics: "views,estimatedMinutesWatched,averageViewDuration",
    filters: videoFilter(videoId),
    sort: "-views",
    endpoint: "analytics.geography",
  });
}

export function devices(videoId: string, start = DEFAULT_START, end = today()) {
  return analyticsQuery({
    startDate: start,
    endDate: end,
    dimensions: "deviceType,operatingSystem",
    metrics: "views,estimatedMinutesWatched",
    filters: videoFilter(videoId),
    endpoint: "analytics.devices",
  });
}

/** Requiere scope monetario + YPP. */
export function revenueDaily(videoId: string, start = DEFAULT_START, end = today()) {
  return analyticsQuery({
    startDate: start,
    endDate: end,
    dimensions: "day",
    metrics:
      "estimatedRevenue,estimatedAdRevenue,estimatedRedPartnerRevenue,grossRevenue,cpm,playbackBasedCpm,adImpressions,monetizedPlaybacks",
    filters: videoFilter(videoId),
    sort: "day",
    endpoint: "analytics.revenueDaily",
  });
}

export function revenueByCountry(videoId: string, start = DEFAULT_START, end = today()) {
  return analyticsQuery({
    startDate: start,
    endDate: end,
    dimensions: "country",
    metrics: "estimatedRevenue,cpm,playbackBasedCpm,monetizedPlaybacks",
    filters: videoFilter(videoId),
    sort: "-estimatedRevenue",
    endpoint: "analytics.revenueGeo",
  });
}

/** Actividad de audiencia por día de la semana y hora (para horarios óptimos). */
export function channelDayHourActivity(start = isoDaysAgo(365), end = today()) {
  return analyticsQuery({
    startDate: start,
    endDate: end,
    dimensions: "day",
    metrics: "views,estimatedMinutesWatched",
    sort: "day",
    endpoint: "analytics.channelDaily",
  });
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
export function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}
