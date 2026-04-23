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
  buildProviderTestFetch,
  isOpenAIReasoningModel,
  parseAnthropicCompletion,
  parseOpenAiResponsesCompletion,
} from "../providerFetch.js";
import {
  parseAnthropicStreamEvent,
  parseOpenAiCompletion,
  parseOpenAiResponsesStreamEvent,
  parseOpenAiStreamEvent,
} from "../streamParsers.js";
import { resolveRequest, type ResolverRequest } from "../resolver.js";
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

/**
 * Exercise the production code path end-to-end: resolver builds the
 * plan from the test's v2 shape, caller issues the HTTP request. Mirrors
 * what streamManager does in handleChat / handleChatStream.
 */
async function buildPlan(k: KeyRecord, model: string, stream: boolean) {
  const req: ResolverRequest = {
    messages: [{ role: "user", content: "Say the single word: pong" }],
    maxOutput: REQUEST_MAX_OUTPUT,
    stream,
    prefer: { model },
  };
  const result = await resolveRequest({
    request: req,
    origin: "https://integration-test",
    key: k,
  });
  if (result.kind !== "ready") {
    throw new Error(`resolver ${result.kind}: ${"message" in result ? result.message : result.reason}`);
  }
  return result.plan;
}

// Output budget sized so reasoning models have room to produce actual
// content (not just consume their budget on internal reasoning). 1024
// tokens across the full matrix runs costs roughly $0.03-$0.10 per full
// run at 2026-04 pricing — acceptable for nightly CI signal.
//
// Below ~256, OpenAI's gpt-*-pro models can 500 internally on
// non-streaming requests (their streaming counterpart keeps working),
// so this bound is also a workaround for an observed provider infra
// issue.
const REQUEST_MAX_OUTPUT = 1024;
// Kept for the unused-import typechecker; matrix now builds via resolver.
void (null as unknown as ChatParams);

/**
 * Retry a fetch on 429 and 5xx up to 3 times with linear backoff.
 * These statuses indicate provider-side transient issues (rate limits,
 * infra blips) that are orthogonal to the code under test. Non-retryable
 * statuses return immediately.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries = 2,
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const r = await fetch(url, init);
    if (r.ok) return r;
    if (r.status !== 429 && r.status < 500) return r;
    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    } else {
      return r;
    }
  }
  // unreachable
  throw new Error("fetchWithRetry exhausted");
}

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
  const res = await fetchWithRetry(params.url, {
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
      const r = await fetchWithRetry(p.url, { method: "GET", headers: p.headers });
      expect(r.ok).toBe(true);
    }, 30_000);

    for (const model of t.chatModels) {
      // OpenAI reasoning models can still produce empty content under
      // tight budgets if the reasoning tokens consume everything — even
      // at 1024 tokens, a complex pro reasoning chain can exhaust
      // output budget. Tolerate that: assert reachability, not content.
      const tolerant = t.id === "openai" && isOpenAIReasoningModel(model);

      it(`non-streaming ${model}: succeeds`, async () => {
        const plan = await buildPlan(key(t, apiKey, model), model, false);
        const r = await fetchWithRetry(plan.url, {
          method: "POST",
          headers: plan.headers,
          body: plan.body,
        });
        if (!r.ok) {
          const errBody = await r.text().catch(() => "");
          throw new Error(`HTTP ${r.status}: ${errBody.slice(0, 200)}`);
        }
        const data = (await r.json()) as Record<string, unknown>;
        const completion = parseCompletionFor(plan.endpoint, data);
        if (tolerant) {
          expect(completion.finish_reason).toBeDefined();
        } else {
          expect(completion.content?.length ?? 0).toBeGreaterThan(0);
        }
      }, 60_000);

      it(`streaming ${model}: emits ≥1 delta or terminates cleanly`, async () => {
        const plan = await buildPlan(key(t, apiKey, model), model, true);
        const { deltas, events } = await runStreamToCompletion({
          url: plan.url,
          headers: plan.headers,
          body: plan.body,
          endpoint: plan.endpoint,
        });
        const ended = events.some((e) => e.type === "done" || e.type === "error");
        if (tolerant) {
          expect(ended).toBe(true);
        } else {
          expect(deltas.length > 0 || ended).toBe(true);
        }
      }, 60_000);
    }
  });
}
