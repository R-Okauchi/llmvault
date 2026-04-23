/**
 * Manages streaming and non-streaming chat requests.
 * Fetches from LLM provider, parses SSE, and sends events over a Chrome Port.
 */

import type {
  ChatStreamRequest,
  ChatRequestMessage,
  ChatCompletion,
  OutgoingResponse,
  StreamEvent,
  KeyRecord,
} from "../shared/protocol.js";
import { getKey, getActiveKey } from "./keyStore.js";
import { getBinding, touchBindingUsage } from "./bindingStore.js";
import {
  buildProviderFetch,
  parseAnthropicCompletion,
  parseOpenAiResponsesCompletion,
  sanitizeErrorText,
  isResponsesFallbackSignal,
} from "./providerFetch.js";
import {
  parseOpenAiStreamEvent,
  parseOpenAiResponsesStreamEvent,
  parseAnthropicStreamEvent,
  parseOpenAiCompletion,
} from "./streamParsers.js";

// ── Key resolution ─────────────────────────────────────

/**
 * Resolve which stored KeyRecord should service this request.
 *
 * Priority (v3 active-key model):
 *   1. `request.keyId` — explicit SDK selection (strongest signal)
 *   2. Per-origin binding — persisted site choice from consent popup
 *   3. Active key — the wallet's current selection, singleton across
 *      the whole wallet
 *
 * `request.provider` is accepted for compatibility but no longer drives
 * resolution (a site that needs a specific provider should pass keyId of
 * a matching key). This eliminates the v2 ambiguity where the "global
 * default" was the first per-provider default in array order.
 */
export async function resolveKey(
  request: { keyId?: string; provider?: string },
  origin: string | null,
): Promise<KeyRecord | null> {
  if (request.keyId) {
    return (await getKey(request.keyId)) ?? null;
  }

  if (origin && origin !== "__internal__") {
    const binding = await getBinding(origin);
    if (binding?.keyId) {
      const keyRecord = await getKey(binding.keyId);
      if (keyRecord) {
        touchBindingUsage(origin).catch(() => {
          // non-critical
        });
        return keyRecord;
      }
      // Binding is stale (referenced key was deleted); fall through.
    }
  }

  return await getActiveKey();
}

// ── Streaming ──────────────────────────────────────────

