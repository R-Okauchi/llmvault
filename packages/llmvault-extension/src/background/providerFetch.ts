/**
 * Builds provider-specific fetch parameters.
 *
 * OpenAI-compatible providers receive the request body as-is (passthrough).
 * Anthropic requests are translated from OpenAI format to Messages API.
 */

import type { ProviderRecord, ChatParams, ChatMessage, Tool } from "../shared/protocol.js";

export interface ProviderFetchParams {
  url: string;
  headers: Record<string, string>;
  body: string;
}

interface NormalizedParams {
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: Tool[];
  tool_choice?: ChatParams["tool_choice"];
  response_format?: ChatParams["response_format"];
}

/**
 * Normalize request: merge deprecated maxTokens → max_tokens, apply defaults.
 */
export function normalizeParams(
  request: ChatParams & { maxTokens?: number },
  provider: ProviderRecord,
): NormalizedParams {
  return {
    model: request.model ?? provider.defaultModel,
    messages: request.messages,
    max_tokens: request.max_tokens ?? request.maxTokens ?? 4096,
    ...(request.temperature !== undefined && { temperature: request.temperature }),
    ...(request.top_p !== undefined && { top_p: request.top_p }),
    ...(request.stop !== undefined && { stop: request.stop }),
    ...(request.tools && { tools: request.tools }),
    ...(request.tool_choice !== undefined && { tool_choice: request.tool_choice }),
    ...(request.response_format && { response_format: request.response_format }),
  };
}

export function buildProviderFetch(
  provider: ProviderRecord,
  request: ChatParams & { maxTokens?: number },
  stream: boolean,
): ProviderFetchParams {
  const params = normalizeParams(request, provider);

  if (provider.provider === "anthropic") {
    return buildAnthropicFetch(provider, params, stream);
  }
  // All other providers: OpenAI-compatible passthrough
  return buildOpenAiPassthrough(provider, params, stream);
}

// ── OpenAI Passthrough ─────────────────────────────────

function buildOpenAiPassthrough(
  provider: ProviderRecord,
  params: NormalizedParams,
  stream: boolean,
): ProviderFetchParams {
  const url = `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages,
    max_tokens: params.max_tokens,
    stream,
  };
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.top_p !== undefined) body.top_p = params.top_p;
  if (params.stop !== undefined) body.stop = params.stop;
  if (params.tools) body.tools = params.tools;
  if (params.tool_choice !== undefined) body.tool_choice = params.tool_choice;
  if (params.response_format) body.response_format = params.response_format;

  return {
    url,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
  };
}

// ── Anthropic Translation ──────────────────────────────

function buildAnthropicFetch(
  provider: ProviderRecord,
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

  return {
    url,
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
