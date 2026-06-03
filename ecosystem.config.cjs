// PM2 — orquesta web + workers. Ejecutar: pm2 start ecosystem.config.cjs
// Requiere: build previo (npm run build) y migraciones aplicadas (npm run migrate).
const TSX = "./node_modules/tsx/dist/cli.mjs";

module.exports = {
  apps: [
    {
      name: "pk-web",
      script: "./node_modules/next/dist/bin/next",
      args: "start -p 3000",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "1G",
      time: true,
      env: { NODE_ENV: "production" },
      error_file: "./logs/web.err.log",
      out_file: "./logs/web.out.log",
    },
    {
      name: "pk-sync",
      script: TSX,
      args: "src/workers/sync.ts",
      autorestart: true,
      max_memory_restart: "700M",
      time: true,
      env: { NODE_ENV: "production" },
      error_file: "./logs/sync.err.log",
      out_file: "./logs/sync.out.log",
    },
    {
      name: "pk-transcribe",
      script: TSX,
      args: "src/workers/transcribe.ts",
      autorestart: true,
      max_memory_restart: "3G", // whisper en CPU puede usar memoria
      time: true,
      env: { NODE_ENV: "production" },
      error_file: "./logs/transcribe.err.log",
      out_file: "./logs/transcribe.out.log",
    },
    {
      name: "pk-trends",
      script: TSX,
      args: "src/workers/trends.ts",
      autorestart: true,
      max_memory_restart: "500M",
      time: true,
      env: { NODE_ENV: "production" },
      error_file: "./logs/trends.err.log",
      out_file: "./logs/trends.out.log",
    },
    {
      name: "pk-analysis",
      script: TSX,
      args: "src/workers/analysis.ts",
      autorestart: true,
      max_memory_restart: "1G",
      time: true,
      env: { NODE_ENV: "production" },
      error_file: "./logs/analysis.err.log",
      out_file: "./logs/analysis.out.log",
    },
  ],
};
