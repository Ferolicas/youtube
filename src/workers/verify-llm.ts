/**
 * verify:llm — Verificador AUTÓNOMO del proveedor LLM (OpenAI).
 *
 * Llama a `llmComplete` con el MISMO prompt de generación de guion (vía buildScriptPrompt)
 * e imprime por consola la respuesta REAL de OpenAI.
 *
 * Es autónomo: NO depende de la base de datos, del server web (Next.js) ni de sesión.
 * Solo necesita OPENAI_API_KEY (y opcionalmente LLM_MODEL) en el .env, que dotenv
 * carga dentro de config/env.ts. El resto de claves que esa config valida (Postgres,
 * OAuth de Google, secretos de sesión) NO las usa este verificador, así que las rellena
 * con placeholders inertes para pasar la validación central sin exigir la config completa
 * ni abrir ninguna conexión.
 *
 *   npm run verify:llm
 *   npm run verify:llm -- "Mi título de vídeo"   # idea personalizada (opcional)
 */
import type { ScriptIdea } from "@/lib/ideas/script-prompt";

// Placeholders inertes SOLO para satisfacer la validación de config/env.ts.
// dotenv no sobreescribe vars ya presentes, así que OPENAI_API_KEY/LLM_MODEL se siguen
// leyendo del .env real. Estas claves no se usan: el verificador no toca BD ni sesión.
process.env.ALLOWED_EMAIL ??= "verify@example.com";
process.env.SESSION_SECRET ??= "verify-llm-placeholder-session-secret-000000";
process.env.TOKEN_ENC_KEY ??= "0".repeat(64);
process.env.DATABASE_URL ??= "postgres://placeholder";
process.env.GOOGLE_CLIENT_ID ??= "placeholder";
process.env.GOOGLE_CLIENT_SECRET ??= "placeholder";
process.env.GOOGLE_REDIRECT_URI ??= "http://localhost:3000/api/auth/google/callback";

const { env } = await import("@/config/env");
const { llmAvailable, llmComplete } = await import("@/lib/ideas/llm");
const { buildScriptPrompt } = await import("@/lib/ideas/script-prompt");

// Idea de ejemplo en memoria — NO se consulta la BD. El título es opcional por CLI.
const idea: ScriptIdea = {
  title: process.argv[2] ?? "Pan keto en 5 minutos sin harina",
  hook_angle: "Muestra el pan recién horneado y promete que es sin harina y sin culpa.",
  suggested_duration_sec: 600,
  keywords: ["pan keto", "sin harina", "desayuno keto", "receta keto"],
};

console.log("proveedor :", "OpenAI");
console.log("modelo    :", env.LLM_MODEL);
console.log("api key   :", llmAvailable() ? `presente (len=${env.OPENAI_API_KEY.length})` : "AUSENTE");

if (!llmAvailable()) {
  console.error("\n[ERROR] Falta OPENAI_API_KEY en el .env. Configúrala y reintenta.");
  process.exit(1);
}

const { system, user } = buildScriptPrompt(idea);
console.log(`\nGenerando guion para: "${idea.title}" …\n`);

const t0 = Date.now();
try {
  const script = await llmComplete({ system, user, maxTokens: 900 });
  const ms = Date.now() - t0;
  console.log(`===== RESPUESTA REAL DE OPENAI (${ms} ms, ${script.length} chars) =====\n`);
  console.log(script);
  console.log("\n===== fin =====");
} catch (err: unknown) {
  console.error("\n[ERROR] La llamada a OpenAI falló:", err instanceof Error ? err.message : String(err));
  process.exit(1);
}
