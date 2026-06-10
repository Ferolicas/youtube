import { createHmac } from "node:crypto";
import { query, queryOne } from "@/lib/db/pool";
import { env } from "@/config/env";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("websub");

const HUB = "https://pubsubhubbub.appspot.com/subscribe";
// El hub de YouTube concede leases de ~5 días (432000s); pedimos el máximo.
const LEASE_SECONDS = 828000;

export function websubEnabled(): boolean {
  return env.WEBSUB_SECRET.length > 0 && env.APP_URL.startsWith("https://");
}

export function topicFor(channelId: string): string {
  return `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`;
}

export function callbackUrl(): string {
  return `${env.APP_URL.replace(/\/$/, "")}/api/websub`;
}

/** Suscribe (o renueva) el feed de un canal en el hub de Google. */
export async function subscribeChannel(
  channelId: string,
  kind: "own" | "competitor"
): Promise<boolean> {
  if (!websubEnabled()) {
    log.info("websub desactivado (falta WEBSUB_SECRET o APP_URL no es https)");
    return false;
  }
  const topic = topicFor(channelId);
  try {
    const res = await fetch(HUB, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        "hub.mode": "subscribe",
        "hub.topic": topic,
        "hub.callback": callbackUrl(),
        "hub.secret": env.WEBSUB_SECRET,
        "hub.lease_seconds": String(LEASE_SECONDS),
      }),
    });
    // el hub responde 202 y luego verifica el callback con un GET (challenge)
    if (res.status !== 202 && res.status !== 204) {
      log.warn(`hub respondió ${res.status} para ${channelId}: ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    await query(
      `INSERT INTO websub_subscriptions (channel_id, kind, topic, lease_until, last_subscribed_at)
       VALUES ($1,$2,$3, now() + ($4 || ' seconds')::interval, now())
       ON CONFLICT (channel_id) DO UPDATE SET
         kind=EXCLUDED.kind, topic=EXCLUDED.topic,
         lease_until=EXCLUDED.lease_until, last_subscribed_at=now()`,
      [channelId, kind, topic, String(LEASE_SECONDS)]
    );
    log.info(`suscrito ${kind} ${channelId} (lease ~${Math.round(LEASE_SECONDS / 86400)}d)`);
    return true;
  } catch (e) {
    log.warn(`subscribe ${channelId} falló: ${String(e)}`);
    return false;
  }
}

/**
 * Renueva suscripciones próximas a caducar (<36h) y asegura las que faltan:
 * el canal propio + los top canales del radar. La llama el worker pulse 1×/día.
 */
export async function renewSubscriptions(): Promise<void> {
  if (!websubEnabled()) return;

  // canal propio
  const own = await queryOne<{ channel_id: string }>(
    `SELECT channel_id FROM channels LIMIT 1`
  );
  // top competidores activos del radar
  const competitors = await query<{ channel_id: string }>(
    `SELECT channel_id FROM competitor_channels
     WHERE active ORDER BY subscriber_count DESC NULLS LAST LIMIT $1`,
    [env.COMPETITOR_RADAR_SIZE]
  );

  const wanted = new Map<string, "own" | "competitor">();
  if (own) wanted.set(own.channel_id, "own");
  for (const c of competitors) {
    if (!wanted.has(c.channel_id)) wanted.set(c.channel_id, "competitor");
  }

  const existing = await query<{ channel_id: string; lease_until: string | null }>(
    `SELECT channel_id, lease_until::text FROM websub_subscriptions`
  );
  const leaseById = new Map(existing.map((s) => [s.channel_id, s.lease_until]));

  for (const [channelId, kind] of wanted) {
    const lease = leaseById.get(channelId);
    const expiringSoon = !lease || new Date(lease).getTime() - Date.now() < 36 * 3600_000;
    if (expiringSoon) await subscribeChannel(channelId, kind);
  }
}

/** Verifica la firma X-Hub-Signature (sha1=...) del cuerpo de la notificación. */
export function verifySignature(body: Buffer, signatureHeader: string | null): boolean {
  if (!env.WEBSUB_SECRET) return false;
  if (!signatureHeader) return false;
  const [algo, theirHex] = signatureHeader.split("=");
  if (algo !== "sha1" || !theirHex) return false;
  const ours = createHmac("sha1", env.WEBSUB_SECRET).update(body).digest("hex");
  return ours.length === theirHex.length && timingSafeEq(ours, theirHex.toLowerCase());
}

function timingSafeEq(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
