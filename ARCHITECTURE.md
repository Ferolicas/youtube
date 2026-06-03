# ARCHITECTURE.md — YouTube Deep Intelligence (Planeta Keto)

> **Estado:** FASE 0 — Arquitectura y decisiones. Documento para validación.
> **Naturaleza:** herramienta personal de inteligencia de canal, mono-usuario, self-hosted en VPS.
> **Canal objetivo:** Planeta Keto · contenido keto en español · público LATAM.
> **Stack:** Next.js 15 (App Router) + TypeScript estricto + PostgreSQL nativo (`pg`) + PM2 + Caddy.
> **NO se usa:** Vercel, Supabase ni ningún servicio gestionado. Todo corre contra tu Postgres nativo en tu VPS.

---

## 0. Principios de diseño

1. **Servidor siempre.** Tokens, llamadas a APIs de YouTube, queries a BD y lógica de negocio viven en el servidor (Server Components, Server Actions, API Routes y workers). El cliente solo pinta.
2. **Idempotencia y reanudabilidad.** Toda ingesta y transcripción se puede cortar y reanudar sin duplicar ni corromper. Todo es `UPSERT` por clave natural + tabla de estado por job.
3. **Honestidad de datos.** Si un dato no existe en la API, **no se inventa**: se marca como no disponible y, cuando hay un camino alternativo (p. ej. importar CSV de Studio), se ofrece explícitamente. Ver §4.
4. **Cuota como recurso de primera clase.** Cada llamada se contabiliza en BD; hay backoff exponencial y cortes preventivos antes del límite diario.
5. **Separación dev/prod.** Desarrollo en Windows (`C:\YOUTUBE`), producción en VPS Linux. Rutas y binarios (yt-dlp, ffmpeg, whisper) abstraídos por configuración, nunca hardcodeados.

---

## 1. Diagrama de módulos y flujo de datos

Flujo macro: **Ingesta → Almacenamiento → Análisis → Recomendación → UI.**

```
┌─────────────────────────────────────────────────────────────────────┐
│                            NAVEGADOR (tú)                             │
│        Next.js 15 App Router · Dashboard · Server Components          │
└───────────────▲─────────────────────────────────────┬───────────────┘
                │ HTTPS                                 │ acciones
        ┌───────┴───────────┐ Caddy (reverse proxy, TLS automático)    │
        │   CAPA WEB (PM2)  │                  ┌────────▼──────────┐
        │  next start :3000 │                  │ API ROUTES /      │
        └───────┬───────────┘                  │ SERVER ACTIONS    │
                │                               └────────┬──────────┘
                │             ┌───────────────────────────┘
                ▼             ▼
        ┌──────────────────────────────────┐
        │   PostgreSQL nativo  (pool `pg`)  │◄───────────────┐
        │   migraciones versionadas         │                │
        └──▲────────▲──────────▲────────────┘                │
           │        │          │                             │
  ┌────────┴──┐ ┌───┴──────┐ ┌─┴──────────────┐  ┌───────────┴────────┐
  │  INGESTA  │ │ ANÁLISIS │ │   TENDENCIAS   │  │   TRANSCRIPCIÓN    │
  │ (workers) │ │(workers) │ │   (worker)     │  │     (worker)       │
  └────┬──────┘ └──────────┘ └───────┬────────┘  └─────────┬──────────┘
       │                             │                     │
 ┌─────┴───────────────┐    ┌────────┴───────┐   ┌─────────┴──────────┐
 │ YouTube Data API v3 │    │ YT Data search │   │ yt-dlp (audio+subs)│
 │ YT Analytics API v2 │    │ Google Trends* │   │ faster-whisper     │
 │ YT Reporting API    │    └────────────────┘   │ ffmpeg             │
 └─────────────────────┘                         └────────────────────┘
   (*) Trends: librería no oficial, best-effort (ver §4.4)
```

### Módulos (carpetas por dominio)

