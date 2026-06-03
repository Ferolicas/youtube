import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/config/env";

export function llmAvailable(): boolean {
  return env.ANTHROPIC_API_KEY.length > 0;
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}

/** Llamada genérica al LLM. Lanza si no hay API key configurada. */
export async function llmComplete(params: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  if (!llmAvailable()) {
    throw new Error("LLM_UNAVAILABLE: configura ANTHROPIC_API_KEY para ideas/guiones con IA.");
  }
  const res = await getClient().messages.create({
    model: env.LLM_MODEL,
    max_tokens: params.maxTokens ?? 2000,
    system: params.system,
    messages: [{ role: "user", content: params.user }],
  });
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/** Intenta parsear el primer bloque JSON de una respuesta del LLM. */
export function extractJson<T>(text: string): T | null {
  const start = text.indexOf("[");
  const startObj = text.indexOf("{");
  const begin = start >= 0 && (startObj < 0 || start < startObj) ? start : startObj;
  if (begin < 0) return null;
  const open = text[begin];
  const close = open === "[" ? "]" : "}";
  const end = text.lastIndexOf(close);
  if (end <= begin) return null;
  try {
    return JSON.parse(text.slice(begin, end + 1)) as T;
  } catch {
    return null;
  }
}
