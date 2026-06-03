import { listVideos } from "@/lib/dashboard/queries";
import { VideosTable } from "@/components/videos-table";
import { EmptyState } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

export default async function VideosPage() {
  const rows = await listVideos();
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Vídeos</h1>
      {rows.length === 0 ? (
        <EmptyState title="Sin vídeos todavía" hint="Conecta tu cuenta y ejecuta un Sync completo para descargar el catálogo." />
      ) : (
        <VideosTable rows={rows} />
      )}
    </div>
  );
}
