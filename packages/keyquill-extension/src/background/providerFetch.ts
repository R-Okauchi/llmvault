/**
 * Builds provider-specific fetch parameters.
 *
 * Three endpoint shapes are produced:
 *   - Chat Completions  (OpenAI-compat passthrough): POST {baseUrl}/chat/completions
 *   - Responses API     (OpenAI only, pro models):   POST {baseUrl}/responses
 *   - Anthropic Messages:                            POST {baseUrl}/messages
 *
 * OpenAI `gpt-5-pro` / `o1-pro` / `o3-pro` ONLY work on the Responses API;
 * hitting `/chat/completions` returns 404 with "This is not a chat model."
 * The dispatch is gated on `provider.provider === "openai"` — other
 * OpenAI-compatible providers never implement Responses.
 */

import type { KeyRecord, ChatParams, ChatMessage, Tool } from "../shared/protocol.js";

export interface ProviderFetchParams {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** Which shape the caller should expect back when parsing the response. */
  endpoint: "chat" | "responses" | "anthropic";
}

export interface ProviderTestFetchParams {
  url: string;
  headers: Record<string, string>;
  method: "GET";
}

type ReasoningEffort = "minimal" | "low" | "medium" | "high";

/**
 * Detect OpenAI reasoning-family models. These require `max_completion_tokens`
 * and REJECT `max_tokens` with a 400 error. Pattern matches real OpenAI
 * model names in production as of 2026-04:
 *
 *   - o-series (API-only since Feb 2026): o1, o1-mini, o3, o3-mini, o4-mini, o3-pro
 *   - GPT-5 family (every active ChatGPT model in 2026): gpt-5, gpt-5-mini,
 *     gpt-5.2, gpt-5.4, gpt-5.4-mini, gpt-5.4-nano, gpt-5.4-thinking,
 *     gpt-5.4-pro
 *
 * Legacy models (gpt-4, gpt-4o, gpt-4.1, gpt-3.5-turbo) still accept
 * `max_tokens` and are NOT matched.
 */
export function isOpenAIReasoningModel(model: string): boolean {
  return /^(o\d+|gpt-5)/i.test(model);
}

/**
 * OpenAI model patterns that ONLY work on the Responses API.
 *
 * When OpenAI ships a new `*-pro` model, add its pattern here AND to the
 * integration test `TARGETS` so CI catches endpoint regressions. The
 * runtime 404 fallback in streamManager.ts acts as a safety net and logs
 * `console.warn` — treat that warning as a bug report against this table.
 */
const OPENAI_RESPONSES_ONLY: RegExp[] = [
  /^gpt-5(\.\d+)?-pro(-.*)?$/i,
  /^o1-pro(-.*)?$/i,
  /^o3-pro(-.*)?$/i,
];

/**
 * Which OpenAI endpoint shape does this (provider, model) pair need?
 * Non-openai providers always use `/chat/completions` — no other
 * OpenAI-compatible vendor implements the Responses API.
 */
export function selectOpenAIEndpoint(
  provider: KeyRecord,
  model: string,
): "chat" | "responses" {
  if (provider.provider !== "openai") return "chat";
  return OPENAI_RESPONSES_ONLY.some((re) => re.test(model)) ? "responses" : "chat";
}

interface NormalizedParams {
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: Tool[];
  tool_choice?: ChatParams["tool_choice"];
  response_format?: ChatParams["response_format"];
  reasoning_effort?: ReasoningEffort;
  /** True iff caller explicitly set temperature (vs. inherited from key defaults). */
  temperatureExplicit: boolean;
}

/**
 * Normalize the request and merge key-level defaults.
 *
 * Precedence (highest first): explicit request field → key.defaults field
 * → provider fallback (model baseline) → hard default (max_tokens 4096).
 * Explicit `undefined` on the request is NOT treated as override; only
 * fields actually set override the key defaults.
 */
