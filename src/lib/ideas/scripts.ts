import { query, queryOne } from "@/lib/db/pool";
import { env } from "@/config/env";
import { llmAvailable, llmComplete } from "@/lib/ideas/llm";
import { buildScriptPrompt } from "@/lib/ideas/script-prompt";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("ideas:scripts");

/**
 * Genera un guion optimizado para retención + mid-rolls AdSense para una idea.
 * Requiere LLM (OPENAI_API_KEY). Sin él, se informa explícitamente.
 */
export async function generateScript(ideaId: number): Promise<{ ok: boolean; reason?: string }> {
  if (!llmAvailable()) {
    return { ok: false, reason: "LLM no configurado (OPENAI_API_KEY). El guion requiere IA." };
  }
  const idea = await queryOne<{
    title: string; hook_angle: string; suggested_duration_sec: number; keywords: string[];
  }>(
    `SELECT title, hook_angle, suggested_duration_sec, keywords FROM daily_ideas WHERE id=$1`,
    [ideaId]
  );
  if (!idea) return { ok: false, reason: "idea no encontrada" };

  const { system, user } = buildScriptPrompt(idea);
  const script = await llmComplete({ system, user, maxTokens: 4000 });
  await query(
    `INSERT INTO idea_scripts (idea_id, script, model, created_at) VALUES ($1,$2,$3, now())
     ON CONFLICT (idea_id) DO UPDATE SET script=EXCLUDED.script, model=EXCLUDED.model, created_at=now()`,
    [ideaId, script, env.LLM_MODEL]
  );
  log.info(`guion generado para idea ${ideaId}`);
  return { ok: true };
}
