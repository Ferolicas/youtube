import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getConnectionStatus } from "@/lib/dashboard/queries";
import { Nav } from "@/components/nav";
import { ActionBar } from "@/components/action-bar";
import { Badge } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const status = await getConnectionStatus();

  return (
    <div className="flex min-h-screen">
      <Nav />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-border bg-panel/30 px-6 py-3">
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-fg">
              {status.channel?.title ?? "Sin canal sincronizado"}
            </span>
            {status.connected ? (
              <Badge tone="good">Conectado</Badge>
            ) : (
              <Badge tone="bad">Desconectado</Badge>
            )}
            {status.connected && (status.monetary ? (
              <Badge tone="info">Monetización ON</Badge>
            ) : (
              <Badge tone="warn">Sin scope monetario</Badge>
            ))}
          </div>
          <ActionBar />
        </header>

        {!status.connected && (
          <div className="border-b border-warn/30 bg-warn/10 px-6 py-2 text-sm text-warn">
            No hay conexión con YouTube.{" "}
            <a href="/api/auth/google" className="underline">Conecta tu cuenta</a> y luego pulsa “Sync”.
          </div>
        )}

        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
