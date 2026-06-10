import { type NextRequest } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getJobStates } from "@/lib/jobs/lock";
import { queueStats } from "@/lib/transcription/queue";
import { quotaSummary } from "@/lib/youtube/quota";
import { unseenAlertCount } from "@/lib/alerts/notify";
import { queryOne } from "@/lib/db/pool";

export const dynamic = "force-dynamic";

const INTERVAL_MS = 3000;

/**
 * SSE: estado en vivo para la UI (jobs corriendo, cola de transcripción,
 * cuota, alertas sin leer, último sync). El ActionBar lo consume con
 * EventSource y refresca la página cuando un job termina.
 */
export async function GET(req: NextRequest) {
  if (!(await getSession())) {
    return new Response("no autenticado", { status: 401 });
  }

  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const push = async () => {
        if (closed) return;
        try {
          const [jobs, queue, quota, unseen, lastSync] = await Promise.all([
            getJobStates(),
            queueStats(),
            quotaSummary(),
            unseenAlertCount(),
            queryOne<{ finished_at: string | null; status: string }>(
              `SELECT finished_at::text, status FROM sync_runs
               WHERE job_type='analytics' ORDER BY started_at DESC LIMIT 1`
            ),
          ]);
          const payload = JSON.stringify({
            ts: new Date().toISOString(),
            jobs, queue, quota,
            unseen_alerts: unseen,
            last_sync: lastSync,
          });
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
        } catch {
          // BD momentáneamente caída: el siguiente tick reintenta
        }
      };

      void push();
      timer = setInterval(() => void push(), INTERVAL_MS);

      req.signal.addEventListener("abort", () => {
        closed = true;
        if (timer) clearInterval(timer);
        try {
          controller.close();
        } catch { /* ya cerrado */ }
      });
    },
    cancel() {
      closed = true;
      if (timer) clearInterval(timer);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
