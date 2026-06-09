-- 005_recipes.sql — "Recetas": archivo PERMANENTE de idea + guion.
--
-- Por qué tabla propia y NO reutilizar idea_scripts:
--   idea_scripts tiene FK ON DELETE CASCADE a daily_ideas (ver 002_analysis.sql),
--   y daily_ideas se BORRA y reinserta cada día en generateDailyIdeas(). Por eso
--   los guiones desaparecen al regenerar las ideas. Esta tabla fotografía la idea
--   y el guion en el momento de generar, SIN FK a daily_ideas, para que sobrevivan.

CREATE TABLE IF NOT EXISTS recipes (
  id                     BIGSERIAL PRIMARY KEY,
  title                  TEXT NOT NULL,
  hook_angle             TEXT,
  thumbnail_brief        TEXT,
  suggested_duration_sec INTEGER,
  keywords               TEXT[],
  script                 TEXT NOT NULL,
  model                  TEXT,
  source_idea_id         BIGINT,   -- referencia suelta (la idea puede borrarse); SIN FK
  for_date               DATE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recipes_created ON recipes(created_at DESC);
