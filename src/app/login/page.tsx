import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await getSession()) redirect("/");
  const { error } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg p-6">
      <div className="w-full max-w-md rounded-2xl border border-border bg-panel p-8 text-center shadow-xl">
        <p className="text-xs uppercase tracking-widest text-muted">Planeta Keto</p>
        <h1 className="mt-1 text-2xl font-bold text-fg">Inteligencia de Canal</h1>
        <p className="mt-3 text-sm text-muted">
          Herramienta personal de análisis profundo. Conecta tu cuenta de YouTube
          para empezar (solo lectura).
        </p>

        {error && (
          <div className="mt-5 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
            {decodeURIComponent(error)}
          </div>
        )}

        <a
          href="/api/auth/google"
          className="mt-6 inline-flex w-full items-center justify-center gap-3 rounded-xl bg-accent px-5 py-3 font-semibold text-bg transition-opacity hover:opacity-90"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M23 12.07c0-.79-.07-1.54-.2-2.27H12v4.51h6.16a5.27 5.27 0 0 1-2.28 3.46v2.88h3.69C21.7 18.62 23 15.66 23 12.07z" opacity=".9" />
            <path d="M12 23c3.08 0 5.66-1.02 7.54-2.76l-3.69-2.88c-1.02.69-2.33 1.1-3.85 1.1-2.96 0-5.47-2-6.36-4.69H1.83v2.95A11 11 0 0 0 12 23z" opacity=".7" />
          </svg>
          Conectar mi cuenta de YouTube
        </a>

        <p className="mt-4 text-xs text-muted">
          Scopes: youtube.readonly · yt-analytics.readonly · yt-analytics-monetary.readonly
        </p>
      </div>
    </main>
  );
}
