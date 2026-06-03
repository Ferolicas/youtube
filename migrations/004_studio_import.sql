-- 004_studio_import.sql
-- Almacena métricas por vídeo que SOLO da YouTube Studio (export CSV) y que la
-- YouTube Analytics API NO expone (o expone mal): CTR/impresiones de miniatura,
-- pantallas finales, shopping, espectadores nuevos/recurrentes, engaged views, etc.
-- NO duplica ni machaca las métricas que la API ya mantiene a diario (vistas,
-- retención, ingresos, subs): eso vive en video_stats_daily / video_revenue_daily.
-- El CTR + impresiones también se vuelca a thumbnail_ctr_import (lo consume el
-- análisis de miniaturas).

CREATE TABLE IF NOT EXISTS studio_content_stats (
  video_id            TEXT PRIMARY KEY REFERENCES videos(video_id) ON DELETE CASCADE,
  period_start        DATE,
  period_end          DATE,
  -- audiencia (Studio-only: la API no da nuevos/recurrentes por vídeo)
  engaged_views       BIGINT,
  unique_viewers      BIGINT,
  avg_views_per_viewer NUMERIC,
  new_viewers         BIGINT,
  returning_viewers   BIGINT,
  casual_viewers      BIGINT,
  regular_viewers     BIGINT,
  stayed_to_watch_pct NUMERIC,
  -- impresiones / CTR de miniatura (NO existen en la API)
  impressions         BIGINT,
  impressions_ctr     NUMERIC,
  -- pantallas finales (NO existen en la API)
  endscreen_clicks    BIGINT,
  endscreens_shown    BIGINT,
  endscreen_ctr       NUMERIC,
  -- tarjetas (la API sí las da, se incluyen como foto Studio)
  card_clicks         BIGINT,
  cards_shown         BIGINT,
  card_ctr            NUMERIC,
  -- shopping / productos (NO existen en la API)
  product_clicks      BIGINT,
  product_impressions BIGINT,
  product_sales_eur   NUMERIC,
  product_orders      BIGINT,
  -- volcado íntegro de la fila (todas las columnas del CSV) por si hace falta luego
  raw                 JSONB,
  imported_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
