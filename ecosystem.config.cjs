// PM2 — orquesta web + workers. Ejecutar: pm2 start ecosystem.config.cjs
// Requiere: build previo (npm run build) y migraciones aplicadas (npm run migrate).
//
// AISLAMIENTO DE DATABASE_URL (evita heredar la BD de otro proyecto):
//   - `cwd: __dirname` fija el directorio de la app (en el VPS: /apps/youtube),
//     de modo que el .env que se carga es SIEMPRE el de esta app.
//   - `PK_ENV_FILE` apunta explícitamente a ese .env; config/env.ts lo carga con
//     override:true, así el ARCHIVO gana sobre cualquier var heredada de PM2.
//   - NUNCA se define DATABASE_URL en ningún bloque `env` de aquí: no hay nada
//     que heredar ni propagar. La BD sale solo del .env de /apps/youtube.
const TSX = "./node_modules/tsx/dist/cli.mjs";
const ENV_FILE = __dirname + "/.env"; // en el VPS = /apps/youtube/.env

module.exports = {
  apps: [
    {
      name: "pk-web",
      script: "./node_modules/next/dist/bin/next",
      args: "start -p 3000",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "1G",
      time: true,
      env: { NODE_ENV: "production", PK_ENV_FILE: ENV_FILE },
      error_file: "./logs/web.err.log",
      out_file: "./logs/web.out.log",
    },
    {
      name: "pk-transcribe",
      script: TSX,
      args: "src/workers/transcribe.ts",
      cwd: __dirname,
      autorestart: true,
      max_memory_restart: "3G", // whisper en CPU puede usar memoria
      time: true,
      env: { NODE_ENV: "production", PK_ENV_FILE: ENV_FILE },
      error_file: "./logs/transcribe.err.log",
      out_file: "./logs/transcribe.out.log",
    },
    {
      // Cron único diario (07:00 por defecto): sync -> analysis -> trends+ideas.
      // Reemplaza a los antiguos pk-sync / pk-trends / pk-analysis.
      name: "pk-daily",
      script: TSX,
      args: "src/workers/daily.ts",
      cwd: __dirname,
      autorestart: true,
      max_memory_restart: "1G",
      time: true,
      env: { NODE_ENV: "production", PK_ENV_FILE: ENV_FILE },
      error_file: "./logs/daily.err.log",
      out_file: "./logs/daily.out.log",
    },
    {
      // PULSO en tiempo casi real (default cada 30 min): snapshot de statistics
      // (~1u por 50 vídeos), VPH, breakouts, renovación WebSub y chequeo de cuota.
      name: "pk-pulse",
      script: TSX,
      args: "src/workers/pulse.ts",
      cwd: __dirname,
      autorestart: true,
      max_memory_restart: "512M",
      time: true,
      env: { NODE_ENV: "production", PK_ENV_FILE: ENV_FILE },
      error_file: "./logs/pulse.err.log",
      out_file: "./logs/pulse.out.log",
    },
  ],
};
