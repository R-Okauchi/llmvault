/**
 * Chat / chatStream handlers (v1.0 broker).
 *
 * The request flow changes in Phase 6:
 *   legacy:   ChatParams → buildProviderFetch → fetch → parse
 *   broker:   ChatParams → toResolverRequest → resolveRequest
 *             → fetch(plan) → parse → append LedgerEntry
 *
 * The extension still accepts the v1 wire protocol (ChatRequestMessage).
 * Internally it's translated to the resolver's ResolverRequest shape and
 * brokered through the same pipeline the v2 SDK will use when it ships
 * (Phase 10).
 */

import type {
  ChatStreamRequest,
  ChatRequestMessage,
  ChatCompletion,
  OutgoingResponse,
  StreamEvent,
  KeyRecord,
  ChatParams,
} from "../shared/protocol.js";
import { getKey, getActiveKey } from "./keyStore.js";
import { getBinding, touchBindingUsage } from "./bindingStore.js";
import {
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
import type { ResolverInput, ResolverRequest, ExecutionPlan } from "./resolver.js";
import { resolveRequest } from "./resolver.js";
import { appendEntry } from "./ledger.js";
import { requestRequestConsent, type RequestConsentContext } from "./consent.js";
import { hasValidApproval, recordApproval } from "./consentCache.js";

// ── Key resolution ─────────────────────────────────────

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
        touchBindingUsage(origin).catch(() => {});
        return keyRecord;
      }
    }
  }
  return await getActiveKey();
}

// ── v1 ChatParams → ResolverRequest translator ─────────

/**
 * Translate wire-level ChatParams (either v1 or v2 shape) into the
 * resolver's ResolverRequest. Prefers v2 fields when present, falls
 * back to translating v1 snake_case fields otherwise. This lets us
 * accept both SDK v1 (frozen at @keyquill@0.3.x) and SDK v2 (@keyquill@2)
 * clients simultaneously.
 */
function toResolverRequest(
  params: ChatParams & { maxTokens?: number },
  stream: boolean,
): ResolverRequest {
  const req: ResolverRequest = {
    messages: params.messages,
    stream,
  };

  // v2 tools / toolChoice / responseFormat pass-through; fall back to v1
  // equivalents if the client is still on the old SDK.
  if (params.tools) req.tools = params.tools;
  const toolChoice = params.toolChoice ?? params.tool_choice;
  if (toolChoice !== undefined) req.toolChoice = toolChoice;
  const responseFormat = params.responseFormat ?? params.response_format;
  if (responseFormat) req.responseFormat = responseFormat;

  // v2 requires / tone / maxOutput pass-through.
  if (params.requires) req.requires = params.requires;
  if (params.tone) req.tone = params.tone;

  // v2 prefer (direct) > synthesized from v1 fields
  const prefer: NonNullable<ResolverRequest["prefer"]> = { ...(params.prefer ?? {}) };
  if (!prefer.model && params.model) prefer.model = params.model;
  if (prefer.temperature === undefined && params.temperature !== undefined) {
    prefer.temperature = params.temperature;
  }
  if (prefer.topP === undefined && params.top_p !== undefined) prefer.topP = params.top_p;
  if (!prefer.reasoningEffort && params.reasoning_effort) {
    prefer.reasoningEffort = params.reasoning_effort;
  }
  if (!prefer.provider && params.provider) prefer.provider = params.provider;
  if (Object.keys(prefer).length > 0) req.prefer = prefer;

  // v2 maxOutput > v1 max_completion_tokens > v1 max_tokens > v1 maxTokens alias
  const maxOutput =
    params.maxOutput ?? params.max_completion_tokens ?? params.max_tokens ?? params.maxTokens;
  if (maxOutput !== undefined) req.maxOutput = maxOutput;

  return req;
}

// ── Ledger helpers ─────────────────────────────────────

