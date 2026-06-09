# RUNBOOK — Planeta Keto Intelligence (operación en VPS)

Guía operativa completa: instalación, arranque, backups y troubleshooting.
VPS objetivo: **4 vCPU · 8 GB RAM · 240 GB SSD · Linux**, sin GPU.

---

## ⚡ Vía rápida (bootstrap automático)

En el VPS, tras `git clone`:

```bash
chmod +x setup.sh
./setup.sh --all      # instala SO + app + BD + arranca PM2 (idempotente)
```

Qué hace `--all`: instala dependencias del sistema (Node 20, Postgres, ffmpeg, yt-dlp, PM2, Caddy),
crea `.env` con secretos generados (`SESSION_SECRET`, `TOKEN_ENC_KEY`), crea rol+BD y escribe `DATABASE_URL`,
instala deps Node + venv Python, aplica migraciones, hace el build y arranca PM2.

Flags individuales: `--system`, `--db`, `--app` (default), `--start`. Ver `./setup.sh --help`.

**Tras el bootstrap, completa a mano en `.env`** lo que solo tú tienes:
`GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI` (RUNBOOK §2), y opcionalmente `YOUTUBE_API_KEY` y `OPENAI_API_KEY`.
Luego: conecta tu cuenta en la web y ejecuta `npm run ingest:full`.

> El resto de este documento detalla cada paso por si prefieres hacerlo manualmente o necesitas depurar.

---

## 0. Prerrequisitos del sistema

```bash
# Node 20 LTS (nvm recomendado)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 20 && nvm use 20

# PostgreSQL nativo
sudo apt update && sudo apt install -y postgresql postgresql-contrib

# Binarios para transcripción
sudo apt install -y ffmpeg python3 python3-venv python3-pip
python3 -m pip install --user -U yt-dlp        # o: sudo apt install yt-dlp

# PM2 y Caddy
npm i -g pm2
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
# (sigue la guía oficial de Caddy para añadir su repo) luego:
sudo apt install -y caddy
```

---

## 1. Base de datos

```bash
sudo -u postgres psql
```
```sql
CREATE USER youtube_app WITH PASSWORD 'cambia-esto';
CREATE DATABASE youtube_analytics OWNER youtube_app;
\q
```
`DATABASE_URL=postgres://youtube_app:cambia-esto@localhost:5432/youtube_analytics`

---

## 2. Google Cloud (OAuth + APIs) — pasos manuales que haces TÚ

1. Crea un proyecto en <https://console.cloud.google.com>.
2. **APIs y servicios → Biblioteca** → habilita: *YouTube Data API v3*, *YouTube Analytics API*, *YouTube Reporting API*.
3. **Pantalla de consentimiento OAuth**:
   - Tipo: **External**.
   - Añade los scopes: `youtube.readonly`, `yt-analytics.readonly`, `yt-analytics-monetary.readonly`.
   - Añade tu email como **usuario de prueba**.
   - **Publica la app a “Production”** para que el refresh token no caduque cada 7 días
     (acepta el aviso de “app no verificada” para tu propia cuenta).
4. **Credenciales → Crear → ID de cliente OAuth → Aplicación web**:
   - *Authorized redirect URI* = `https://tu-dominio.com/api/auth/google/callback`
     (en dev: `http://localhost:3000/api/auth/google/callback`).
   - Copia **Client ID** y **Client Secret** a `.env`.
5. (Opcional) Crea una **API key** para `search` de tendencias → `YOUTUBE_API_KEY`.

---

## 3. Configuración y dependencias

```bash
git clone <tu-repo> planeta-keto && cd planeta-keto
cp .env.example .env && nano .env      # rellena TODO (genera secretos abajo)

# Secretos:
openssl rand -hex 32   # -> SESSION_SECRET
openssl rand -hex 32   # -> TOKEN_ENC_KEY (32 bytes = 64 hex)

npm ci
python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
# Apunta PYTHON_BIN en .env al python del venv, p.ej: /ruta/planeta-keto/.venv/bin/python
```

La primera vez que Whisper transcriba descargará el modelo `large-v3-turbo` (~1.5 GB).

---

## 4. Migraciones + build

```bash
npm run migrate      # crea/actualiza el esquema (idempotente)
npm run build        # build de producción de Next.js
mkdir -p logs data media
```