export function normalizeParams(
  request: ChatParams & { maxTokens?: number },
  provider: KeyRecord,
): NormalizedParams {
  const defaults = provider.defaults;
  const temperature = request.temperature ?? defaults?.temperature;
  const topP = request.top_p ?? defaults?.topP;
  const reasoningEffort = request.reasoning_effort ?? defaults?.reasoningEffort;
  return {
    model: request.model ?? provider.defaultModel,
    messages: request.messages,
    max_tokens: request.max_tokens ?? request.maxTokens ?? 4096,
    ...(request.max_completion_tokens !== undefined && {
      max_completion_tokens: request.max_completion_tokens,
    }),
    ...(temperature !== undefined && { temperature }),
    ...(topP !== undefined && { top_p: topP }),
    ...(request.stop !== undefined && { stop: request.stop }),
    ...(request.tools && { tools: request.tools }),
    ...(request.tool_choice !== undefined && { tool_choice: request.tool_choice }),
    ...(request.response_format && { response_format: request.response_format }),
    ...(reasoningEffort !== undefined && { reasoning_effort: reasoningEffort }),
    temperatureExplicit: request.temperature !== undefined,
  };
}

export interface BuildOptions {
  /**
   * Override the auto-selected endpoint. Used by the fallback path when
   * /chat/completions returns 404 "not a chat model" — the caller retries
   * once with `forceEndpoint: "responses"` rather than re-running the
   * model matcher.
   */
  forceEndpoint?: "chat" | "responses";
}

export function buildProviderFetch(
  provider: KeyRecord,
  request: ChatParams & { maxTokens?: number },
  stream: boolean,
  opts: BuildOptions = {},
): ProviderFetchParams {
  const params = normalizeParams(request, provider);

  if (provider.provider === "anthropic") {
    return buildAnthropicFetch(provider, params, stream);
  }

  const endpoint = opts.forceEndpoint ?? selectOpenAIEndpoint(provider, params.model);
  if (endpoint === "responses") {
    return buildOpenAiResponses(provider, params, stream);
  }
  return buildOpenAiPassthrough(provider, params, stream);
}

// ── Provider reachability test (used by popup Test button) ────────

/**
 * Builds a minimal GET request against `/models` for credential validation.
 * Free, model-agnostic, no parameter constraints — works for every preset
 * (OpenAI-compat and Anthropic both expose `GET /v1/models`).
 */
export function buildProviderTestFetch(provider: KeyRecord): ProviderTestFetchParams {
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/models`;
  if (provider.provider === "anthropic") {
    return {
      url,
      method: "GET",
      headers: {
        "x-api-key": provider.apiKey,
        "anthropic-version": "2023-06-01",
      },
    };
  }
  return {
    url,
    method: "GET",
    headers: { Authorization: `Bearer ${provider.apiKey}` },
  };
}

// ── OpenAI Chat Completions Passthrough ─────────────────

function buildOpenAiPassthrough(
  provider: KeyRecord,
  params: NormalizedParams,
  stream: boolean,
): ProviderFetchParams {
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
    stream,
  };
  // Reasoning-family models reject `max_tokens` and require
  // `max_completion_tokens`. Legacy models accept `max_tokens`.
  if (isOpenAIReasoningModel(params.model)) {
    body.max_completion_tokens = params.max_completion_tokens ?? params.max_tokens;
  } else {
    body.max_tokens = params.max_tokens;
    if (params.max_completion_tokens !== undefined) {
      body.max_completion_tokens = params.max_completion_tokens;
    }
  }
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.top_p !== undefined) body.top_p = params.top_p;
  if (params.stop !== undefined) body.stop = params.stop;
  if (params.tools) body.tools = params.tools;
  if (params.tool_choice !== undefined) body.tool_choice = params.tool_choice;
  if (params.response_format) body.response_format = params.response_format;
  if (params.reasoning_effort !== undefined) body.reasoning_effort = params.reasoning_effort;

  return {
    url,
    endpoint: "chat",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
  };
}

// ── OpenAI Responses API (gpt-5-pro, o1-pro, o3-pro) ────

function buildOpenAiResponses(
  provider: KeyRecord,
  params: NormalizedParams,
  stream: boolean,
): ProviderFetchParams {
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/responses`;

  const input = convertMessagesToResponsesInput(params.messages);

  const body: Record<string, unknown> = {
    model: params.model,
    input,
    max_output_tokens: params.max_completion_tokens ?? params.max_tokens,
    stream,
  };

  // Responses API reasoning models reject temperature ≠ 1. Omit any
  // inherited/default temperature unless caller explicitly set it to 1.
  // This defends against a common failure mode where per-key
  // `defaults.temperature = 0.7` silently breaks pro model requests.
  if (params.temperatureExplicit && params.temperature === 1) {
    body.temperature = 1;
  }
  if (params.top_p !== undefined) body.top_p = params.top_p;

  if (params.reasoning_effort) {
    body.reasoning = { effort: params.reasoning_effort };
  }
  if (params.tools) {
    // Responses API uses flat `{type:"function", name, description, parameters}` tools
    // rather than the nested `{type:"function", function:{...}}` shape of Chat Completions.
    body.tools = params.tools.map((t) => ({
      type: "function",
      name: t.function.name,
      ...(t.function.description && { description: t.function.description }),
      parameters: t.function.parameters ?? { type: "object" },
      ...(t.function.strict !== undefined && { strict: t.function.strict }),
    }));
  }
  if (params.tool_choice !== undefined) body.tool_choice = params.tool_choice;
  if (params.response_format) {
    // Responses API nests format under `text`.
    body.text = { format: params.response_format };
  }

  return {
    url,
    endpoint: "responses",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
  };
}

