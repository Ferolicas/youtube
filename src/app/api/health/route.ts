import { NextResponse } from "next/server";
import { pool } from "@/lib/db/pool";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await pool.query("SELECT 1");
    return NextResponse.json({ ok: true, db: "up", ts: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ ok: false, db: "down", error: String(e) }, { status: 503 });
  }
}
