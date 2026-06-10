import { query, queryOne } from "@/lib/db/pool";
import { encrypt, decrypt } from "@/lib/auth/crypto";
import {
  refreshAccessToken,
  type GoogleTokenResponse,
} from "@/lib/auth/google-oauth";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("tokens");

interface TokenRow {
  google_email: string;
  access_token: Buffer;
  refresh_token: Buffer;
  scopes: string[];
  token_type: string | null;
  expires_at: Date;
}

/** Persiste tokens (cifrados) tras el intercambio del code. Mono-usuario (id=1). */
export async function saveTokens(params: {
  email: string;
  tokens: GoogleTokenResponse;
  existingRefresh?: string;
}): Promise<void> {
  const { email, tokens } = params;
  const refresh = tokens.refresh_token ?? params.existingRefresh;
  if (!refresh) {
    throw new Error(
      "No se recibió refresh_token. Revoca el acceso y reconecta con prompt=consent."
    );
  }
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  await query(
    `INSERT INTO oauth_tokens (id, google_email, access_token, refresh_token, scopes, token_type, expires_at, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (id) DO UPDATE SET
       google_email = EXCLUDED.google_email,
       access_token = EXCLUDED.access_token,
       refresh_token = EXCLUDED.refresh_token,
       scopes = EXCLUDED.scopes,
       token_type = EXCLUDED.token_type,
       expires_at = EXCLUDED.expires_at,
       updated_at = now()`,
    [
      email,
      encrypt(tokens.access_token),
      encrypt(refresh),
      tokens.scope.split(" "),
      tokens.token_type,
      expiresAt,
    ]
  );
  log.info(`tokens guardados para ${email}, expira ${expiresAt.toISOString()}`);
}

export async function hasConnection(): Promise<boolean> {
  const row = await queryOne(`SELECT 1 FROM oauth_tokens WHERE id = 1`);
  return row !== null;
}

/**
 * Devuelve un access_token válido, refrescándolo si quedan <120s.
 * Si el refresh falla (revocado/caducado), lanza para que la UI pida reconectar.
 */
export async function getValidAccessToken(): Promise<string> {
  const row = await queryOne<TokenRow>(
    `SELECT * FROM oauth_tokens WHERE id = 1`
  );
  if (!row) throw new Error("NO_CONNECTION: conecta tu cuenta de YouTube primero.");

  const msLeft = row.expires_at.getTime() - Date.now();
  if (msLeft > 120_000) return decrypt(row.access_token);

  log.info("access_token expira pronto, refrescando…");
  const refresh = decrypt(row.refresh_token);
  try {
    const refreshed = await refreshAccessToken(refresh);
    await saveTokens({
      email: row.google_email,
      tokens: refreshed,
      existingRefresh: refresh,
    });
    return refreshed.access_token;
  } catch (err) {
    log.error("refresh falló — se requiere reconectar", String(err));
    // alerta (BD + Telegram) con dedupe diario; import dinámico para evitar ciclos
    try {
      const { notify } = await import("@/lib/alerts/notify");
      await notify({
        kind: "token_failed",
        title: "Token de YouTube caducado o revocado",
        detail: "Los workers no pueden llamar a la API. Entra a la web y reconecta tu cuenta.",
        dedupeKey: `token:${new Date().toISOString().slice(0, 10)}`,
        dedupeHours: 12,
      });
    } catch { /* noop */ }
    throw new Error("REFRESH_FAILED: reconecta tu cuenta de YouTube.");
  }
}

export async function getScopes(): Promise<string[]> {
  const row = await queryOne<{ scopes: string[] }>(
    `SELECT scopes FROM oauth_tokens WHERE id = 1`
  );
  return row?.scopes ?? [];
}

/** True si tenemos el scope monetario (necesario para RPM/CPM/ingresos). */
export async function hasMonetaryScope(): Promise<boolean> {
  const scopes = await getScopes();
  return scopes.some((s) => s.includes("yt-analytics-monetary"));
}
