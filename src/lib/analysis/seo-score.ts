import { query, queryOne } from "@/lib/db/pool";
import { saveSnapshot } from "@/lib/analysis/queries";
import { longOnlySql } from "@/lib/analysis/scope";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("analysis:seo-score");

interface Component {
  key: string;
  label: string;
  points: number;      // obtenidos
  max: number;         // posibles
  fix: string | null;  // qué hacer si no está al máximo
}

interface ScoreRow {
  video_id: string;
  title: string | null;
  description: string | null;
  caption_available: boolean | null;
  has_transcript: boolean;
  tags_count: number;
  title_len: number;
  desc_len: number;
  chapters: number;
  links: number;
  ctr: number | null;
  impressions: number | null;
  endscreens_shown: number | null;
  endscreen_clicks: number | null;
  search_views: string | null;
  total_views: string | null;
  top_terms: string[] | null;
}

/**
 * SEO Score 0-100 por vídeo, compuesto por factores accionables. Todos los
 * insumos ya viven en la BD (metadata, Studio import, search terms reales).
 * Guarda el desglose en video_seo_scores y un resumen en el snapshot 'seo_scores'.
 */
export async function computeSeoScores(): Promise<void> {
  const channelCtr = await queryOne<{ ctr: string | null }>(`
    SELECT (SUM(s.impressions * s.impressions_ctr) / NULLIF(SUM(s.impressions),0))::numeric(6,3)::text AS ctr
    FROM studio_content_stats s JOIN videos v ON v.video_id=s.video_id
    WHERE ${longOnlySql("v")} AND s.impressions_ctr IS NOT NULL AND s.impressions IS NOT NULL
  `);
  const medianCtr = channelCtr?.ctr ? Number(channelCtr.ctr) : null;

  const rows = await query<ScoreRow>(`
    WITH tagc AS (SELECT video_id, count(*) AS n FROM video_tags GROUP BY video_id),
    tr AS (SELECT video_id FROM transcripts),
    search AS (
      SELECT video_id, SUM(views) AS sv,
             array_agg(detail ORDER BY views DESC) FILTER (WHERE views > 0) AS terms
      FROM video_traffic_details WHERE source_type='YT_SEARCH' GROUP BY video_id
    ),
    total AS (SELECT video_id, SUM(views) AS tv FROM video_traffic_sources GROUP BY video_id)
    SELECT v.video_id, v.title, v.description, v.caption_available,
           (tr.video_id IS NOT NULL) AS has_transcript,
           COALESCE(tagc.n,0)::int AS tags_count,
           length(coalesce(v.title,''))::int AS title_len,
           length(coalesce(v.description,''))::int AS desc_len,
           (SELECT count(*) FROM regexp_matches(coalesce(v.description,''), '^\\s*\\d{1,2}:\\d{2}', 'gm'))::int AS chapters,
           (SELECT count(*) FROM regexp_matches(coalesce(v.description,''), 'https?://', 'g'))::int AS links,
           s.impressions_ctr::float AS ctr, s.impressions::float AS impressions,
           s.endscreens_shown::int, s.endscreen_clicks::int,
           search.sv::text AS search_views, total.tv::text AS total_views,
           search.terms[1:5] AS top_terms
    FROM videos v
    LEFT JOIN tagc ON tagc.video_id=v.video_id
    LEFT JOIN tr ON tr.video_id=v.video_id
    LEFT JOIN studio_content_stats s ON s.video_id=v.video_id
    LEFT JOIN search ON search.video_id=v.video_id
    LEFT JOIN total ON total.video_id=v.video_id
    WHERE ${longOnlySql("v")}
  `);

  let computed = 0;
  const summaries: { video_id: string; title: string | null; score: number }[] = [];

  for (const r of rows) {
    const comps: Component[] = [];
    const title = (r.title ?? "").toLowerCase();

    // 1) Título (20)
    const titleOk = r.title_len > 0 && r.title_len <= 70;
    comps.push({
      key: "title_length", label: "Título ≤70 caracteres", max: 8,
      points: titleOk ? 8 : r.title_len <= 85 ? 4 : 0,
      fix: titleOk ? null : "Acorta el título; keyword y gancho en los primeros 60 caracteres.",
    });
    const matchedTerm = (r.top_terms ?? []).find((t) => t && title.includes(t.toLowerCase().slice(0, Math.max(4, t.length - 2))));
    const hasSearchData = (r.top_terms ?? []).length > 0;
    comps.push({
      key: "title_keyword", label: "Keyword real de búsqueda en el título", max: 12,
      points: !hasSearchData ? 6 : matchedTerm ? 12 : 0, // sin datos: neutro
      fix: !hasSearchData
        ? "Aún sin datos de búsqueda para este vídeo (umbral o sin tráfico de search)."
        : matchedTerm ? null
        : `Te encuentran buscando «${r.top_terms![0]}» pero el título no lo contiene: inclúyelo.`,
    });

    // 2) Descripción (25)
    comps.push({
      key: "description", label: "Descripción ≥200 caracteres", max: 10,
      points: r.desc_len >= 200 ? 10 : r.desc_len >= 100 ? 5 : 0,
      fix: r.desc_len >= 200 ? null : "Escribe 200+ caracteres con keywords naturales en las 2 primeras líneas.",
    });
    comps.push({
      key: "chapters", label: "Capítulos (timestamps)", max: 10,
      points: r.chapters >= 3 ? 10 : r.chapters > 0 ? 5 : 0,
      fix: r.chapters >= 3 ? null : "Añade 3+ capítulos (0:00 Intro...): mejoran búsqueda y key moments en Google.",
    });
    comps.push({
      key: "links", label: "Enlaces internos/CTA en descripción", max: 5,
      points: r.links > 0 ? 5 : 0,
      fix: r.links > 0 ? null : "Enlaza 1-2 vídeos/playlist tuyos relacionados (sesión más larga = señal positiva).",
    });

    // 3) Tags (10)
    comps.push({
      key: "tags", label: "8-15 etiquetas", max: 10,
      points: r.tags_count >= 8 ? 10 : r.tags_count >= 4 ? 5 : 0,
      fix: r.tags_count >= 8 ? null : "Añade tags: término amplio (keto) + long-tail (desayuno keto fácil).",
    });

    // 4) Subtítulos (10)
    const hasCaptions = r.caption_available === true || r.has_transcript;
    comps.push({
      key: "captions", label: "Subtítulos disponibles", max: 10,
      points: hasCaptions ? 10 : 0,
      fix: hasCaptions ? null : "Sube subtítulos en español (mejora indexación y accesibilidad).",
    });

    // 5) CTR vs canal (15) — solo si hay datos de Studio
    if (r.ctr !== null && medianCtr !== null && (r.impressions ?? 0) >= 500) {
      const ratio = r.ctr / medianCtr;
      comps.push({
        key: "ctr", label: `CTR ${r.ctr.toFixed(1)}% vs canal ${medianCtr.toFixed(1)}%`, max: 15,
        points: ratio >= 1.1 ? 15 : ratio >= 0.9 ? 10 : ratio >= 0.7 ? 5 : 0,
        fix: ratio >= 0.9 ? null : "CTR bajo el promedio del canal: prueba nueva miniatura/título (Test & Compare).",
      });
    } else {
      comps.push({
        key: "ctr", label: "CTR (sin datos suficientes de Studio)", max: 15, points: 8,
        fix: "Importa el CSV de Studio para evaluar CTR real (npm run import:studio).",
      });
    }

    // 6) Tráfico de búsqueda (10)
    const sv = Number(r.search_views ?? 0);
    const tv = Number(r.total_views ?? 0);
    if (tv > 100) {
      const share = sv / tv;
      comps.push({
        key: "search_share", label: `Búsqueda = ${(share * 100).toFixed(0)}% de vistas`, max: 10,
        points: share >= 0.25 ? 10 : share >= 0.1 ? 6 : share > 0 ? 3 : 0,
        fix: share >= 0.25 ? null : "Poco tráfico de búsqueda: refuerza keyword en título/descripción/capítulos.",
      });
    } else {
      comps.push({ key: "search_share", label: "Búsqueda (muestra insuficiente)", max: 10, points: 5, fix: null });
    }

    // 7) Pantalla final (10) — dato Studio
    if (r.endscreens_shown !== null && r.endscreens_shown > 0) {
      const ctr = (r.endscreen_clicks ?? 0) / r.endscreens_shown;
      comps.push({
        key: "endscreen", label: "Pantalla final activa", max: 10,
        points: ctr >= 0.03 ? 10 : 7,
        fix: ctr >= 0.03 ? null : "Pantalla final con CTR <3%: apunta a un vídeo MUY relacionado y menciónalo en voz.",
      });
    } else {
      comps.push({
        key: "endscreen", label: "Sin datos de pantalla final", max: 10, points: 5,
        fix: "Verifica que el vídeo tenga pantalla final (o importa el CSV de Studio).",
      });
    }

    const score = Math.round(
      (comps.reduce((a, c) => a + c.points, 0) / comps.reduce((a, c) => a + c.max, 0)) * 100
    );
    await query(
      `INSERT INTO video_seo_scores (video_id, score, components, computed_at)
       VALUES ($1,$2,$3, now())
       ON CONFLICT (video_id) DO UPDATE SET score=EXCLUDED.score,
         components=EXCLUDED.components, computed_at=now()`,
      [r.video_id, score, JSON.stringify(comps)]
    );
    summaries.push({ video_id: r.video_id, title: r.title, score });
    computed++;
  }

  // gaps de contenido: búsquedas del canal y tendencias sin vídeo que las cubra
  const gaps = await query<{ term: string; views: string; source: string }>(`
    WITH latest_terms AS (
      SELECT DISTINCT ON (term) term, views FROM channel_search_terms
      ORDER BY term, period_end DESC
    ),
    candidates AS (
      SELECT term, COALESCE(views,0) AS views, 'búsqueda real' AS source FROM latest_terms
      UNION ALL
      SELECT keyword AS term, COALESCE(SUM(score),0)::bigint AS views, 'tendencia' AS source
      FROM trend_keywords WHERE for_date >= (now()-interval '7 days')::date GROUP BY keyword
    )
    SELECT c.term, c.views::text, c.source FROM candidates c
    WHERE length(c.term) >= 5
      AND NOT EXISTS (
        SELECT 1 FROM videos v
        WHERE ${longOnlySql("v")}
          AND (lower(v.title) LIKE '%' || lower(c.term) || '%'
               OR EXISTS (SELECT 1 FROM video_tags t WHERE t.video_id=v.video_id
                          AND lower(t.tag) LIKE '%' || lower(c.term) || '%'))
      )
    ORDER BY c.views DESC LIMIT 20
  `);

  summaries.sort((a, b) => a.score - b.score);
  await saveSnapshot("seo_scores", "all", {
    computed,
    avg_score: summaries.length
      ? Math.round(summaries.reduce((a, s) => a + s.score, 0) / summaries.length)
      : null,
    worst: summaries.slice(0, 15),
    best: summaries.slice(-5).reverse(),
    content_gaps: gaps.map((g) => ({ term: g.term, weight: Number(g.views), source: g.source })),
  });
  log.info(`SEO scores: ${computed} vídeos, ${gaps.length} gaps de contenido`);
}
