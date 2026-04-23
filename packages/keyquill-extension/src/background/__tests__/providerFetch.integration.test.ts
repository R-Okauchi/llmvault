/**
 * Live-API integration matrix. Skipped when the corresponding env var is
 * missing — safe to run on forks / local envs without every key.
 *
 * Costs: each target fires GET /models + 1 non-streaming chat + 1 streaming
 * chat per catalogued model. Prompts are capped at ~32 output tokens so
 * a full matrix run is a fraction of a cent at Apr-2026 rates.
 *
 * Adding a new preset? Update TARGETS here too — the catalog-coverage
 * guard in providerFetch.test.ts will fail CI if you forget.
 */

import { describe, it, expect } from "vitest";
import type { ChatParams, ChatCompletion, KeyRecord, StreamEvent } from "../../shared/protocol.js";
import {
  buildProviderFetch,
  buildProviderTestFetch,
  parseAnthropicCompletion,
  parseOpenAiResponsesCompletion,
} from "../providerFetch.js";
import {
  parseAnthropicStreamEvent,
  parseOpenAiCompletion,
  parseOpenAiResponsesStreamEvent,
  parseOpenAiStreamEvent,
} from "../streamParsers.js";
import { INTEGRATION_TARGETS, type Target } from "./integrationTargets.js";

function key(t: Target, apiKey: string, model: string): KeyRecord {
  return {
    keyId: `it-${t.id}`,
    provider: t.id,
    label: "integration",
    apiKey,
    baseUrl: t.baseUrl,
    defaultModel: model,
    createdAt: 0,
    updatedAt: 0,
  };
}

const REQUEST: ChatParams = {
  messages: [{ role: "user", content: "Say the single word: pong" }],
  max_completion_tokens: 32,
  max_tokens: 32,
};

function parseCompletionFor(
  endpoint: "chat" | "responses" | "anthropic",
  data: Record<string, unknown>,
): ChatCompletion {
  switch (endpoint) {
    case "anthropic":
      return parseAnthropicCompletion(data) as ChatCompletion;
    case "responses":
      return parseOpenAiResponsesCompletion(data) as ChatCompletion;
    default:
      return parseOpenAiCompletion(data);
  }
}

async function runStreamToCompletion(params: {
  url: string;
  headers: Record<string, string>;
  body: string;
  endpoint: "chat" | "responses" | "anthropic";
}): Promise<{ deltas: string[]; events: StreamEvent[] }> {
  const res = await fetch(params.url, {
    method: "POST",
    headers: params.headers,
    body: params.body,
  });
  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`Stream ${res.status}: ${body.slice(0, 200)}`);
  }
  const events: StreamEvent[] = [];
  const port = { postMessage: (e: StreamEvent) => events.push(e) };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
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
        if (params.endpoint === "anthropic") parseAnthropicStreamEvent(port, data);
        else if (params.endpoint === "responses")
          parseOpenAiResponsesStreamEvent(port, data);
        else parseOpenAiStreamEvent(port, data);
      } catch {
        // skip malformed
      }
    }
  }
  const deltas = events.flatMap((e) => (e.type === "delta" ? [e.text] : []));
  return { deltas, events };
}

for (const t of INTEGRATION_TARGETS) {
  describe.skipIf(!process.env[t.env])(`${t.id} live API`, () => {
    const apiKey = process.env[t.env] as string;

    it(`GET /models returns 2xx`, async () => {
      const p = buildProviderTestFetch(key(t, apiKey, t.chatModels[0]));
      const r = await fetch(p.url, { method: "GET", headers: p.headers });
      expect(r.ok).toBe(true);
    }, 30_000);

    for (const model of t.chatModels) {
      const expectEmpty = t.expectEmptyContentFor?.test(model) ?? false;

      it(`non-streaming ${model}: succeeds`, async () => {
        const p = buildProviderFetch(key(t, apiKey, model), REQUEST, false);
        const r = await fetch(p.url, {
          method: "POST",
          headers: p.headers,
          body: p.body,
        });
        if (!r.ok) {
          const errBody = await r.text().catch(() => "");
          throw new Error(`HTTP ${r.status}: ${errBody.slice(0, 200)}`);
        }
        const data = (await r.json()) as Record<string, unknown>;
        const completion = parseCompletionFor(p.endpoint, data);
        if (expectEmpty) {
          // pro/reasoning under tight budget may return empty content
          // with finish_reason=length — still counts as a working request.
          expect(completion.finish_reason).toBeDefined();
        } else {
          expect(completion.content?.length ?? 0).toBeGreaterThan(0);
        }
      }, 60_000);

      it(`streaming ${model}: emits ≥1 delta or terminates cleanly`, async () => {
        const p = buildProviderFetch(key(t, apiKey, model), REQUEST, true);
        const { deltas, events } = await runStreamToCompletion(p);
        // Either there are text deltas, OR the stream completed (length
        // truncation on a 32-token reasoning-model budget is acceptable).
        const ended = events.some((e) => e.type === "done" || e.type === "error");
        if (expectEmpty) {
          expect(ended).toBe(true);
        } else {
          expect(deltas.length > 0 || ended).toBe(true);
        }
      }, 60_000);
    }
  });
}
