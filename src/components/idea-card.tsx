"use client";
import { useState } from "react";
import { FileText, Loader2, Clock } from "lucide-react";
import { Card, Badge } from "@/components/ui/primitives";
import { formatSeconds } from "@/lib/utils/duration";

export interface IdeaDTO {
  id: string;
  title: string;
  hook_angle: string;
  thumbnail_brief: string;
  suggested_duration_sec: number;
  keywords: string[];
  suggested_publish_at: string;
  priority: string;
  rationale: unknown;
  source: string;
  has_script: boolean;
}

export function IdeaCard({ idea }: { idea: IdeaDTO }) {
  const [script, setScript] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rationale = idea.rationale as { por_que?: string; evidencia?: string } | null;

  async function loadScript() {
    const res = await fetch(`/api/ideas/${idea.id}/script`);
    if (res.ok) { setScript((await res.json()).script); setOpen(true); }
  }
  async function generate() {
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/ideas/${idea.id}/script`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? "error"); return; }
      await loadScript();
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  }

  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-semibold text-fg">{idea.title}</h3>
        <Badge tone="good">P{Math.round(Number(idea.priority))}</Badge>
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-muted">
        <span className="inline-flex items-center gap-1"><Clock size={12} /> {formatSeconds(idea.suggested_duration_sec)}</span>
        <span>Publicar: {idea.suggested_publish_at?.slice(0, 16).replace("T", " ")} UTC</span>
        <Badge tone={idea.source === "llm" ? "info" : "default"}>{idea.source}</Badge>
      </div>

      <div className="space-y-2 text-sm">
        <p><span className="text-muted">Gancho: </span>{idea.hook_angle}</p>
        <p><span className="text-muted">Miniatura: </span>{idea.thumbnail_brief}</p>
        {rationale?.por_que && <p className="text-xs text-muted">📊 {rationale.por_que} <em>({rationale.evidencia})</em></p>}
      </div>

      <div className="flex flex-wrap gap-1">
        {(idea.keywords ?? []).map((k) => <Badge key={k}>{k}</Badge>)}
      </div>

      <div className="flex items-center gap-2 border-t border-border pt-3">
        {idea.has_script || script ? (
          <button onClick={() => (open ? setOpen(false) : loadScript())} className="inline-flex items-center gap-2 rounded-lg bg-panel2 px-3 py-1.5 text-xs hover:bg-border">
            <FileText size={13} /> {open ? "Ocultar guion" : "Ver guion"}
          </button>
        ) : (
          <button onClick={generate} disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-accent/15 px-3 py-1.5 text-xs text-accent hover:bg-accent/25 disabled:opacity-50">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <FileText size={13} />} Generar guion
          </button>
        )}
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>

      {open && script && (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-bg p-3 text-xs leading-relaxed text-muted">{script}</pre>
      )}
    </Card>
  );
}
