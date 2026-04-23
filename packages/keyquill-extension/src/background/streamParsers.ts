/**
 * Pure SSE event parsers for each provider shape. No chrome / storage
 * imports, so they're trivially unit-testable.
 *
 * Each parser takes a port-like object with `postMessage` and the decoded
 * event payload, dispatches StreamEvents, and returns `true` iff the event
 * was terminal (streamManager uses this to avoid emitting a duplicate
 * trailing `done`).
 */

import type { ChatCompletion, StreamEvent, ToolCallDelta } from "../shared/protocol.js";
import { sanitizeErrorText } from "./providerFetch.js";

type PortLike = { postMessage: (e: StreamEvent) => void };

function sendEvent(port: PortLike, event: StreamEvent): void {
  try {
    port.postMessage(event);
  } catch {
    // Port disconnected — ignore
  }
}

// ── OpenAI Chat Completions SSE ────────────────────────

export function parseOpenAiStreamEvent(port: PortLike, data: Record<string, unknown>): boolean {
  const choices = data.choices as Array<Record<string, unknown>> | undefined;
  if (!choices?.[0]) return false;

  const choice = choices[0];
  const delta = choice.delta as Record<string, unknown> | undefined;

  if (delta?.content) {
    sendEvent(port, { type: "delta", text: delta.content as string });
  }

  if (delta?.tool_calls) {
    sendEvent(port, {
      type: "tool_call_delta",
      tool_calls: delta.tool_calls as ToolCallDelta[],
    });
  }

  if (choice.finish_reason) {
    const usage = data.usage as Record<string, number> | undefined;
    sendEvent(port, {
      type: "done",
      finish_reason: choice.finish_reason as ChatCompletion["finish_reason"],
      usage: usage
        ? { promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0 }
        : undefined,
    });
    return true;
  }
  return false;
}

// ── OpenAI Responses API SSE ───────────────────────────

/**
 * Events arrive as JSON objects with a `type` discriminator. Handled:
 *   - response.output_item.added (function_call item prologue: id + name)
 *   - response.output_text.delta (assistant text chunks)
 *   - response.function_call_arguments.delta (tool args chunks)
 *   - response.completed (terminal, with usage)
 *   - response.incomplete / failed (terminal length/error)
 * Anything else (reasoning deltas, created, in_progress, etc.) is ignored.
 *
 * Tool-call index is derived from `output_index`, which is stable for a
 * single function_call item across its delta stream.
 */
export function parseOpenAiResponsesStreamEvent(
  port: PortLike,
  data: Record<string, unknown>,
): boolean {
  const eventType = data.type as string | undefined;
  if (!eventType) return false;

  switch (eventType) {
    case "response.output_text.delta": {
      const delta = data.delta;
      if (typeof delta === "string" && delta.length > 0) {
        sendEvent(port, { type: "delta", text: delta });
      }
      return false;
    }
    case "response.output_item.added": {
      const item = data.item as Record<string, unknown> | undefined;
      if (item?.type === "function_call") {
        sendEvent(port, {
          type: "tool_call_delta",
          tool_calls: [
            {
              index: (data.output_index as number) ?? 0,
              id: (item.call_id as string) ?? (item.id as string),
              type: "function",
              function: { name: item.name as string, arguments: "" },
            },
          ],
        });
      }
      return false;
    }
    case "response.function_call_arguments.delta": {
      const delta = data.delta;
      if (typeof delta === "string" && delta.length > 0) {
        sendEvent(port, {
          type: "tool_call_delta",
          tool_calls: [
            {
              index: (data.output_index as number) ?? 0,
              function: { arguments: delta },
            },
          ],
        });
      }
      return false;
    }
    case "response.completed": {
      const resp = data.response as Record<string, unknown> | undefined;
      const usage = resp?.usage as Record<string, number> | undefined;
      const output = (resp?.output ?? []) as Array<Record<string, unknown>>;
      const hasToolCall = output.some((i) => i.type === "function_call");
      sendEvent(port, {
        type: "done",
        finish_reason: hasToolCall ? "tool_calls" : "stop",
        usage: usage
          ? { promptTokens: usage.input_tokens ?? 0, completionTokens: usage.output_tokens ?? 0 }
          : undefined,
      });
      return true;
    }
    case "response.incomplete": {
      const resp = data.response as Record<string, unknown> | undefined;
      const reason = (resp?.incomplete_details as { reason?: string } | undefined)?.reason;
      sendEvent(port, {
        type: "done",
        finish_reason: reason === "content_filter" ? "content_filter" : "length",
      });
      return true;
    }
    case "response.failed": {
      const resp = data.response as Record<string, unknown> | undefined;
      const err = resp?.error as { message?: string } | undefined;
      sendEvent(port, {
        type: "error",
        code: "PROVIDER_ERROR",
        message: sanitizeErrorText(err?.message ?? "Response failed"),
      });
      return true;
    }
    default:
      return false;
  }
}

// ── Anthropic SSE ──────────────────────────────────────

export function parseAnthropicStreamEvent(
  port: PortLike,
  data: Record<string, unknown>,
): boolean {
  const eventType = data.type as string;

  if (eventType === "content_block_delta") {
    const delta = data.delta as Record<string, unknown>;
    if (delta?.type === "text_delta") {
      sendEvent(port, { type: "delta", text: delta.text as string });
    }
    if (delta?.type === "input_json_delta") {
      sendEvent(port, {
        type: "tool_call_delta",
        tool_calls: [
          {
            index: data.index as number,
            function: { arguments: delta.partial_json as string },
          },
        ],
      });
    }
  }

  if (eventType === "content_block_start") {
    const block = data.content_block as Record<string, unknown>;
    if (block?.type === "tool_use") {
      sendEvent(port, {
        type: "tool_call_delta",
        tool_calls: [
          {
            index: data.index as number,
            id: block.id as string,
            type: "function",
            function: { name: block.name as string, arguments: "" },
          },
        ],
      });
    }
  }

  if (eventType === "message_delta") {
    const delta = data.delta as Record<string, unknown> | undefined;
    const stopReason = delta?.stop_reason as string | undefined;
    const finishReason = stopReason === "tool_use" ? ("tool_calls" as const) : ("stop" as const);
    const usage = data.usage as Record<string, number> | undefined;
    sendEvent(port, {
      type: "done",
      finish_reason: finishReason,
      usage: usage
        ? { promptTokens: usage.input_tokens ?? 0, completionTokens: usage.output_tokens ?? 0 }
        : undefined,
    });
    return true;
  }
  return false;
}

export function parseOpenAiCompletion(data: Record<string, unknown>): ChatCompletion {
  const choices = data.choices as Array<Record<string, unknown>> | undefined;
  const message = choices?.[0]?.message as Record<string, unknown> | undefined;
  const usage = data.usage as Record<string, number> | undefined;

  const result: ChatCompletion = {
    content: (message?.content as string) ?? null,
    finish_reason: (choices?.[0]?.finish_reason as ChatCompletion["finish_reason"]) ?? "stop",
  };

  if (message?.tool_calls) {
    result.tool_calls = message.tool_calls as ChatCompletion["tool_calls"];
  }

  if (usage) {
    result.usage = {
      promptTokens: usage.prompt_tokens ?? 0,
      completionTokens: usage.completion_tokens ?? 0,
    };
  }

  return result;
}