function makeLedgerTemplate(
  plan: ExecutionPlan,
  key: KeyRecord,
  origin: string,
): { base: Pick<Parameters<typeof appendEntry>[0], "timestamp" | "keyId" | "origin" | "model" | "endpoint" | "inputTokens" | "outputTokens" | "estimatedCostUSD" | "trace"> } {
  return {
    base: {
      timestamp: Date.now(),
      keyId: key.keyId,
      origin: origin === "__internal__" ? "extension:popup" : origin,
      model: plan.model.id,
      endpoint: plan.endpoint,
      inputTokens: plan.estimatedTokens.input,
      outputTokens: plan.estimatedTokens.output,
      estimatedCostUSD: plan.estimatedCostUSD,
      trace: plan.trace,
    },
  };
}

async function recordLedger(opts: {
  plan: ExecutionPlan;
  key: KeyRecord;
  origin: string;
  status: "success" | "error" | "cancelled";
  errorCode?: string;
  actualInputTokens?: number;
  actualOutputTokens?: number;
  reasoningTokens?: number;
  actualCostUSD?: number;
}): Promise<void> {
  try {
    const { base } = makeLedgerTemplate(opts.plan, opts.key, opts.origin);
    await appendEntry({
      ...base,
      ...(opts.actualInputTokens !== undefined ? { inputTokens: opts.actualInputTokens } : {}),
      ...(opts.actualOutputTokens !== undefined ? { outputTokens: opts.actualOutputTokens } : {}),
      ...(opts.reasoningTokens !== undefined ? { reasoningTokens: opts.reasoningTokens } : {}),
      estimatedCostUSD: base.estimatedCostUSD,
      actualCostUSD: opts.actualCostUSD ?? opts.plan.estimatedCostUSD,
      status: opts.status,
      ...(opts.errorCode ? { errorCode: opts.errorCode } : {}),
    });
  } catch {
    // Ledger failures must never break a chat flow.
  }
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
      message: "No Keyquill key available. Open the extension popup to add one.",
    });
    return;
  }

  sendEvent(port, {
    type: "start",
    keyId: keyRecord.keyId,
    provider: keyRecord.provider,
    label: keyRecord.label,
  });

  const originStr = origin ?? "__unknown__";
  let plan = await runResolver(request, originStr, keyRecord, true, undefined);
  if (!plan.kind) return handleNonReadyForStream(port, plan, keyRecord, originStr, request);
  let executionPlan = plan.plan;

  let response: Response;
  try {
    response = await fetch(executionPlan.url, {
      method: "POST",
      headers: executionPlan.headers,
      body: executionPlan.body,
    });
  } catch (err) {
    sendEvent(port, {
      type: "error",
      code: "PROVIDER_UNREACHABLE",
      message: `Could not reach provider: ${err instanceof Error ? err.message : "unknown"}`,
    });
    await recordLedger({ plan: executionPlan, key: keyRecord, origin: originStr, status: "error", errorCode: "PROVIDER_UNREACHABLE" });
    return;
  }

  // 404 fallback: uncatalogued pro-style model → retry on /responses.
  if (
    !response.ok &&
    keyRecord.provider === "openai" &&
    executionPlan.endpoint === "chat"
  ) {
    const errBody = await response.text().catch(() => "");
    if (isResponsesFallbackSignal(response.status, errBody)) {
      console.warn(
        `[keyquill] model "${executionPlan.model.id}" rejected at /chat/completions; retrying on /responses. Add to modelCatalog.ts with endpoint: "responses" to avoid this roundtrip.`,
      );
      plan = await runResolver(request, originStr, keyRecord, true, "responses");
      if (!plan.kind) return handleNonReadyForStream(port, plan, keyRecord, originStr, request);
      executionPlan = plan.plan;
      try {
        response = await fetch(executionPlan.url, {
          method: "POST",
          headers: executionPlan.headers,
          body: executionPlan.body,
        });
      } catch (err) {
        sendEvent(port, {
          type: "error",
          code: "PROVIDER_UNREACHABLE",
          message: `Could not reach provider: ${err instanceof Error ? err.message : "unknown"}`,
        });
        await recordLedger({ plan: executionPlan, key: keyRecord, origin: originStr, status: "error", errorCode: "PROVIDER_UNREACHABLE" });
        return;
      }
    } else {
      sendEvent(port, {
        type: "error",
        code: "PROVIDER_ERROR",
        message: `Provider returned ${response.status}: ${sanitizeErrorText(errBody.slice(0, 500))}`,
      });
      await recordLedger({ plan: executionPlan, key: keyRecord, origin: originStr, status: "error", errorCode: `HTTP_${response.status}` });
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
    await recordLedger({ plan: executionPlan, key: keyRecord, origin: originStr, status: "error", errorCode: `HTTP_${response.status}` });
    return;
  }

  if (!response.body) {
    sendEvent(port, { type: "error", code: "PROVIDER_ERROR", message: "Empty response body from provider." });
    await recordLedger({ plan: executionPlan, key: keyRecord, origin: originStr, status: "error", errorCode: "EMPTY_BODY" });
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const endpoint = executionPlan.endpoint;
  let sawTerminalEvent = false;
  let reasoningTokens: number | undefined;
  let actualInputTokens: number | undefined;
  let actualOutputTokens: number | undefined;

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
            captureUsage(data, (u) => {
              actualInputTokens = u.input_tokens ?? actualInputTokens;
              actualOutputTokens = u.output_tokens ?? actualOutputTokens;
              reasoningTokens = u.reasoning_tokens ?? reasoningTokens;
            });
          } else {
            if (parseOpenAiStreamEvent(port, data)) sawTerminalEvent = true;
            captureUsage(data, (u) => {
              actualInputTokens = u.prompt_tokens ?? actualInputTokens;
              actualOutputTokens = u.completion_tokens ?? actualOutputTokens;
            });
          }
        } catch {
          // skip malformed JSON lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!sawTerminalEvent) sendEvent(port, { type: "done" });

  const actualCost = actualInputTokens !== undefined && actualOutputTokens !== undefined
    ? estimateActualCost(executionPlan, actualInputTokens, actualOutputTokens, reasoningTokens)
    : undefined;
  await recordLedger({
    plan: executionPlan,
    key: keyRecord,
    origin: originStr,
    status: "success",
    actualInputTokens,
    actualOutputTokens,
    reasoningTokens,
    actualCostUSD: actualCost,
  });
}

