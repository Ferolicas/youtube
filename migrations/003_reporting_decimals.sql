-- 003_reporting_decimals.sql
-- Fix de ingesta Reporting/Analytics: el "watch time" en minutos llega como DECIMAL
-- (watch_time_minutes = segundos_vistos / 60, p. ej. 43.7367), pero estas columnas
-- se declararon BIGINT en 001_init.sql. Eso provocaba:
--     invalid input syntax for type bigint: "43.7367"
-- y descartaba decenas de reportes. Cambiamos las columnas de DURACIÓN (minutos
-- vistos) a DOUBLE PRECISION.
--
-- Qué NO se toca (a propósito):
--   • Contadores enteros legítimos: views, likes, comments, shares, card_impressions,
--     card_clicks, ad_impressions, monetized_playbacks, subscribers* → siguen BIGINT/INTEGER.
--   • average_view_duration / average_view_percentage → ya eran NUMERIC.
--   • Ingresos (estimated_revenue, *_revenue, cpm, playback_based_cpm) → ya eran NUMERIC,
--     nunca fueron BIGINT, así que no estaban afectados por este bug.
--
-- El cast BIGINT -> DOUBLE PRECISION es seguro: los valores existentes son enteros.

ALTER TABLE channel_stats_daily
  ALTER COLUMN estimated_minutes_watched TYPE double precision
  USING estimated_minutes_watched::double precision;

ALTER TABLE video_stats_daily
  ALTER COLUMN estimated_minutes_watched TYPE double precision
  USING estimated_minutes_watched::double precision;

ALTER TABLE video_traffic_sources
  ALTER COLUMN estimated_minutes_watched TYPE double precision
  USING estimated_minutes_watched::double precision;

ALTER TABLE video_geography
  ALTER COLUMN estimated_minutes_watched TYPE double precision
  USING estimated_minutes_watched::double precision;

ALTER TABLE video_devices
  ALTER COLUMN estimated_minutes_watched TYPE double precision
  USING estimated_minutes_watched::double precision;
