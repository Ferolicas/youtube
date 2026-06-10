"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { RefreshCw, BarChart3, TrendingUp, Lightbulb, Bell, Loader2 } from "lucide-react";

type Task = "sync" | "sync_full" | "analysis" | "trends" | "ideas";

interface JobState {
  job_name: string;
  running: boolean;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
}
interface LiveStatus {
  ts: string;
  jobs: JobState[];
  queue: Record<string, number>;
  quota: Record<string, { used: number; limit: number }>;
  unseen_alerts: number;
  last_sync: { finished_at: string | null; status: string } | null;
}

const TASK_TO_JOB: Record<Task, string> = {
  sync: "sync", sync_full: "sync", analysis: "analysis", trends: "trends", ideas: "ideas",
};

/**
 * Barra de acciones EN VIVO: se conecta a /api/events (SSE), muestra qué job
 * corre ahora mismo, deshabilita los botones mientras tanto y refresca los
 * datos de la página automáticamente cuando un job termina.
 */
export function ActionBar() {
  const router = useRouter();
  const [status, setStatus] = useState<LiveStatus | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const prevRunning = useRef<Set<string>>(new Set());

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as LiveStatus;
        setStatus(data);
        const nowRunning = new Set(data.jobs.filter((j) => j.running).map((j) => j.job_name));
        // ¿terminó algo que estaba corriendo? -> refrescar datos del server
        for (const j of prevRunning.current) {
          if (!nowRunning.has(j) && j !== "pulse") {
            router.refresh();
            setMsg(`'${j}' terminó`);
            break;
          }
        }
        prevRunning.current = nowRunning;
      } catch { /* evento malformado: ignorar */ }
    };
    es.onerror = () => { /* EventSource reintenta solo */ };
    return () => es.close();
  }, [router]);

  async function trigger(task: Task) {
    setMsg(null);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task }),
      });
      const data = await res.json();
      if (res.status === 409) setMsg(`⏳ ${data.error}`);
      else if (!res.ok) setMsg(`Error: ${data.error ?? res.status}`);
      else setMsg(`'${task}' lanzada`);
    } catch (e) {
      setMsg(`Error: ${String(e)}`);
    }
  }

  const runningJobs = new Set((status?.jobs ?? []).filter((j) => j.running).map((j) => j.job_name));
  const anyTaskRunning = ["sync", "analysis", "trends", "ideas"].some((j) => runningJobs.has(j));
  const isRunning = (task: Task) => runningJobs.has(TASK_TO_JOB[task]);

  const btn = "inline-flex items-center gap-2 rounded-lg border border-border bg-panel2 px-3 py-1.5 text-xs font-medium text-fg hover:bg-border disabled:opacity-50";

  return (
    <div className="flex items-center gap-2">
      {msg && <span className="mr-1 max-w-64 truncate text-xs text-muted">{msg}</span>}
      {anyTaskRunning && (
        <span className="inline-flex items-center gap-1.5 rounded-lg bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent">
          <Loader2 size={12} className="animate-spin" />
          {[...runningJobs].filter((j) => j !== "pulse").join(", ")}
        </span>
      )}
      {runningJobs.has("pulse") && (
        <span className="text-xs text-muted" title="pulso de catálogo en curso">●</span>
      )}
      <button className={btn} disabled={anyTaskRunning} onClick={() => trigger("sync")}>
        <RefreshCw size={13} className={isRunning("sync") ? "animate-spin" : ""} /> Sync
      </button>
      <button className={btn} disabled={anyTaskRunning} onClick={() => trigger("ideas")}>
        <Lightbulb size={13} className={isRunning("ideas") ? "animate-pulse" : ""} /> Ideas diarias
      </button>
      <button className={btn} disabled={anyTaskRunning} onClick={() => trigger("trends")}>
        <TrendingUp size={13} /> Tendencias
      </button>
      <button className={btn} disabled={anyTaskRunning} onClick={() => trigger("analysis")}>
        <BarChart3 size={13} /> Analizar
      </button>
      <Link
        href="/alerts"
        className="relative inline-flex items-center rounded-lg border border-border bg-panel2 p-1.5 text-fg hover:bg-border"
        title="Alertas"
      >
        <Bell size={14} />
        {(status?.unseen_alerts ?? 0) > 0 && (
          <span className="absolute -right-1.5 -top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
            {status!.unseen_alerts > 99 ? "99+" : status!.unseen_alerts}
          </span>
        )}
      </Link>
    </div>
  );
}