function convertMessagesToResponsesInput(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        input.push({
          role: "system",
          content: [{ type: "input_text", text: msg.content }],
        });
        break;
      case "user": {
        if (typeof msg.content === "string") {
          input.push({
            role: "user",
            content: [{ type: "input_text", text: msg.content }],
          });
        } else {
          input.push({
            role: "user",
            content: msg.content.map((part) =>
              part.type === "text"
                ? { type: "input_text", text: part.text }
                : { type: "input_image", image_url: part.image_url.url },
            ),
          });
        }
        break;
      }
      case "assistant": {
        if (msg.content) {
          input.push({
            role: "assistant",
            content: [{ type: "output_text", text: msg.content }],
          });
        }
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            input.push({
              type: "function_call",
              call_id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
            });
          }
        }
        break;
      }
      case "tool":
        input.push({
          type: "function_call_output",
          call_id: msg.tool_call_id,
          output: msg.content,
        });
        break;
    }
  }
  return input;
}

// ── Reasoning effort → Anthropic thinking budget ───────
const REASONING_TO_THINKING_BUDGET: Record<ReasoningEffort, number> = {
  minimal: 1024,
  low: 4096,
  medium: 12000,
  high: 32000,
};

// ── Anthropic Translation ──────────────────────────────

function buildAnthropicFetch(
  provider: KeyRecord,
  params: NormalizedParams,
  stream: boolean,
): ProviderFetchParams {
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/messages`;

  // Extract system messages
  const systemMessages = params.messages.filter(
    (m): m is Extract<ChatMessage, { role: "system" }> => m.role === "system",
  );
  const system =
    systemMessages.length > 0
      ? systemMessages.map((m) => ({ type: "text" as const, text: m.content }))
      : undefined;

  // Convert remaining messages to Anthropic format
  const messages = params.messages
    .filter((m) => m.role !== "system")
    .map(convertMessageToAnthropic);

  // Convert tools
  const tools = params.tools?.map(convertToolToAnthropic);

  const body: Record<string, unknown> = {
    model: params.model,
    messages,
    max_tokens: params.max_tokens,
    stream,
  };
  if (system) body.system = system;
  if (tools && tools.length > 0) body.tools = tools;
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.top_p !== undefined) body.top_p = params.top_p;
  if (params.stop) {
    body.stop_sequences = Array.isArray(params.stop) ? params.stop : [params.stop];
  }
  if (params.reasoning_effort) {
    // Anthropic extended thinking: translate OpenAI-style effort enum to
    // an explicit token budget.
    body.thinking = {
      type: "enabled",
      budget_tokens: REASONING_TO_THINKING_BUDGET[params.reasoning_effort],
    };
  }

  return {
    url,
    endpoint: "anthropic",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": provider.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  };
}

// ── Anthropic Message Conversion ───────────────────────

function convertMessageToAnthropic(msg: ChatMessage): Record<string, unknown> {
  switch (msg.role) {
    case "user": {
      if (typeof msg.content === "string") {
        return { role: "user", content: msg.content };
      }
      // Convert ContentPart[] to Anthropic content blocks
      const content = msg.content.map((part) => {
        if (part.type === "text") {
          return { type: "text", text: part.text };
        }
        // image_url → Anthropic image block
        const url = part.image_url.url;
        if (url.startsWith("data:")) {
          const match = url.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            return {
              type: "image",
              source: { type: "base64", media_type: match[1], data: match[2] },
            };
          }
        }
        return { type: "image", source: { type: "url", url } };
      });
      return { role: "user", content };
    }

    case "assistant": {
      const content: Array<Record<string, unknown>> = [];
      if (msg.content) {
        content.push({ type: "text", text: msg.content });
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments),
          });
        }
      }
      return { role: "assistant", content: content.length > 0 ? content : undefined };
    }

    case "tool":
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id,
            content: msg.content,
          },
        ],
      };

    default:
      return { role: (msg as ChatMessage).role, content: (msg as { content?: string }).content };
  }
}

function convertToolToAnthropic(tool: Tool): Record<string, unknown> {
  return {
    name: tool.function.name,
    ...(tool.function.description && { description: tool.function.description }),
    input_schema: tool.function.parameters ?? { type: "object" },
  };
}

// ── Anthropic Response Parsing ─────────────────────────

/**
 * Parse an Anthropic non-streaming response into OpenAI-compatible ChatCompletion shape.
 */
export function parseAnthropicCompletion(data: Record<string, unknown>): {
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  finish_reason: "stop" | "tool_calls" | "length" | "content_filter";
  usage?: { promptTokens: number; completionTokens: number };
} {
  const contentBlocks = (data.content ?? []) as Array<Record<string, unknown>>;
  let textContent = "";
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];

  for (const block of contentBlocks) {
    if (block.type === "text") {
      textContent += block.text as string;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id as string,
        type: "function",
        function: {
          name: block.name as string,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  const stopReason = data.stop_reason as string | undefined;
  const finishReason = stopReason === "tool_use" ? ("tool_calls" as const) : ("stop" as const);

  const usage = data.usage as Record<string, number> | undefined;

  return {
    content: textContent || null,
    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
    finish_reason: finishReason,
    ...(usage && {
      usage: {
        promptTokens: usage.input_tokens ?? 0,
        completionTokens: usage.output_tokens ?? 0,
      },
    }),
  };
}

// ── OpenAI Responses Parsing (non-streaming) ───────────

/**
 * Parse an OpenAI Responses API non-streaming response into the same
 * ChatCompletion shape that `parseOpenAiCompletion` produces, so
 * downstream code can stay endpoint-agnostic.
 */
export function parseOpenAiResponsesCompletion(data: Record<string, unknown>): {
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  finish_reason: "stop" | "tool_calls" | "length" | "content_filter";
  usage?: { promptTokens: number; completionTokens: number };
} {
  const output = (data.output ?? []) as Array<Record<string, unknown>>;
  let textContent = "";
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];

  for (const item of output) {
    if (item.type === "message") {
      const parts = (item.content ?? []) as Array<Record<string, unknown>>;
      for (const part of parts) {
        if (part.type === "output_text" && typeof part.text === "string") {
          textContent += part.text;
        }
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: (item.call_id as string) ?? (item.id as string),
        type: "function",
        function: {
          name: item.name as string,
          arguments: (item.arguments as string) ?? "",
        },
      });
    }
  }

  let finishReason: "stop" | "tool_calls" | "length" | "content_filter" = "stop";
  if (toolCalls.length > 0) {
    finishReason = "tool_calls";
  } else if (data.status === "incomplete") {
    const reason = (data.incomplete_details as { reason?: string } | undefined)?.reason;
    finishReason = reason === "content_filter" ? "content_filter" : "length";
  }

  const usage = data.usage as Record<string, number> | undefined;

  return {
    content: textContent || null,
    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
    finish_reason: finishReason,
    ...(usage && {
      usage: {
        promptTokens: usage.input_tokens ?? 0,
        completionTokens: usage.output_tokens ?? 0,
      },
    }),
  };
}

// ── Error text sanitization ────────────────────────────

/**
 * Redact credential-shaped substrings from provider error bodies before
 * they surface to the UI. Preserves the provider's semantic error text
 * (endpoint/model errors) so users can debug without leaking keys.
 */
export function sanitizeErrorText(text: string): string {
  return text
    .replace(/Bearer\s+[\w\-_.]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, "[REDACTED]")
    .replace(/\bkey-[A-Za-z0-9_-]{10,}/g, "[REDACTED]");
}

/**
 * Heuristic for the "model doesn't support /chat/completions" 404 that
 * OpenAI returns for pro models. Used by streamManager.ts to trigger a
 * one-shot retry against the Responses API.
 */
export function isResponsesFallbackSignal(status: number, body: string): boolean {
  if (status !== 404) return false;
  return /not a chat model/i.test(body) || /v1\/responses/i.test(body);
}
