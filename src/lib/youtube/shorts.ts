import { withBackoff } from "@/lib/youtube/rate-limiter";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
// Cookie de consentimiento: sin ella, YouTube responde 30x -> consent.youtube.com
// desde IPs de datacenter y NUNCA revela el 200/303 real (causa de "0 Shorts").
const CONSENT_COOKIE = "SOCS=CAISEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg; CONSENT=YES+1";

export interface ShortVerdict {
  /** true=Short, false=largo, null=indeterminado (no se pudo resolver). */
  isShort: boolean | null;
  method: string;
}

/**
 * Clasifica el FORMATO según la autoridad del propio YouTube (criterio del dueño):
 *   GET youtube.com/shorts/{id}
 *     → 200            => es SHORT (vertical)
 *     → 303 → /watch   => es LARGO
 * La DURACIÓN no es criterio. Un Short puede durar >60s.
 */
export async function detectShort(videoId: string): Promise<ShortVerdict> {
  try {
    const res = await withBackoff(
      `shorts:${videoId}`,
      () =>
        fetch(`https://www.youtube.com/shorts/${videoId}`, {
          method: "GET",
          redirect: "manual",
          headers: { "User-Agent": UA, Cookie: CONSENT_COOKIE },
        }),
      { maxRetries: 2, retryOn: (s) => s >= 500 }
    );
    // No necesitamos el cuerpo (en 200 sería el HTML del Short): liberarlo.
    res.body?.cancel().catch(() => undefined);

    if (res.status === 200) return { isShort: true, method: "shorts_url" };
    const loc = res.headers.get("location") ?? "";
    if (/\/watch/.test(loc)) return { isShort: false, method: "shorts_url" };
    // 30x → consent u otra respuesta inesperada: no concluyente. No adivinamos por duración.
    return { isShort: null, method: "indeterminate" };
  } catch {
    return { isShort: null, method: "error" };
  }
}