function captureUsage(
  data: Record<string, unknown>,
  setter: (u: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number; reasoning_tokens?: number }) => void,
): void {
  const topUsage = data.usage as Record<string, number> | undefined;
  const respUsage = (data.response as Record<string, unknown> | undefined)?.usage as Record<string, number> | undefined;
  const u = topUsage ?? respUsage;
  if (u) setter(u);
}

// ── Non-streaming ──────────────────────────────────────

export async function handleChat(
  request: ChatRequestMessage,
  origin: string | null,
): Promise<OutgoingResponse> {
  const keyRecord = await resolveKey(request, origin);
  if (!keyRecord) {
    return { type: "error", code: "KEY_NOT_FOUND", message: "No Keyquill key available." };
  }
  const originStr = origin ?? "__unknown__";

  let plan = await runResolver(request, originStr, keyRecord, false, undefined);
  if (!plan.kind) return nonReadyToResponse(plan);
  let executionPlan = plan.plan;

  let response: Response;
  try {
    response = await fetch(executionPlan.url, {
      method: "POST",
      headers: executionPlan.headers,
      body: executionPlan.body,
    });
  } catch (err) {
    await recordLedger({ plan: executionPlan, key: keyRecord, origin: originStr, status: "error", errorCode: "PROVIDER_UNREACHABLE" });
    return {
      type: "error",
      code: "PROVIDER_UNREACHABLE",
      message: `Could not reach provider: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }

  // 404 fallback (same rules as streaming path).
  if (!response.ok && keyRecord.provider === "openai" && executionPlan.endpoint === "chat") {
    const errBody = await response.text().catch(() => "");
    if (isResponsesFallbackSignal(response.status, errBody)) {
      console.warn(
        `[keyquill] model "${executionPlan.model.id}" rejected at /chat/completions; retrying on /responses.`,
      );
      plan = await runResolver(request, originStr, keyRecord, false, "responses");
      if (!plan.kind) return nonReadyToResponse(plan);
      executionPlan = plan.plan;
      try {
        response = await fetch(executionPlan.url, {
          method: "POST",
          headers: executionPlan.headers,
          body: executionPlan.body,
        });
      } catch (err) {
        await recordLedger({ plan: executionPlan, key: keyRecord, origin: originStr, status: "error", errorCode: "PROVIDER_UNREACHABLE" });
        return {
          type: "error",
          code: "PROVIDER_UNREACHABLE",
          message: `Could not reach provider: ${err instanceof Error ? err.message : "unknown"}`,
        };
      }
    } else {
      await recordLedger({ plan: executionPlan, key: keyRecord, origin: originStr, status: "error", errorCode: `HTTP_${response.status}` });
      return {
        type: "error",
        code: "PROVIDER_ERROR",
        message: `Provider returned ${response.status}: ${sanitizeErrorText(errBody.slice(0, 500))}`,
      };
    }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "unknown");
    await recordLedger({ plan: executionPlan, key: keyRecord, origin: originStr, status: "error", errorCode: `HTTP_${response.status}` });
    return {
      type: "error",
      code: "PROVIDER_ERROR",
      message: `Provider returned ${response.status}: ${sanitizeErrorText(text.slice(0, 500))}`,
    };
  }

  const data = (await response.json()) as Record<string, unknown>;

  let completion: ChatCompletion;
  switch (executionPlan.endpoint) {
    case "anthropic":
      completion = parseAnthropicCompletion(data) as ChatCompletion;
      break;
    case "responses":
      completion = parseOpenAiResponsesCompletion(data) as ChatCompletion;
      break;
    default:
      completion = parseOpenAiCompletion(data);
  }

  // Capture actual usage for ledger.
  const rawUsage = (data.usage ?? (data.response as Record<string, unknown> | undefined)?.usage) as
    | Record<string, number>
    | undefined;
  const actualInputTokens = rawUsage?.input_tokens ?? rawUsage?.prompt_tokens;
  const actualOutputTokens = rawUsage?.output_tokens ?? rawUsage?.completion_tokens;
  const reasoningTokens = rawUsage?.reasoning_tokens;
  const actualCost =
    actualInputTokens !== undefined && actualOutputTokens !== undefined
      ? estimateActualCost(executionPlan, actualInputTokens, actualOutputTokens, reasoningTokens)
      : undefined;

  await recordLedger({
    plan: executionPlan,
    key: keyRecord,
    origin: originStr,
    status: "success",
    actualInputTokens,
    actualOutputTokens,
    reasoningTokens,
    actualCostUSD: actualCost,
  });

  return { type: "chatCompletion", completion, keyId: keyRecord.keyId };
}

// ── Helpers ────────────────────────────────────────────

type ResolverResolved =
  | { kind: true; plan: ExecutionPlan }
  | { kind: false; error: OutgoingResponse; reason: "reject" | "consent-required" };

async function runResolver(
  request: ChatParams & { maxTokens?: number },
  origin: string,
  key: KeyRecord,
  stream: boolean,
  forceEndpoint?: "chat" | "responses",
  consentGranted?: { modelGate?: boolean; costGate?: boolean },
): Promise<ResolverResolved> {
  const resolverInput: ResolverInput = {
    request: toResolverRequest(request, stream),
    origin,
    key,
    ...(forceEndpoint ? { forceEndpoint } : {}),
    ...(consentGranted ? { consentGranted } : {}),
  };
  const result = await resolveRequest(resolverInput);
  if (result.kind === "ready") return { kind: true, plan: result.plan };
  if (result.kind === "reject") {
    return {
      kind: false,
      reason: "reject",
      error: {
        type: "error",
        code: `POLICY_${result.reason.toUpperCase().replace(/-/g, "_")}`,
        message: result.message,
      },
    };
  }

  // consent-required: ask the user via popup, then retry with the
  // matching bypass. If the user clicked "always" in the popup, the
  // key's policy was already updated by consent.ts — a naked retry
  // (no bypass) will pass the gate.
  const context: RequestConsentContext = {
    origin: result.context.origin || origin,
    keyId: result.context.keyId || key.keyId,
    model: result.context.model ?? "",
    reason: mapReason(result.reason),
    ...(result.context.estimatedCostUSD !== undefined
      ? { estimatedCostUSD: result.context.estimatedCostUSD }
      : {}),
    ...(result.context.capability ? { capability: result.context.capability } : {}),
  };

  // Cache fast-path: identical request was just approved "once".
  if (hasValidApproval(context)) {
    return runResolver(request, origin, key, stream, forceEndpoint, bypassFor(result.reason));
  }

  const decision = await requestRequestConsent(context);
  if (!decision.approved) {
    return {
      kind: false,
      reason: "reject",
      error: {
        type: "error",
        code: `POLICY_${result.reason.toUpperCase().replace(/-/g, "_")}_REJECTED`,
        message: `User rejected the request (${result.reason}).`,
      },
    };
  }

  if (decision.scope === "once") {
    recordApproval(context);
  } else {
    // "always" updates the key's policy. Reload the key so the retry
    // sees the new allowlist/denylist. Bypass is still set in case the
    // updated policy needs another consent round (e.g., separate
    // violations on the same request); the resolver skips only the gate
    // that the user just approved.
    const reloaded = (await (await import("./keyStore.js")).getKey(key.keyId)) ?? key;
    key = reloaded;
  }

  return runResolver(request, origin, key, stream, forceEndpoint, bypassFor(result.reason));
}

function mapReason(
  r: "model-outside-allowlist" | "model-in-denylist" | "high-cost" | "capability-missing",
): RequestConsentContext["reason"] {
  return r;
}

function bypassFor(
  r: "model-outside-allowlist" | "model-in-denylist" | "high-cost" | "capability-missing",
): { modelGate?: boolean; costGate?: boolean } {
  switch (r) {
    case "model-outside-allowlist":
    case "model-in-denylist":
      return { modelGate: true };
    case "high-cost":
      return { costGate: true };
    case "capability-missing":
      // Capability gaps can't be bypassed — the model genuinely lacks
      // the capability. Consent for this reason is informational.
      return {};
  }
}

function nonReadyToResponse(r: ResolverResolved): OutgoingResponse {
  // r.kind is `false` here — TS narrows via the discriminant.
  return r.kind === false ? r.error : { type: "error", code: "INTERNAL", message: "unreachable" };
}

function handleNonReadyForStream(
  port: chrome.runtime.Port,
  r: ResolverResolved,
  key: KeyRecord,
  origin: string,
  _request: ChatStreamRequest,
): void {
  if (r.kind === true) return;
  const err = r.error as Extract<OutgoingResponse, { type: "error" }>;
  sendEvent(port, { type: "error", code: err.code, message: err.message });
  // Ledger: no execution plan yet, so synthesize a minimal entry.
  appendEntry({
    timestamp: Date.now(),
    keyId: key.keyId,
    origin: origin === "__internal__" ? "extension:popup" : origin,
    model: "unknown",
    endpoint: "chat",
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUSD: 0,
    actualCostUSD: 0,
    status: "error",
    errorCode: err.code,
  }).catch(() => {});
}

function estimateActualCost(
  plan: ExecutionPlan,
  input: number,
  output: number,
  reasoning?: number,
): number {
  const pricing = plan.model.pricing;
  const inputCost = (input / 1_000_000) * pricing.inputPer1M;
  const outputCost = (output / 1_000_000) * pricing.outputPer1M;
  const reasoningRate = pricing.reasoningPer1M ?? pricing.outputPer1M;
  const reasoningCost = ((reasoning ?? 0) / 1_000_000) * reasoningRate;
  return inputCost + outputCost + reasoningCost;
}

function sendEvent(port: chrome.runtime.Port, event: StreamEvent): void {
  try {
    port.postMessage(event);
  } catch {
    // Port disconnected — ignore
  }
}
