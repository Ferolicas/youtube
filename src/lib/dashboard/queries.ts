import { query, queryOne } from "@/lib/db/pool";
import { latestSnapshot } from "@/lib/analysis/queries";
import { longOnlySql, INCLUDE_SHORTS } from "@/lib/analysis/scope";
import { hasConnection, hasMonetaryScope } from "@/lib/auth/tokens";
import { quotaSummary } from "@/lib/youtube/quota";
import { queueStats } from "@/lib/transcription/queue";

export async function getConnectionStatus() {
  const connected = await hasConnection();
  const channel = await queryOne<{ title: string; subscriber_count: string; video_count: number }>(
    `SELECT title, subscriber_count::text, video_count FROM channels LIMIT 1`
  );
  return {
    connected,
    monetary: connected ? await hasMonetaryScope() : false,
    channel,
  };
}

/**
 * Top movers: vídeos con más vistas ganadas en las últimas ~24h, calculado con
 * los snapshots del pulso (pk-pulse). Requiere al menos 2 snapshots separados.
 */
export async function getTopMovers(limit = 8) {
  return query<{
    video_id: string; title: string; gained: string; hours: string; vph: string; total: string;
  }>(`
    WITH latest AS (
      SELECT DISTINCT ON (video_id) video_id, captured_at, view_count
      FROM video_stats_snapshot ORDER BY video_id, captured_at DESC
    ),
    day_ago AS (
      SELECT DISTINCT ON (s.video_id) s.video_id, s.captured_at, s.view_count
      FROM video_stats_snapshot s
      WHERE s.captured_at <= now() - interval '20 hours'
        AND s.captured_at >= now() - interval '36 hours'
      ORDER BY s.video_id, s.captured_at DESC
    )
    SELECT v.video_id, v.title,
           (l.view_count - d.view_count)::text AS gained,
           round(EXTRACT(EPOCH FROM (l.captured_at - d.captured_at)) / 3600)::text AS hours,
           round((l.view_count - d.view_count)
                 / NULLIF(EXTRACT(EPOCH FROM (l.captured_at - d.captured_at)) / 3600, 0), 1)::text AS vph,
           l.view_count::text AS total
    FROM videos v
    JOIN latest l ON l.video_id = v.video_id
    JOIN day_ago d ON d.video_id = v.video_id
    WHERE ${longOnlySql("v")} AND l.view_count > d.view_count
    ORDER BY (l.view_count - d.view_count) DESC
    LIMIT $1
  `, [limit]);
}

/** Crecimiento del canal: agregados de la serie diaria (channel_stats_daily). */
export async function getChannelGrowth() {
  const r = await queryOne<{
    views_7d: string | null; views_30d: string | null;
    subs_7d: string | null; subs_30d: string | null;
    minutes_30d: string | null;
  }>(`
    SELECT
      SUM(views) FILTER (WHERE date >= (now()-interval '7 days')::date)::text AS views_7d,
      SUM(views) FILTER (WHERE date >= (now()-interval '30 days')::date)::text AS views_30d,
      SUM(COALESCE(subscribers_gained,0)-COALESCE(subscribers_lost,0))
        FILTER (WHERE date >= (now()-interval '7 days')::date)::text AS subs_7d,
      SUM(COALESCE(subscribers_gained,0)-COALESCE(subscribers_lost,0))
        FILTER (WHERE date >= (now()-interval '30 days')::date)::text AS subs_30d,
      SUM(estimated_minutes_watched) FILTER (WHERE date >= (now()-interval '30 days')::date)::text AS minutes_30d
    FROM channel_stats_daily
  `);
  return r;
}

