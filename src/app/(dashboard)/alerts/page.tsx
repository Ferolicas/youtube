import { recentAlerts } from "@/lib/alerts/notify";
import { Card, CardTitle, Badge, EmptyState } from "@/components/ui/primitives";
import { MarkSeenButton } from "@/components/mark-seen-button";

export const dynamic = "force-dynamic";

const TONE: Record<string, "good" | "warn" | "bad" | "info" | "default"> = {
  breakout: "good",
  new_video: "info",
  competitor_video: "warn",
  pipeline_failed: "bad",
  token_failed: "bad",
  quota: "warn",
};

const KIND_LABEL: Record<string, string> = {
  breakout: "🚀 Breakout",
  new_video: "Nuevo vídeo",
  competitor_video: "Competidor",
  pipeline_failed: "Pipeline",
  token_failed: "Token",
  quota: "Cuota",
};

export default async function AlertsPage() {
  const alerts = await recentAlerts(100);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Alertas</h1>
        {alerts.some((a) => !a.seen) && <MarkSeenButton />}
      </div>

      {alerts.length === 0 ? (
        <EmptyState
          title="Sin alertas todavía"
          hint="Aquí verás breakouts (vídeos despegando), subidas de competidores, fallos de pipeline, token caducado y cuota alta. Configura TELEGRAM_BOT_TOKEN para recibirlas también en el móvil."
        />
      ) : (
        <Card>
          <CardTitle hint={`${alerts.filter((a) => !a.seen).length} sin leer`}>Últimas 100</CardTitle>
          <ul className="divide-y divide-border/50">
            {alerts.map((a) => (
              <li key={a.id} className={`flex items-start gap-3 py-3 ${a.seen ? "opacity-60" : ""}`}>
                <Badge tone={TONE[a.kind] ?? "default"}>{KIND_LABEL[a.kind] ?? a.kind}</Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-fg">{a.title}</p>
                  {a.detail && <p className="mt-0.5 whitespace-pre-line text-xs text-muted">{a.detail}</p>}
                </div>
                <span className="shrink-0 text-xs tabular text-muted">
                  {a.created_at.slice(0, 16).replace("T", " ")}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
