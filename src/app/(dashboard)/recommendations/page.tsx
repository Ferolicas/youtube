import { getRecommendationsData } from "@/lib/dashboard/queries";
import { Card, Badge, EmptyState } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

const AREA_LABEL: Record<string, string> = {
  config: "Configuración", format_mix: "Mix de formatos", cadence: "Cadencia",
  seo: "SEO", monetization: "Monetización", branding: "Branding",
};

export default async function RecommendationsPage() {
  const recs = await getRecommendationsData();
  if (recs.length === 0) {
    return <EmptyState title="Sin recomendaciones" hint="Ejecuta “Analizar” para generar recomendaciones priorizadas a partir de tus datos." />;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Reestructuración del canal</h1>
      <p className="text-sm text-muted">Recomendaciones específicas a tus datos, ordenadas por impacto y esfuerzo.</p>

      <div className="space-y-3">
        {recs.map((r) => {
          const impact = Math.round(Number(r.impact));
          const effort = Math.round(Number(r.effort));
          return (
            <Card key={r.id} className="flex items-start gap-4">
              <div className="flex flex-col items-center gap-1">
                <span className="text-2xl font-bold text-accent tabular">{impact}</span>
                <span className="text-[10px] uppercase text-muted">impacto</span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-2">
                  <Badge tone="info">{AREA_LABEL[r.area] ?? r.area}</Badge>
                  <span className="text-xs text-muted">esfuerzo {effort}/5</span>
                </div>
                <p className="font-semibold text-fg">{r.title}</p>
                <p className="mt-1 text-sm text-muted">{r.detail}</p>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
