import { getScriptAnalysisData } from "@/lib/dashboard/queries";
import { Card, CardTitle, Stat, Badge, EmptyState, Th, Td } from "@/components/ui/primitives";
import { fmtNum } from "@/lib/utils/cn";

export const dynamic = "force-dynamic";

interface ContrastTerm { term: string; high_pct: number; low_pct: number; lift: number; }
interface Example { video_id: string; title: string | null; text: string; retention: number | null; views: number; reliable: boolean; }
interface Zone { contrast: ContrastTerm[]; examples_high: Example[]; examples_low: Example[]; }
interface Phrase { phrase: string; videos: number; avg_ret_with: number; avg_ret_without: number; delta: number; verdict: string; }
interface Guion {
  generated_at: string;
  diagnostics: {
    videos_total: number; long_form: number; with_retention: number; with_transcript: number;
    with_both: number; retention_points: { avg: number; min: number; max: number };
    low_view_threshold: number; reliable_with_both: number;
  };
  cohort: { size_high: number; size_low: number; reliable: boolean };
  abandonment: {
    items: { video_id: string; title: string | null; at_pct: number; at_sec: number; drop: number; phrase: string; views: number; reliable: boolean }[];
    hotspots: { bucket_pct: number; avg_drop: number; n: number }[];
  };
  hooks: Zone; middle: Zone; closing: Zone;
  recurring_phrases: Phrase[];
  recommendations: { type: string; text: string; evidence: string }[];
  caveats: string[];
}

