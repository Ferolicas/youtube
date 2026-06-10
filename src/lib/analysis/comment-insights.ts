import { query } from "@/lib/db/pool";
import { saveSnapshot } from "@/lib/analysis/queries";
import { longOnlySql } from "@/lib/analysis/scope";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("analysis:comments");

// Léxico ES compacto para sentimiento aproximado (heurístico, no ML).
const POSITIVE = new Set(("gracias excelente delicioso deliciosa rico rica riquisimo riquisima genial perfecto perfecta " +
  "encanta encanto encantan funciona funciono buenisimo buenisima maravilla maravilloso bendiciones felicidades " +
  "mejor favorito favorita recomiendo love exito exitos util utiles facil faciles claro clara").split(/\s+/));
const NEGATIVE = new Set(("malo mala no funciona horrible feo fea caro cara dificil error mentira engaño asco " +
  "aburrido aburrida confuso confusa duda dudas problema problemas queja imposible falso falsa").split(/\s+/));

const QUESTION_STARTS = /^(que|qué|como|cómo|cuanto|cuánto|cuanta|cuánta|cuantos|cuántos|puedo|puede|se puede|sirve|donde|dónde|cual|cuál|por que|por qué|cada cuanto|cada cuánto|hay que)/i;

function normalize(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/**
 * Minería de comentarios: preguntas frecuentes (ideas directas de la audiencia),
 * temas recurrentes y sentimiento aproximado por vídeo. Snapshot 'comments'.
 */
export async function computeCommentInsights(): Promise<void> {
  const rows = await query<{
    comment_id: string; video_id: string; title: string | null;
    text: string; like_count: number; published_at: string | null;
  }>(`
    SELECT c.comment_id, c.video_id, v.title, c.text, COALESCE(c.like_count,0) AS like_count,
           c.published_at::text
    FROM video_comments c JOIN videos v ON v.video_id=c.video_id
    WHERE ${longOnlySql("v")} AND length(coalesce(c.text,'')) > 5
  `);

  if (rows.length === 0) {
    await saveSnapshot("comments", "all", {
      available: false,
      reason: "Aún no hay comentarios ingestados. Corre un Sync (paso 'comments').",
    });
    log.warn("sin comentarios para analizar");
    return;
  }

  // 1) PREGUNTAS — lo que tu audiencia pide explícitamente
  const questions = rows
    .filter((r) => /[?¿]/.test(r.text) || QUESTION_STARTS.test(r.text.trim()))
    .map((r) => ({
      video_id: r.video_id,
      video_title: r.title,
      text: r.text.slice(0, 280),
      likes: r.like_count,
      published_at: r.published_at,
    }))
    .sort((a, b) => b.likes - a.likes);

  // 2) TEMAS recurrentes en preguntas (bigramas de contenido)
  const STOP = new Set(("de la que el en y a los del se las por un para con no una su al lo como mas más es son este esta " +
    "hola buenas dias días doctor doctora gracias saludos video vídeo videos canal me mi tu te yo si sí muy bien tambien también " +
    "puede puedo hacer hace donde dónde cual cuál cuanto cuánto sirve usar uso").split(/\s+/));
  const counts = new Map<string, { n: number; likes: number; example: string }>();
  for (const q of questions) {
    const toks = normalize(q.text).replace(/[^a-z0-9ñ\s]/g, " ").split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w));
    const grams = new Set<string>();
    for (let i = 0; i + 2 <= toks.length; i++) grams.add(toks.slice(i, i + 2).join(" "));
    for (const g of grams) {
      const cur = counts.get(g) ?? { n: 0, likes: 0, example: q.text };
      cur.n += 1;
      cur.likes += q.likes;
      counts.set(g, cur);
    }
  }
  const askedTopics = [...counts.entries()]
    .filter(([, v]) => v.n >= 3)
    .map(([topic, v]) => ({ topic, questions: v.n, total_likes: v.likes, example: v.example.slice(0, 160) }))
    .sort((a, b) => b.questions - a.questions)
    .slice(0, 20);

  // 3) SENTIMIENTO aproximado por vídeo (léxico; honesto: es heurístico)
  const byVideo = new Map<string, { title: string | null; pos: number; neg: number; total: number }>();
  for (const r of rows) {
    const cur = byVideo.get(r.video_id) ?? { title: r.title, pos: 0, neg: 0, total: 0 };
    const toks = normalize(r.text).split(/\W+/);
    let p = 0, n = 0;
    for (const t of toks) {
      if (POSITIVE.has(t)) p++;
      if (NEGATIVE.has(t)) n++;
    }
    if (p > n) cur.pos++;
    else if (n > p) cur.neg++;
    cur.total++;
    byVideo.set(r.video_id, cur);
  }
  const sentiment = [...byVideo.entries()]
    .filter(([, v]) => v.total >= 5)
    .map(([video_id, v]) => ({
      video_id, title: v.title, comments: v.total,
      positive_pct: Math.round((v.pos / v.total) * 100),
      negative_pct: Math.round((v.neg / v.total) * 100),
    }))
    .sort((a, b) => b.negative_pct - a.negative_pct);

  await saveSnapshot("comments", "all", {
    available: true,
    total_comments: rows.length,
    questions_count: questions.length,
    top_questions: questions.slice(0, 25),
    asked_topics: askedTopics,
    sentiment_worst: sentiment.slice(0, 10),
    sentiment_best: [...sentiment].sort((a, b) => b.positive_pct - a.positive_pct).slice(0, 10),
    note: "Sentimiento heurístico por léxico (aproximado). Las preguntas con más likes son demanda directa de contenido.",
  });
  log.info(`comentarios: ${rows.length} analizados, ${questions.length} preguntas, ${askedTopics.length} temas`);
}