---

## 5. Arranque con PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup           # ejecuta el comando que imprime (arranque al boot)
pm2 status
```

Procesos: `pk-web` (3000), `pk-transcribe`, `pk-daily` (cron único 07:00).

> `pk-daily` ejecuta el pipeline completo (sync → analysis → trends+ideas) y
> **reemplaza** a los antiguos `pk-sync`/`pk-trends`/`pk-analysis`. Carga su
> config desde `/apps/youtube/.env` (vía `cwd`+`PK_ENV_FILE` en
> `ecosystem.config.cjs` y `override:true` en `config/env.ts`) y verifica con
> `SELECT current_database()` que está en la BD correcta antes de escribir.

#### PRIMER deploy con pk-daily (VPS ya en marcha con los crons viejos)

Orden importa: `pk-daily` **todavía no existe**, así que NO lo metas en el `reload`
(fallaría). Primero recarga lo que ya corre, luego crea el cron nuevo. Solo afecta
a procesos `pk-*` (por nombre); **no toca** `cfanalisis-*`/`n8n`/`ketoscan`/`planetaketo`.

```bash
git pull
npm ci

# Blindaje del migrate MANUAL: override:true protege a PM2, pero este comando lo
# corres en TU shell. Si hay una DATABASE_URL exportada, podría ganar (run-migrations
# no tiene guardia de current_database). Verifica que esté vacía y, si no, bórrala:
echo "$DATABASE_URL"        # debe salir VACÍO
unset DATABASE_URL          # ejecútalo si lo anterior NO estaba vacío

npm run migrate             # aplica 005_recipes.sql (idempotente)
npm run build

# Recarga SOLO los procesos que YA existen (pk-daily aún no):
pm2 reload pk-web pk-transcribe

# Switch de crons (solo la 1ª vez): borra los 3 viejos y crea pk-daily:
pm2 delete pk-sync pk-trends pk-analysis
pm2 start ecosystem.config.cjs --only pk-daily
pm2 save

# Verifica que pk-daily está en la BD correcta (nombre dinámico desde el .env):
pm2 logs pk-daily --lines 30
#   esperado: (worker:daily) conectado a DB 'youtube_analytics' como 'youtube_app' (esperada por .env: 'youtube_analytics')
```

---

## 6. Caddy (HTTPS)

```bash
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile     # pon tu dominio real
sudo systemctl reload caddy
```
Apunta el DNS A de tu dominio al VPS; Caddy emite el certificado solo.

---

## 7. Primer uso (orden correcto)

1. Abre `https://tu-dominio.com` → **Conectar mi cuenta de YouTube** → consiente los scopes.
2. Lanza el primer ingest COMPLETO (descarga todo el catálogo + histórico):
   ```bash
   npm run ingest:full          # = tsx src/workers/sync.ts --full
   ```
   o desde la UI: botón **Sync** (incremental) / usa `ingest:full` para el histórico.
3. Deja correr `pk-transcribe` (transcribe en background, reanudable).
4. Genera análisis e ideas:
   ```bash
   npx tsx src/workers/analysis.ts --once
   npx tsx src/workers/trends.ts --once
   ```
   o botones **Analizar** / **Tendencias** en la UI.

A partir de aquí, `pk-daily` lo hace solo: a las **07:00** (TZ configurable, `CRON_DAILY`)
ejecuta en orden sync → analysis → trends+ideas. Los botones del dashboard
(Sync / Ideas diarias / Tendencias / Analizar) siguen disponibles para disparos manuales.

---

## 8. Operación diaria / comandos útiles

```bash
pm2 logs pk-sync --lines 100        # ver logs de un proceso
pm2 logs pk-transcribe
pm2 restart pk-web                  # reiniciar tras un deploy
pm2 reload pk-web pk-transcribe pk-daily   # recarga SOLO esta app (no uses `all`)
pm2 monit                           # CPU/RAM en vivo

# disparos manuales
npm run pipeline                    # pipeline diario completo, una vez (sync->analysis->trends+ideas)
npm run ingest:full                 # re-backfill completo
npx tsx src/workers/sync.ts --once  # sync incremental único
npx tsx src/workers/analysis.ts --once

# salud
curl -s http://localhost:3000/api/health | jq
```

