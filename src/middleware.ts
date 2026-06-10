import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

/**
 * Protege todo salvo login, callback OAuth y assets.
 * Verificación HMAC del JWT de sesión (sin tocar BD; compatible con runtime edge/node).
 */
const SECRET = new TextEncoder().encode(process.env.SESSION_SECRET ?? "");
const PUBLIC_PATHS = [
  "/login",
  "/api/auth/google",
  "/api/auth/google/callback",
  "/api/health",
  // WebSub: Google verifica (GET challenge) y notifica (POST firmado con HMAC).
  "/api/websub",
];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/")) ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon")
  ) {
    return NextResponse.next();
  }

  const token = req.cookies.get("pk_session")?.value;
  let valid = false;
  if (token) {
    try {
      await jwtVerify(token, SECRET);
      valid = true;
    } catch {
      valid = false;
    }
  }

  if (!valid) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
