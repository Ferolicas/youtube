import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * Carga del .env con `override: true`: el ARCHIVO siempre gana sobre cualquier
 * variable ya presente en el entorno (p. ej. heredada del demonio de PM2). Esto
 * evita el incidente de heredar una DATABASE_URL de otro proyecto y escribir en
 * la BD equivocada. `PK_ENV_FILE` permite fijar la ruta absoluta del .env
 * (lo usa pk-daily en el VPS: /apps/youtube/.env); si no, se usa ./.env del cwd.
 */
loadEnv({
  path: process.env.PK_ENV_FILE ?? resolve(process.cwd(), ".env"),
  override: true,
});

/**
 * Configuración central tipada. Falla rápido si falta algo crítico.
 * Las claves opcionales se validan en el punto de uso (p. ej. OPENAI_API_KEY).
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  ALLOWED_EMAIL: z.string().email(),

  SESSION_SECRET: z.string().min(32, "SESSION_SECRET debe tener >=32 chars"),
  TOKEN_ENC_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "TOKEN_ENC_KEY debe ser 32 bytes en hex (64 chars)"),

  DATABASE_URL: z.string().min(1),
  PGSSLMODE: z.string().default("disable"),

  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.string().url(),
  YOUTUBE_API_KEY: z.string().optional().default(""),

  YT_DLP_BIN: z.string().default("yt-dlp"),
  FFMPEG_BIN: z.string().default("ffmpeg"),
  PYTHON_BIN: z.string().default("python3"),

  WHISPER_MODEL: z.string().default("large-v3-turbo"),
  WHISPER_COMPUTE_TYPE: z.string().default("int8"),
  WHISPER_THREADS: z.coerce.number().int().positive().default(3),
  WHISPER_LANG: z.string().default("es"),

  DATA_DIR: z.string().default("./data"),
  MEDIA_DIR: z.string().default("./media"),

  OPENAI_API_KEY: z.string().optional().default(""),
  LLM_MODEL: z.string().default("gpt-4o"),

  QUOTA_DATA_DAILY: z.coerce.number().default(10000),
  QUOTA_ANALYTICS_DAILY: z.coerce.number().default(10000),
  QUOTA_SAFETY_MARGIN: z.coerce.number().default(0.92),

  TZ: z.string().default("America/Mexico_City"),
  CRON_SYNC: z.string().default("0 6 * * *"),
  CRON_TRENDS: z.string().default("0 7 * * *"),
  CRON_ANALYSIS: z.string().default("30 7 * * *"),
  // Cron único del pipeline diario (sync -> analysis -> trends+ideas).
  CRON_DAILY: z.string().default("0 7 * * *"),
});

function load() {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Configuración de entorno inválida:\n${issues}`);
  }
  return parsed.data;
}

export const env = load();
export type Env = z.infer<typeof schema>;

export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
] as const;

/**
 * Scopes de identidad necesarios para que el callback pueda llamar a userinfo
 * y obtener el email del usuario (verificación contra ALLOWED_EMAIL). Sin esto,
 * el token no tiene permiso de perfil y userinfo devuelve 401.
 */
export const IDENTITY_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
] as const;

/** Todos los scopes solicitados en el consentimiento OAuth (identidad + YouTube). */
export const OAUTH_SCOPES = [...IDENTITY_SCOPES, ...YOUTUBE_SCOPES] as const;
