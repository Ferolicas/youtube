import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { markAlertsSeen } from "@/lib/alerts/notify";

export const dynamic = "force-dynamic";

/** Marca todas las alertas como leídas (lo usa la página /alerts). */
export async function POST() {
  if (!(await getSession())) {
    return NextResponse.json({ error: "no autenticado" }, { status: 401 });
  }
  await markAlertsSeen();
  return NextResponse.json({ ok: true });
}
