import { listVideos, getChannelCtr, getEndScreensData } from "@/lib/dashboard/queries";
import { VideosTable } from "@/components/videos-table";
import { Card, CardTitle, EmptyState, Th, Td } from "@/components/ui/primitives";
import { fmtNum, fmtPct } from "@/lib/utils/cn";

export const dynamic = "force-dynamic";

export default async function VideosPage() {
  const [rows, channelCtr, endScreens] = await Promise.all([
    listVideos(),
    getChannelCtr(),
    getEndScreensData(),
  ]);
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Vídeos</h1>
      {rows.length === 0 ? (
        <EmptyState title="Sin vídeos todavía" hint="Conecta tu cuenta y ejecuta un Sync completo para descargar el catálogo." />
      ) : (
        <VideosTable rows={rows} channelCtr={channelCtr} />
      )}

      {endScreens.length > 0 && (
        <Card>
          <CardTitle hint="dato exclusivo de YouTube Studio (importado del CSV)">Pantallas finales por vídeo</CardTitle>
          <p className="mb-3 text-xs text-muted">
            Clics y CTR de pantallas finales: qué vídeos consiguen que la audiencia siga a otro contenido al terminar.
          </p>
          <div className="overflow-auto">
            <table className="w-full">
              <thead><tr>
                <Th>Vídeo</Th>
                <Th className="text-right">Clics</Th>
                <Th className="text-right">Mostradas</Th>
                <Th className="text-right">CTR</Th>
              </tr></thead>
              <tbody>
                {endScreens.map((e) => (
                  <tr key={e.video_id} className="hover:bg-panel/50">
                    <Td className="max-w-[420px] truncate">{e.title ?? e.video_id}</Td>
                    <Td className="text-right tabular">{fmtNum(e.clicks)}</Td>
                    <Td className="text-right tabular">{fmtNum(e.shown)}</Td>
                    <Td className="text-right tabular">{e.ctr ? fmtPct(Number(e.ctr)) : "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
