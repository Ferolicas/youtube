import { query } from "@/lib/db/pool";

/** Vista materializada en memoria de cada vídeo con sus métricas clave. */
export interface VideoMetrics {
  video_id: string;
  title: string | null;
  published_at: string | null;
  duration_seconds: number | null;
  is_short: boolean | null;
  views: number;
  avg_view_percentage: number | null;
  avg_view_duration: number | null;
  subscribers_gained: number | null;
  estimated_revenue: number | null;
  cpm: number | null;
  monetized_playbacks: number | null;
  first30: string | null;
  tags_count: number;
}

export async function getVideoMetrics(): Promise<VideoMetrics[]> {
  return query<VideoMetrics>(`
    WITH latest_snap AS (
      SELECT DISTINCT ON (video_id) video_id, view_count
      FROM video_stats_snapshot ORDER BY video_id, captured_at DESC
    ),
    agg AS (
      SELECT video_id,
             AVG(average_view_percentage) AS avg_view_percentage,
             AVG(average_view_duration)   AS avg_view_duration,
             SUM(subscribers_gained)      AS subscribers_gained
      FROM video_stats_daily GROUP BY video_id
    ),
    rev AS (
      SELECT video_id, SUM(estimated_revenue) AS estimated_revenue,
             AVG(NULLIF(cpm,0)) AS cpm, SUM(monetized_playbacks) AS monetized_playbacks
      FROM video_revenue_daily GROUP BY video_id
    ),
    first30 AS (
      SELECT video_id, string_agg(text, ' ' ORDER BY idx) AS first30
      FROM transcript_segments WHERE start_sec <= 30 GROUP BY video_id
    ),
    tagc AS (SELECT video_id, count(*) AS tags_count FROM video_tags GROUP BY video_id)
    SELECT v.video_id, v.title, v.published_at::text, v.duration_seconds, v.is_short,
           COALESCE(ls.view_count, 0)::float AS views,
           a.avg_view_percentage::float AS avg_view_percentage,
           a.avg_view_duration::float AS avg_view_duration,
           a.subscribers_gained::float AS subscribers_gained,
           rev.estimated_revenue::float AS estimated_revenue,
           rev.cpm::float AS cpm,
           rev.monetized_playbacks::float AS monetized_playbacks,
           f.first30, COALESCE(tc.tags_count, 0)::int AS tags_count
    FROM videos v
    LEFT JOIN latest_snap ls ON ls.video_id = v.video_id
    LEFT JOIN agg a ON a.video_id = v.video_id
    LEFT JOIN rev ON rev.video_id = v.video_id
    LEFT JOIN first30 f ON f.video_id = v.video_id
    LEFT JOIN tagc tc ON tc.video_id = v.video_id
  `);
}

export async function saveSnapshot(kind: string, scope: string, payload: unknown): Promise<void> {
  await query(
    `INSERT INTO analysis_snapshots (kind, scope, payload) VALUES ($1,$2,$3)`,
    [kind, scope, JSON.stringify(payload)]
  );
}

export async function latestSnapshot<T>(kind: string, scope = "all"): Promise<T | null> {
  const rows = await query<{ payload: T }>(
    `SELECT payload FROM analysis_snapshots WHERE kind=$1 AND scope=$2
     ORDER BY computed_at DESC LIMIT 1`,
    [kind, scope]
  );
  return rows[0]?.payload ?? null;
}