export async function getOverview() {
  const counts = await queryOne<{ total: string; longs: string; shorts: string; transcribed: string }>(`
    SELECT
      count(*)::text AS total,
      count(*) FILTER (WHERE is_short=false)::text AS longs,
      count(*) FILTER (WHERE is_short=true)::text AS shorts,
      (SELECT count(*) FROM transcripts)::text AS transcribed
    FROM videos
  `);
  const medians = await query<{ is_short: boolean; med: string }>(`
    WITH snap AS (
      SELECT DISTINCT ON (video_id) video_id, view_count FROM video_stats_snapshot
      ORDER BY video_id, captured_at DESC
    )
    SELECT v.is_short, percentile_cont(0.5) WITHIN GROUP (ORDER BY COALESCE(snap.view_count,0))::text AS med
    FROM videos v LEFT JOIN snap ON snap.video_id=v.video_id GROUP BY v.is_short
  `);
  const lastSync = await queryOne<{ finished_at: string; status: string }>(
    `SELECT finished_at::text, status FROM sync_runs WHERE job_type='analytics' ORDER BY started_at DESC LIMIT 1`
  );
  const channel = await queryOne<{ title: string; subscriber_count: string; view_count: string; keywords: string | null }>(
    `SELECT title, subscriber_count::text, view_count::text, keywords FROM channels LIMIT 1`
  );
  const outliers = await query<{ video_id: string; title: string; views: string; performance_ratio: string }>(
    `SELECT o.video_id, v.title, o.views::text, o.performance_ratio::text
     FROM outlier_analysis o JOIN videos v ON v.video_id=o.video_id
     WHERE o.is_outlier AND ${longOnlySql("v")} ORDER BY o.views DESC LIMIT 5`
  );
  return {
    counts,
    medians: Object.fromEntries(medians.map((m) => [m.is_short ? "short" : "long", Math.round(Number(m.med))])),
    lastSync,
    channel,
    outliers,
    quota: await quotaSummary(),
    transcription: await queueStats(),
  };
}

export interface VideoListRow {
  video_id: string; title: string; is_short: boolean; published_at: string;
  duration_seconds: number; views: string; retention: string | null; subs: string | null;
  ctr: string | null;
}
export async function listVideos(format?: "long" | "short"): Promise<VideoListRow[]> {
  return query<VideoListRow>(`
    WITH snap AS (
      SELECT DISTINCT ON (video_id) video_id, view_count FROM video_stats_snapshot
      ORDER BY video_id, captured_at DESC
    ),
    agg AS (SELECT video_id, AVG(average_view_percentage) AS ret, SUM(subscribers_gained) AS subs
            FROM video_stats_daily GROUP BY video_id)
    SELECT v.video_id, v.title, v.is_short, v.published_at::text, v.duration_seconds,
           COALESCE(snap.view_count,0)::text AS views,
           agg.ret::numeric(6,2)::text AS retention, agg.subs::text AS subs,
           s.impressions_ctr::numeric(6,2)::text AS ctr
    FROM videos v
    LEFT JOIN snap ON snap.video_id=v.video_id
    LEFT JOIN agg ON agg.video_id=v.video_id
    LEFT JOIN studio_content_stats s ON s.video_id=v.video_id
    ${format ? `WHERE v.is_short=${format === "short"}` : ""}
    ORDER BY COALESCE(snap.view_count,0) DESC
  `);
}

/** CTR medio de canal ponderado por impresiones (umbral para marcar miniaturas a mejorar). */
export async function getChannelCtr(): Promise<number | null> {
  const r = await queryOne<{ ctr: string | null }>(
    `SELECT (SUM(s.impressions * s.impressions_ctr) / NULLIF(SUM(s.impressions),0))::numeric(6,2)::text AS ctr
     FROM studio_content_stats s JOIN videos v ON v.video_id=s.video_id
     WHERE ${longOnlySql("v")} AND s.impressions_ctr IS NOT NULL AND s.impressions IS NOT NULL`
  );
  return r?.ctr ? Number(r.ctr) : null;
}

export interface EndScreenRow {
  video_id: string; title: string | null; clicks: number; shown: number; ctr: string | null;
}
/** Rendimiento de pantallas finales por vídeo (dato exclusivo de YouTube Studio). */
export async function getEndScreensData(): Promise<EndScreenRow[]> {
  return query<EndScreenRow>(`
    SELECT s.video_id, v.title,
           COALESCE(s.endscreen_clicks,0)::int AS clicks,
           COALESCE(s.endscreens_shown,0)::int AS shown,
           s.endscreen_ctr::numeric(6,2)::text AS ctr
    FROM studio_content_stats s JOIN videos v ON v.video_id=s.video_id
    WHERE ${longOnlySql("v")} AND COALESCE(s.endscreens_shown,0) > 0
    ORDER BY s.endscreen_clicks DESC NULLS LAST, s.endscreen_ctr DESC NULLS LAST
    LIMIT 50
  `);
}