function mmss(sec: number): string {
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function ContrastTable({ rows }: { rows: ContrastTerm[] }) {
  if (rows.length === 0) return <p className="text-sm text-muted">Sin patrones separables todavía.</p>;
  return (
    <table className="w-full">
      <thead><tr><Th>Patrón</Th><Th className="text-right">Alta ret.</Th><Th className="text-right">Baja ret.</Th><Th className="text-right">Δ</Th></tr></thead>
      <tbody>
        {rows.map((t) => (
          <tr key={t.term}>
            <Td>{t.term}</Td>
            <Td className="text-right tabular">{t.high_pct}%</Td>
            <Td className="text-right tabular">{t.low_pct}%</Td>
            <Td className="text-right tabular">
              <Badge tone={t.lift > 0 ? "good" : t.lift < 0 ? "bad" : "default"}>{t.lift > 0 ? "+" : ""}{t.lift}</Badge>
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Examples({ items, tone }: { items: Example[]; tone: "good" | "bad" }) {
  if (items.length === 0) return <p className="text-sm text-muted">—</p>;
  return (
    <div className="space-y-2">
      {items.map((e) => (
        <div key={e.video_id} className="rounded-lg border border-border/60 bg-panel2/40 p-2">
          <div className="mb-1 flex items-center gap-2 text-xs text-muted">
            <Badge tone={tone}>{e.retention !== null ? `${e.retention}% ret.` : "s/ret"}</Badge>
            <span>{fmtNum(e.views)} vistas</span>
            {!e.reliable && <Badge tone="warn">pocas vistas · poco fiable</Badge>}
          </div>
          <p className="line-clamp-3 text-sm text-fg">{e.text || <span className="text-muted">(sin texto en esta zona)</span>}</p>
        </div>
      ))}
    </div>
  );
}

function ZoneBlock({ title, hint, zone }: { title: string; hint: string; zone: Zone }) {
  return (
    <Card>
      <CardTitle hint={hint}>{title}</CardTitle>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase text-muted">Patrones: alta vs baja retención</p>
          <ContrastTable rows={zone.contrast} />
        </div>
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase text-accent">Ejemplos de ALTA retención</p>
            <Examples items={zone.examples_high} tone="good" />
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase text-danger">Ejemplos de BAJA retención</p>
            <Examples items={zone.examples_low} tone="bad" />
          </div>
        </div>
      </div>
    </Card>
  );
}

export default async function GuionPage() {
  const data = (await getScriptAnalysisData()) as Guion | null;
  if (!data) {
    return (
      <EmptyState
        title="Sin análisis de guion todavía"
        hint="Ejecuta “Analizar” (worker:analysis). Requiere transcripciones (transcripts/transcript_segments) y curvas de retención (video_retention)."
      />
    );
  }
  const d = data.diagnostics;
  const maxDrop = Math.max(0.0001, ...data.abandonment.hotspots.map((h) => h.avg_drop));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Análisis de guion</h1>
        <p className="text-sm text-muted">
          Cruza tus transcripciones con la curva de retención para entender qué funciona en tu narrativa.
        </p>
      </div>

      {/* Honestidad / limitaciones */}
      <Card className="border-warn/40 bg-warn/5">
        <CardTitle>Cómo leer esto (limitaciones)</CardTitle>
        <ul className="list-inside list-disc space-y-1 text-xs text-muted">
          {data.caveats.map((c, i) => <li key={i}>{c}</li>)}
        </ul>
      </Card>

      {/* Diagnóstico de datos */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Vídeos largos" value={fmtNum(d.long_form)} />
        <Stat label="Con transcripción + retención" value={fmtNum(d.with_both)} sub={`${fmtNum(d.reliable_with_both)} fiables (≥${fmtNum(d.low_view_threshold)} vistas)`} accent />
        <Stat label="Granularidad retención" value={`~${d.retention_points.avg} pts`} sub={`mín ${d.retention_points.min} · máx ${d.retention_points.max}`} />
        <Stat label="Cohortes (alta/baja)" value={`${data.cohort.size_high} / ${data.cohort.size_low}`} sub={data.cohort.reliable ? "solo vídeos fiables" : "incluye pocas vistas"} />
      </div>

      {/* 1. Puntos de abandono */}
      <Card>
        <CardTitle hint="caída de retención cruzada con la transcripción por timestamp">1 · Puntos de abandono</CardTitle>
        <div className="mb-4">
          <p className="mb-2 text-xs font-semibold uppercase text-muted">Dónde se cae (por % del vídeo)</p>
          <div className="space-y-1">
            {data.abandonment.hotspots.map((h) => (
              <div key={h.bucket_pct} className="flex items-center gap-2">
                <span className="w-16 text-right text-xs tabular text-muted">{h.bucket_pct}–{h.bucket_pct + 10}%</span>
                <div className="h-3 flex-1 rounded bg-panel2">
                  <div className="h-3 rounded bg-danger/70" style={{ width: `${(h.avg_drop / maxDrop) * 100}%` }} />
                </div>
                <span className="w-10 text-right text-xs tabular text-muted">{h.n}</span>
              </div>
            ))}
          </div>
        </div>
        {data.abandonment.items.length === 0 ? (
          <p className="text-sm text-muted">Sin momentos de abandono cruzables (faltan curvas de retención o transcripción).</p>
        ) : (
          <table className="w-full">
            <thead><tr><Th>Vídeo</Th><Th>Momento</Th><Th>Caída</Th><Th>Qué se decía</Th></tr></thead>
            <tbody>
              {data.abandonment.items.map((it, i) => (
                <tr key={`${it.video_id}-${i}`}>
                  <Td className="max-w-[180px] truncate">{it.title ?? it.video_id} {!it.reliable && <Badge tone="warn">poco fiable</Badge>}</Td>
                  <Td className="tabular">{mmss(it.at_sec)} <span className="text-muted">({it.at_pct}%)</span></Td>
                  <Td className="tabular text-danger">−{(it.drop * 100).toFixed(1)}</Td>
                  <Td className="max-w-[360px] text-sm">“{it.phrase || "—"}”</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* 2/3. Gancho, medio, cierre */}
      <ZoneBlock title="2 · Gancho (primeros 30s)" hint="apertura: alta vs baja retención" zone={data.hooks} />
      <ZoneBlock title="3 · Zona media" hint="40–65% del vídeo" zone={data.middle} />
      <ZoneBlock title="3 · Cierre / CTA" hint="último 15%" zone={data.closing} />

      {/* 4. Frases recurrentes */}
      <Card>
        <CardTitle hint="frases que repites, correlacionadas con retención">4 · Frases recurrentes</CardTitle>
        {data.recurring_phrases.length === 0 ? (
          <p className="text-sm text-muted">Sin frases recurrentes suficientes (mín. 3 vídeos).</p>
        ) : (
          <table className="w-full">
            <thead><tr><Th>Frase</Th><Th className="text-right">Vídeos</Th><Th className="text-right">Ret. con</Th><Th className="text-right">Ret. sin</Th><Th className="text-right">Δ</Th><Th>Veredicto</Th></tr></thead>
            <tbody>
              {data.recurring_phrases.map((p) => (
                <tr key={p.phrase}>
                  <Td>“{p.phrase}”</Td>
                  <Td className="text-right tabular">{p.videos}</Td>
                  <Td className="text-right tabular">{p.avg_ret_with}%</Td>
                  <Td className="text-right tabular">{p.avg_ret_without}%</Td>
                  <Td className="text-right tabular">{p.delta > 0 ? "+" : ""}{p.delta}</Td>
                  <Td><Badge tone={p.verdict === "ayuda" ? "good" : p.verdict === "perjudica" ? "bad" : "default"}>{p.verdict}</Badge></Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {/* 5. Recomendaciones */}
      <Card>
        <CardTitle hint="basadas en la evidencia de tu propio canal">5 · Recomendaciones accionables</CardTitle>
        <div className="space-y-3">
          {data.recommendations.map((r, i) => (
            <div key={i} className="flex items-start gap-3">
              <Badge tone={r.type === "conservar" ? "good" : r.type === "cambiar" ? "bad" : "info"}>{r.type}</Badge>
              <div>
                <p className="text-sm font-medium text-fg">{r.text}</p>
                <p className="text-xs text-muted">{r.evidence}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
