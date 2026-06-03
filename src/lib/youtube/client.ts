import { getValidAccessToken } from "@/lib/auth/tokens";
import { throttle, withBackoff } from "@/lib/youtube/rate-limiter";
import { assertQuota, logQuota, type ApiName } from "@/lib/youtube/quota";

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfterMs?: number
  ) {
    super(message);
    this.name = "HttpError";
  }
}

interface CallOptions {
  api: ApiName;
  endpoint: string;
  cost: number;
  method?: "GET" | "POST";
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Si true, no añade Authorization (para Data API con API key pública). */
  useApiKey?: string;
}

/**
 * Llamada autenticada a una API de YouTube con:
 *  - guard de cuota (corte preventivo)
 *  - token bucket (rate limit)
 *  - backoff exponencial ante 429/5xx/403 transitorio
 *  - contabilidad de cuota
 */
export async function ytCall<T>(
  baseUrl: string,
  opts: CallOptions
): Promise<T> {
  await assertQuota(opts.api, opts.cost);

  const url = new URL(baseUrl);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  if (opts.useApiKey) url.searchParams.set("key", opts.useApiKey);

  const result = await withBackoff(`${opts.api}:${opts.endpoint}`, async () => {
    await throttle(opts.api);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (!opts.useApiKey) {
      headers.Authorization = `Bearer ${await getValidAccessToken()}`;
    }
    if (opts.body) headers["Content-Type"] = "application/json";

    const res = await fetch(url.toString(), {
      method: opts.method ?? "GET",
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      const retryAfter = res.headers.get("Retry-After");
      throw new HttpError(
        res.status,
        `${opts.endpoint} -> ${res.status}: ${text.slice(0, 500)}`,
        retryAfter ? Number(retryAfter) * 1000 : undefined
      );
    }
    return (await res.json()) as T;
  });

  await logQuota(opts.api, opts.endpoint, opts.cost);
  return result;
}

export const DATA_BASE = "https://www.googleapis.com/youtube/v3";
export const ANALYTICS_BASE = "https://youtubeanalytics.googleapis.com/v2/reports";
export const REPORTING_BASE = "https://youtubereporting.googleapis.com/v1";
