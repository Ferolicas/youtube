import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import { buildAuthUrl } from "@/lib/auth/google-oauth";

export const dynamic = "force-dynamic";

/** Inicia el flujo OAuth: genera state CSRF y redirige al consentimiento de Google. */
export async function GET() {
  const state = randomBytes(16).toString("hex");
  const store = await cookies();
  store.set("pk_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });
  return NextResponse.redirect(buildAuthUrl(state));
}
