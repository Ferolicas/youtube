import OpenAI from "openai";
import { env } from "@/config/env";

export function llmAvailable(): boolean {
  return env.OPENAI_API_KEY.length > 0;
}

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return client;
}

/** Llamada genérica al LLM. Lanza si no hay API key configurada. */
export async function llmComplete(params: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  if (!llmAvailable()) {
    throw new Error("LLM_UNAVAILABLE: configura OPENAI_API_KEY para ideas/guiones con IA.");
  }
  const res = await getClient().chat.completions.create({
    model: env.LLM_MODEL,
    max_tokens: params.maxTokens ?? 2000,
    messages: [
      { role: "system", content: params.system },
      { role: "user", content: params.user },
    ],
  });
  return res.choices[0]?.message?.content ?? "";
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
