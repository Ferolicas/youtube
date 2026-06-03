-- 001_init.sql — esquema base: auth, canal, vídeos, métricas, transcripción, jobs.

-- ===================== AUTH =====================
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id            SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  google_email  TEXT NOT NULL,
  access_token  BYTEA NOT NULL,
  refresh_token BYTEA NOT NULL,
  scopes        TEXT[] NOT NULL,
  token_type    TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===================== CANAL =====================
CREATE TABLE IF NOT EXISTS channels (
  channel_id          TEXT PRIMARY KEY,
  title               TEXT,
  description         TEXT,
  custom_url          TEXT,
  published_at        TIMESTAMPTZ,
  country             TEXT,
  default_language    TEXT,
  keywords            TEXT,
  topic_ids           TEXT[],
  uploads_playlist_id TEXT,
  thumbnails          JSONB,
  subscriber_count    BIGINT,
  view_count          BIGINT,
  video_count         INTEGER,
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channel_stats_daily (
  channel_id  TEXT REFERENCES channels(channel_id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  subscribers BIGINT,
  views       BIGINT,
  estimated_minutes_watched BIGINT,
  subscribers_gained INTEGER,
  subscribers_lost   INTEGER,
  PRIMARY KEY (channel_id, date)
);

-- ===================== VÍDEOS =====================
CREATE TABLE IF NOT EXISTS videos (
  video_id               TEXT PRIMARY KEY,
  channel_id             TEXT REFERENCES channels(channel_id) ON DELETE CASCADE,
  title                  TEXT,
  description            TEXT,
  published_at           TIMESTAMPTZ,
  duration_seconds       INTEGER,
  is_short               BOOLEAN,
  short_detection_method TEXT,
  category_id            TEXT,
  default_language       TEXT,
  default_audio_language TEXT,
  definition             TEXT,
  dimension              TEXT,
  caption_available      BOOLEAN,
  licensed_content       BOOLEAN,
  made_for_kids          BOOLEAN,
  privacy_status         TEXT,
  thumbnails             JSONB,
  topic_ids              TEXT[],
  fetched_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_videos_channel_pub ON videos(channel_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_is_short ON videos(is_short);
CREATE INDEX IF NOT EXISTS idx_videos_title_fts
  ON videos USING GIN (to_tsvector('spanish', coalesce(title, '')));

CREATE TABLE IF NOT EXISTS video_tags (
  video_id TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  position INTEGER,
  PRIMARY KEY (video_id, tag)
);

CREATE TABLE IF NOT EXISTS video_stats_snapshot (
  video_id      TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  view_count    BIGINT,
  like_count    BIGINT,
  comment_count BIGINT,
  favorite_count BIGINT,
  PRIMARY KEY (video_id, captured_at)
);

-- ===================== MÉTRICAS PRIVADAS =====================
CREATE TABLE IF NOT EXISTS video_stats_daily (
  video_id TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  date     DATE NOT NULL,
  views BIGINT,
  estimated_minutes_watched BIGINT,
  average_view_duration NUMERIC,
  average_view_percentage NUMERIC,
  likes INTEGER, comments INTEGER, shares INTEGER,
  subscribers_gained INTEGER, subscribers_lost INTEGER,
  card_impressions BIGINT, card_clicks BIGINT, card_click_rate NUMERIC,
  source TEXT,
  PRIMARY KEY (video_id, date)
);

CREATE TABLE IF NOT EXISTS video_retention (
  video_id TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  elapsed_ratio NUMERIC NOT NULL,
  audience_watch_ratio NUMERIC,
  relative_retention_performance NUMERIC,
  computed_through DATE,
  PRIMARY KEY (video_id, elapsed_ratio)
);

CREATE TABLE IF NOT EXISTS video_traffic_sources (
  video_id TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  period_start DATE, period_end DATE,
  source_type TEXT NOT NULL,
  source_detail TEXT NOT NULL DEFAULT '',
  views BIGINT, estimated_minutes_watched BIGINT,
  PRIMARY KEY (video_id, period_start, period_end, source_type, source_detail)
);

CREATE TABLE IF NOT EXISTS video_demographics (
  video_id TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  period_start DATE, period_end DATE,
  age_group TEXT NOT NULL,
  gender TEXT NOT NULL,
  viewer_percentage NUMERIC,
  PRIMARY KEY (video_id, period_start, period_end, age_group, gender)
);

CREATE TABLE IF NOT EXISTS video_geography (
  video_id TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  period_start DATE, period_end DATE,
  country_code TEXT NOT NULL,
  views BIGINT, estimated_minutes_watched BIGINT, average_view_duration NUMERIC,
  PRIMARY KEY (video_id, period_start, period_end, country_code)
);

CREATE TABLE IF NOT EXISTS video_devices (
  video_id TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  period_start DATE, period_end DATE,
  device_type TEXT NOT NULL,
  operating_system TEXT NOT NULL DEFAULT '',
  views BIGINT, estimated_minutes_watched BIGINT,
  PRIMARY KEY (video_id, period_start, period_end, device_type, operating_system)
);

-- Monetización (YPP + scope monetario). RPM se deriva en consulta.
CREATE TABLE IF NOT EXISTS video_revenue_daily (
  video_id TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  date DATE NOT NULL,
  estimated_revenue NUMERIC,
  estimated_ad_revenue NUMERIC,
  estimated_red_partner_revenue NUMERIC,
  gross_revenue NUMERIC,
  cpm NUMERIC,
  playback_based_cpm NUMERIC,
  ad_impressions BIGINT,
  monetized_playbacks BIGINT,
  PRIMARY KEY (video_id, date)
);

CREATE TABLE IF NOT EXISTS video_revenue_geo (
  video_id TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  period_start DATE, period_end DATE,
  country_code TEXT NOT NULL,
  estimated_revenue NUMERIC, cpm NUMERIC, playback_based_cpm NUMERIC,
  monetized_playbacks BIGINT,
  PRIMARY KEY (video_id, period_start, period_end, country_code)
);

-- ===================== MINIATURAS =====================
CREATE TABLE IF NOT EXISTS thumbnails (
  video_id TEXT PRIMARY KEY REFERENCES videos(video_id) ON DELETE CASCADE,
  image_url TEXT, local_path TEXT, width INTEGER, height INTEGER,
  dominant_colors JSONB, brightness NUMERIC, contrast NUMERIC, saturation NUMERIC,
  colorfulness NUMERIC,
  has_face BOOLEAN, face_count INTEGER, detected_text TEXT,
  analysis_model TEXT, analyzed_at TIMESTAMPTZ
);

-- Workaround: impresiones/CTR de miniatura NO existen en la API -> import CSV de Studio.
CREATE TABLE IF NOT EXISTS thumbnail_ctr_import (
  video_id TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  period_start DATE, period_end DATE,
  impressions BIGINT, ctr NUMERIC,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (video_id, period_start, period_end)
);

-- ===================== TRANSCRIPCIÓN =====================
CREATE TABLE IF NOT EXISTS transcripts (
  video_id TEXT PRIMARY KEY REFERENCES videos(video_id) ON DELETE CASCADE,
  language TEXT,
  source TEXT,
  model TEXT,
  full_text TEXT,
  fts tsvector GENERATED ALWAYS AS (to_tsvector('spanish', coalesce(full_text, ''))) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transcripts_fts ON transcripts USING GIN (fts);

CREATE TABLE IF NOT EXISTS transcript_segments (
  video_id TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  start_sec NUMERIC, end_sec NUMERIC, text TEXT,
  PRIMARY KEY (video_id, idx)
);

-- ===================== LISTAS / SECCIONES =====================
CREATE TABLE IF NOT EXISTS playlists (
  playlist_id TEXT PRIMARY KEY,
  channel_id TEXT REFERENCES channels(channel_id) ON DELETE CASCADE,
  title TEXT, description TEXT, item_count INTEGER,
  fetched_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS playlist_items (
  playlist_id TEXT REFERENCES playlists(playlist_id) ON DELETE CASCADE,
  video_id TEXT, position INTEGER,
  PRIMARY KEY (playlist_id, video_id)
);
CREATE TABLE IF NOT EXISTS channel_sections (
  section_id TEXT PRIMARY KEY,
  channel_id TEXT REFERENCES channels(channel_id) ON DELETE CASCADE,
  type TEXT, style TEXT, position INTEGER, content JSONB
);

-- ===================== JOBS / CUOTA =====================
CREATE TABLE IF NOT EXISTS sync_runs (
  id BIGSERIAL PRIMARY KEY,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  cursor JSONB,
  items_processed INTEGER DEFAULT 0,
  error TEXT,
  started_at TIMESTAMPTZ DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_type ON sync_runs(job_type, started_at DESC);

CREATE TABLE IF NOT EXISTS transcription_queue (
  video_id TEXT PRIMARY KEY REFERENCES videos(video_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  source_planned TEXT,
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  audio_path TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tq_status ON transcription_queue(status);

CREATE TABLE IF NOT EXISTS api_quota_log (
  id BIGSERIAL PRIMARY KEY,
  api TEXT NOT NULL,
  endpoint TEXT,
  cost_units INTEGER,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  day DATE GENERATED ALWAYS AS ((occurred_at AT TIME ZONE 'UTC')::date) STORED
);
CREATE INDEX IF NOT EXISTS idx_quota_day_api ON api_quota_log(day, api);

CREATE TABLE IF NOT EXISTS reporting_jobs (
  job_id TEXT PRIMARY KEY,
  report_type TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reporting_downloads (
  report_id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES reporting_jobs(job_id) ON DELETE CASCADE,
  start_date DATE, end_date DATE,
  status TEXT, downloaded_at TIMESTAMPTZ
);
