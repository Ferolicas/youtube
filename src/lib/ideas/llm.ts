import OpenAI from "openai";
import { env } from "@/config/env";

/**
 * Capa LLM multi-proveedor. El proveedor se infiere del nombre del modelo:
 *   - "claude-*"  -> Anthropic Messages API (fetch directo, sin SDK extra)
 *   - resto       -> OpenAI Chat Completions (SDK ya presente)
 * Ej.: LLM_MODEL=claude-sonnet-4-6 + ANTHROPIC_API_KEY, o LLM_MODEL=gpt-4o +
 * OPENAI_API_KEY. Los embeddings siguen siendo de OpenAI (embeddings.ts).
 */

type Provider = "openai" | "anthropic";

function providerFor(model: string): Provider {
  return model.toLowerCase().startsWith("claude") ? "anthropic" : "openai";
}

export function llmAvailable(): boolean {
  return providerFor(env.LLM_MODEL) === "anthropic"
    ? env.ANTHROPIC_API_KEY.length > 0
    : env.OPENAI_API_KEY.length > 0;
}

let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  return openaiClient;
}

/** Llamada genérica al LLM. Lanza si no hay API key del proveedor configurada. */
export async function llmComplete(params: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  if (!llmAvailable()) {
    throw new Error(
      `LLM_UNAVAILABLE: configura ${providerFor(env.LLM_MODEL) === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} para '${env.LLM_MODEL}'.`
    );
  }

  if (providerFor(env.LLM_MODEL) === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: env.LLM_MODEL,
        max_tokens: params.maxTokens ?? 2000,
        system: params.system,
        messages: [{ role: "user", content: params.user }],
      }),
    });
    if (!res.ok) {
      throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    return (data.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  }

  const res = await getOpenAI().chat.completions.create({
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
