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
 * - toggle OFF (por defecto): `"<alias>.is_short = false"`
 * - toggle ON: `"TRUE"`
 * Uso: `... WHERE ${longOnlySql("v")} AND ...`
 * Seguro frente a inyección: `alias` lo controla el código, no entrada de usuario.
 */
export function longOnlySql(alias = "v"): string {
  return INCLUDE_SHORTS ? "TRUE" : `${alias}.is_short = false`;
}

/** Predicado JS para filtrar arrays en memoria por el mismo criterio. */
export function isInScope(v: { is_short: boolean | null }): boolean {
  return INCLUDE_SHORTS ? true : v.is_short === false;
}
