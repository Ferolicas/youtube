import { query, queryOne } from "@/lib/db/pool";
import { env } from "@/config/env";
import { llmAvailable, llmComplete } from "@/lib/ideas/llm";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("ideas:scripts");

/**
 * Genera un guion optimizado para retención + mid-rolls AdSense para una idea.
 * Requiere LLM (ANTHROPIC_API_KEY). Sin él, se informa explícitamente.
 */
export async function generateScript(ideaId: number): Promise<{ ok: boolean; reason?: string }> {
  if (!llmAvailable()) {
    return { ok: false, reason: "LLM no configurado (ANTHROPIC_API_KEY). El guion requiere IA." };
  }
  const idea = await queryOne<{
    title: string; hook_angle: string; suggested_duration_sec: number; keywords: string[];
  }>(
    `SELECT title, hook_angle, suggested_duration_sec, keywords FROM daily_ideas WHERE id=$1`,
    [ideaId]
  );
  if (!idea) return { ok: false, reason: "idea no encontrada" };

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

  const script = await llmComplete({ system, user, maxTokens: 4000 });
  await query(
    `INSERT INTO idea_scripts (idea_id, script, model, created_at) VALUES ($1,$2,$3, now())
     ON CONFLICT (idea_id) DO UPDATE SET script=EXCLUDED.script, model=EXCLUDED.model, created_at=now()`,
    [ideaId, script, env.LLM_MODEL]
  );
  log.info(`guion generado para idea ${ideaId}`);
  return { ok: true };
}