export async function handleChatStream(
  port: chrome.runtime.Port,
  request: ChatStreamRequest,
  origin: string | null,
): Promise<void> {
  const keyRecord = await resolveKey(request, origin);

  if (!keyRecord) {
    sendEvent(port, {
      type: "error",
      code: "KEY_NOT_FOUND",
      message:
        "No Keyquill key available. Open the extension popup to add one or to bind this site to a key.",
    });
    return;
  }

  // Announce which key is servicing this stream (for audit / UI hint).
  sendEvent(port, {
    type: "start",
    keyId: keyRecord.keyId,
    provider: keyRecord.provider,
    label: keyRecord.label,
  });

  let fetchParams = buildProviderFetch(keyRecord, request, true);

  let response: Response;
  try {
    response = await fetch(fetchParams.url, {
      method: "POST",
      headers: fetchParams.headers,
      body: fetchParams.body,
    });
  } catch (err) {
    sendEvent(port, {
      type: "error",
      code: "PROVIDER_UNREACHABLE",
      message: `Could not reach provider: ${err instanceof Error ? err.message : "unknown"}`,
    });
    return;
  }

  // One-shot fallback: some OpenAI models (gpt-*-pro, o*-pro) only work on
  // the Responses API and return 404 from /chat/completions. Retry once
  // against /responses. The warning flags it so OPENAI_RESPONSES_ONLY can
  // be updated to avoid the roundtrip next time.
  if (
    !response.ok &&
    keyRecord.provider === "openai" &&
    fetchParams.endpoint === "chat"
  ) {
    const errBody = await response.text().catch(() => "");
    if (isResponsesFallbackSignal(response.status, errBody)) {
      console.warn(
        `[keyquill] model "${request.model ?? keyRecord.defaultModel}" rejected at /chat/completions; retrying on /responses. Consider adding it to OPENAI_RESPONSES_ONLY.`,
      );
      fetchParams = buildProviderFetch(keyRecord, request, true, {
        forceEndpoint: "responses",
      });
      try {
        response = await fetch(fetchParams.url, {
          method: "POST",
          headers: fetchParams.headers,
          body: fetchParams.body,
        });
      } catch (err) {
        sendEvent(port, {
          type: "error",
          code: "PROVIDER_UNREACHABLE",
          message: `Could not reach provider: ${err instanceof Error ? err.message : "unknown"}`,
        });
        return;
      }
    } else {
      sendEvent(port, {
        type: "error",
        code: "PROVIDER_ERROR",
        message: `Provider returned ${response.status}: ${sanitizeErrorText(errBody.slice(0, 500))}`,
      });
      return;
    }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown error");
    sendEvent(port, {
      type: "error",
      code: "PROVIDER_ERROR",
      message: `Provider returned ${response.status}: ${sanitizeErrorText(text.slice(0, 500))}`,
    });
    return;
  }

  if (!response.body) {
    sendEvent(port, {
      type: "error",
      code: "PROVIDER_ERROR",
      message: "Empty response body from provider.",
    });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const endpoint = fetchParams.endpoint;
  let sawTerminalEvent = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data: ")) continue;

        try {
          const data = JSON.parse(trimmed.slice(6));

          if (endpoint === "anthropic") {
            if (parseAnthropicStreamEvent(port, data)) sawTerminalEvent = true;
          } else if (endpoint === "responses") {
            if (parseOpenAiResponsesStreamEvent(port, data)) sawTerminalEvent = true;
          } else {
            if (parseOpenAiStreamEvent(port, data)) sawTerminalEvent = true;
          }
        } catch {
          // Skip malformed JSON lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!sawTerminalEvent) {
    sendEvent(port, { type: "done" });
  }
}

// ── Non-Streaming Chat ─────────────────────────────────

export async function handleChat(
  request: ChatRequestMessage,
  origin: string | null,
): Promise<OutgoingResponse> {
  const keyRecord = await resolveKey(request, origin);

  if (!keyRecord) {
    return { type: "error", code: "KEY_NOT_FOUND", message: "No Keyquill key available." };
  }

  let fetchParams = buildProviderFetch(keyRecord, request, false);

  let response: Response;
  try {
    response = await fetch(fetchParams.url, {
      method: "POST",
      headers: fetchParams.headers,
      body: fetchParams.body,
    });
  } catch (err) {
    return {
      type: "error",
      code: "PROVIDER_UNREACHABLE",
      message: `Could not reach provider: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }

  if (
    !response.ok &&
    keyRecord.provider === "openai" &&
    fetchParams.endpoint === "chat"
  ) {
    const errBody = await response.text().catch(() => "");
    if (isResponsesFallbackSignal(response.status, errBody)) {
      console.warn(
        `[keyquill] model "${request.model ?? keyRecord.defaultModel}" rejected at /chat/completions; retrying on /responses. Consider adding it to OPENAI_RESPONSES_ONLY.`,
      );
      fetchParams = buildProviderFetch(keyRecord, request, false, {
        forceEndpoint: "responses",
      });
      try {
        response = await fetch(fetchParams.url, {
          method: "POST",
          headers: fetchParams.headers,
          body: fetchParams.body,
        });
      } catch (err) {
        return {
          type: "error",
          code: "PROVIDER_UNREACHABLE",
          message: `Could not reach provider: ${err instanceof Error ? err.message : "unknown"}`,
        };
      }
    } else {
      return {
        type: "error",
        code: "PROVIDER_ERROR",
        message: `Provider returned ${response.status}: ${sanitizeErrorText(errBody.slice(0, 500))}`,
      };
    }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown");
    return {
      type: "error",
      code: "PROVIDER_ERROR",
      message: `Provider returned ${response.status}: ${sanitizeErrorText(text.slice(0, 500))}`,
    };
  }

  const data = (await response.json()) as Record<string, unknown>;

  let completion: ChatCompletion;
  switch (fetchParams.endpoint) {
    case "anthropic":
      completion = parseAnthropicCompletion(data);
      break;
    case "responses":
      completion = parseOpenAiResponsesCompletion(data);
      break;
    default:
      completion = parseOpenAiCompletion(data);
  }

  return { type: "chatCompletion", completion, keyId: keyRecord.keyId };
}

// ── Helpers ────────────────────────────────────────────

function sendEvent(port: chrome.runtime.Port, event: StreamEvent): void {
  try {
    port.postMessage(event);
  } catch {
    // Port disconnected — ignore
  }
}
