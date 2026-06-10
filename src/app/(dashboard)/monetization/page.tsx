import Link from "next/link";
import { getMonetizationData } from "@/lib/dashboard/queries";
import { Card, CardTitle, Stat, Badge, EmptyState, Th, Td } from "@/components/ui/primitives";
import { SimpleBar } from "@/components/charts/charts";
import { fmtMoney, fmtNum } from "@/lib/utils/cn";

export const dynamic = "force-dynamic";

interface MonSnap {
  available: boolean;
  reason?: string;
  videos_with_revenue?: number;
  total_revenue: number;
  channel_rpm: number | null;
  by_duration: { bucket: string; videos: number; revenue: number; avg_rpm: number | null }[];
  by_country_latam: { country: string; revenue: number; cpm: number | null; monetized_playbacks: number }[];
  top_earners: { video_id: string; title: string; revenue: number; rpm: number | null; cpm: number | null }[];
  under_monetized_long: { video_id: string; title: string; rpm: number | null }[];
  recommendations: string[];
}

export default async function MonetizationPage() {
  const snap = (await getMonetizationData()) as MonSnap | null;

  if (!snap) return <EmptyState title="Sin análisis de monetización" hint="Ejecuta Sync + Analizar." />;
  if (!snap.available) {
    return (
      <div className="space-y-4">
        <h1 className="text-xl font-bold">Monetización AdSense</h1>
        <div className="rounded-lg border border-warn/30 bg-warn/10 p-4 text-sm text-warn">{snap.reason}</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Monetización AdSense</h1>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <Stat label="Ingresos estimados" value={fmtMoney(snap.total_revenue)} accent />
        <Stat label="RPM del canal" value={fmtMoney(snap.channel_rpm)} />
        <Stat label="Vídeos largos con ingresos" value={fmtNum(snap.videos_with_revenue ?? snap.top_earners.length)} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle hint="clave para mid-rolls">RPM por duración</CardTitle>
          <SimpleBar data={snap.by_duration.map((b) => ({ bucket: b.bucket, rpm: b.avg_rpm ?? 0 }))} xKey="bucket" yKey="rpm" color="hsl(152 65% 45%)" />
        </Card>
        <Card>
          <CardTitle>Ingresos por país LATAM</CardTitle>
          <table className="w-full">
            <thead><tr><Th>País</Th><Th className="text-right">Ingresos</Th><Th className="text-right">CPM</Th></tr></thead>
            <tbody>
              {snap.by_country_latam.slice(0, 12).map((c) => (
                <tr key={c.country}><Td>{c.country}</Td><Td className="text-right tabular">{fmtMoney(c.revenue)}</Td><Td className="text-right tabular">{fmtMoney(c.cpm)}</Td></tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <Card>
        <CardTitle>Recomendaciones AdSense</CardTitle>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {snap.recommendations.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>Top 15 earners</CardTitle>
          <table className="w-full">
            <thead><tr><Th>Título</Th><Th className="text-right">Ingresos</Th><Th className="text-right">RPM</Th></tr></thead>
            <tbody>
              {snap.top_earners.slice(0, 10).map((v) => (
                <tr key={v.video_id}><Td><Link href={`/videos/${v.video_id}`} className="hover:text-accent">{v.title}</Link></Td><Td className="text-right tabular">{fmtMoney(v.revenue)}</Td><Td className="text-right tabular">{fmtMoney(v.rpm)}</Td></tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card>
          <CardTitle hint=">8 min, RPM bajo">Largos infra-monetizados</CardTitle>
          {snap.under_monetized_long.length ? (
            <table className="w-full">
              <thead><tr><Th>Título</Th><Th className="text-right">RPM</Th></tr></thead>
              <tbody>
                {snap.under_monetized_long.map((v) => (
                  <tr key={v.video_id}><Td><Link href={`/videos/${v.video_id}`} className="hover:text-accent">{v.title}</Link></Td><Td className="text-right"><Badge tone="warn">{fmtMoney(v.rpm)}</Badge></Td></tr>
                ))}
              </tbody>
            </table>
          ) : <p className="text-sm text-muted">Ninguno detectado.</p>}
        </Card>
      </div>
    </div>
  );
}
