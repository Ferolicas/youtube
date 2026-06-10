import { query } from "@/lib/db/pool";
import { env } from "@/config/env";
import { createLogger } from "@/lib/utils/logger";
import { searchVideos } from "@/lib/youtube/data-api";
import { usedToday } from "@/lib/youtube/quota";

const log = createLogger("trends:ranks");

const REGION = "MX"; // mercado principal LATAM; configurable a futuro

/**
 * Rank tracking: ¿en qué posición aparecen NUESTROS vídeos al buscar las
 * keywords que nos importan? Cada chequeo cuesta 100u (search.list), así que
 * se rotan RANK_KEYWORDS_PER_DAY por día, priorizando las menos recientes.
 * Fuentes de keywords: búsquedas reales del canal (channel_search_terms) +
 * tendencias (trend_keywords).
 */
export async function trackKeywordRanks(): Promise<number> {
  if (env.RANK_KEYWORDS_PER_DAY <= 0) return 0;

  // presupuesto: no arrancar si la cuota de hoy ya va muy gastada
  const used = await usedToday("data");
  const budget = env.QUOTA_DATA_DAILY * env.QUOTA_SAFETY_MARGIN;
  if (used + env.RANK_KEYWORDS_PER_DAY * 100 > budget * 0.8) {
    log.warn(`rank tracking pospuesto: cuota data ${used}/${Math.round(budget)}`);
    return 0;
  }

  // candidatas: top búsquedas reales + top tendencias, las menos chequeadas primero
  const candidates = await query<{ keyword: string }>(`
    WITH pool AS (
      SELECT term AS keyword, SUM(COALESCE(views,0)) AS weight
      FROM channel_search_terms
      WHERE captured_at > now() - interval '30 days'
      GROUP BY term
      UNION ALL
      SELECT keyword, SUM(COALESCE(score,0)) AS weight
      FROM trend_keywords
      WHERE for_date >= (now() - interval '7 days')::date
      GROUP BY keyword
    ),
    ranked AS (
      SELECT keyword, SUM(weight) AS w FROM pool GROUP BY keyword
    ),
    last_check AS (
      SELECT keyword, MAX(checked_at) AS last FROM keyword_ranks WHERE region=$1 GROUP BY keyword
    )
    SELECT r.keyword FROM ranked r
    LEFT JOIN last_check lc ON lc.keyword = r.keyword
    WHERE length(r.keyword) BETWEEN 4 AND 60
    ORDER BY lc.last ASC NULLS FIRST, r.w DESC
    LIMIT $2
  `, [REGION, env.RANK_KEYWORDS_PER_DAY]);

  if (candidates.length === 0) {
    log.info("rank tracking: sin keywords candidatas aún (faltan search terms/tendencias)");
    return 0;
  }

  const ownIds = new Set(
    (await query<{ video_id: string }>(`SELECT video_id FROM videos WHERE channel_id IS NOT NULL`))
      .map((r) => r.video_id)
  );
  const today = new Date().toISOString().slice(0, 10);

  let checked = 0;
  for (const c of candidates) {
    try {
      const results = await searchVideos({
        q: c.keyword,
        regionCode: REGION,
        order: "relevance",
        maxResults: 20,
        relevanceLanguage: "es",
      });
      let rank: number | null = null;
      let videoId: string | null = null;
      const top = results.slice(0, 10).map((r, i) => ({
        pos: i + 1,
        video_id: r.id?.videoId ?? null,
        title: r.snippet?.title ?? null,
        channel: r.snippet?.channelTitle ?? null,
      }));
      for (let i = 0; i < results.length; i++) {
        const id = results[i]?.id?.videoId;
        if (id && ownIds.has(id)) {
          rank = i + 1;
          videoId = id;
          break;
        }
      }
      await query(
        `INSERT INTO keyword_ranks (keyword, region, checked_at, rank, video_id, top)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (keyword, region, checked_at) DO UPDATE SET
           rank=EXCLUDED.rank, video_id=EXCLUDED.video_id, top=EXCLUDED.top`,
        [c.keyword, REGION, today, rank, videoId, JSON.stringify(top)]
      );
      checked++;
      log.info(`rank '${c.keyword}': ${rank === null ? "fuera del top 20" : `#${rank}`}`);
    } catch (e) {
      log.warn(`rank '${c.keyword}' falló: ${String(e).slice(0, 160)}`);
      break; // probablemente cuota; paramos limpio
    }
  }
  return checked;
}