export async function getVideoDetail(id: string) {
  const video = await queryOne<Record<string, unknown>>(
    `SELECT v.*, t.full_text IS NOT NULL AS has_transcript FROM videos v
     LEFT JOIN transcripts t ON t.video_id=v.video_id WHERE v.video_id=$1`,
    [id]
  );
  if (!video) return null;
  const [retention, traffic, geography, demographics, devices, revenue, daily, outlier, thumb, transcriptHead] =
    await Promise.all([
      query<{ elapsed_ratio: string; audience_watch_ratio: string }>(
        `SELECT elapsed_ratio::text, audience_watch_ratio::text FROM video_retention WHERE video_id=$1 ORDER BY elapsed_ratio`, [id]),
      query<{ source_type: string; views: string }>(
        `SELECT source_type, SUM(views)::text AS views FROM video_traffic_sources WHERE video_id=$1 GROUP BY source_type ORDER BY SUM(views) DESC`, [id]),
      query<{ country_code: string; views: string }>(
        `SELECT country_code, SUM(views)::text AS views FROM video_geography WHERE video_id=$1 GROUP BY country_code ORDER BY SUM(views) DESC LIMIT 12`, [id]),
      query<{ age_group: string; gender: string; viewer_percentage: string }>(
        `SELECT age_group, gender, AVG(viewer_percentage)::numeric(6,2)::text AS viewer_percentage FROM video_demographics WHERE video_id=$1 GROUP BY age_group, gender ORDER BY AVG(viewer_percentage) DESC`, [id]),
      query<{ device_type: string; views: string }>(
        `SELECT device_type, SUM(views)::text AS views FROM video_devices WHERE video_id=$1 GROUP BY device_type ORDER BY SUM(views) DESC`, [id]),
      queryOne<{ revenue: string; cpm: string; rpm: string }>(
        `WITH snap AS (SELECT view_count FROM video_stats_snapshot WHERE video_id=$1 ORDER BY captured_at DESC LIMIT 1)
         SELECT SUM(estimated_revenue)::numeric(12,2)::text AS revenue,
                AVG(NULLIF(cpm,0))::numeric(8,2)::text AS cpm,
                (SUM(estimated_revenue)/NULLIF((SELECT view_count FROM snap),0)*1000)::numeric(8,2)::text AS rpm
         FROM video_revenue_daily WHERE video_id=$1`, [id]),
      query<{ date: string; views: string }>(
        `SELECT date::text, SUM(views)::text AS views FROM video_stats_daily WHERE video_id=$1 GROUP BY date ORDER BY date`, [id]),
      queryOne<{ z_score: string; performance_ratio: string; drivers: unknown; is_outlier: boolean }>(
        `SELECT z_score::text, performance_ratio::text, drivers, is_outlier FROM outlier_analysis WHERE video_id=$1`, [id]),
      queryOne<{ local_path: string; image_url: string; brightness: string; contrast: string; saturation: string; dominant_colors: unknown }>(
        `SELECT local_path, image_url, brightness::text, contrast::text, saturation::text, dominant_colors FROM thumbnails WHERE video_id=$1`, [id]),
      queryOne<{ snippet: string }>(
        `SELECT left(full_text, 1200) AS snippet FROM transcripts WHERE video_id=$1`, [id]),
    ]);
  const tags = await query<{ tag: string }>(`SELECT tag FROM video_tags WHERE video_id=$1 ORDER BY position`, [id]);
  // SEO: búsquedas reales que traen a este vídeo + vídeos que lo recomiendan
  const searchTerms = await query<{ detail: string; views: string }>(
    `SELECT detail, COALESCE(views,0)::text AS views FROM video_traffic_details
     WHERE video_id=$1 AND source_type='YT_SEARCH' ORDER BY views DESC NULLS LAST LIMIT 15`, [id]);
  const suggestedBy = await query<{ detail: string; views: string; title: string | null }>(
    `SELECT d.detail, COALESCE(d.views,0)::text AS views, v.title
     FROM video_traffic_details d LEFT JOIN videos v ON v.video_id=d.detail
     WHERE d.video_id=$1 AND d.source_type='RELATED_VIDEO'
     ORDER BY d.views DESC NULLS LAST LIMIT 10`, [id]);
  const seoScore = await queryOne<{ score: number; components: unknown }>(
    `SELECT score, components FROM video_seo_scores WHERE video_id=$1`, [id]);
  return { video, retention, traffic, geography, demographics, devices, revenue, daily, outlier, thumb, transcriptHead, tags, searchTerms, suggestedBy, seoScore };
}

