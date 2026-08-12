import { isCursorAvailable } from "./cursor-agent.js";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatCompletionOptions = {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
};

export type AiClientConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export function resolveAiClientConfig(): AiClientConfig | undefined {
  const apiKey =
    process.env.CONTENT_AI_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return undefined;

  const baseUrl = (
    process.env.CONTENT_AI_BASE_URL?.trim() ||
    process.env.OPENAI_BASE_URL?.trim() ||
    "https://api.openai.com/v1"
  ).replace(/\/+$/, "");

  const model =
    process.env.CONTENT_AI_MODEL?.trim() ||
    process.env.OPENAI_MODEL?.trim() ||
    "gpt-4o-mini";

  return { apiKey, baseUrl, model };
}

export function isAiAvailable(): boolean {
  // Cursor CLI (agent login or CURSOR_API_KEY) preferred for content
  if (isCursorAvailable()) return true;
  return Boolean(resolveAiClientConfig());
}

export async function chatCompletion(
  options: ChatCompletionOptions,
  config = resolveAiClientConfig(),
): Promise<string> {
  if (!config) {
    throw new Error(
      "AI client not configured. Set CURSOR_API_KEY (preferred) or OPENAI_API_KEY.",
    );
  }

  const body: Record<string, unknown> = {
    model: config.model,
    messages: options.messages,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.maxTokens ?? 2048,
  };
  if (options.json) {
    body.response_format = { type: "json_object" };
  }

  const res = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `AI chat completion failed (${res.status}): ${text.slice(0, 400)}`,
    );
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("AI chat completion returned empty content");
  }
  return content;
}

export function parseJsonObject<T>(raw: string): T {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fence?.[1]) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  return JSON.parse(text) as T;
}
