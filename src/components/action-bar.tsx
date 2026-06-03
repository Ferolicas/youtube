"use client";
import { useState } from "react";
import { RefreshCw, BarChart3, TrendingUp } from "lucide-react";

type Task = "sync" | "sync_full" | "analysis" | "trends";

export function ActionBar() {
  const [busy, setBusy] = useState<Task | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function trigger(task: Task) {
    setBusy(task);
    setMsg(null);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task }),
      });
      const data = await res.json();
      setMsg(res.ok ? `Tarea '${task}' lanzada (ver logs).` : `Error: ${data.error ?? res.status}`);
    } catch (e) {
      setMsg(`Error: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  const btn = "inline-flex items-center gap-2 rounded-lg border border-border bg-panel2 px-3 py-1.5 text-xs font-medium text-fg hover:bg-border disabled:opacity-50";

  return (
    <div className="flex items-center gap-2">
      {msg && <span className="mr-2 text-xs text-muted">{msg}</span>}
      <button className={btn} disabled={!!busy} onClick={() => trigger("sync")}>
        <RefreshCw size={13} className={busy === "sync" ? "animate-spin" : ""} /> Sync
      </button>
      <button className={btn} disabled={!!busy} onClick={() => trigger("trends")}>
        <TrendingUp size={13} /> Tendencias
      </button>
      <button className={btn} disabled={!!busy} onClick={() => trigger("analysis")}>
        <BarChart3 size={13} /> Analizar
      </button>
    </div>
  );
}
