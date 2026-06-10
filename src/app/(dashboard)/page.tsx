import Link from "next/link";
import { getOverview, getTopMovers, getChannelGrowth } from "@/lib/dashboard/queries";
import { Card, CardTitle, Stat, Badge, Th, Td } from "@/components/ui/primitives";
import { fmtNum } from "@/lib/utils/cn";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const [o, movers, growth] = await Promise.all([
    getOverview(),
    getTopMovers(8),
    getChannelGrowth(),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Overview</h1>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat
          label="Suscriptores"
          value={fmtNum(Number(o.channel?.subscriber_count ?? 0))}
          sub={growth?.subs_30d ? `${Number(growth.subs_30d) >= 0 ? "+" : ""}${fmtNum(Number(growth.subs_30d))} en 30d` : undefined}
          accent
        />
        <Stat
          label="Vistas 7d (canal)"
          value={growth?.views_7d ? fmtNum(Number(growth.views_7d)) : "—"}
          sub={growth?.views_30d ? `${fmtNum(Number(growth.views_30d))} en 30d` : "corre un Sync para la serie de canal"}
        />
        <Stat label="Vídeos largos" value={fmtNum(Number(o.counts?.longs ?? 0))} sub={`mediana ${fmtNum(o.medians.long ?? 0)} vistas`} />
        <Stat label="Transcritos" value={`${fmtNum(Number(o.counts?.transcribed ?? 0))}/${fmtNum(Number(o.counts?.total ?? 0))}`} />
      </div>

      <Card>
        <CardTitle hint="vistas ganadas últimas ~24h (pulso cada 30 min)">Moviéndose AHORA</CardTitle>
        {movers.length === 0 ? (
          <p className="text-sm text-muted">
            Aún sin datos de pulso suficientes (se necesitan ≥2 snapshots separados ~24h).
            Arranca <code className="rounded bg-panel2 px-1">pk-pulse</code> en PM2 o corre <code className="rounded bg-panel2 px-1">npm run pulse</code>.
          </p>
        ) : (
          <table className="w-full">
            <thead><tr><Th>Vídeo</Th><Th className="text-right">+Vistas</Th><Th className="text-right">v/h</Th><Th className="text-right">Total</Th></tr></thead>
            <tbody>
              {movers.map((m) => (
                <tr key={m.video_id}>
                  <Td><Link href={`/videos/${m.video_id}`} className="hover:text-accent">{m.title}</Link></Td>
                  <Td className="text-right tabular"><Badge tone="good">+{fmtNum(Number(m.gained))}</Badge></Td>
                  <Td className="text-right tabular">{m.vph}</Td>
                  <Td className="text-right tabular text-muted">{fmtNum(Number(m.total))}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

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