export async function getOutliersData() {
  const snapshot = await latestSnapshot<Record<string, unknown>>("outliers");
  const rows = await query<{ video_id: string; title: string; views: string; z_score: string; performance_ratio: string; is_short: boolean; drivers: unknown }>(
    `SELECT o.video_id, v.title, o.views::text, o.z_score::text, o.performance_ratio::text, v.is_short, o.drivers
     FROM outlier_analysis o JOIN videos v ON v.video_id=o.video_id
     WHERE o.is_outlier AND ${longOnlySql("v")} ORDER BY o.views DESC`
  );
  return { snapshot, rows };
}

export async function getAudienceData() {
  return {
    long: await latestSnapshot<Record<string, unknown>>("audience", "long"),
    // Shorts solo si el toggle los incluye; por defecto la pestaña Audiencia es long-only.
    short: INCLUDE_SHORTS ? await latestSnapshot<Record<string, unknown>>("audience", "short") : null,
  };
}

export async function getThumbnailsData() {
  const snapshot = await latestSnapshot<Record<string, unknown>>("thumbnails");
  const list = await query<{ video_id: string; title: string; image_url: string; views: string; brightness: string; saturation: string }>(`
    WITH snap AS (SELECT DISTINCT ON (video_id) video_id, view_count FROM video_stats_snapshot ORDER BY video_id, captured_at DESC)
    SELECT t.video_id, v.title, t.image_url, COALESCE(snap.view_count,0)::text AS views,
           t.brightness::numeric(4,2)::text AS brightness, t.saturation::numeric(4,2)::text AS saturation
    FROM thumbnails t JOIN videos v ON v.video_id=t.video_id
    LEFT JOIN snap ON snap.video_id=t.video_id
    WHERE ${longOnlySql("v")}
    ORDER BY COALESCE(snap.view_count,0) DESC LIMIT 40
  `);
  const ctrImported = await queryOne<{ n: string }>(`SELECT count(*)::text AS n FROM thumbnail_ctr_import`);
  return { snapshot, list, ctrImported: Number(ctrImported?.n ?? 0) };
}

export async function getTrendsData() {
  const keywords = await query<{ keyword: string; score: string }>(
    `SELECT keyword, SUM(score)::numeric(8,1)::text AS score FROM trend_keywords
     WHERE for_date >= (now()-interval '7 day')::date GROUP BY keyword ORDER BY SUM(score) DESC LIMIT 30`
  );
  const competitors = await query<{ title: string; channel_title: string; view_count: string; vph: string; region: string; video_id: string }>(
    `SELECT title, channel_title, view_count::text, vph::text, region, video_id FROM competitor_videos
     ORDER BY vph DESC NULLS LAST LIMIT 25`
  );
  // radar: canales seguidos con su velocidad (subs ganados últimos 7d de serie diaria)
  const radar = await query<{
    channel_id: string; title: string; subscriber_count: string | null;
    subs_7d: string | null; videos_7d: string | null; last_checked: string | null;
  }>(`
    WITH delta AS (
      SELECT channel_id,
             MAX(subscribers) FILTER (WHERE date >= (now()-interval '7 days')::date)
               - MIN(subscribers) FILTER (WHERE date >= (now()-interval '7 days')::date) AS subs_7d,
             MAX(videos) FILTER (WHERE date >= (now()-interval '7 days')::date)
               - MIN(videos) FILTER (WHERE date >= (now()-interval '7 days')::date) AS videos_7d
      FROM competitor_channel_stats_daily GROUP BY channel_id
    )
    SELECT c.channel_id, c.title, c.subscriber_count::text,
           d.subs_7d::text, d.videos_7d::text, c.last_checked::text
    FROM competitor_channels c
    LEFT JOIN delta d ON d.channel_id = c.channel_id
    WHERE c.active
    ORDER BY c.subscriber_count DESC NULLS LAST
    LIMIT 25
  `);
  // posiciones: último chequeo por keyword
  const ranks = await query<{
    keyword: string; rank: number | null; video_id: string | null; checked_at: string; prev_rank: number | null;
  }>(`
    WITH ordered AS (
      SELECT keyword, region, rank, video_id, checked_at,
             ROW_NUMBER() OVER (PARTITION BY keyword, region ORDER BY checked_at DESC) AS rn
      FROM keyword_ranks
    )
    SELECT o1.keyword, o1.rank, o1.video_id, o1.checked_at::text,
           o2.rank AS prev_rank
    FROM ordered o1
    LEFT JOIN ordered o2 ON o2.keyword=o1.keyword AND o2.region=o1.region AND o2.rn=2
    WHERE o1.rn=1
    ORDER BY o1.rank ASC NULLS LAST, o1.checked_at DESC
    LIMIT 40
  `);
  return { keywords, competitors, radar, ranks };
}

