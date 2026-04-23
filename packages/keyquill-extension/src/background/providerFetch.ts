/**
 * Shared provider-level helpers that outlive the Phase 6 resolver cutover.
 *
 * Before v1.0 this file built the full provider request. That logic moved
 * into `resolver.ts` (body construction) and `modelCatalog.ts` (endpoint
 * selection and reasoning-family classification). The pieces that remain
 * here are used from outside the resolver pipeline:
 *
 *   - `buildProviderTestFetch`: popup Test button probes `GET /models`
 *     directly — no resolver, no ledger, just a reachability check.
 *   - `sanitizeErrorText`: used by streamManager and messageRouter to
 *     scrub credentials out of provider error bodies before display.
 *   - `isResponsesFallbackSignal`: the 404→/responses retry heuristic in
 *     streamManager relies on this.
 *   - `parseAnthropicCompletion` / `parseOpenAiResponsesCompletion`:
 *     non-streaming response parsers used by `handleChat`.
 *   - `isOpenAIReasoningModel`: public helper for tests / external
 *     consumers; delegates to the catalog for known models, regex
 *     fallback for unlisted names.
 */

import type { KeyRecord } from "../shared/protocol.js";
import { getModel, isOpenAIReasoning } from "../shared/modelCatalog.js";

export interface ProviderTestFetchParams {
  url: string;
  headers: Record<string, string>;
  method: "GET";
}

// ── Reasoning-family detection (public helper) ─────────

/**
 * True for OpenAI reasoning-family models (o-series, gpt-5 family).
 * Catalogue-driven when the model is known; regex fallback catches
 * unlisted variants (pre-release or deprecated) until the monthly
 * catalog refresh lands.
 */
export function isOpenAIReasoningModel(model: string): boolean {
  const spec = getModel(model);
  if (spec) return isOpenAIReasoning(spec);
  return REASONING_FALLBACK_REGEX.test(model);
}

const REASONING_FALLBACK_REGEX = /^(o\d+|gpt-5)/i;

// ── Provider reachability test (used by popup Test button) ────────

/**
 * Minimal GET request against `/models` for credential validation.
 * Free, model-agnostic — works for every preset (OpenAI-compat and
 * Anthropic both expose `GET /v1/models`).
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

// ── Anthropic Response Parsing ─────────────────────────

/**
 * Parse an Anthropic non-streaming response into OpenAI-compatible
 * ChatCompletion shape. Used by `handleChat` after a successful provider
 * round-trip.
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
 * Parse an OpenAI Responses API non-streaming response into the canonical
 * ChatCompletion shape. Endpoint-agnostic downstream consumers never
 * notice which endpoint served the request.
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
 * so users can debug without leaking keys.
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
