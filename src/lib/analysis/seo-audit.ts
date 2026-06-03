import { query, queryOne } from "@/lib/db/pool";
import { saveSnapshot } from "@/lib/analysis/queries";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("analysis:seo");

interface Finding {
  severity: "alta" | "media" | "baja";
  area: string;
  issue: string;
  recommendation: string;
  count?: number;
}

/** Diagnóstico de configuración/SEO: keywords del canal, tags, descripciones, idioma. */
export async function computeSeoAudit() {
  const findings: Finding[] = [];

  const channel = await queryOne<{ keywords: string | null; description: string | null; default_language: string | null }>(
    `SELECT keywords, description, default_language FROM channels LIMIT 1`
  );

  if (!channel?.keywords || channel.keywords.trim().length < 10) {
    findings.push({
      severity: "alta", area: "canal",
      issue: "Keywords del canal vacías o muy pobres.",
      recommendation: "Añade 10-15 keywords keto/LATAM en Configuración > Canal > Palabras clave (ej: keto, dieta cetogénica, recetas keto, bajar de peso, ayuno).",
    });
  }
  if (!channel?.description || channel.description.trim().length < 200) {
    findings.push({
      severity: "media", area: "canal",
      issue: "Descripción del canal corta (<200 caracteres).",
      recommendation: "Describe propuesta de valor, frecuencia de subida y keywords principales en los primeros 100 caracteres.",
    });
  }
  if (!channel?.default_language) {
    findings.push({
      severity: "media", area: "canal",
      issue: "Idioma por defecto del canal no configurado.",
      recommendation: "Fija 'es' como idioma por defecto para mejorar recomendación a hispanohablantes.",
    });
  }

  // vídeos sin tags
  const noTags = await queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM videos v
     WHERE NOT EXISTS (SELECT 1 FROM video_tags t WHERE t.video_id=v.video_id)`
  );
  if (Number(noTags?.n ?? 0) > 0) {
    findings.push({
      severity: "alta", area: "vídeos", count: Number(noTags!.n),
      issue: `${noTags!.n} vídeos sin etiquetas (tags).`,
      recommendation: "Añade 8-15 tags relevantes por vídeo combinando término amplio (keto) + long-tail (desayuno keto fácil).",
    });
  }

  // descripciones pobres
  const shortDesc = await queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM videos WHERE length(coalesce(description,'')) < 150`
  );
  if (Number(shortDesc?.n ?? 0) > 0) {
    findings.push({
      severity: "media", area: "vídeos", count: Number(shortDesc!.n),
      issue: `${shortDesc!.n} vídeos con descripción <150 caracteres.`,
      recommendation: "Usa descripciones de 200+ palabras con keywords naturales, timestamps y enlaces internos a vídeos relacionados.",
    });
  }

  // títulos demasiado largos (se truncan ~60-70 chars)
  const longTitles = await queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM videos WHERE length(coalesce(title,'')) > 70`
  );
  if (Number(longTitles?.n ?? 0) > 0) {
    findings.push({
      severity: "baja", area: "vídeos", count: Number(longTitles!.n),
      issue: `${longTitles!.n} títulos >70 caracteres (riesgo de truncado).`,
      recommendation: "Coloca la keyword y el gancho en los primeros 60 caracteres.",
    });
  }

  // idioma de audio sin declarar
  const noAudioLang = await queryOne<{ n: string }>(
    `SELECT count(*)::text AS n FROM videos WHERE default_audio_language IS NULL`
  );
  if (Number(noAudioLang?.n ?? 0) > 0) {
    findings.push({
      severity: "baja", area: "vídeos", count: Number(noAudioLang!.n),
      issue: `${noAudioLang!.n} vídeos sin idioma de audio declarado.`,
      recommendation: "Declara 'es' como idioma de audio para habilitar subtítulos automáticos y doblaje multilenguaje.",
    });
  }

  const tagStats = await query<{ tag: string; n: string }>(
    `SELECT tag, count(*)::text AS n FROM video_tags GROUP BY tag ORDER BY count(*) DESC LIMIT 20`
  );

  await saveSnapshot("seo", "all", {
    findings: findings.sort((a, b) => sev(b.severity) - sev(a.severity)),
    channel_keywords: channel?.keywords ?? null,
    top_tags: tagStats.map((t) => ({ tag: t.tag, count: Number(t.n) })),
    health_score: Math.max(0, 100 - findings.reduce((a, f) => a + sev(f.severity) * 8, 0)),
  });
  log.info(`SEO audit: ${findings.length} hallazgos`);
}

function sev(s: Finding["severity"]): number {
  return s === "alta" ? 3 : s === "media" ? 2 : 1;
}
