import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { runSync } from "@/workers/sync";
import { runAnalysis } from "@/workers/analysis";
import { runTrends } from "@/workers/trends";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const bodySchema = z.object({
  task: z.enum(["sync", "sync_full", "analysis", "trends"]),
});

/** Dispara tareas manualmente desde la UI (además de los crons). */
export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "no autenticado" }, { status: 401 });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  // Lanzamos en background (no bloquea la respuesta); el progreso se ve en logs/sync_runs.
  const { task } = parsed.data;
  const job =
    task === "sync" ? runSync({ full: false })
    : task === "sync_full" ? runSync({ full: true })
    : task === "analysis" ? runAnalysis()
    : runTrends();
  job.catch((e) => console.error(`[api/sync] tarea ${task} falló:`, e));

  return NextResponse.json({ ok: true, started: task });
}