```
/src
  /app                      → Next.js App Router (UI + API routes)
    /(dashboard)            → vistas protegidas
    /api                    → endpoints server-only (oauth callback, triggers, health)
  /lib
    /db                     → pool pg, repositorios, helpers de query
    /auth                   → OAuth Google, cifrado y refresco de tokens
    /youtube                → clientes Data/Analytics/Reporting + rate limiter + quota log
    /transcription          → orquestación yt-dlp + whisper + cola
    /analysis               → outliers, clustering, audiencia, timing, miniaturas, SEO, AdSense
    /trends                 → search competidores + google trends
    /ideas                  → generador de ideas + guiones
    /recommendations        → motor de recomendaciones priorizadas
    /validations            → esquemas Zod reutilizables
    /config                 → env tipado, rutas de binarios, constantes
  /workers                  → entrypoints PM2 (cron sync, transcription, trends, analysis)
/migrations                 → SQL versionado (node-pg-migrate)
```

### Procesos PM2 (prod)

| Proceso | Tipo | Función |
|---|---|---|
| `pk-web` | servidor | `next start`, sirve dashboard + API routes |
| `pk-sync` | cron | sync incremental diario (Data + Analytics + descarga Reporting) |
| `pk-transcribe` | worker | drena la cola de transcripción (1 job a la vez, baja prioridad) |
| `pk-trends` | cron | tendencias keto/LATAM + competidores (1×/día) |
| `pk-analysis` | cron | recálculo de outliers/clusters/recomendaciones tras cada sync |

---

## 2. Topología de despliegue

