import Link from "next/link";
import { getSeoData, getSeoScoresData, getChannelSearchTerms } from "@/lib/dashboard/queries";
import { Card, CardTitle, Stat, Badge, EmptyState, Th, Td } from "@/components/ui/primitives";
import { fmtNum } from "@/lib/utils/cn";

export const dynamic = "force-dynamic";

interface SeoSnap {
  findings: { severity: "alta" | "media" | "baja"; area: string; issue: string; recommendation: string; count?: number }[];
  channel_keywords: string | null;
  top_tags: { tag: string; count: number }[];
  health_score: number;
}
interface ScoresSnap {
  computed: number;
  avg_score: number | null;
  content_gaps?: { term: string; weight: number; source: string }[];
}
interface ScoreComponent {
  key: string; label: string; points: number; max: number; fix: string | null;
}

export default async function ConfigAuditPage() {
  const [snap, scores, searchTerms] = await Promise.all([
    getSeoData() as Promise<SeoSnap | null>,
    getSeoScoresData(),
    getChannelSearchTerms(20),
  ]);
  if (!snap) return <EmptyState title="Sin diagnóstico de configuración" hint="Ejecuta Sync + Analizar." />;

  const scoresSnap = scores.snapshot as ScoresSnap | null;
  const tone = (s: string): "bad" | "warn" | "default" =>
    s === "alta" ? "bad" : s === "media" ? "warn" : "default";
  const scoreTone = (n: number): "good" | "warn" | "bad" => (n >= 75 ? "good" : n >= 50 ? "warn" : "bad");

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Configuración & SEO</h1>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Health score (canal)" value={`${snap.health_score}/100`} accent={snap.health_score >= 70} />
        <Stat label="SEO medio (vídeos)" value={scoresSnap?.avg_score != null ? `${scoresSnap.avg_score}/100` : "—"} accent={(scoresSnap?.avg_score ?? 0) >= 70} />
        <Stat label="Hallazgos" value={snap.findings.length} />
        <Stat label="Gaps de contenido" value={scoresSnap?.content_gaps?.length ?? 0} />
      </div>

      <Card>
        <CardTitle hint="te buscan así — úsalo en títulos/tags">Búsquedas reales que traen vistas (90d)</CardTitle>
        {searchTerms.length ? (
          <div className="flex flex-wrap gap-2">
            {searchTerms.map((t) => (
              <Badge key={t.term} tone="info">{t.term} · {fmtNum(Number(t.views))}</Badge>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted">Sin datos aún: corre un Sync (se piden a Analytics con el detalle YT_SEARCH).</p>
        )}
      </Card>

      {(scoresSnap?.content_gaps?.length ?? 0) > 0 && (
        <Card>
          <CardTitle hint="búsquedas/tendencias SIN vídeo tuyo que las cubra">Gaps de contenido — oportunidades</CardTitle>
          <table className="w-full">
            <thead><tr><Th>Término</Th><Th>Fuente</Th><Th className="text-right">Peso</Th></tr></thead>
            <tbody>
              {scoresSnap!.content_gaps!.map((g) => (
                <tr key={`${g.term}-${g.source}`}>
                  <Td className="font-medium">{g.term}</Td>
                  <Td><Badge tone={g.source === "búsqueda real" ? "good" : "default"}>{g.source}</Badge></Td>
                  <Td className="text-right tabular">{fmtNum(g.weight)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card>
        <CardTitle hint={`${scores.rows.length} vídeos evaluados — peores primero`}>SEO Score por vídeo</CardTitle>
        {scores.rows.length === 0 ? (
          <p className="text-sm text-muted">Ejecuta “Analizar” para calcular los scores.</p>
        ) : (
          <div className="space-y-2">
            {scores.rows.slice(0, 20).map((r) => {
              const comps = (r.components as ScoreComponent[]) ?? [];
              const fixes = comps.filter((c) => c.fix && c.points < c.max);
              return (
                <details key={r.video_id} className="rounded-lg border border-border bg-panel2 p-3">
                  <summary className="flex cursor-pointer items-center justify-between gap-3">
                    <Link href={`/videos/${r.video_id}`} className="min-w-0 flex-1 truncate text-sm font-medium hover:text-accent">
                      {r.title}
                    </Link>
                    <Badge tone={scoreTone(r.score)}>{r.score}/100</Badge>
                  </summary>
                  <ul className="mt-3 space-y-1.5 border-t border-border/50 pt-3">
                    {fixes.length === 0 && <li className="text-xs text-muted">Sin arreglos pendientes relevantes.</li>}
                    {fixes.map((c) => (
                      <li key={c.key} className="text-xs">
                        <span className="text-muted">[{c.points}/{c.max}]</span>{" "}
                        <span className="text-fg">{c.label}:</span>{" "}
                        <span className="text-muted">{c.fix}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              );
            })}
          </div>
        )}
      </Card>

      <Card>
        <CardTitle>Hallazgos priorizados (canal)</CardTitle>
        <div className="space-y-3">
          {snap.findings.map((f, i) => (
            <div key={i} className="rounded-lg border border-border bg-panel2 p-3">
              <div className="mb-1 flex items-center gap-2">
                <Badge tone={tone(f.severity)}>{f.severity}</Badge>
                <span className="text-xs text-muted">{f.area}</span>
                {f.count !== undefined && <span className="text-xs text-muted">· {f.count} afectados</span>}
              </div>
              <p className="text-sm font-medium text-fg">{f.issue}</p>
              <p className="text-sm text-muted">→ {f.recommendation}</p>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>Keywords actuales del canal</CardTitle>
          {snap.channel_keywords ? (
            <p className="text-sm text-muted">{snap.channel_keywords}</p>
          ) : <p className="text-sm text-warn">Sin keywords configuradas en el canal.</p>}
        </Card>
        <Card>
          <CardTitle>Tags más usados</CardTitle>
          <table className="w-full">
            <thead><tr><Th>Tag</Th><Th className="text-right">Usos</Th></tr></thead>
            <tbody>{snap.top_tags.map((t) => (<tr key={t.tag}><Td>{t.tag}</Td><Td className="text-right tabular">{t.count}</Td></tr>))}</tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}
