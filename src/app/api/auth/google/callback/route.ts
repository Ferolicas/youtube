import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { env } from "@/config/env";
import { exchangeCode, fetchUserInfo } from "@/lib/auth/google-oauth";
import { saveTokens } from "@/lib/auth/tokens";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { createLogger } from "@/lib/utils/logger";

export const dynamic = "force-dynamic";
const log = createLogger("oauth:callback");

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const store = await cookies();
  const expectedState = store.get("pk_oauth_state")?.value;
  store.delete("pk_oauth_state");

  const fail = (msg: string) =>
    NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(msg)}`, env.APP_URL));

  if (error) return fail(`Google devolvió: ${error}`);
  if (!code) return fail("Falta el código de autorización.");
  if (!state || state !== expectedState) return fail("State inválido (posible CSRF).");

  try {
    const tokens = await exchangeCode(code);
    const info = await fetchUserInfo(tokens.access_token);

    if (info.email.toLowerCase() !== env.ALLOWED_EMAIL.toLowerCase()) {
      log.warn(`intento de acceso no autorizado: ${info.email}`);
      return fail("Esta cuenta no está autorizada.");
    }

    await saveTokens({ email: info.email, tokens });
    const session = await createSession(info.email);
    await setSessionCookie(session);
    log.info(`conexión OK para ${info.email}`);
    return NextResponse.redirect(new URL("/", env.APP_URL));
  } catch (e) {
    log.error("callback falló", String(e));
    return fail("No se pudo completar la conexión. Revisa scopes y vuelve a intentar.");
  }
}
