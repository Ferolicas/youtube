import Link from "next/link";
import { getOverview } from "@/lib/dashboard/queries";
import { Card, CardTitle, Stat, Badge, Th, Td } from "@/components/ui/primitives";
import { fmtNum } from "@/lib/utils/cn";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const o = await getOverview();

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Overview</h1>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Suscriptores" value={fmtNum(Number(o.channel?.subscriber_count ?? 0))} accent />
        <Stat label="Vídeos largos" value={fmtNum(Number(o.counts?.longs ?? 0))} sub={`mediana ${fmtNum(o.medians.long ?? 0)} vistas`} />
        <Stat label="Shorts" value={fmtNum(Number(o.counts?.shorts ?? 0))} sub={`mediana ${fmtNum(o.medians.short ?? 0)} vistas`} />
        <Stat label="Transcritos" value={`${fmtNum(Number(o.counts?.transcribed ?? 0))}/${fmtNum(Number(o.counts?.total ?? 0))}`} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardTitle hint="vistas vs mediana del canal">Top outliers</CardTitle>
          {o.outliers.length === 0 ? (
            <p className="text-sm text-muted">Aún sin outliers calculados. Ejecuta “Analizar”.</p>
          ) : (
            <table className="w-full">
              <thead><tr><Th>Título</Th><Th className="text-right">Vistas</Th><Th className="text-right">×mediana</Th></tr></thead>
              <tbody>
                {o.outliers.map((v) => (
                  <tr key={v.video_id}>
                    <Td><Link href={`/videos/${v.video_id}`} className="hover:text-accent">{v.title}</Link></Td>
                    <Td className="text-right tabular">{fmtNum(Number(v.views))}</Td>
                    <Td className="text-right tabular"><Badge tone="good">{Number(v.performance_ratio).toFixed(1)}×</Badge></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <div className="space-y-6">
          <Card>
            <CardTitle>Cola de transcripción</CardTitle>
            <div className="flex flex-wrap gap-2">
              {Object.entries(o.transcription).length === 0 && <span className="text-sm text-muted">vacía</span>}
              {Object.entries(o.transcription).map(([k, v]) => (
                <Badge key={k} tone={k === "done" ? "good" : k === "failed" ? "bad" : "default"}>{k}: {v}</Badge>
              ))}
            </div>
          </Card>

          <Card>
            <CardTitle>Cuota API (hoy)</CardTitle>
            <div className="space-y-2">
              {Object.entries(o.quota).map(([api, q]) => (
                <div key={api}>
                  <div className="flex justify-between text-xs text-muted">
                    <span>{api}</span><span className="tabular">{fmtNum(q.used)}/{fmtNum(q.limit)}</span>
                  </div>
                  <div className="mt-1 h-1.5 w-full rounded-full bg-panel2">
                    <div className="h-1.5 rounded-full bg-accent2" style={{ width: `${Math.min(100, (q.used / q.limit) * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardTitle>Último sync</CardTitle>
            <p className="text-sm">
              {o.lastSync ? (
                <>
                  <Badge tone={o.lastSync.status === "done" ? "good" : o.lastSync.status === "paused_quota" ? "warn" : "bad"}>{o.lastSync.status}</Badge>
                  <span className="ml-2 text-muted">{o.lastSync.finished_at?.slice(0, 16).replace("T", " ")}</span>
                </>
              ) : <span className="text-muted">nunca</span>}
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}
