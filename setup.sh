#!/usr/bin/env bash
# ============================================================
#  setup.sh — Bootstrap de Planeta Keto Intelligence (VPS Linux)
#  Idempotente y seguro: no pisa .env existente, no borra datos.
#
#  Uso:
#    ./setup.sh              # bootstrap de la app (env, secretos, deps, migrate, build)
#    ./setup.sh --system     # instala dependencias del SO (apt, sudo) — Node, PG, ffmpeg, Caddy...
#    ./setup.sh --db         # crea rol + base de datos en Postgres local
#    ./setup.sh --start      # arranca/recarga PM2
#    ./setup.sh --all        # --system + app + --db + --start (todo de una)
#
#  Requiere Ubuntu/Debian (apt) para --system. El resto es portable.
# ============================================================
set -euo pipefail

cd "$(dirname "$0")"
ENV_FILE=".env"

# ---------- helpers de salida ----------
c_green='\033[0;32m'; c_yellow='\033[0;33m'; c_red='\033[0;31m'; c_blue='\033[0;36m'; c_off='\033[0m'
info()  { echo -e "${c_blue}▸${c_off} $*"; }
ok()    { echo -e "${c_green}✓${c_off} $*"; }
warn()  { echo -e "${c_yellow}!${c_off} $*"; }
err()   { echo -e "${c_red}✗${c_off} $*" >&2; }
die()   { err "$*"; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# ---------- gestión de .env ----------
ensure_env_file() {
  if [[ ! -f "$ENV_FILE" ]]; then
    [[ -f .env.example ]] || die "Falta .env.example"
    cp .env.example "$ENV_FILE"
    ok "Creado $ENV_FILE desde .env.example"
  else
    info "$ENV_FILE ya existe (no se sobrescribe)"
  fi
}

# get_env KEY -> imprime el valor actual (vacío si no hay)
get_env() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2- || true; }

# set_env KEY VALUE -> crea o reemplaza la línea
set_env() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    # delimitador | ; los valores (hex/url) no lo contienen
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    echo "${key}=${val}" >> "$ENV_FILE"
  fi
}

# ensure_secret KEY -> genera secreto hex de 32 bytes si está vacío
ensure_secret() {
  local key="$1" cur
  cur="$(get_env "$key")"
  if [[ -z "$cur" ]]; then
    have openssl || die "openssl no disponible para generar $key"
    set_env "$key" "$(openssl rand -hex 32)"
    ok "Generado $key"
  else
    info "$key ya configurado"
  fi
}

# ---------- pasos ----------
step_system() {
  info "Instalando dependencias del sistema (requiere sudo)…"
  have apt-get || die "--system solo soporta apt (Ubuntu/Debian). Instala manualmente en otros SO."
  sudo apt-get update -y

  # Node 20 (nodesource) si no hay node >=20
  if ! have node || [[ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]]; then
    info "Instalando Node.js 20 (NodeSource)…"
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
  ok "Node $(node -v)"

  sudo apt-get install -y postgresql postgresql-contrib ffmpeg python3 python3-venv python3-pip curl
  ok "Postgres, ffmpeg, python instalados"

  have pm2 || sudo npm i -g pm2
  ok "PM2 $(pm2 -v 2>/dev/null || echo listo)"

  if ! have yt-dlp; then
    info "Instalando yt-dlp…"
    sudo curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
    sudo chmod a+rx /usr/local/bin/yt-dlp
  fi
  ok "yt-dlp $(yt-dlp --version 2>/dev/null || echo listo)"

  if ! have caddy; then
    info "Instalando Caddy…"
    sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    sudo apt-get update -y && sudo apt-get install -y caddy
  fi
  ok "Caddy listo (configura /etc/caddy/Caddyfile con tu dominio)"
}

