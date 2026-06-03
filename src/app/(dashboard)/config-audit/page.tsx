import { getSeoData } from "@/lib/dashboard/queries";
import { Card, CardTitle, Stat, Badge, EmptyState, Th, Td } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

interface SeoSnap {
  findings: { severity: "alta" | "media" | "baja"; area: string; issue: string; recommendation: string; count?: number }[];
  channel_keywords: string | null;
  top_tags: { tag: string; count: number }[];
  health_score: number;
}

export default async function ConfigAuditPage() {
  const snap = (await getSeoData()) as SeoSnap | null;
  if (!snap) return <EmptyState title="Sin diagnóstico de configuración" hint="Ejecuta Sync + Analizar." />;

  const tone = (s: string): "bad" | "warn" | "default" =>
    s === "alta" ? "bad" : s === "media" ? "warn" : "default";

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Configuración & SEO</h1>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <Stat label="Health score" value={`${snap.health_score}/100`} accent={snap.health_score >= 70} />
        <Stat label="Hallazgos" value={snap.findings.length} />
        <Stat label="Tags únicos (top)" value={snap.top_tags.length} />
      </div>

      <Card>
        <CardTitle>Hallazgos priorizados</CardTitle>
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
