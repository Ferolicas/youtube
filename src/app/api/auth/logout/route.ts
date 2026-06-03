import { NextResponse } from "next/server";
import { env } from "@/config/env";
import { clearSessionCookie } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function POST() {
  await clearSessionCookie();
  return NextResponse.redirect(new URL("/login", env.APP_URL), { status: 303 });
}