- **Dev:** Windows (`C:\YOUTUBE`), Node 20+, Postgres local o túnel al VPS. yt-dlp/ffmpeg/whisper opcionales en dev.
- **Prod:** VPS Linux, 4 cores (asumido sin GPU — ver §7 y §11). Caddy hace TLS automático (Let's Encrypt) y proxy a `127.0.0.1:3000`. PM2 gobierna todos los procesos con `pm2 startup` + `pm2 save`.
- **Secrets:** `.env` fuera del repo, `.env.example` con llaves sin valores. `TOKEN_ENC_KEY` para cifrar tokens. Nada de credenciales en el bundle del cliente.

---

## 3. APIs de YouTube — qué saca exactamente cada una

> Las tres APIs se habilitan en el mismo proyecto de Google Cloud y comparten el cliente OAuth. Scopes solicitados (solo lectura):
> `youtube.readonly`, `yt-analytics.readonly`, `yt-analytics-monetary.readonly`.

### 3.1 YouTube Data API v3 — catálogo, metadata pública y configuración

| Llamada | `part` / params | Qué obtenemos | Coste |
|---|---|---|---|
| `channels.list` | `snippet,contentDetails,statistics,brandingSettings,topicDetails,status` | Datos del canal, **keywords del canal** (`brandingSettings.channel.keywords`), país, idioma por defecto, `uploads` playlist ID, totales (subs, vistas, nº vídeos) | 1 |
| `playlistItems.list` | playlist = uploads, `snippet,contentDetails` | IDs de **todos** los vídeos (paginación completa, 50/página) | 1/página |
| `videos.list` | `snippet,contentDetails,statistics,status,topicDetails,localizations` (50 IDs/llamada) | Título, descripción, `publishedAt`, **tags**, categoría, `duration` (ISO-8601), definition/dimension, idioma por defecto y de audio, miniaturas, privacy, `madeForKids`, **statistics** (views/likes/comments) | 1/lote |
| `playlists.list` | `snippet,contentDetails` | Listas de reproducción del canal | 1 |
| `channelSections.list` | `snippet,contentDetails` | **Secciones** y orden de la home del canal | 1 |
| `search.list` | `type=video`, `regionCode`, `order`, `q`, `publishedAfter` | Competidores y vídeos populares del nicho (solo stats públicas) | **100** |
| `captions.list` | `part=snippet`, `videoId` | Pistas de subtítulos disponibles del **propio** canal | 50 |

**Diferenciación Short vs largo (no hay flag oficial):**
1. Pre-filtro por `duration` ≤ 180s (Shorts admiten hasta 3 min desde 2025; histórico ≤ 60s).
2. Verificación autoritativa: HEAD a `https://www.youtube.com/shorts/{id}` → si responde 200 (no redirige a `/watch`), es Short. yt-dlp también expone aspecto vertical.
Se guarda `is_short` + `short_detection_method` para trazabilidad.

### 3.2 YouTube Analytics API v2 — métricas privadas (`reports.query`)

Todas con `ids=channel==MINE`, `startDate`/`endDate` y `filters=video==<ID>` para nivel vídeo.

| Insight | dimensions | metrics | Disponible |
|---|---|---|---|
| Serie temporal por vídeo | `day` | `views, estimatedMinutesWatched, averageViewDuration, averageViewPercentage, likes, comments, shares, subscribersGained, subscribersLost` | ✅ |
| **Curva de retención** | `elapsedVideoTimeRatio` | `audienceWatchRatio, relativeRetentionPerformance` | ✅ (sujeto a umbral de muestra) |
| Fuentes de tráfico | `insightTrafficSourceType` (+ `insightTrafficSourceDetail`) | `views, estimatedMinutesWatched` | ✅ |
| Demografía | `ageGroup, gender` | `viewerPercentage` | ✅ (sujeto a umbral) |
| Geografía (LATAM) | `country` (+ `province`) | `views, estimatedMinutesWatched, averageViewDuration` | ✅ |
| Dispositivo / SO | `deviceType, operatingSystem` | `views, estimatedMinutesWatched` | ✅ |
| Cards | (agregado) | `cardImpressions, cardClicks, cardClickRate, cardTeaserImpressions, cardTeaserClicks, cardTeaserClickRate` | ✅ |
| Suscriptores por vídeo | `day` o agregado | `subscribersGained, subscribersLost` | ✅ |
| **Monetización (AdSense)** | `day` / `country` | `estimatedRevenue, estimatedAdRevenue, grossRevenue, cpm, playbackBasedCpm, adImpressions, monetizedPlaybacks` | ✅ **solo si el canal está en YPP** + scope monetario |

### 3.3 YouTube Reporting API — backfill histórico masivo (bulk CSV)

- Modelo: se crea **un reporting job por tipo de reporte**; Google genera **CSVs diarios** descargables y hace **backfill histórico (hasta ~180 días)** al crear el job. Cada CSV queda disponible ~60 días.
- Uso en este proyecto: **cargar el histórico completo día-a-día** (actividad de usuario, fuentes de tráfico, demografía, dispositivos, geografía y —si hay YPP— informes de ingresos `*_a1`) **sin quemar la cuota de Analytics**.
- División de trabajo: Reporting = backfill profundo y barato; Analytics = consultas on-demand y refresco incremental reciente.

---

## 4. Limitaciones reales de las APIs (lo que **NO** se puede hacer)

> Esto es lo que me pediste explícitamente: marcar lo que no es posible en lugar de simularlo. Afecta a varias fases, así que conviene decidirlo ahora.

### 4.1 ⚠️ Impresiones de miniatura y CTR de impresiones — **NO disponibles en NINGUNA API pública**
Ni Data, ni Analytics, ni Reporting exponen `impressions` ni `impressionClickThroughRate` de miniatura. Solo existen en la UI de **YouTube Studio**.
- **Impacto:** Fase 3 "Análisis de miniaturas vs CTR real" no puede correlacionar con CTR real de forma automática vía API.
- **Camino honesto que implementaré:** (a) análisis visual de miniaturas siempre (texto/caras/colores/contraste) correlacionado con proxies que **sí** tenemos (views, retención, `averageViewPercentage`); y (b) un **importador de CSV** para que pegues el export de Studio (modo avanzado: Impresiones + CTR por vídeo). Con ese CSV cargado, el CTR real entra al análisis. Sin CSV, se usa solo el proxy y se marca como "CTR no disponible".

### 4.2 ⚠️ Umbrales de privacidad en vídeos de poco tráfico
YouTube **suprime** demografía, geografía y parte de la retención cuando la muestra es pequeña. Tu canal tiene la mayoría de vídeos en ~300-400 vistas → **muchos breakdowns por vídeo vendrán vacíos**. A nivel **canal/agregado** sí habrá datos sólidos; a nivel vídeo individual de baja vista, no siempre.
- **Impacto:** los perfiles de audiencia por vídeo serán fiables sobre todo para los outliers y para agregados. Lo dejaré explícito en la UI ("datos insuficientes para este vídeo").

### 4.3 Monetización requiere YPP — ✅ CONFIRMADO (canal en YPP)
`estimatedRevenue/cpm/playbackBasedCpm/rpm` solo existen si el canal está en el **YouTube Partner Program** y se concede el scope monetario. **Planeta Keto está en YPP** → se solicita `yt-analytics-monetary.readonly` y habrá datos reales de ingresos por vídeo, tema, duración y país LATAM. (Nota: "RPM" no es métrica directa de la API; se **deriva** = `estimatedRevenue / views × 1000`; `cpm` y `playbackBasedCpm` sí son directos.)

### 4.4 ⚠️ Google Trends no tiene API oficial
Se usaría una librería no oficial (p. ej. pytrends). Es **best-effort**: puede romperse o limitar. Lo trataré como señal complementaria, con fallback a "tendencias derivadas de YouTube search" que sí es oficial.

### 4.5 ⚠️ Competidores: solo métricas públicas
De otros canales solo hay views/likes/comments públicos. **No** hay retención, CTR ni ingresos de terceros. El análisis competitivo se limita a lo público.

### 4.6 ⚠️ OAuth en modo "Testing" caduca el refresh token a los 7 días
Si la pantalla de consentimiento queda en "Testing", el refresh token expira cada 7 días (re-login semanal). **Recomendación:** publicar la app a "Production" (aunque salga el aviso de "app no verificada", para tu propia cuenta se acepta y el refresh token deja de caducar). Detalle en §6.

---

## 5. Cuotas y rate limiting

| API | Cuota por defecto | Estrategia |
|---|---|---|
| Data API v3 | **10.000 unidades/día** | Catálogo completo cuesta decenas de unidades (playlistItems 1u/pág + videos.list 1u/50). El gasto fuerte es `search.list` (100u). Presupuesto diario reservado para búsquedas de tendencias (~20-40 búsquedas = 2.000-4.000u). Subtítulos vía **yt-dlp** (0 cuota) en vez de `captions.download`. |
| Analytics API v2 | ~10.000 consultas/día + límites por 100s | **Backfill una sola vez** vía Reporting. Refresco incremental diario solo de vídeos activos / rangos recientes. Batching por rango de fechas. |
| Reporting API | Generosa (gestión de jobs) | Crear jobs una vez; descargar CSVs diarios. Coste marginal. |

**Mecánica común (`/lib/youtube/rate-limiter.ts`):**
- Token-bucket por API + **backoff exponencial con jitter** ante `403 quotaExceeded/rateLimitExceeded` y `5xx`; respeto de `Retry-After`.
- **Contabilidad de cuota** en tabla `api_quota_log` (coste por llamada + acumulado diario). Corte preventivo al acercarse al límite; el job marca su cursor y **reanuda al día siguiente** (idempotente).
- Logs claros por llamada (endpoint, coste, resultado). Nunca se silencian fallos.

---

## 6. OAuth 2.0 y seguridad de tokens

- **Un solo botón:** "Conectar mi cuenta de YouTube" → flujo OAuth con `access_type=offline` y `prompt=consent` (fuerza refresh token), scopes de §3.
- **Implementación:** Auth.js (NextAuth v5) provider Google para el handshake; los tokens de YouTube se persisten en **nuestra** tabla cifrada `oauth_tokens` para que los workers (fuera de la sesión web) puedan usarlos.
- **Cifrado en reposo:** AES-256-GCM a nivel app (`TOKEN_ENC_KEY` en env); se guarda `iv || tag || ciphertext` como `bytea`. Alternativa `pgcrypto` documentada.
- **Refresco:** helper que renueva el access token antes de expirar y reescribe cifrado; si el refresh falla (revocado/caducado), se marca y la UI pide reconectar.
- **Mono-usuario:** sin registro público. Solo tu cuenta puede entrar (allowlist por email + sesión). Sin `localStorage` para datos sensibles.
- **Publishing status:** recomendado "Production" para evitar caducidad de 7 días (§4.6).

---

## 7. Decisión justificada de transcripción

**Restricción real (✅ CONFIRMADO):** VPS de **4 vCPU, 8 GB RAM, 240 GB SSD, sin GPU**. faster-whisper (CTranslate2) en CPU:

| Modelo (int8, CPU 4c) | Velocidad aprox.* | Calidad ES | Veredicto |
|---|---|---|---|
| `large-v3` | ~1×–0.5× realtime (a veces más lento) | Máxima | Inviable como vía principal para todo el catálogo |
| `large-v3-turbo` | ~4×–8× más rápido que large-v3 | Casi igual para transcripción | **Recomendado como fallback** |
| `medium` | Rápido | Buena | Alternativa si turbo va justo |

(*) Estimaciones a **benchmarkear en tu VPS real**; sin GPU el coste de `large-v3` para cientos de vídeos largos (p. ej. 200 × 20 min ≈ 67h de audio) puede ser de **cientos de horas de CPU**, compitiendo con la web.

### Decisión (✅ CONFIRMADA por ti)
1. **Subtítulos oficiales primero (coste 0, instantáneo):** con `yt-dlp --write-subs --write-auto-subs --sub-langs es` se obtiene la pista en español (subida o auto-generada) sin gastar cuota de API. Para la mayoría de tus vídeos esto basta.
2. **Whisper solo como fallback** cuando no haya subtítulos utilizables. Modelo por defecto **`large-v3-turbo` int8**, **1 job concurrente** y `OMP_NUM_THREADS` limitado (p. ej. 3 de 4 vCPU) para no ahogar la web/Postgres; `nice`/`ionice` en prod. Con 8 GB RAM, turbo int8 (~1.5-2 GB) deja margen holgado para Next + Postgres.
3. `large-v3` puro queda **disponible por configuración** (flag), pero no es la vía por defecto dado que no hay GPU.

En ambos casos se guarda transcripción **con timestamps** (segmentos), `source` (`youtube_caption` | `whisper`), modelo, e idioma. La cola es **idempotente y reanudable** con estado por vídeo.

---

## 8. Esquema completo de PostgreSQL

> DDL de referencia (se materializará en migraciones versionadas en Fase 1). Tipos resumidos; convenciones: `snake_case`, `created_at/updated_at timestamptz`, claves naturales de YouTube como PK donde aplica, `UPSERT` por esas claves.

### 8.1 Auth y canal

```sql
CREATE TABLE oauth_tokens (
  id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- mono-usuario
  google_email    TEXT NOT NULL,
  access_token    BYTEA NOT NULL,   -- AES-256-GCM (iv||tag||ct)
  refresh_token   BYTEA NOT NULL,   -- AES-256-GCM
  scopes          TEXT[] NOT NULL,
  token_type      TEXT,
  expires_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE channels (
  channel_id          TEXT PRIMARY KEY,
  title               TEXT,
  description         TEXT,
  custom_url          TEXT,
  published_at        TIMESTAMPTZ,
  country             TEXT,
  default_language    TEXT,
  keywords            TEXT,            -- brandingSettings.channel.keywords (crudo)
  topic_ids           TEXT[],
  uploads_playlist_id TEXT,
  thumbnails          JSONB,
  subscriber_count    BIGINT,
  view_count          BIGINT,
  video_count         INTEGER,
  fetched_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE channel_stats_daily (
  channel_id  TEXT REFERENCES channels(channel_id),
  date        DATE NOT NULL,
  subscribers BIGINT, views BIGINT,
  estimated_minutes_watched BIGINT,
  subscribers_gained INTEGER, subscribers_lost INTEGER,
  PRIMARY KEY (channel_id, date)
);
```

### 8.2 Vídeos y metadata

```sql
CREATE TABLE videos (
  video_id              TEXT PRIMARY KEY,
  channel_id            TEXT REFERENCES channels(channel_id),
  title                 TEXT,
  description           TEXT,
  published_at          TIMESTAMPTZ,
  duration_seconds      INTEGER,
  is_short              BOOLEAN,
  short_detection_method TEXT,          -- 'shorts_url' | 'duration' | 'aspect'
  category_id           TEXT,
  default_language      TEXT,
  default_audio_language TEXT,
  definition            TEXT,            -- hd/sd
  dimension             TEXT,            -- 2d/3d
  caption_available     BOOLEAN,
  licensed_content      BOOLEAN,
  made_for_kids         BOOLEAN,
  privacy_status        TEXT,
  thumbnails            JSONB,
  topic_ids             TEXT[],
  fetched_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_videos_channel_pub ON videos(channel_id, published_at DESC);
CREATE INDEX idx_videos_is_short    ON videos(is_short);
CREATE INDEX idx_videos_title_fts   ON videos USING GIN (to_tsvector('spanish', coalesce(title,'')));

CREATE TABLE video_tags (
  video_id TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  position INTEGER,
  PRIMARY KEY (video_id, tag)
);

-- snapshot acumulado (Data API statistics) en cada sync
CREATE TABLE video_stats_snapshot (
  video_id      TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  view_count    BIGINT, like_count BIGINT, comment_count BIGINT, favorite_count BIGINT,
  PRIMARY KEY (video_id, captured_at)
);
```

### 8.3 Métricas privadas (Analytics + Reporting)

```sql
CREATE TABLE video_stats_daily (
  video_id TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  date     DATE NOT NULL,
  views BIGINT, estimated_minutes_watched BIGINT,
  average_view_duration NUMERIC, average_view_percentage NUMERIC,
  likes INTEGER, comments INTEGER, shares INTEGER,
  subscribers_gained INTEGER, subscribers_lost INTEGER,
  card_impressions BIGINT, card_clicks BIGINT, card_click_rate NUMERIC,
  source TEXT,  -- 'analytics' | 'reporting'
  PRIMARY KEY (video_id, date)
);

CREATE TABLE video_retention (
  video_id TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  elapsed_ratio NUMERIC NOT NULL,             -- 0.00 .. 1.00
  audience_watch_ratio NUMERIC,
  relative_retention_performance NUMERIC,
  computed_through DATE,
  PRIMARY KEY (video_id, elapsed_ratio)
);

CREATE TABLE video_traffic_sources (
  video_id TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  period_start DATE, period_end DATE,
  source_type TEXT NOT NULL, source_detail TEXT,
  views BIGINT, estimated_minutes_watched BIGINT,
  PRIMARY KEY (video_id, period_start, period_end, source_type, source_detail)
);

CREATE TABLE video_demographics (
  video_id TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  period_start DATE, period_end DATE,
  age_group TEXT, gender TEXT, viewer_percentage NUMERIC,
  PRIMARY KEY (video_id, period_start, period_end, age_group, gender)
);

CREATE TABLE video_geography (
  video_id TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  period_start DATE, period_end DATE,
  country_code TEXT NOT NULL,
  views BIGINT, estimated_minutes_watched BIGINT, average_view_duration NUMERIC,
  PRIMARY KEY (video_id, period_start, period_end, country_code)
);

CREATE TABLE video_devices (
  video_id TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  period_start DATE, period_end DATE,
  device_type TEXT, operating_system TEXT,
  views BIGINT, estimated_minutes_watched BIGINT,
  PRIMARY KEY (video_id, period_start, period_end, device_type, operating_system)
);

-- Monetización (solo si YPP + scope monetario). RPM se deriva en consulta.
CREATE TABLE video_revenue_daily (
  video_id TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  date DATE NOT NULL,
  estimated_revenue NUMERIC, estimated_ad_revenue NUMERIC,
  estimated_red_partner_revenue NUMERIC, gross_revenue NUMERIC,
  cpm NUMERIC, playback_based_cpm NUMERIC,
  ad_impressions BIGINT, monetized_playbacks BIGINT,
  PRIMARY KEY (video_id, date)
);

CREATE TABLE video_revenue_geo (
  video_id TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  period_start DATE, period_end DATE, country_code TEXT NOT NULL,
  estimated_revenue NUMERIC, cpm NUMERIC, playback_based_cpm NUMERIC,
  monetized_playbacks BIGINT,
  PRIMARY KEY (video_id, period_start, period_end, country_code)
);
```

### 8.4 Miniaturas (visión) + import manual de CTR

```sql
CREATE TABLE thumbnails (
  video_id TEXT PRIMARY KEY REFERENCES videos(video_id) ON DELETE CASCADE,
  image_url TEXT, local_path TEXT, width INTEGER, height INTEGER,
  dominant_colors JSONB, brightness NUMERIC, contrast NUMERIC, saturation NUMERIC,
  has_face BOOLEAN, face_count INTEGER, detected_text TEXT,  -- OCR
  analysis_model TEXT, analyzed_at TIMESTAMPTZ
);

-- Workaround honesto: impresiones/CTR reales NO existen en la API (§4.1).
-- Se importan desde el CSV de YouTube Studio (modo avanzado).
CREATE TABLE thumbnail_ctr_import (
  video_id TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  period_start DATE, period_end DATE,
  impressions BIGINT, ctr NUMERIC,           -- %
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (video_id, period_start, period_end)
);
```

### 8.5 Transcripciones

```sql
CREATE TABLE transcripts (
  video_id TEXT PRIMARY KEY REFERENCES videos(video_id) ON DELETE CASCADE,
  language TEXT, source TEXT,        -- 'youtube_caption' | 'whisper'
  model TEXT, full_text TEXT,
  fts tsvector GENERATED ALWAYS AS (to_tsvector('spanish', coalesce(full_text,''))) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_transcripts_fts ON transcripts USING GIN (fts);

CREATE TABLE transcript_segments (
  video_id TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  start_sec NUMERIC, end_sec NUMERIC, text TEXT,
  PRIMARY KEY (video_id, idx)
);
```

### 8.6 Listas, secciones, jobs y cuota

```sql
CREATE TABLE playlists (
  playlist_id TEXT PRIMARY KEY, channel_id TEXT REFERENCES channels(channel_id),
  title TEXT, description TEXT, item_count INTEGER, fetched_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE playlist_items (
  playlist_id TEXT REFERENCES playlists(playlist_id) ON DELETE CASCADE,
  video_id TEXT, position INTEGER,
  PRIMARY KEY (playlist_id, video_id)
);
CREATE TABLE channel_sections (
  section_id TEXT PRIMARY KEY, channel_id TEXT REFERENCES channels(channel_id),
  type TEXT, style TEXT, position INTEGER, content JSONB
);

-- Idempotencia / reanudabilidad de TODA la ingesta
CREATE TABLE sync_runs (
  id BIGSERIAL PRIMARY KEY,
  job_type TEXT NOT NULL,            -- 'catalog' | 'analytics' | 'reporting' | 'thumbnails' ...
  status TEXT NOT NULL,              -- 'running' | 'done' | 'failed' | 'paused_quota'
  cursor JSONB,                      -- page tokens / fechas / último video procesado
  items_processed INTEGER DEFAULT 0,
  error TEXT,
  started_at TIMESTAMPTZ DEFAULT now(), finished_at TIMESTAMPTZ
);

CREATE TABLE transcription_queue (
  video_id TEXT PRIMARY KEY REFERENCES videos(video_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|downloading|transcribing|done|failed|skipped
  source_planned TEXT,                     -- 'caption' | 'whisper'
  attempts INTEGER DEFAULT 0, last_error TEXT,
  audio_path TEXT, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ
);

CREATE TABLE api_quota_log (
  id BIGSERIAL PRIMARY KEY,
  api TEXT NOT NULL,                  -- 'data' | 'analytics' | 'reporting'
  endpoint TEXT, cost_units INTEGER,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  day DATE GENERATED ALWAYS AS ((occurred_at AT TIME ZONE 'UTC')::date) STORED
);
CREATE INDEX idx_quota_day_api ON api_quota_log(day, api);

CREATE TABLE reporting_jobs (
  job_id TEXT PRIMARY KEY, report_type TEXT, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE reporting_downloads (
  report_id TEXT PRIMARY KEY, job_id TEXT REFERENCES reporting_jobs(job_id),
  start_date DATE, end_date DATE, status TEXT, downloaded_at TIMESTAMPTZ
);
```

### 8.7 Salidas de análisis (Fases 3-5)

```sql
CREATE TABLE content_clusters (
  id BIGSERIAL PRIMARY KEY, label TEXT, keywords TEXT[],
  format TEXT,                       -- 'long' | 'short'
  avg_views NUMERIC, avg_retention NUMERIC, computed_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE cluster_members (
  cluster_id BIGINT REFERENCES content_clusters(id) ON DELETE CASCADE,
  video_id TEXT REFERENCES videos(video_id) ON DELETE CASCADE,
  distance NUMERIC, PRIMARY KEY (cluster_id, video_id)
);
-- Embeddings: pgvector si está disponible; si no, float4[] + clustering en worker (ver §11)
CREATE TABLE video_embeddings (
  video_id TEXT PRIMARY KEY REFERENCES videos(video_id) ON DELETE CASCADE,
  model TEXT, embedding BYTEA   -- o vector(N) con pgvector
);

CREATE TABLE outlier_analysis (
  video_id TEXT PRIMARY KEY REFERENCES videos(video_id),
  is_outlier BOOLEAN, views BIGINT, z_score NUMERIC,
  drivers JSONB,                    -- variables que explican el éxito + pesos
  computed_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE trend_keywords (
  id BIGSERIAL PRIMARY KEY, keyword TEXT, region TEXT,
  source TEXT,                      -- 'google_trends' | 'youtube_search'
  score NUMERIC, captured_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE competitor_videos (
  video_id TEXT PRIMARY KEY, channel_title TEXT, title TEXT,
  view_count BIGINT, like_count BIGINT, comment_count BIGINT,
  published_at TIMESTAMPTZ, region TEXT, relevance NUMERIC, captured_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE daily_ideas (
  id BIGSERIAL PRIMARY KEY, for_date DATE NOT NULL,
  title TEXT, hook_angle TEXT, thumbnail_brief TEXT,
  suggested_duration_sec INTEGER, keywords TEXT[], suggested_publish_at TIMESTAMPTZ,
  priority NUMERIC, rationale JSONB, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE idea_scripts (
  idea_id BIGINT PRIMARY KEY REFERENCES daily_ideas(id) ON DELETE CASCADE,
  script TEXT,                      -- gancho, promesa, desarrollo, mid-roll AdSense, CTA
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE recommendations (
  id BIGSERIAL PRIMARY KEY, area TEXT,   -- 'config' | 'format_mix' | 'cadence' | 'seo' | 'monetization'
  title TEXT, detail TEXT, impact NUMERIC, effort NUMERIC,
  evidence JSONB, status TEXT DEFAULT 'open', created_at TIMESTAMPTZ DEFAULT now()
);
```

---

## 9. Estrategia de ingesta (idempotente y reanudable)

1. **Catálogo:** `channels.list` → uploads playlist → paginar `playlistItems.list` (sin límite) → `videos.list` por lotes de 50 → clasificar Short/largo. Cursor (page token) en `sync_runs.cursor`.
2. **Histórico privado:** crear `reporting_jobs` y descargar backfill (CSV → `video_stats_daily`/geo/demo/etc., `source='reporting'`).
3. **Analytics on-demand:** retención (curva), tráfico, demografía, geografía, dispositivos, revenue por vídeo (prioridad a outliers y vídeos recientes). Respetando cuota (§5).
4. **Miniaturas:** descarga + análisis visual (caras/OCR/color/contraste).
5. **Transcripción:** encolar todos los vídeos → subtítulos vía yt-dlp; fallback Whisper turbo (§7).
6. **Incremental diario (`pk-sync`):** snapshot de statistics, refresco de métricas recientes, descarga de nuevos CSV de Reporting, alta de vídeos nuevos. Todo `UPSERT`. Si se agota cuota → `status='paused_quota'` y reanuda al día siguiente.

---

## 10. Mapa de fases siguientes (resumen)

- **F1** Infra + OAuth (botón único, tokens cifrados, migraciones).
- **F2** Ingesta exhaustiva + cron + cola de transcripción.
- **F3** Motor de análisis (outliers, clusters, audiencia, timing, miniaturas, SEO, AdSense).
- **F4** Tendencias + ideas diarias + guiones.
- **F5** Recomendaciones / reestructuración priorizada por impacto.
- **F6** UI profesional (shadcn/ui + Tailwind, gráficos de retención/CTR, tablas).
- **F7** Despliegue VPS (PM2 + Caddy) + RUNBOOK.md.

---

## 11. Decisiones confirmadas y pendientes menores

### ✅ Confirmado (tus respuestas)
1. **Monetización:** Planeta Keto **en YPP** → datos reales de RPM/CPM/ingresos (scope monetario).
2. **VPS:** **4 vCPU, 8 GB RAM, 240 GB SSD, sin GPU.**
3. **Transcripción:** subtítulos oficiales primero + **`large-v3-turbo` int8** como fallback (1 job, hilos limitados).
4. **Google Cloud / OAuth:** lo preparamos en **Fase 1** (creación de proyecto, habilitar 3 APIs, client OAuth y publicar a "Production" para evitar re-login semanal).

### Pendientes menores (no bloquean Fase 0; se resuelven en su fase)
- **pgvector:** comprobaré en F1/F3 si tu Postgres admite la extensión (mejora el clustering). Fallback: embeddings en `bytea` + clustering en worker. (Decisión a tomar en F3.)
- **Dominio** para Caddy/HTTPS: lo necesito en **F7**, no ahora.

---

**FASE 0 entregada y decisiones cerradas. Me detengo aquí y espero tu OK explícito antes de pasar a la Fase 1.**
