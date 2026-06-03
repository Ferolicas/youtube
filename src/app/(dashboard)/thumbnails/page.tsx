import Link from "next/link";
import { getThumbnailsData } from "@/lib/dashboard/queries";
import { Card, CardTitle, Badge, EmptyState, Th, Td } from "@/components/ui/primitives";
import { fmtNum } from "@/lib/utils/cn";

export const dynamic = "force-dynamic";

interface ThumbSnap {
  ctr_data_available: boolean;
  note: string;
  sample_size: number;
  correlations: { feature: string; correlation_with: string; r: number }[];
  text_overlay: { with_text_avg: number; without_text_avg: number; ocr_available: boolean };
}

export default async function ThumbnailsPage() {
  const { snapshot, list, ctrImported } = await getThumbnailsData();
  const snap = snapshot as ThumbSnap | null;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Análisis de miniaturas</h1>

      <div className="rounded-lg border border-warn/30 bg-warn/10 p-3 text-sm text-warn">
        <strong>Importante:</strong> el CTR de impresiones no existe en ninguna API de YouTube (solo en Studio).
        {ctrImported > 0
          ? ` Tienes ${ctrImported} filas de CTR importadas desde Studio: las correlaciones usan CTR real.`
          : " Importa el CSV de Studio (modo avanzado: Impresiones + CTR) a la tabla thumbnail_ctr_import para correlacionar con CTR real. Mientras tanto se usan vistas como proxy."}
      </div>

      {snap && (
        <Card>
          <CardTitle hint={`muestra: ${snap.sample_size}`}>Correlaciones de features visuales</CardTitle>
          <p className="mb-3 text-xs text-muted">{snap.note}</p>
          <table className="w-full">
            <thead><tr><Th>Feature</Th><Th>Objetivo</Th><Th className="text-right">r (Pearson)</Th></tr></thead>
            <tbody>
              {snap.correlations.map((c) => (
                <tr key={c.feature}>
                  <Td>{c.feature}</Td>
                  <Td><Badge tone={c.correlation_with === "ctr_real" ? "good" : "warn"}>{c.correlation_with}</Badge></Td>
                  <Td className="text-right tabular">{c.r}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {list.length === 0 ? (
        <EmptyState title="Sin miniaturas analizadas" hint="Ejecuta Sync para descargar y analizar miniaturas." />
      ) : (
        <Card>
          <CardTitle>Miniaturas (top por vistas)</CardTitle>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {list.map((t) => (
              <Link key={t.video_id} href={`/videos/${t.video_id}`} className="group rounded-lg border border-border bg-panel2 p-2 hover:border-accent">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={t.image_url} alt={t.title} className="aspect-video w-full rounded object-cover" />
                <p className="mt-1 line-clamp-1 text-xs text-fg">{t.title}</p>
                <div className="mt-1 flex items-center justify-between text-[10px] text-muted">
                  <span className="tabular">{fmtNum(Number(t.views))} vistas</span>
                  <span>brillo {t.brightness ?? "—"}</span>
                </div>
              </Link>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
