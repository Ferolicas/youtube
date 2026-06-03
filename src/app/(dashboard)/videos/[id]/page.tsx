import Link from "next/link";
import { notFound } from "next/navigation";
import { getVideoDetail } from "@/lib/dashboard/queries";
import { Card, CardTitle, Stat, Badge, Td, Th } from "@/components/ui/primitives";
import { RetentionChart, TimeSeries, ScatterLikeBars } from "@/components/charts/charts";
import { fmtNum, fmtPct, fmtMoney } from "@/lib/utils/cn";
import { formatSeconds } from "@/lib/utils/duration";

export const dynamic = "force-dynamic";

export default async function VideoDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await getVideoDetail(id);
  if (!d) notFound();
  const v = d.video as Record<string, string | number | boolean>;

  const retention = d.retention.map((r) => ({ x: Number(r.elapsed_ratio), ratio: Number(r.audience_watch_ratio) }));
  const daily = d.daily.map((r) => ({ date: r.date.slice(5), views: Number(r.views) }));
  const drivers = (d.outlier?.drivers ?? {}) as Record<string, unknown>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/videos" className="text-sm text-muted hover:text-fg">← Vídeos</Link>
        {v.is_short ? <Badge tone="info">Short</Badge> : <Badge>Largo</Badge>}
        {d.outlier?.is_outlier && <Badge tone="good">Outlier {Number(d.outlier.performance_ratio).toFixed(1)}×</Badge>}
      </div>
      <h1 className="text-xl font-bold">{String(v.title ?? id)}</h1>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Stat label="Duración" value={formatSeconds(Number(v.duration_seconds ?? 0))} />
        <Stat label="z-score" value={d.outlier ? Number(d.outlier.z_score).toFixed(2) : "—"} />
        <Stat label="Ingresos" value={d.revenue?.revenue ? fmtMoney(Number(d.revenue.revenue)) : "—"} accent />
        <Stat label="RPM" value={d.revenue?.rpm ? fmtMoney(Number(d.revenue.rpm)) : "—"} />
        <Stat label="CPM" value={d.revenue?.cpm ? fmtMoney(Number(d.revenue.cpm)) : "—"} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle hint="audienceWatchRatio">Curva de retención</CardTitle>
          {retention.length ? <RetentionChart data={retention} /> : <p className="text-sm text-muted">Sin datos de retención (posible umbral de privacidad por baja vista).</p>}
        </Card>
        <Card>
          <CardTitle>Vistas por día</CardTitle>
          {daily.length ? <TimeSeries data={daily} xKey="date" yKey="views" /> : <p className="text-sm text-muted">Sin serie diaria.</p>}
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card>
          <CardTitle>Fuentes de tráfico</CardTitle>
          {d.traffic.length ? (
            <ScatterLikeBars data={d.traffic.map((t) => ({ label: t.source_type, value: Number(t.views) }))} />
          ) : <p className="text-sm text-muted">Sin datos.</p>}
        </Card>
        <Card>
          <CardTitle>Geografía (top)</CardTitle>
          {d.geography.length ? (
            <table className="w-full"><tbody>
              {d.geography.map((g) => (
                <tr key={g.country_code}><Td>{g.country_code}</Td><Td className="text-right tabular">{fmtNum(Number(g.views))}</Td></tr>
              ))}
            </tbody></table>
          ) : <p className="text-sm text-muted">Sin datos (umbral de privacidad).</p>}
        </Card>
        <Card>
          <CardTitle>Dispositivos / Demografía</CardTitle>
          {d.devices.length ? (
            <div className="space-y-1">
              {d.devices.map((dev) => (
                <div key={dev.device_type} className="flex justify-between text-sm"><span>{dev.device_type}</span><span className="tabular">{fmtNum(Number(dev.views))}</span></div>
              ))}
            </div>
          ) : <p className="text-sm text-muted">Sin datos de dispositivo.</p>}
          {d.demographics.length > 0 && (
            <div className="mt-3 border-t border-border pt-2">
              {d.demographics.slice(0, 5).map((dm, i) => (
                <div key={i} className="flex justify-between text-xs text-muted"><span>{dm.age_group} · {dm.gender}</span><span>{fmtPct(Number(dm.viewer_percentage))}</span></div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {d.outlier?.is_outlier && (
        <Card>
          <CardTitle hint="qué explica el rendimiento">Drivers del outlier</CardTitle>
          <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-3">
            {Object.entries(drivers).map(([k, val]) => (
              <div key={k} className="rounded-lg bg-panel2 p-2">
                <span className="text-xs text-muted">{k}</span>
                <div className="font-medium">{String(val)}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardTitle>Primeros segundos (transcripción)</CardTitle>
          {d.transcriptHead?.snippet ? (
            <p className="text-sm leading-relaxed text-muted">{d.transcriptHead.snippet}…</p>
          ) : <p className="text-sm text-muted">Sin transcripción todavía.</p>}
        </Card>
        <Card>
          <CardTitle>Tags ({d.tags.length})</CardTitle>
          <div className="flex flex-wrap gap-1">
            {d.tags.length ? d.tags.map((t) => <Badge key={t.tag}>{t.tag}</Badge>) : <span className="text-sm text-warn">Sin tags (mala práctica SEO)</span>}
          </div>
        </Card>
      </div>
    </div>
  );
}
