"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Clock, X, Loader2 } from "lucide-react";
import { Card, Badge } from "@/components/ui/primitives";
import { formatSeconds } from "@/lib/utils/duration";

export interface RecipeDTO {
  id: string;
  title: string;
  hook_angle: string | null;
  thumbnail_brief: string | null;
  suggested_duration_sec: number | null;
  keywords: string[] | null;
  script: string;
  model: string | null;
  for_date: string | null;
  created_at: string;
}

export function RecipeCard({ recipe }: { recipe: RecipeDTO }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function remove() {
    if (!confirm(`¿Eliminar la receta «${recipe.title}»? Esta acción no se puede deshacer.`)) return;
    setDeleting(true);
    setErr(null);
    try {
      const res = await fetch(`/api/recipes/${recipe.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErr(data.error ?? `error ${res.status}`);
        return;
      }
      router.refresh();
    } catch (e) {
      setErr(String(e));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-semibold text-fg">{recipe.title}</h3>
        <button
          onClick={remove}
          disabled={deleting}
          title="Eliminar receta"
          className="shrink-0 rounded-md p-1 text-muted hover:bg-danger/15 hover:text-danger disabled:opacity-50"
        >
          {deleting ? <Loader2 size={15} className="animate-spin" /> : <X size={15} />}
        </button>
      </div>

      <div className="flex flex-wrap gap-3 text-xs text-muted">
        {recipe.suggested_duration_sec != null && (
          <span className="inline-flex items-center gap-1"><Clock size={12} /> {formatSeconds(recipe.suggested_duration_sec)}</span>
        )}
        <span>Guardada: {recipe.created_at?.slice(0, 16).replace("T", " ")}</span>
        {recipe.model && <Badge tone="info">{recipe.model}</Badge>}
      </div>

      {recipe.hook_angle && (
        <p className="text-sm"><span className="text-muted">Gancho: </span>{recipe.hook_angle}</p>
      )}

      {(recipe.keywords ?? []).length > 0 && (
        <div className="flex flex-wrap gap-1">
          {(recipe.keywords ?? []).map((k) => <Badge key={k}>{k}</Badge>)}
        </div>
      )}

      <div className="flex items-center gap-2 border-t border-border pt-3">
        <button
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-2 rounded-lg bg-panel2 px-3 py-1.5 text-xs hover:bg-border"
        >
          <FileText size={13} /> {open ? "Ocultar guion" : "Ver guion"}
        </button>
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>

      {open && (
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg bg-bg p-3 text-xs leading-relaxed text-muted">{recipe.script}</pre>
      )}
    </Card>
  );
}
