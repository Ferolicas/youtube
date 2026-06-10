import Link from "next/link";
import { getOutliersData } from "@/lib/dashboard/queries";
import { INCLUDE_SHORTS } from "@/lib/analysis/scope";
import { Card, CardTitle, Badge, Th, Td, EmptyState } from "@/components/ui/primitives";
import { fmtNum } from "@/lib/utils/cn";

export const dynamic = "force-dynamic";

interface Driver { feature: string; outliers_avg: number; normal_avg: number; lift: number | null }
interface FmtBlock { count: number; outlier_count: number; median_views: number; mean_views: number; drivers: Driver[] }

export default async function OutliersPage() {
  const { snapshot, rows } = await getOutliersData();
  if (!snapshot && rows.length === 0) {
    return <EmptyState title="Sin análisis de outliers" hint="Ejecuta “Analizar” tras sincronizar datos." />;
  }
  const snap = snapshot as Record<string, FmtBlock> | null;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Análisis de outliers</h1>
      <p className="text-sm text-muted">Compara estadísticamente tus vídeos de alto rendimiento (≥10K o z≥2) contra la mediana del canal e identifica qué variables los explican.</p>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {(INCLUDE_SHORTS ? (["long", "short"] as const) : (["long"] as const)).map((fmt) => {
          const b = snap?.[fmt];
          if (!b) return null;
          return (
            <Card key={fmt}>
              <CardTitle hint={`${b.outlier_count}/${b.count} outliers`}>{fmt === "long" ? "Vídeos largos" : "Shorts"}</CardTitle>
              <div className="mb-3 flex gap-4 text-sm">
                <span className="text-muted">Mediana: <span className="tabular text-fg">{fmtNum(b.median_views)}</span></span>
                <span className="text-muted">Media: <span className="tabular text-fg">{fmtNum(b.mean_views)}</span></span>
              </div>
              <table className="w-full">
                <thead><tr><Th>Driver</Th><Th className="text-right">Outliers</Th><Th className="text-right">Resto</Th><Th className="text-right">Lift</Th></tr></thead>
                <tbody>
                  {b.drivers.map((dr) => (
                    <tr key={dr.feature}>
                      <Td>{dr.feature}</Td>
                      <Td className="text-right tabular">{dr.outliers_avg}</Td>
                      <Td className="text-right tabular text-muted">{dr.normal_avg}</Td>
                      <Td className="text-right">{dr.lift !== null ? <Badge tone={dr.lift > 0.1 ? "good" : dr.lift < -0.1 ? "bad" : "default"}>{dr.lift > 0 ? "+" : ""}{(dr.lift * 100).toFixed(0)}%</Badge> : "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardTitle>Outliers detectados</CardTitle>
        <table className="w-full">
          <thead><tr><Th>Título</Th><Th>Tipo</Th><Th className="text-right">Vistas</Th><Th className="text-right">z</Th><Th className="text-right">×mediana</Th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.video_id} className="hover:bg-panel/50">
                <Td><Link href={`/videos/${r.video_id}`} className="hover:text-accent">{r.title}</Link></Td>
                <Td>{r.is_short ? <Badge tone="info">Short</Badge> : <Badge>Largo</Badge>}</Td>
                <Td className="text-right tabular">{fmtNum(Number(r.views))}</Td>
                <Td className="text-right tabular">{Number(r.z_score).toFixed(2)}</Td>
                <Td className="text-right"><Badge tone="good">{Number(r.performance_ratio).toFixed(1)}×</Badge></Td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