/** Snapshot de insights de comentarios (preguntas, temas, sentimiento). */
export async function getCommentsData() {
  return latestSnapshot<Record<string, unknown>>("comments");
}

/** SEO scores por vídeo + resumen (gaps de contenido, peores/mejores). */
export async function getSeoScoresData() {
  const snapshot = await latestSnapshot<Record<string, unknown>>("seo_scores");
  const rows = await query<{
    video_id: string; title: string | null; score: number; components: unknown;
  }>(`
    SELECT s.video_id, v.title, s.score, s.components
    FROM video_seo_scores s JOIN videos v ON v.video_id=s.video_id
    WHERE ${longOnlySql("v")}
    ORDER BY s.score ASC
  `);
  return { snapshot, rows };
}

/** Top búsquedas reales del canal (última captura). */
export async function getChannelSearchTerms(limit = 25) {
  return query<{ term: string; views: string }>(`
    SELECT DISTINCT ON (term) term, COALESCE(views,0)::text AS views
    FROM channel_search_terms
    ORDER BY term, period_end DESC
  `).then((rows) => rows.sort((a, b) => Number(b.views) - Number(a.views)).slice(0, limit));
}

export async function getIdeasData(date?: string) {
  const forDate = date ?? (await queryOne<{ d: string }>(`SELECT max(for_date)::text AS d FROM daily_ideas`))?.d;
  if (!forDate) return { forDate: null, ideas: [] };
  const ideas = await query<{
    id: string; title: string; hook_angle: string; thumbnail_brief: string; suggested_duration_sec: number;
    keywords: string[]; suggested_publish_at: string; priority: string; rationale: unknown; source: string; has_script: boolean;
  }>(
    `SELECT i.id::text, i.title, i.hook_angle, i.thumbnail_brief, i.suggested_duration_sec, i.keywords,
            i.suggested_publish_at::text, i.priority::text, i.rationale, i.source,
            (s.idea_id IS NOT NULL) AS has_script
     FROM daily_ideas i LEFT JOIN idea_scripts s ON s.idea_id=i.id
     WHERE i.for_date=$1 ORDER BY i.priority DESC`,
    [forDate]
  );
  return { forDate, ideas };
}

export async function getScript(ideaId: string) {
  return queryOne<{ script: string; model: string }>(
    `SELECT script, model FROM idea_scripts WHERE idea_id=$1`, [ideaId]
  );
}

export async function getMonetizationData() {
  return latestSnapshot<Record<string, unknown>>("monetization");
}

export async function getScriptAnalysisData() {
  return latestSnapshot<Record<string, unknown>>("guion");
}

export async function getSeoData() {
  return latestSnapshot<Record<string, unknown>>("seo");
}

export async function getRecommendationsData() {
  return query<{ id: string; area: string; title: string; detail: string; impact: string; effort: string; evidence: unknown }>(
    `SELECT id::text, area, title, detail, impact::text, effort::text, evidence FROM recommendations
     WHERE status='open' ORDER BY impact DESC, effort ASC`
  );
}

export interface RecipeRow {
  id: string;
  title: string;
  hook_angle: string | null;
  thumbnail_brief: string | null;
  suggested_duration_sec: number | null;
  keywords: string[] | null;
  script: string;
  model: string | null;
  for_date: string | null;
  created_at: string;
}
/** Recetas guardadas (idea + guion), de nueva a vieja. */
export async function getRecipes(): Promise<RecipeRow[]> {
  return query<RecipeRow>(
    `SELECT id::text, title, hook_angle, thumbnail_brief, suggested_duration_sec, keywords,
            script, model, for_date::text AS for_date, created_at::text AS created_at
     FROM recipes ORDER BY created_at DESC`
  );
}

/** Borra una receta de forma permanente. Devuelve true si existía. */
export async function deleteRecipe(id: number): Promise<boolean> {
  const rows = await query<{ id: string }>(`DELETE FROM recipes WHERE id=$1 RETURNING id::text`, [id]);
  return rows.length > 0;
}
