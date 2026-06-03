import { getAudienceData } from "@/lib/dashboard/queries";
import { Card, CardTitle, Stat, Badge, EmptyState, Th, Td } from "@/components/ui/primitives";
import { SimpleBar } from "@/components/charts/charts";
import { fmtNum } from "@/lib/utils/cn";

export const dynamic = "force-dynamic";

interface AudSnap {
  format: string;
  latam_share_pct: number;
  avg_retention_pct: number | null;
  videos_with_data: number;
  top_countries: { country: string; views: number; is_latam: boolean }[];
  demographics: { age: string; gender: string; pct: number }[];
  devices: { device: string; views: number }[];
  traffic_sources: { source: string; views: number }[];
}

function Block({ snap, title }: { snap: AudSnap | null; title: string }) {
  if (!snap) return <EmptyState title={`Sin datos de audiencia (${title})`} hint="Ejecuta Sync + Analizar." />;
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="grid grid-cols-3 gap-4">
        <Stat label="Cuota LATAM" value={`${snap.latam_share_pct}%`} accent />
        <Stat label="Retención media" value={snap.avg_retention_pct ? `${snap.avg_retention_pct}%` : "—"} />
        <Stat label="Vídeos con datos" value={fmtNum(snap.videos_with_data)} />
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>Top países</CardTitle>
          <SimpleBar data={snap.top_countries.slice(0, 12)} xKey="country" yKey="views" />
        </Card>
        <Card>
          <CardTitle>Demografía (edad · género)</CardTitle>
          {snap.demographics.length ? (
            <table className="w-full"><thead><tr><Th>Edad</Th><Th>Género</Th><Th className="text-right">%</Th></tr></thead>
              <tbody>{snap.demographics.slice(0, 10).map((d, i) => (
                <tr key={i}><Td>{d.age}</Td><Td>{d.gender}</Td><Td className="text-right tabular">{d.pct}%</Td></tr>
              ))}</tbody>
            </table>
          ) : <p className="text-sm text-muted">Sin demografía (umbral de privacidad en vídeos de baja vista).</p>}
        </Card>
        <Card>
          <CardTitle>Dispositivos</CardTitle>
          <div className="flex flex-wrap gap-2">
            {snap.devices.map((d) => <Badge key={d.device}>{d.device}: {fmtNum(d.views)}</Badge>)}
          </div>
        </Card>
        <Card>
          <CardTitle>Fuentes de tráfico</CardTitle>
          <div className="flex flex-wrap gap-2">
            {snap.traffic_sources.map((t) => <Badge key={t.source} tone="info">{t.source}: {fmtNum(t.views)}</Badge>)}
          </div>
        </Card>
      </div>
    </div>
  );
}

export default async function AudiencePage() {
  const { long, short } = await getAudienceData();
  return (
    <div className="space-y-8">
      <h1 className="text-xl font-bold">Audiencia habitual</h1>
      <p className="text-sm text-muted">Perfil separado por formato. Nota: en vídeos de pocas vistas YouTube oculta demografía/geografía por privacidad; los agregados son fiables.</p>
      <Block snap={long as AudSnap | null} title="Vídeos largos" />
      <Block snap={short as AudSnap | null} title="Shorts" />
    </div>
  );
}
