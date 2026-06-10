import { query, queryOne } from "@/lib/db/pool";
import { env } from "@/config/env";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("alerts");

export type AlertKind =
  | "breakout"
  | "pipeline_failed"
  | "token_failed"
  | "quota"
  | "new_video"
  | "competitor_video";

/**
 * Registra una alerta en BD y, si hay TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID,
 * la envía por Telegram. `dedupeKey` evita repetir la misma alerta dentro de
 * `dedupeHours` (p. ej. cuota al 80% solo una vez al día).
 */
export async function notify(params: {
  kind: AlertKind;
  title: string;
  detail?: string;
  payload?: Record<string, unknown>;
  dedupeKey?: string;
  dedupeHours?: number;
}): Promise<boolean> {
  const { kind, title, detail, payload, dedupeKey, dedupeHours = 24 } = params;

  if (dedupeKey) {
    const dup = await queryOne(
      `SELECT 1 FROM alerts
        WHERE kind=$1 AND payload->>'dedupe_key' = $2
          AND created_at > now() - ($3 || ' hours')::interval
        LIMIT 1`,
      [kind, dedupeKey, String(dedupeHours)]
    );
    if (dup) return false;
  }

  await query(
    `INSERT INTO alerts (kind, title, detail, payload) VALUES ($1,$2,$3,$4)`,
    [kind, title, detail ?? null, JSON.stringify({ ...payload, dedupe_key: dedupeKey ?? null })]
  );

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      const text = `*${escapeMd(title)}*${detail ? `\n${escapeMd(detail)}` : ""}`;
      const res = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text,
            parse_mode: "Markdown",
            disable_web_page_preview: true,
          }),
        }
      );
      if (!res.ok) log.warn(`telegram ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } catch (e) {
      log.warn(`telegram falló: ${String(e)}`);
    }
  }
  log.info(`[${kind}] ${title}`);
  return true;
}

function escapeMd(s: string): string {
  return s.replace(/([_*[\]()`])/g, "\\$1");
}

/** Últimas alertas para la UI. */
export async function recentAlerts(limit = 30) {
  return query<{
    id: string; kind: string; title: string; detail: string | null;
    seen: boolean; created_at: string;
  }>(
    `SELECT id::text, kind, title, detail, seen, created_at::text
     FROM alerts ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
}

export async function unseenAlertCount(): Promise<number> {
  const r = await queryOne<{ n: string }>(`SELECT count(*)::text AS n FROM alerts WHERE NOT seen`);
  return Number(r?.n ?? 0);
}

export async function markAlertsSeen(): Promise<void> {
  await query(`UPDATE alerts SET seen=true WHERE NOT seen`);
}