step_db() {
  info "Configurando PostgreSQL local…"
  have psql || die "psql no encontrado. Ejecuta primero: ./setup.sh --system"

  local db="planeta_keto" user="pk_user" pass
  # reutiliza password de DATABASE_URL si ya existe; si no, genera una
  local current_url; current_url="$(get_env DATABASE_URL)"
  if [[ "$current_url" == postgres://*@* && "$current_url" != *"usuario:password"* ]]; then
    ok "DATABASE_URL ya configurada; no se toca la BD."
    return
  fi
  pass="$(openssl rand -hex 16)"

  sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${user}'" | grep -q 1 \
    || sudo -u postgres psql -c "CREATE USER ${user} WITH PASSWORD '${pass}';"
  sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${db}'" | grep -q 1 \
    || sudo -u postgres psql -c "CREATE DATABASE ${db} OWNER ${user};"
  # si el rol ya existía, fijamos la password que vamos a escribir en .env
  sudo -u postgres psql -c "ALTER USER ${user} WITH PASSWORD '${pass}';" >/dev/null

  set_env DATABASE_URL "postgres://${user}:${pass}@localhost:5432/${db}"
  ok "BD '${db}' y rol '${user}' listos; DATABASE_URL escrita en .env"
}

step_app() {
  ensure_env_file
  ensure_secret SESSION_SECRET
  ensure_secret TOKEN_ENC_KEY

  have node || die "Node no encontrado. Ejecuta: ./setup.sh --system"

  info "Instalando dependencias Node…"
  if [[ -f package-lock.json ]]; then npm ci; else npm install; fi
  ok "node_modules listo"

  # Python venv para Whisper + clustering
  if have python3; then
    if [[ ! -d .venv ]]; then python3 -m venv .venv; ok "venv creado"; fi
    ./.venv/bin/pip install -q --upgrade pip
    ./.venv/bin/pip install -q -r requirements.txt
    set_env PYTHON_BIN "$(pwd)/.venv/bin/python"
    ok "Dependencias Python instaladas; PYTHON_BIN apuntado al venv"
  else
    warn "python3 no encontrado: transcripción Whisper y clustering quedarán deshabilitados hasta instalarlo."
  fi

  mkdir -p logs data media
  ok "Directorios logs/ data/ media/ creados"

  # Migraciones solo si la conexión funciona
  info "Aplicando migraciones…"
  if npm run migrate; then
    ok "Migraciones aplicadas"
  else
    warn "Migraciones fallaron (¿DATABASE_URL correcta? ¿Postgres arriba?). Corrige .env y reintenta: npm run migrate"
  fi

  info "Build de producción…"
  npm run build
  ok "Build completado"
}

step_start() {
  have pm2 || die "PM2 no encontrado. Ejecuta: ./setup.sh --system"
  if pm2 describe pk-web >/dev/null 2>&1; then
    pm2 reload ecosystem.config.cjs
    ok "PM2 recargado"
  else
    pm2 start ecosystem.config.cjs
    pm2 save
    ok "PM2 arrancado. Ejecuta 'pm2 startup' (una vez) para arranque al boot."
  fi
  pm2 status
}

print_next_steps() {
  echo
  echo -e "${c_green}=== Bootstrap terminado ===${c_off}"
  echo "Pendiente que completes TÚ en .env:"
  echo "  • GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI (ver RUNBOOK §2)"
  echo "  • YOUTUBE_API_KEY (opcional, para tendencias)"
  echo "  • ANTHROPIC_API_KEY (opcional, para guiones)"
  echo "  • APP_URL y dominio en Caddyfile (producción)"
  echo
  echo "Luego:"
  echo "  1) ./setup.sh --start        # o: pm2 start ecosystem.config.cjs"
  echo "  2) Abre la web y pulsa 'Conectar mi cuenta de YouTube'"
  echo "  3) npm run ingest:full       # primer backfill completo"
  echo "  4) npx tsx src/workers/analysis.ts --once && npx tsx src/workers/trends.ts --once"
}

# ---------- router de argumentos ----------
main() {
  local do_system=0 do_db=0 do_app=1 do_start=0
  if [[ $# -gt 0 ]]; then
    do_app=0
    for arg in "$@"; do
      case "$arg" in
        --system) do_system=1 ;;
        --db)     do_db=1 ;;
        --app)    do_app=1 ;;
        --start)  do_start=1 ;;
        --all)    do_system=1; do_app=1; do_db=1; do_start=1 ;;
        -h|--help)
          grep -E '^#( |$)' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) die "Argumento desconocido: $arg (usa --help)" ;;
      esac
    done
  fi

  [[ $do_system -eq 1 ]] && step_system
  [[ $do_app    -eq 1 ]] && step_app
  [[ $do_db     -eq 1 ]] && step_db
  # si configuramos BD después de la app, reintenta migraciones
  if [[ $do_db -eq 1 && $do_app -eq 1 ]]; then
    info "Reintentando migraciones con la nueva BD…"; npm run migrate && ok "Migraciones OK" || warn "Revisa .env"
  fi
  [[ $do_start  -eq 1 ]] && step_start

  print_next_steps
}

main "$@"
