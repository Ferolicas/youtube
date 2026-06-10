import { env } from "@/config/env";

/**
 * Punto ÚNICO de verdad del alcance de formato de la app.
 *
 * Por defecto toda la inteligencia (análisis, ideas, recomendaciones, etc.)
 * trabaja SOLO con vídeos largos; los Shorts solo aparecen en la pestaña Vídeos
 * como referencia. Con INCLUDE_SHORTS=true en el .env, el toggle amplía todo el
 * análisis para incluir también Shorts.
 *
 * Ningún módulo debe redefinir este criterio: todos importan de aquí. Así no se
 * duplica la lógica ni se olvida en algún sitio. (Si algún día se quiere un toggle
 * de UI en runtime, basta con cambiar la fuente de INCLUDE_SHORTS aquí.)
 */
export const INCLUDE_SHORTS = env.INCLUDE_SHORTS;

/**
 * Fragmento SQL para el WHERE sobre la tabla `videos` (alias configurable).
 * Incluye SIEMPRE una red de seguridad: `channel_id IS NOT NULL`, que excluye los
 * vídeos sin dueño (fantasmas ajenos que entran por el import de Studio y que la
 * reconciliación no adopta). El filtro de formato (is_short) solo aplica con el
 * toggle OFF.
 * - toggle OFF (por defecto): `"<alias>.is_short = false AND <alias>.channel_id IS NOT NULL"`
 * - toggle ON: `"<alias>.channel_id IS NOT NULL"`
 * Uso: `... WHERE ${longOnlySql("v")} AND ...`
 * Seguro frente a inyección: `alias` lo controla el código, no entrada de usuario.
 */
export function longOnlySql(alias = "v"): string {
  const owned = `${alias}.channel_id IS NOT NULL`;
  return INCLUDE_SHORTS ? owned : `${alias}.is_short = false AND ${owned}`;
}

/** Predicado JS para filtrar arrays en memoria por el mismo criterio. */
export function isInScope(v: { is_short: boolean | null; channel_id?: string | null }): boolean {
  if (v.channel_id === null) return false; // fantasma sin dueño
  return INCLUDE_SHORTS ? true : v.is_short === false;
}
