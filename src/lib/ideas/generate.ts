import { query } from "@/lib/db/pool";
import { latestSnapshot } from "@/lib/analysis/queries";
import { llmAvailable, llmComplete, extractJson } from "@/lib/ideas/llm";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("ideas");

interface Idea {
  title: string;
  hook_angle: string;
  thumbnail_brief: string;
  suggested_duration_sec: number;
  keywords: string[];
  suggested_publish_hour_utc: number;
  priority: number;
  rationale: Record<string, unknown>;
}

/** Genera la lista priorizada de ideas del día combinando tu canal + tendencias. */
export async function generateDailyIdeas(forDate = todayDate()): Promise<number> {
  const context = await buildContext();

  let ideas: Idea[];
  let source: "llm" | "data-driven";
  if (llmAvailable()) {
    try {
      ideas = await generateWithLlm(context);
      source = "llm";
    } catch (e) {
      log.warn(`LLM falló, usando fallback determinista: ${String(e)}`);
      ideas = generateDataDriven(context);
      source = "data-driven";
    }
  } else {
    ideas = generateDataDriven(context);
    source = "data-driven";
  }

  // limpiar ideas previas del día y reinsertar
  await query(`DELETE FROM daily_ideas WHERE for_date=$1`, [forDate]);
  for (const idea of ideas) {
    const publishAt = nextOccurrence(idea.suggested_publish_hour_utc);
    await query(
      `INSERT INTO daily_ideas (for_date, title, hook_angle, thumbnail_brief, suggested_duration_sec,
         keywords, suggested_publish_at, priority, rationale, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        forDate, idea.title, idea.hook_angle, idea.thumbnail_brief,
        idea.suggested_duration_sec, idea.keywords, publishAt,
        idea.priority, JSON.stringify(idea.rationale), source,
      ]
    );
  }
  log.info(`${ideas.length} ideas generadas (${source}) para ${forDate}`);
  return ideas.length;
}

interface Context {
  topClusters: { label: string; keywords: string[]; avg_views: number; avg_rpm: number | null }[];
  outlierTitles: string[];
  trendKeywords: string[];
  competitorTitles: string[];
  bestHours: number[];
  channelTitle: string;
}

async function buildContext(): Promise<Context> {
  const clusters = await query<{ label: string; keywords: string[]; avg_views: string; avg_rpm: string | null }>(
    `SELECT label, keywords, avg_views::text, avg_rpm::text FROM content_clusters
     ORDER BY avg_views DESC NULLS LAST LIMIT 6`
  );
  const outliers = await query<{ title: string }>(
    `SELECT v.title FROM outlier_analysis o JOIN videos v ON v.video_id=o.video_id
     WHERE o.is_outlier ORDER BY o.views DESC LIMIT 8`
  );
  const trendKw = await query<{ keyword: string }>(
    `SELECT keyword FROM trend_keywords WHERE for_date >= (now()-interval '3 day')::date
     GROUP BY keyword ORDER BY SUM(score) DESC LIMIT 20`
  );
  const competitors = await query<{ title: string }>(
    `SELECT title FROM competitor_videos ORDER BY vph DESC NULLS LAST LIMIT 12`
  );
  const timing = await latestSnapshot<{ best_hours_utc: { hour_utc: number }[] }>("timing", "long");
  const channel = await query<{ title: string }>(`SELECT title FROM channels LIMIT 1`);

  return {
    topClusters: clusters.map((c) => ({
      label: c.label, keywords: c.keywords,
      avg_views: Number(c.avg_views ?? 0), avg_rpm: c.avg_rpm ? Number(c.avg_rpm) : null,
    })),
    outlierTitles: outliers.map((o) => o.title).filter(Boolean) as string[],
    trendKeywords: trendKw.map((t) => t.keyword),
    competitorTitles: competitors.map((c) => c.title).filter(Boolean) as string[],
    bestHours: (timing?.best_hours_utc ?? []).map((h) => h.hour_utc).slice(0, 3),
    channelTitle: channel[0]?.title ?? "Planeta Keto",
  };
}

async function generateWithLlm(ctx: Context): Promise<Idea[]> {
  const system = `Eres estratega de contenido de YouTube experto en el nicho keto en español para audiencia LATAM.
Generas ideas de vídeo accionables y monetizables (AdSense) basadas EXCLUSIVAMENTE en los datos del canal y tendencias provistos.
Respondes SOLO con un array JSON válido, sin texto adicional.`;

  const user = `Canal: ${ctx.channelTitle}
Clusters de mayor rendimiento (tema -> vistas medias, RPM): ${JSON.stringify(ctx.topClusters)}
Títulos de mis outliers (lo que ya funcionó): ${JSON.stringify(ctx.outlierTitles)}
Keywords en tendencia (keto/LATAM): ${JSON.stringify(ctx.trendKeywords)}
Títulos competidores en alza: ${JSON.stringify(ctx.competitorTitles)}
Mejores horas de publicación (UTC): ${JSON.stringify(ctx.bestHours)}

Genera 8 ideas de vídeo priorizadas. Cada objeto del array:
{
  "title": "título optimizado <=60 chars con keyword + gancho",
  "hook_angle": "ángulo del gancho de los primeros 15s",
  "thumbnail_brief": "qué poner en la miniatura (texto corto, elemento visual, emoción)",
  "suggested_duration_sec": entero (>=480 si buscas mid-rolls AdSense),
  "keywords": ["5-8 keywords"],
  "suggested_publish_hour_utc": entero 0-23 (usa mis mejores horas),
  "priority": número 1-100,
  "rationale": {"por_que": "...", "evidencia": "qué dato lo respalda"}
}`;

  const text = await llmComplete({ system, user, maxTokens: 3000 });
  const parsed = extractJson<Idea[]>(text);
  if (!parsed || parsed.length === 0) throw new Error("respuesta LLM no parseable");
  return parsed;
}

/** Fallback sin LLM: combina clusters ganadores con keywords en tendencia. */
function generateDataDriven(ctx: Context): Idea[] {
  const ideas: Idea[] = [];
  const hour = ctx.bestHours[0] ?? 14;
  const clusters = ctx.topClusters.length ? ctx.topClusters : [{ label: "keto recetas", keywords: ["keto", "recetas"], avg_views: 0, avg_rpm: null }];

  const trends = ctx.trendKeywords.length ? ctx.trendKeywords : ["desayuno keto", "pan keto", "ayuno"];
  let i = 0;
  for (const cl of clusters) {
    const trend = trends[i % trends.length] ?? "keto";
    const kw = [...new Set([...(cl.keywords ?? []).slice(0, 3), trend])];
    ideas.push({
      title: capitalize(`${trend}: ${cl.keywords?.[0] ?? "keto"} que sí funciona`).slice(0, 60),
      hook_angle: `Abre mostrando el resultado final + promesa de "${trend}" en los primeros 10s.`,
      thumbnail_brief: `Texto grande "${trend.toUpperCase()}", cara con expresión de sorpresa, alto contraste.`,
      suggested_duration_sec: 600,
      keywords: kw,
      suggested_publish_hour_utc: hour,
      priority: Math.round(60 + (cl.avg_views ? Math.min(40, Math.log10(cl.avg_views + 1) * 8) : 0)),
      rationale: {
        por_que: `El tema '${cl.label}' es de tus de mayor rendimiento y '${trend}' está en tendencia.`,
        evidencia: `cluster avg_views=${cl.avg_views}, rpm=${cl.avg_rpm ?? "n/d"}`,
      },
    });
    i++;
  }
  return ideas.sort((a, b) => b.priority - a.priority).slice(0, 8);
}

function capitalize(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1); }
function todayDate(): string { return new Date().toISOString().slice(0, 10); }
function nextOccurrence(hourUtc: number): Date {
  const d = new Date();
  d.setUTCHours(hourUtc, 0, 0, 0);
  if (d.getTime() < Date.now()) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
