import { query } from "@/lib/db/pool";
import { searchVideos, getVideosByIds } from "@/lib/youtube/data-api";
import { isoDurationToSeconds } from "@/lib/utils/duration";
import { isoDaysAgo } from "@/lib/youtube/analytics-api";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("trends:youtube");

const KETO_SEEDS = [
  "keto recetas", "dieta cetogénica", "desayuno keto", "pan keto",
  "postres keto", "ayuno intermitente keto", "keto para principiantes",
  "bajar de peso keto", "menú keto semanal", "snacks keto",
];
const LATAM_REGIONS = ["MX", "CO", "AR", "PE", "CL"];

/**
 * Descubre competidores de alto rendimiento y keywords en alza en keto/LATAM
 * vía YouTube Data API (search oficial). Coste: 100 unidades por búsqueda.
 */
export async function discoverYoutubeTrends(opts: { maxSearches?: number } = {}) {
  const maxSearches = opts.maxSearches ?? 8;
  const publishedAfter = isoDaysAgo(30) + "T00:00:00Z";
  const seenIds = new Set<string>();
  const collectedIds: { id: string; region: string }[] = [];

  let searches = 0;
  for (const seed of KETO_SEEDS) {
    if (searches >= maxSearches) break;
    const region = LATAM_REGIONS[searches % LATAM_REGIONS.length]!;
    try {
      const results = await searchVideos({
        q: seed, regionCode: region, order: "viewCount",
        publishedAfter, maxResults: 20, relevanceLanguage: "es",
      });
      for (const r of results) {
        const id = r.id?.videoId;
        if (id && !seenIds.has(id)) {
          seenIds.add(id);
          collectedIds.push({ id, region });
        }
      }
      searches++;
    } catch (e) {
      log.warn(`search '${seed}' falló: ${String(e)}`);
      break; // probablemente cuota; paramos limpio
    }
  }

  if (collectedIds.length === 0) {
    log.warn("sin resultados de búsqueda (¿cuota agotada o sin API key?)");
    return { competitors: 0, keywords: 0 };
  }

  // hidratamos estadísticas + duración
  const videos = await getVideosByIds(collectedIds.map((c) => c.id));
  const regionById = new Map(collectedIds.map((c) => [c.id, c.region]));

  let comp = 0;
  for (const v of videos) {
    const views = Number(v.statistics?.viewCount ?? 0);
    const published = v.snippet?.publishedAt;
    const hours = published ? Math.max(1, (Date.now() - new Date(published).getTime()) / 3_600_000) : 1;
    const dur = isoDurationToSeconds(v.contentDetails?.duration);
    await query(
      `INSERT INTO competitor_videos (video_id, channel_id, channel_title, title, description,
         view_count, like_count, comment_count, duration_seconds, is_short, published_at, region, vph, captured_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
       ON CONFLICT (video_id) DO UPDATE SET view_count=EXCLUDED.view_count,
         like_count=EXCLUDED.like_count, comment_count=EXCLUDED.comment_count,
         vph=EXCLUDED.vph, captured_at=now()`,
      [
        v.id, v.snippet?.channelId ?? null, v.snippet?.channelTitle ?? null,
        v.snippet?.title ?? null, (v.snippet?.description ?? "").slice(0, 1000),
        views, Number(v.statistics?.likeCount ?? 0), Number(v.statistics?.commentCount ?? 0),
        dur, dur <= 180, published ?? null, regionById.get(v.id) ?? null,
        Number((views / hours).toFixed(1)),
      ]
    );
    comp++;
  }

  // keywords en alza: frecuencia de términos en títulos de los top por vph
  const kw = extractKeywords(videos.map((v) => v.snippet?.title ?? ""));
  for (const [keyword, score] of kw) {
    await query(
      `INSERT INTO trend_keywords (keyword, region, source, score) VALUES ($1,'LATAM','youtube_search',$2)`,
      [keyword, score]
    );
  }
  log.info(`tendencias YouTube: ${comp} competidores, ${kw.length} keywords`);
  return { competitors: comp, keywords: kw.length };
}

const STOP = new Set([
  "de", "la", "que", "el", "en", "y", "a", "los", "del", "se", "las", "por", "un",
  "para", "con", "no", "una", "su", "al", "lo", "como", "mas", "más", "keto", "como",
  "tu", "mi", "este", "esta", "muy", "the", "of", "to",
]);

function extractKeywords(titles: string[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const t of titles) {
    const words = t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9áéíóúñ ]/gi, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w));
    for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 25);
}
