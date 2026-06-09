import { query, queryOne } from "@/lib/db/pool";
import { env } from "@/config/env";
import { llmAvailable, llmComplete } from "@/lib/ideas/llm";
import { buildScriptPrompt, type GuionInsights } from "@/lib/ideas/script-prompt";
import { latestSnapshot } from "@/lib/analysis/queries";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("ideas:scripts");

/** Forma parcial del snapshot "guion" (computeScriptAnalysis) que aquí consumimos. */
interface GuionSnapshot {
  hooks?: { contrast?: { term: string; lift: number }[] };
  recurring_phrases?: { phrase: string; verdict: string }[];
  abandonment?: { hotspots?: { bucket_pct: number; avg_drop: number; n: number }[] };
  recommendations?: { text: string }[];
}

/** Destila el snapshot "guion" en los insights que inyecta el prompt del guion. */
async function loadGuionInsights(): Promise<GuionInsights | undefined> {
  const snap = await latestSnapshot<GuionSnapshot>("guion");
  if (!snap) return undefined;

  const hookTermsKeep = (snap.hooks?.contrast ?? [])
    .filter((t) => t.lift >= 25)
    .slice(0, 5)
    .map((t) => t.term);
  const muletillasAvoid = (snap.recurring_phrases ?? [])
    .filter((p) => p.verdict === "perjudica")
    .slice(0, 5)
    .map((p) => p.phrase);
  const phrasesKeep = (snap.recurring_phrases ?? [])
    .filter((p) => p.verdict === "ayuda")
    .slice(0, 3)
    .map((p) => p.phrase);
  const worst = [...(snap.abandonment?.hotspots ?? [])]
    .filter((h) => h.n >= 2)
    .sort((a, b) => b.avg_drop - a.avg_drop)[0];
  const worstAbandonBucket = worst ? `${worst.bucket_pct}-${worst.bucket_pct + 10}%` : undefined;
  const recommendations = (snap.recommendations ?? []).slice(0, 4).map((r) => r.text);

  const insights: GuionInsights = {
    hookTermsKeep,
    muletillasAvoid,
    phrasesKeep,
    worstAbandonBucket,
    recommendations,
  };
  // Si todo vino vacío, no aportamos sección al prompt.
  const hasAny =
    hookTermsKeep.length || muletillasAvoid.length || phrasesKeep.length || worstAbandonBucket || recommendations.length;
  return hasAny ? insights : undefined;
}

/**
 * Genera un guion optimizado para retención + mid-rolls AdSense para una idea.
 * Inyecta los datos reales del análisis de guion (snapshot "guion") en el prompt.
 * Requiere LLM (OPENAI_API_KEY). Sin él, se informa explícitamente.
 *
 * Además de guardar en idea_scripts (efímero, ligado a daily_ideas), guarda una
 * RECETA permanente (tabla recipes, sin FK) que fotografía idea + guion + fecha,
 * para que sobreviva al borrado diario de daily_ideas.
 */
export async function generateScript(ideaId: number): Promise<{ ok: boolean; reason?: string }> {
  if (!llmAvailable()) {
    return { ok: false, reason: "LLM no configurado (OPENAI_API_KEY). El guion requiere IA." };
  }
  const idea = await queryOne<{
    title: string;
    hook_angle: string;
    thumbnail_brief: string | null;
    suggested_duration_sec: number;
    keywords: string[];
    for_date: string | null;
  }>(
    `SELECT title, hook_angle, thumbnail_brief, suggested_duration_sec, keywords, for_date::text AS for_date
     FROM daily_ideas WHERE id=$1`,
    [ideaId]
  );
  if (!idea) return { ok: false, reason: "idea no encontrada" };

  const insights = await loadGuionInsights();
  const { system, user } = buildScriptPrompt(idea, insights);
  const script = await llmComplete({ system, user, maxTokens: 4000 });

  await query(
    `INSERT INTO idea_scripts (idea_id, script, model, created_at) VALUES ($1,$2,$3, now())
     ON CONFLICT (idea_id) DO UPDATE SET script=EXCLUDED.script, model=EXCLUDED.model, created_at=now()`,
    [ideaId, script, env.LLM_MODEL]
  );

  // Receta permanente (no se borra al regenerar ideas del día).
  await query(
    `INSERT INTO recipes (title, hook_angle, thumbnail_brief, suggested_duration_sec, keywords,
        script, model, source_idea_id, for_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      idea.title, idea.hook_angle, idea.thumbnail_brief, idea.suggested_duration_sec,
      idea.keywords, script, env.LLM_MODEL, ideaId, idea.for_date,
    ]
  );

  log.info(`guion generado para idea ${ideaId} (insights=${insights ? "sí" : "no"}) y guardado en recetas`);
  return { ok: true };
}
