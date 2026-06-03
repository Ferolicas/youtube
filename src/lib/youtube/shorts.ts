import { withBackoff } from "@/lib/youtube/rate-limiter";

const SHORT_MAX_SECONDS = 180; // Shorts admiten hasta 3 min desde 2025

/**
 * Determina si un vídeo es Short.
 *  1) Pre-filtro: duración > 180s => definitivamente largo (no gasta red).
 *  2) Verificación autoritativa: HEAD a youtube.com/shorts/{id}.
 *     Si responde 200 sin redirigir a /watch => es Short.
 * Devuelve también el método usado para trazabilidad.
 */
export async function detectShort(
  videoId: string,
  durationSeconds: number
): Promise<{ isShort: boolean; method: string }> {
  if (durationSeconds > SHORT_MAX_SECONDS) {
    return { isShort: false, method: "duration" };
  }
  try {
    const res = await withBackoff(
      `shorts:${videoId}`,
      async () => {
        const r = await fetch(`https://www.youtube.com/shorts/${videoId}`, {
          method: "HEAD",
          redirect: "manual",
        });
        return r;
      },
      { maxRetries: 2, retryOn: (s) => s >= 500 }
    );
    // 200 => es Short; 3xx (redirige a /watch) => no es Short.
    const isShort = res.status === 200;
    return { isShort, method: "shorts_url" };
  } catch {
    // Fallback conservador: por duración.
    return { isShort: durationSeconds <= 60, method: "duration_fallback" };
  }
}
