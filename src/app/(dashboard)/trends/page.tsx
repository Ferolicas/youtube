import { getTrendsData } from "@/lib/dashboard/queries";
import { Card, CardTitle, Badge, EmptyState, Th, Td } from "@/components/ui/primitives";
import { SimpleBar } from "@/components/charts/charts";
import { fmtNum } from "@/lib/utils/cn";

export const dynamic = "force-dynamic";

export default async function TrendsPage() {
  const { keywords, competitors } = await getTrendsData();

  if (keywords.length === 0 && competitors.length === 0) {
    return <EmptyState title="Sin datos de tendencias" hint="Ejecuta “Tendencias”. Requiere YOUTUBE_API_KEY o cuota OAuth disponible." />;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Tendencias keto / LATAM</h1>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle hint="últimos 7 días">Keywords en alza</CardTitle>
          {keywords.length ? (
            <SimpleBar data={keywords.slice(0, 15).map((k) => ({ kw: k.keyword, score: Number(k.score) }))} xKey="kw" yKey="score" height={300} />
          ) : <p className="text-sm text-muted">Sin keywords.</p>}
        </Card>
        <Card>
          <CardTitle>Nube de términos</CardTitle>
          <div className="flex flex-wrap gap-2">
            {keywords.map((k) => <Badge key={k.keyword} tone="info">{k.keyword}</Badge>)}
          </div>
        </Card>
      </div>

      <Card>
        <CardTitle hint="ordenado por views/hora">Competidores en alza</CardTitle>
        {competitors.length ? (
          <table className="w-full">
            <thead><tr><Th>Título</Th><Th>Canal</Th><Th>Región</Th><Th className="text-right">Vistas</Th><Th className="text-right">V/h</Th></tr></thead>
            <tbody>
              {competitors.map((c) => (
                <tr key={c.video_id} className="hover:bg-panel/50">
                  <Td><a href={`https://youtube.com/watch?v=${c.video_id}`} target="_blank" rel="noreferrer" className="hover:text-accent">{c.title}</a></Td>
                  <Td className="text-muted">{c.channel_title}</Td>
                  <Td>{c.region}</Td>
                  <Td className="text-right tabular">{fmtNum(Number(c.view_count))}</Td>
                  <Td className="text-right tabular">{fmtNum(Number(c.vph))}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="text-sm text-muted">Sin competidores capturados.</p>}
      </Card>
    </div>
  );
}
