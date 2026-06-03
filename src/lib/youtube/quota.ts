import { query, queryOne } from "@/lib/db/pool";
import { env } from "@/config/env";

export type ApiName = "data" | "analytics" | "reporting";

const DAILY_LIMIT: Record<ApiName, number> = {
  data: env.QUOTA_DATA_DAILY,
  analytics: env.QUOTA_ANALYTICS_DAILY,
  reporting: 1_000_000, // reporting es generosa; no la limitamos en la práctica
};

/** Registra el consumo de una llamada para auditoría y corte preventivo. */
export async function logQuota(
  api: ApiName,
  endpoint: string,
  costUnits: number
): Promise<void> {
  await query(
    `INSERT INTO api_quota_log (api, endpoint, cost_units) VALUES ($1, $2, $3)`,
    [api, endpoint, costUnits]
  );
}

export async function usedToday(api: ApiName): Promise<number> {
  const row = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(cost_units), 0) AS total
       FROM api_quota_log
      WHERE api = $1 AND day = (now() AT TIME ZONE 'UTC')::date`,
    [api]
  );
  return Number(row?.total ?? 0);
}

/** Lanza si la siguiente llamada superaría el margen de seguridad del límite diario. */
export async function assertQuota(api: ApiName, cost: number): Promise<void> {
  const limit = DAILY_LIMIT[api] * env.QUOTA_SAFETY_MARGIN;
  const used = await usedToday(api);
  if (used + cost > limit) {
    throw new QuotaExceededError(api, used, limit);
  }
}

export class QuotaExceededError extends Error {
  constructor(
    public api: ApiName,
    public used: number,
    public limit: number
  ) {
    super(
      `QUOTA_GUARD: '${api}' usaría ${used + 1}/${Math.floor(limit)} (límite diario con margen). Pausa hasta mañana.`
    );
    this.name = "QuotaExceededError";
  }
}

export async function quotaSummary() {
  const apis: ApiName[] = ["data", "analytics", "reporting"];
  const out: Record<string, { used: number; limit: number }> = {};
  for (const api of apis) {
    out[api] = { used: await usedToday(api), limit: DAILY_LIMIT[api] };
  }
  return out;
}
