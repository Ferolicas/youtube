import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { acquireJobLock, type JobName } from "@/lib/jobs/lock";
import { runSync } from "@/workers/sync";
import { runAnalysis } from "@/workers/analysis";
import { runTrends } from "@/workers/trends";
import { generateDailyIdeas } from "@/lib/ideas/generate";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  task: z.enum(["sync", "sync_full", "analysis", "trends", "ideas"]),
});

/** Mapa tarea -> (job lock, función). sync/sync_full comparten el lock 'sync'. */
const TASKS: Record<string, { job: JobName; fn: () => Promise<unknown> }> = {
  sync: { job: "sync", fn: () => runSync({ full: false }) },
  sync_full: { job: "sync", fn: () => runSync({ full: true }) },
  analysis: { job: "analysis", fn: () => runAnalysis() },
  trends: { job: "trends", fn: () => runTrends() },
  ideas: { job: "ideas", fn: () => generateDailyIdeas() },
};

/**
 * Dispara tareas manualmente desde la UI (además de los crons).
 * Exclusión: si el job ya corre (cron o botón), responde 409 en vez de duplicar.
 * Nota: runSync/runAnalysis/runTrends ya llevan su propio withJobLock interno;
 * aquí solo COMPROBAMOS disponibilidad con un try-lock efímero para poder
 * responder 409 de forma inmediata y honesta al usuario.
 */
export async function POST(req: NextRequest) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "no autenticado" }, { status: 401 });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { task } = parsed.data;
  const def = TASKS[task]!;

  // try-lock efímero: si está ocupado -> 409. Si está libre, lo soltamos al
  // instante y lanzamos la tarea (que re-adquiere su lock al empezar).
  const probe = await acquireJobLock(def.job, { silent: true });
  if (!probe) {
    return NextResponse.json(
      { error: `la tarea '${def.job}' ya está en ejecución` },
      { status: 409 }
    );
  }
  await probe.release();

  // Lanzamos en background; el progreso se ve en vivo vía /api/events.
  def.fn().catch((e) => console.error(`[api/sync] tarea ${task} falló:`, e));

  return NextResponse.json({ ok: true, started: task });
}
