/**
 * Construcción del prompt de generación de guion. Función PURA: sin BD ni red.
 * Reutilizada por generateScript (lib/ideas/scripts.ts) y por el verificador `npm run verify:llm`,
 * de modo que ambos usan exactamente el mismo prompt.
 */

/** Campos mínimos de una idea necesarios para construir el prompt del guion. */
export interface ScriptIdea {
  title: string;
  hook_angle: string;
  suggested_duration_sec: number | null;
  keywords: string[] | null;
}

/**
 * Devuelve el par (system, user) para un guion de YouTube optimizado para
 * retención y mid-rolls de AdSense, con la estructura obligatoria:
 * gancho → promesa → desarrollo → mid-roll AdSense → clímax → CTA.
 */
export function buildScriptPrompt(idea: ScriptIdea): { system: string; user: string } {
  const minutes = Math.round((idea.suggested_duration_sec ?? 600) / 60);
  const system = `Eres guionista de YouTube experto en retención y en contenido keto en español para LATAM.
Escribes guiones que maximizan el tiempo de visualización y crean valles naturales para mid-rolls de AdSense.`;
  const user = `Escribe un guion completo para un vídeo de ~${minutes} min.
Título: "${idea.title}"
Gancho: ${idea.hook_angle}
Keywords: ${(idea.keywords ?? []).join(", ")}

Estructura obligatoria con marcas de tiempo aproximadas:
1. GANCHO (0-15s): frena el scroll, plantea la promesa.
2. PROMESA / PREVIEW (15-40s): qué va a aprender y por qué quedarse.
3. DESARROLLO en 3-4 bloques con micro-ganchos entre bloques.
4. PUNTO MID-ROLL: marca [MID-ROLL ADSENSE] en un valle natural tras entregar valor (no a mitad de una explicación).
5. CLÍMAX / mejor tip al final para retener.
6. CTA final (suscripción + vídeo relacionado).
Incluye indicaciones de B-roll entre corchetes. Español neutro LATAM.`;
  return { system, user };
}
