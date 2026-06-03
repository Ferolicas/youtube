-- 002_analysis.sql — salidas del motor de análisis, tendencias, ideas y recomendaciones.

CREATE TABLE IF NOT EXISTS content_clusters (
  id BIGSERIAL PRIMARY KEY,
  label TEXT,
  keywords TEXT[],
  format TEXT,                       -- 'long' | 'short' | 'all'
  size INTEGER,
  avg_views NUMERIC,
  median_views NUMERIC,
  avg_retention NUMERIC,
  avg_rpm NUMERIC,
  computed_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cluster_members (
  cluster_id BIGINT REFERENCES content_clusters(id) ON DELETE CASCADE,
  video_id TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  distance NUMERIC,
  PRIMARY KEY (cluster_id, video_id)
);

-- Embeddings: bytea (float32 LE empaquetado) si no hay pgvector; o vector(N) si lo hay.
CREATE TABLE IF NOT EXISTS video_embeddings (
  video_id TEXT PRIMARY KEY REFERENCES videos(video_id) ON DELETE CASCADE,
  model TEXT,
  dims INTEGER,
  embedding BYTEA,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outlier_analysis (
  video_id TEXT PRIMARY KEY REFERENCES videos(video_id) ON DELETE CASCADE,
  is_outlier BOOLEAN,
  views BIGINT,
  z_score NUMERIC,
  performance_ratio NUMERIC,         -- views / mediana del canal (mismo formato)
  drivers JSONB,                     -- variables que explican el éxito + señales
  computed_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analysis_snapshots (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,                -- 'audience' | 'timing' | 'formats' | 'seo' | 'monetization'
  scope TEXT NOT NULL DEFAULT 'all', -- 'long' | 'short' | 'all'
  payload JSONB NOT NULL,
  computed_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_analysis_kind ON analysis_snapshots(kind, scope, computed_at DESC);

CREATE TABLE IF NOT EXISTS trend_keywords (
  id BIGSERIAL PRIMARY KEY,
  keyword TEXT NOT NULL,
  region TEXT,
  source TEXT NOT NULL,              -- 'google_trends' | 'youtube_search'
  score NUMERIC,
  captured_at TIMESTAMPTZ DEFAULT now(),
  for_date DATE DEFAULT (now() AT TIME ZONE 'UTC')::date
);
CREATE INDEX IF NOT EXISTS idx_trend_kw_date ON trend_keywords(for_date, source);

CREATE TABLE IF NOT EXISTS competitor_videos (
  video_id TEXT PRIMARY KEY,
  channel_id TEXT,
  channel_title TEXT,
  title TEXT,
  description TEXT,
  view_count BIGINT,
  like_count BIGINT,
  comment_count BIGINT,
  duration_seconds INTEGER,
  is_short BOOLEAN,
  published_at TIMESTAMPTZ,
  region TEXT,
  relevance NUMERIC,
  vph NUMERIC,                       -- views per hour desde publicación (señal outlier)
  captured_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_competitor_captured ON competitor_videos(captured_at DESC);

CREATE TABLE IF NOT EXISTS daily_ideas (
  id BIGSERIAL PRIMARY KEY,
  for_date DATE NOT NULL,
  title TEXT,
  hook_angle TEXT,
  thumbnail_brief TEXT,
  suggested_duration_sec INTEGER,
  keywords TEXT[],
  suggested_publish_at TIMESTAMPTZ,
  priority NUMERIC,
  rationale JSONB,
  source TEXT,                       -- 'llm' | 'data-driven'
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ideas_date ON daily_ideas(for_date, priority DESC);

CREATE TABLE IF NOT EXISTS idea_scripts (
  idea_id BIGINT PRIMARY KEY REFERENCES daily_ideas(id) ON DELETE CASCADE,
  script TEXT,
  model TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recommendations (
  id BIGSERIAL PRIMARY KEY,
  area TEXT NOT NULL,                -- 'config' | 'format_mix' | 'cadence' | 'seo' | 'monetization' | 'branding'
  title TEXT NOT NULL,
  detail TEXT,
  impact NUMERIC,                    -- 1..5
  effort NUMERIC,                    -- 1..5
  evidence JSONB,
  status TEXT DEFAULT 'open',        -- 'open' | 'done' | 'dismissed'
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reco_open ON recommendations(status, impact DESC);