### Estado en BD
```sql
SELECT job_type, status, items_processed, started_at FROM sync_runs ORDER BY started_at DESC LIMIT 10;
SELECT status, count(*) FROM transcription_queue GROUP BY status;
SELECT api, day, SUM(cost_units) FROM api_quota_log GROUP BY api, day ORDER BY day DESC LIMIT 6;
```

---

## 9. Deploy de cambios

```bash
git pull
npm ci
echo "$DATABASE_URL"   # debe estar VACÍO; npm run migrate corre en TU shell y
unset DATABASE_URL     # run-migrations no tiene guardia de current_database.
npm run migrate
npm run build
# Recarga SOLO los procesos de esta app (por nombre). NO uses `pm2 reload all`:
# el VPS comparte PM2 con otros proyectos (cfanalisis-*, n8n, ketoscan, planetaketo).
pm2 reload pk-web pk-transcribe pk-daily
```

---

## 10. Backups de PostgreSQL

```bash
# Backup diario (añádelo a crontab del sistema)
0 3 * * * pg_dump -U youtube_app youtube_analytics | gzip > /var/backups/pk_$(date +\%F).sql.gz

# Restore
gunzip -c /var/backups/pk_2026-06-01.sql.gz | psql -U youtube_app youtube_analytics
```
Retén también `media/` (miniaturas) y `data/` (CSV reporting) si quieres conservar artefactos; son regenerables.

---

## 11. Cuotas de API

- Data API: 10.000 u/día. `search` cuesta 100 u → `pk-trends` limita a ~8 búsquedas/día.
- Analytics: el backfill usa Reporting (barato); el refresco diario solo toca vídeos recientes.
- Si ves `QUOTA_GUARD` / `paused_quota` en `sync_runs`: es normal, reanuda solo al día siguiente.
- Sube `QUOTA_*` en `.env` solo si Google te amplía la cuota.

---

## 12. Troubleshooting

| Síntoma | Causa probable | Solución |
|---|---|---|
| `NO_CONNECTION` / banner “Desconectado” | sin OAuth o token revocado | Reconecta en la web (botón). |
| `REFRESH_FAILED` | refresh token caducó (app en “Testing”) | Publica la app a “Production” y reconecta. |
| Sin RPM/CPM | falta scope monetario o no hay YPP | Verifica YPP; reconecta concediendo `yt-analytics-monetary.readonly`. |
| Demografía/geografía vacías por vídeo | umbral de privacidad (poca vista) | Esperado; usa los agregados de canal. |
| `whisper falló` | falta faster-whisper o modelo | `pip install -r requirements.txt`; revisa `PYTHON_BIN`. |
| `yt-dlp audio falló` | yt-dlp desactualizado / sin ffmpeg | `pip install -U yt-dlp`; instala ffmpeg; revisa `FFMPEG_BIN`. |
| Clustering omitido | sin scikit-learn | `pip install -r requirements.txt`. |
| Ideas sin guion | sin `OPENAI_API_KEY` | Configúrala; las ideas funcionan sin LLM, los guiones no. |
| `search` no devuelve nada | cuota agotada o sin API key | Espera reset diario o añade `YOUTUBE_API_KEY`. |
| CTR de miniatura ausente | no existe en la API | Importa CSV de Studio a `thumbnail_ctr_import` (ver §13). |

---

## 13. Importar CTR real de miniaturas (workaround manual)

El CTR de impresiones NO está en ninguna API. Para análisis con CTR real:
1. YouTube Studio → Analytics → pestaña “Contenido” → **Modo avanzado** → exporta CSV con columnas *Impresiones* y *CTR de impresiones*.
2. Inserta en `thumbnail_ctr_import` (video_id, period_start, period_end, impressions, ctr).
3. Re-ejecuta `analysis --once`: las correlaciones de miniatura pasarán a usar CTR real.

---

## 14. Seguridad

- `.env` nunca en git (ya está en `.gitignore`). Tokens cifrados AES-256-GCM en BD.
- Acceso restringido a `ALLOWED_EMAIL`. Cualquier otra cuenta es rechazada en el callback.
- Postgres solo escucha en `localhost`. Caddy termina TLS.
