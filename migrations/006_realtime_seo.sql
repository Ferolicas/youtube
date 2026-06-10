-- 006_realtime_seo.sql — corrección de periodos acumulados + infraestructura
-- de tiempo real (alerts, job_state, websub, pulse) y SEO (search terms,
-- seo scores, radar de competidores, comentarios, ranks).

-- ============================================================
-- C1 — LIMPIEZA de periodos huérfanos.
-- El ingest insertaba un set acumulado (publicación→hoy) por día de sync sin
-- borrar el del día anterior; los consumidores suman TODOS los periodos.
-- Conservamos solo el periodo más reciente (period_end máximo) por vídeo.
-- A partir de ahora el código mantiene UN único set acumulado por vídeo.
-- ============================================================

DELETE FROM video_traffic_sources t
USING (SELECT video_id, MAX(period_end) AS max_end FROM video_traffic_sources GROUP BY video_id) m
WHERE t.video_id = m.video_id AND t.period_end < m.max_end;

DELETE FROM video_demographics d
USING (SELECT video_id, MAX(period_end) AS max_end FROM video_demographics GROUP BY video_id) m
WHERE d.video_id = m.video_id AND d.period_end < m.max_end;

DELETE FROM video_geography g
USING (SELECT video_id, MAX(period_end) AS max_end FROM video_geography GROUP BY video_id) m
WHERE g.video_id = m.video_id AND g.period_end < m.max_end;

DELETE FROM video_devices dv
USING (SELECT video_id, MAX(period_end) AS max_end FROM video_devices GROUP BY video_id) m
WHERE dv.video_id = m.video_id AND dv.period_end < m.max_end;

DELETE FROM video_revenue_geo r
USING (SELECT video_id, MAX(period_end) AS max_end FROM video_revenue_geo GROUP BY video_id) m
WHERE r.video_id = m.video_id AND r.period_end < m.max_end;

-- ============================================================
-- C2 — Estado de jobs (espejo legible de los advisory locks)
-- ============================================================
CREATE TABLE IF NOT EXISTS job_state (
  job_name    TEXT PRIMARY KEY,            -- 'sync' | 'analysis' | 'trends' | 'ideas' | 'pulse' | 'daily_pipeline'
  running     BOOLEAN NOT NULL DEFAULT false,
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  last_error  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- A3 — Detalle de fuentes de tráfico (search terms reales, vídeos que
-- nos recomiendan, etc.). Un set acumulado por (video, source_type).
-- ============================================================
CREATE TABLE IF NOT EXISTS video_traffic_details (
  video_id     TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  source_type  TEXT NOT NULL,              -- 'YT_SEARCH' | 'RELATED_VIDEO' | ...
  detail       TEXT NOT NULL,              -- término de búsqueda / video_id sugeridor
  views        BIGINT,
  estimated_minutes_watched BIGINT,
  period_start DATE,
  period_end   DATE,
  PRIMARY KEY (video_id, source_type, detail)
);
CREATE INDEX IF NOT EXISTS idx_vtd_type ON video_traffic_details(source_type, views DESC);

-- Términos de búsqueda a nivel canal (top 25 por consulta; histórico por periodo)
CREATE TABLE IF NOT EXISTS channel_search_terms (
  term         TEXT NOT NULL,
  views        BIGINT,
  estimated_minutes_watched BIGINT,
  period_start DATE NOT NULL,
  period_end   DATE NOT NULL,
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (term, period_end)
);

-- ============================================================
-- R1/R4 — Alertas (breakout, fallos, cuota, websub...)
-- ============================================================
CREATE TABLE IF NOT EXISTS alerts (
  id         BIGSERIAL PRIMARY KEY,
  kind       TEXT NOT NULL,                -- 'breakout' | 'pipeline_failed' | 'token_failed' | 'quota' | 'new_video' | 'competitor_video'
  title      TEXT NOT NULL,
  detail     TEXT,
  payload    JSONB,
  seen       BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_unseen ON alerts(seen) WHERE NOT seen;

-- Índice para consultas de pulso (deltas por captured_at)
CREATE INDEX IF NOT EXISTS idx_snapshot_captured ON video_stats_snapshot(captured_at DESC);

-- ============================================================
-- R2 — Suscripciones WebSub (push de subidas nuevas)
-- ============================================================
CREATE TABLE IF NOT EXISTS websub_subscriptions (
  channel_id         TEXT PRIMARY KEY,
  kind               TEXT NOT NULL,        -- 'own' | 'competitor'
  topic              TEXT NOT NULL,
  lease_until        TIMESTAMPTZ,
  last_subscribed_at TIMESTAMPTZ,
  last_notification  TIMESTAMPTZ
);

-- ============================================================
-- S2 — SEO score por vídeo
-- ============================================================
CREATE TABLE IF NOT EXISTS video_seo_scores (
  video_id    TEXT PRIMARY KEY REFERENCES videos(video_id) ON DELETE CASCADE,
  score       INTEGER NOT NULL,            -- 0-100
  components  JSONB NOT NULL,              -- desglose por factor con puntos y fix
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- S4 — Radar de competidores (canales seguidos por playlist, 1u)
-- ============================================================
CREATE TABLE IF NOT EXISTS competitor_channels (
  channel_id          TEXT PRIMARY KEY,
  title               TEXT,
  uploads_playlist_id TEXT,
  subscriber_count    BIGINT,
  video_count         INTEGER,
  view_count          BIGINT,
  country             TEXT,
  source              TEXT DEFAULT 'search',  -- 'search' | 'manual'
  active              BOOLEAN NOT NULL DEFAULT true,
  first_seen          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_checked        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS competitor_channel_stats_daily (
  channel_id  TEXT REFERENCES competitor_channels(channel_id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  subscribers BIGINT,
  views       BIGINT,
  videos      INTEGER,
  PRIMARY KEY (channel_id, date)
);

-- ============================================================
-- S5 — Comentarios propios (minería de preguntas/temas)
-- ============================================================
CREATE TABLE IF NOT EXISTS video_comments (
  comment_id   TEXT PRIMARY KEY,
  video_id     TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  author       TEXT,
  text         TEXT,
  like_count   INTEGER,
  reply_count  INTEGER,
  published_at TIMESTAMPTZ,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_comments_video ON video_comments(video_id, published_at DESC);

-- ============================================================
-- S6 — Rank tracking por keyword (search.list rotativo)
-- ============================================================
CREATE TABLE IF NOT EXISTS keyword_ranks (
  keyword    TEXT NOT NULL,
  region     TEXT NOT NULL DEFAULT 'MX',
  checked_at DATE NOT NULL,
  rank       INTEGER,                      -- posición de NUESTRO mejor vídeo (NULL = fuera del top)
  video_id   TEXT,                         -- nuestro vídeo mejor posicionado
  top        JSONB,                        -- top resultados (id, canal, título) para contexto
  PRIMARY KEY (keyword, region, checked_at)
);
CREATE INDEX IF NOT EXISTS idx_ranks_kw ON keyword_ranks(keyword, checked_at DESC);
