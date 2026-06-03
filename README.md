# Planeta Keto Intelligence

Herramienta personal y self-hosted de **análisis profundo del canal de YouTube Planeta Keto**
(keto en español, audiencia LATAM). No es un dashboard básico: es inteligencia quirúrgica de canal
orientada a entender outliers, perfilar audiencia, optimizar SEO/miniaturas, maximizar **AdSense**
y generar ideas + guiones accionables cada día.

> Stack: **Next.js 15 (App Router) · TypeScript estricto · PostgreSQL nativo (`pg`) · PM2 · Caddy**.
> Sin Vercel/Supabase/servicios gestionados. Todo corre en tu VPS contra tu Postgres.

## Documentos clave
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** — arquitectura, esquema de BD, APIs, cuotas y límites reales.
- **[RUNBOOK.md](./RUNBOOK.md)** — instalación, operación, backups y troubleshooting.

## Mapa rápido
```
src/
  app/                     UI (App Router) + API routes (OAuth, health, sync, scripts)
  lib/
    auth/                  OAuth Google, cifrado y refresco de tokens
    youtube/               clientes Data/Analytics/Reporting + rate limit + cuota
    ingest/                catálogo, analytics, reporting, miniaturas
    transcription/         cola + runner (yt-dlp + Whisper)
    analysis/              outliers, clusters, audiencia, timing, miniaturas, SEO, AdSense
    trends/ ideas/ recommendations/   tendencias, ideas+guiones, reestructuración
    dashboard/             queries para la UI
  workers/                 entrypoints PM2 (sync, transcribe, trends, analysis)
migrations/                SQL versionado
scripts/                   whisper_transcribe.py, cluster_videos.py
```

## Arranque (resumen)
```bash
cp .env.example .env        # rellena credenciales y secretos
npm ci
npm run migrate
npm run build
pm2 start ecosystem.config.cjs
# luego: conecta tu cuenta en la web y ejecuta `npm run ingest:full`
```
Detalle completo en el RUNBOOK.

## Límites honestos (importante)
- **CTR/impresiones de miniatura**: no existen en ninguna API de YouTube → análisis por proxy + importador CSV de Studio.
- **Vídeos de baja vista**: demografía/geografía/retención por vídeo pueden venir vacías por umbral de privacidad.
- **Monetización**: requiere YPP + scope monetario (tu canal lo tiene).
- **Google Trends**: sin API oficial; señal best-effort (fallback a YouTube search).
- **Guiones de ideas**: requieren `ANTHROPIC_API_KEY` (las ideas funcionan sin LLM).
