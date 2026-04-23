/**
 * Broker resolver — the core of the v1.0 architecture.
 *
 * Takes a developer's ChatParams (capability-declared, v2 shape) + the
 * key's KeyPolicy + the ModelCatalogue and produces either a concrete
 * ExecutionPlan (url, headers, body, cost estimate) or a consent-required /
 * reject outcome.
 *
 * This module is intentionally self-contained — no chrome.storage, no
 * Port, no fetch. Pure functions (except for the top-level `resolveRequest`
 * which is async for future extensibility). Phase 5 introduces the
 * ledger and consent caching; Phase 6 wires the resolver into
 * messageRouter and retires `providerFetch.ts`.
 *
 * Stages (in order):
 *   1. Privacy     — origin regex, HTTPS requirement, provider allowlist
 *   2. Model       — explicit prefer.model → catalogue → capability-match
 *   3. Capability  — the selected model must support everything the dev asked for
 *   4. Budget      — per-request cost ceiling, token ceiling
 *   5. Tokens      — clamp maxOutput to min(dev, policy, model.context.output)
 *   6. Reasoning   — clamp reasoning_effort to policy.maxReasoningEffort
 *   7. Sampling    — tone → temperature per model family
 *   8. Body build  — shape per catalogue endpoint
 *
 * At any stage, the resolver can short-circuit with `reject` or
 * `consent-required`. A successful run returns `ready` with a full
 * ExecutionPlan plus a ResolverTrace for audit logging.
 */

import type {
  ChatMessage,
  ContentPart,
  KeyPolicy,
  KeyRecord,
  ReasoningEffort,
  ResponseFormat,
  Tool,
  ToolChoice,
  Capability,
} from "../shared/protocol.js";
import {
  ALL_MODELS,
  type ModelSpec,
  estimateCost,
  findByCapabilities,
  getModel,
  matchesCapabilities,
} from "../shared/modelCatalog.js";

// ── Public types ───────────────────────────────────────

export type Tone = "precise" | "balanced" | "creative";

/**
 * v2 ChatParams — capability-first. Developers declare intent, broker
 * picks concrete model + parameters. Tier 3 (full control) is still
 * available via `prefer.*`.
 */
export interface ResolverRequest {
  messages: ChatMessage[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;
  stream?: boolean;
  /** Developer's capability requirements. Resolver rejects if no allowed model satisfies. */
  requires?: Capability[];
  /** Behavioral abstraction over temperature. "precise"=0.0, "balanced"=0.7, "creative"=1.0-1.2. */
  tone?: Tone;
  /** Developer's max output budget. Clamped by policy.budget.maxTokensPerRequest. */
  maxOutput?: number;
  /** Tier-3 explicit overrides. All optional. */
  prefer?: {
    model?: string;
    provider?: string;
    reasoningEffort?: ReasoningEffort;
    temperature?: number;
    topP?: number;
  };
}

export interface ResolverInput {
  request: ResolverRequest;
  origin: string;
  key: KeyRecord;
  /**
   * Override the catalogue-selected endpoint. Used by the 404 fallback
   * path in streamManager: when /chat/completions returns the pro-model
   * 404 signal, we retry once with `forceEndpoint: "responses"` and
   * rebuild the body in the Responses shape using the same model.
   */
  forceEndpoint?: "chat" | "responses";
}

export interface ExecutionPlan {
  model: ModelSpec;
  endpoint: "chat" | "responses" | "anthropic";
  url: string;
  headers: Record<string, string>;
  body: string;
  estimatedCostUSD: number;
  estimatedTokens: { input: number; output: number };
  trace: ResolverTrace;
}

export interface ResolverTrace {
  modelChosen: string;
  modelSelectionReason: "explicit" | "capability-match" | "default";
  endpointReason: "catalog-endpoint" | "fallback-chat";
  estimatedCostUSD: number;
  estimatedTokens: { input: number; output: number };
  clampedMaxOutput?: { requested: number; effective: number; limitSource: string };
  clampedReasoning?: { requested: ReasoningEffort; effective: ReasoningEffort };
  temperatureSource?: "tone" | "prefer" | "policy" | "model-constraint" | "omitted";
  temperatureValue?: number;
  policyVersion?: number;
}

export type RejectReason =
  | "no-model-matches-capabilities"
  | "model-denied-by-policy"
  | "model-outside-allowlist"
  | "capability-missing-from-model"
  | "unknown-model"
  | "budget-request-over-limit"
  | "origin-blocked"
  | "provider-blocked"
  | "https-required"
  | "capability-only-requires-developer-capabilities"
  | "capability-only-no-preferred-model";

export type ConsentReason =
  | "model-outside-allowlist"
  | "model-in-denylist"
  | "high-cost"
  | "capability-missing";

export interface ConsentContext {
  origin: string;
  keyId: string;
  model?: string;
  estimatedCostUSD?: number;
  capability?: Capability;
}

export type ResolverOutput =
  | { kind: "ready"; plan: ExecutionPlan }
  | { kind: "reject"; reason: RejectReason; message: string }
  | { kind: "consent-required"; reason: ConsentReason; context: ConsentContext };

// ── Tone → temperature mapping ─────────────────────────

/**
 * Map developer's `tone` hint to a concrete temperature, adjusted per
 * model family constraints. Reasoning models always override to
 * `constraints.temperatureMustBe` (typically 1).
 */
function resolveTemperature(
  model: ModelSpec,
  request: ResolverRequest,
  policy: KeyPolicy,
): { value: number | undefined; source: ResolverTrace["temperatureSource"] } {
  // Hard constraint wins absolutely.
  if (model.constraints?.temperatureMustBe !== undefined) {
    return {
      value: model.constraints.temperatureMustBe,
      source: "model-constraint",
    };
  }

  if (request.prefer?.temperature !== undefined) {
    return { value: request.prefer.temperature, source: "prefer" };
  }

  if (request.tone) {
    const map: Record<Tone, { default: number; anthropic: number }> = {
      precise: { default: 0.0, anthropic: 0.0 },
      balanced: { default: 0.7, anthropic: 0.7 },
      creative: { default: 1.2, anthropic: 1.0 },
    };
    const t =
      model.provider === "anthropic" ? map[request.tone].anthropic : map[request.tone].default;
    return { value: t, source: "tone" };
  }

  if (policy.sampling?.temperature !== undefined) {
    return { value: policy.sampling.temperature, source: "policy" };
  }

  return { value: undefined, source: "omitted" };
}

// ── Reasoning effort clamp ─────────────────────────────

const EFFORT_ORDER: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high"];

function effortRank(e: ReasoningEffort | undefined): number {
  return e ? EFFORT_ORDER.indexOf(e) : -1;
}

/**
 * Clamp requested reasoning_effort to the policy's max, using enum rank
 * as the ordering. If the policy caps at "medium" and the request asks
 * for "high", the effective value becomes "medium".
 */
function clampReasoningEffort(
  requested: ReasoningEffort | undefined,
  policyCap: ReasoningEffort | undefined,
): { effective: ReasoningEffort | undefined; clamped: boolean } {
  if (!requested) return { effective: undefined, clamped: false };
  if (!policyCap) return { effective: requested, clamped: false };
  if (effortRank(requested) <= effortRank(policyCap)) {
    return { effective: requested, clamped: false };
  }
  return { effective: policyCap, clamped: true };
}

// ── Token budget clamp ─────────────────────────────────

interface TokenClamp {
  effective: number;
  limitSource: string;
}

function clampMaxOutput(
  requested: number | undefined,
  policyCap: number | undefined,
  modelMax: number,
): TokenClamp {
  const candidates: Array<{ value: number; source: string }> = [
    { value: modelMax, source: "model.context.output" },
  ];
  if (policyCap !== undefined) candidates.push({ value: policyCap, source: "policy.maxTokensPerRequest" });
  if (requested !== undefined) candidates.push({ value: requested, source: "request.maxOutput" });

  // Pick the smallest (most restrictive).
  const winner = candidates.reduce((a, b) => (b.value < a.value ? b : a));
  return { effective: winner.value, limitSource: winner.source };
}

// ── Input token estimation ─────────────────────────────

function estimateInputTokens(messages: ChatMessage[], tools: Tool[] | undefined): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof (msg as { content?: unknown }).content === "string") {
      chars += (msg as { content: string }).content.length;
    } else if (Array.isArray((msg as { content?: unknown }).content)) {
      for (const part of (msg as { content: ContentPart[] }).content) {
        if (part.type === "text") chars += part.text.length;
        // Images/audio: rough approximation (not tokenised char-wise).
        else chars += 1000;
      }
    }
  }
  if (tools) {
    for (const t of tools) {
      chars += t.function.name.length;
      if (t.function.description) chars += t.function.description.length;
      if (t.function.parameters) chars += JSON.stringify(t.function.parameters).length;
    }
  }
  // Rough heuristic: ~4 chars per token (English average). Adequate for
  // pre-flight cost estimates; not a billing-grade tokeniser.
  return Math.ceil(chars / 4);
}

// ── Stage 1: Privacy ───────────────────────────────────

function privacyCheck(input: ResolverInput): ResolverOutput | null {
  const { origin, key } = input;
  const privacy = key.policy?.privacy;
  if (!privacy) return null; // No policy ⇒ no enforcement (Phase 3 back-compat)

  if (privacy.requireHttps) {
    const isHttps =
      key.baseUrl.startsWith("https://") ||
      key.baseUrl.startsWith("http://localhost") ||
      key.baseUrl.startsWith("http://127.0.0.1");
    if (!isHttps) {
      return {
        kind: "reject",
        reason: "https-required",
        message: `Key policy requires HTTPS for provider endpoints (baseUrl: ${key.baseUrl}).`,
      };
    }
  }

  if (privacy.allowedOriginsRegex) {
    try {
      const re = new RegExp(privacy.allowedOriginsRegex);
      if (!re.test(origin)) {
        return {
          kind: "reject",
          reason: "origin-blocked",
          message: `Origin "${origin}" is not permitted by this key's policy.`,
        };
      }
    } catch {
      // Invalid regex — fail closed so a malformed policy doesn't become
      // a silent allow-all.
      return {
        kind: "reject",
        reason: "origin-blocked",
        message: `Key policy has an invalid allowedOriginsRegex.`,
      };
    }
  }

  if (privacy.allowedProviders && !privacy.allowedProviders.includes(key.provider)) {
    return {
      kind: "reject",
      reason: "provider-blocked",
      message: `Key policy does not allow provider "${key.provider}".`,
    };
  }

  return null;
}

// ── Stage 2 + 3: Model selection + capability check ────

interface ModelSelection {
  model: ModelSpec;
  reason: ResolverTrace["modelSelectionReason"];
}

function selectModel(input: ResolverInput): ResolverOutput | ModelSelection {
  const { request, key } = input;
  const policy = key.policy;
  const requires = request.requires ?? [];

  // Derive implicit capability requirements from the request shape.
  const implicitCaps: Capability[] = [...requires];
  if (request.tools && request.tools.length > 0 && !implicitCaps.includes("tool_use")) {
    implicitCaps.push("tool_use");
  }
  if (request.responseFormat && request.responseFormat.type !== "text" && !implicitCaps.includes("structured_output")) {
    implicitCaps.push("structured_output");
  }
  if (request.stream && !implicitCaps.includes("streaming")) {
    implicitCaps.push("streaming");
  }

  // Tier-3: explicit `prefer.model` always wins if policy allows.
  if (request.prefer?.model) {
    const explicit = getModel(request.prefer.model);
    if (!explicit) {
      return {
        kind: "reject",
        reason: "unknown-model",
        message: `Model "${request.prefer.model}" is not in the catalog.`,
      };
    }
    const gate = gateModel(explicit, policy);
    if (gate) return gate;
    return { model: explicit, reason: "explicit" };
  }

  // Tier-2: capability-driven selection.
  if (implicitCaps.length > 0) {
    const providerFilter = request.prefer?.provider ? [request.prefer.provider] : undefined;
    const matches = findByCapabilities(implicitCaps, providerFilter).filter((m) => {
      // Also honor policy filters here.
      return !gateModel(m, policy);
    });
    if (matches.length === 0) {
      return {
        kind: "reject",
        reason: "no-model-matches-capabilities",
        message: `No allowed model satisfies all capabilities: ${implicitCaps.join(", ")}.`,
      };
    }
    // Prefer user's configured preferredPerCapability if any capability matches.
    const preferred = findPreferredPerCapability(implicitCaps, matches, policy);
    if (preferred) return { model: preferred, reason: "capability-match" };
    // Fallback: if the key's defaultModel meets the capabilities, use it.
    const keyDefault = getModel(key.defaultModel);
    if (keyDefault && matches.includes(keyDefault)) {
      return { model: keyDefault, reason: "default" };
    }
    // Pick the first match (catalog declaration order).
    return { model: matches[0], reason: "capability-match" };
  }

  // Tier-1: no capability hint. Use the key's default model.
  const def = getModel(key.defaultModel);
  if (!def) {
    return {
      kind: "reject",
      reason: "unknown-model",
      message: `Key's defaultModel "${key.defaultModel}" is not in the catalog.`,
    };
  }
  const gate = gateModel(def, policy);
  if (gate) return gate;
  return { model: def, reason: "default" };
}

/**
 * Apply modelPolicy allowlist/denylist checks. Returns a rejection or
 * consent-required outcome if the model isn't admissible; null if it is.
 */
function gateModel(model: ModelSpec, policy: KeyPolicy | undefined): ResolverOutput | null {
  const mp = policy?.modelPolicy;
  if (!mp) return null;

  if (mp.mode === "denylist" && mp.deniedModels?.includes(model.id)) {
    if (mp.onViolation === "confirm") {
      return {
        kind: "consent-required",
        reason: "model-in-denylist",
        context: { origin: "", keyId: "", model: model.id },
      };
    }
    return {
      kind: "reject",
      reason: "model-denied-by-policy",
      message: `Model "${model.id}" is on the key's denylist.`,
    };
  }

  if (mp.mode === "allowlist") {
    const allowed = mp.allowedModels ?? [];
    if (!allowed.includes(model.id)) {
      if (mp.onViolation === "confirm") {
        return {
          kind: "consent-required",
          reason: "model-outside-allowlist",
          context: { origin: "", keyId: "", model: model.id },
        };
      }
      return {
        kind: "reject",
        reason: "model-outside-allowlist",
        message: `Model "${model.id}" is not on the key's allowlist.`,
      };
    }
  }

  return null;
}

/**
 * Find the user's preferred model for any of the requested capabilities,
 * provided the preferred model is in the admissible `matches` set.
 */
function findPreferredPerCapability(
  caps: readonly Capability[],
  matches: readonly ModelSpec[],
  policy: KeyPolicy | undefined,
): ModelSpec | null {
  const pref = policy?.modelPolicy.preferredPerCapability;
  if (!pref) return null;
  for (const c of caps) {
    const preferredId = pref[c];
    if (!preferredId) continue;
    const hit = matches.find((m) => m.id === preferredId);
    if (hit) return hit;
  }
  return null;
}

// ── Stage 4: Budget check ──────────────────────────────

function budgetCheck(
  model: ModelSpec,
  estimatedCost: number,
  policy: KeyPolicy | undefined,
  origin: string,
  keyId: string,
): ResolverOutput | null {
  const limit = policy?.budget.maxCostPerRequestUSD;
  if (limit === undefined) return null;
  if (estimatedCost <= limit) return null;

  const onHit = policy?.budget.onBudgetHit ?? "warn";
  if (onHit === "block") {
    return {
      kind: "reject",
      reason: "budget-request-over-limit",
      message: `Estimated cost $${estimatedCost.toFixed(4)} exceeds per-request limit $${limit.toFixed(2)}.`,
    };
  }
  if (onHit === "confirm") {
    return {
      kind: "consent-required",
      reason: "high-cost",
      context: { origin, keyId, model: model.id, estimatedCostUSD: estimatedCost },
    };
  }
  // "warn" just passes through — Phase 5 ledger will surface the warning.
  return null;
}

// ── Stage 8: Body construction ─────────────────────────

interface BodyBuildInput {
  model: ModelSpec;
  request: ResolverRequest;
  key: KeyRecord;
  maxOutput: number;
  reasoningEffort: ReasoningEffort | undefined;
  temperature: number | undefined;
  topP: number | undefined;
}

function buildBody(
  input: BodyBuildInput,
  forceEndpoint?: "chat" | "responses",
): { url: string; headers: Record<string, string>; body: string } {
  const { model, key } = input;
  const base = key.baseUrl.replace(/\/+$/, "");
  const endpoint = forceEndpoint ?? model.endpoint;
  switch (endpoint) {
    case "chat":
      return buildChatBody(base, input);
    case "responses":
      return buildResponsesBody(base, input);
    case "anthropic":
      return buildAnthropicBody(base, input);
  }
}

function buildChatBody(base: string, b: BodyBuildInput) {
  const { model, request, key, maxOutput, reasoningEffort, temperature, topP } = b;
  const body: Record<string, unknown> = {
    model: model.id,
    messages: request.messages,
    stream: Boolean(request.stream),
  };
  // Reasoning family: max_completion_tokens only.
  if (model.capabilities.includes("reasoning") && model.constraints?.temperatureMustBe !== undefined) {
    body.max_completion_tokens = maxOutput;
  } else {
    body.max_tokens = maxOutput;
  }
  if (temperature !== undefined) body.temperature = temperature;
  if (topP !== undefined) body.top_p = topP;
  if (request.tools) body.tools = request.tools;
  if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
  if (request.responseFormat) body.response_format = request.responseFormat;
  if (reasoningEffort !== undefined) body.reasoning_effort = reasoningEffort;

  return {
    url: `${base}/chat/completions`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key.apiKey}`,
    },
    body: JSON.stringify(body),
  };
}

function buildResponsesBody(base: string, b: BodyBuildInput) {
  const { model, request, key, maxOutput, reasoningEffort, temperature, topP } = b;
  const input = convertMessagesToResponsesInput(request.messages);
  const body: Record<string, unknown> = {
    model: model.id,
    input,
    max_output_tokens: maxOutput,
    stream: Boolean(request.stream),
  };
  // Reasoning models reject temperature ≠ 1; only include if it IS 1 (or
  // a value the model explicitly requires).
  if (temperature === 1 || (model.constraints?.temperatureMustBe !== undefined && temperature === model.constraints.temperatureMustBe)) {
    body.temperature = temperature;
  }
  if (topP !== undefined) body.top_p = topP;
  if (reasoningEffort !== undefined) body.reasoning = { effort: reasoningEffort };
  if (request.tools) {
    body.tools = request.tools.map((t) => ({
      type: "function",
      name: t.function.name,
      ...(t.function.description && { description: t.function.description }),
      parameters: t.function.parameters ?? { type: "object" },
      ...(t.function.strict !== undefined && { strict: t.function.strict }),
    }));
  }
  if (request.toolChoice !== undefined) body.tool_choice = request.toolChoice;
  if (request.responseFormat) body.text = { format: request.responseFormat };

  return {
    url: `${base}/responses`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key.apiKey}`,
    },
    body: JSON.stringify(body),
  };
}

function convertMessagesToResponsesInput(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        result.push({
          role: "system",
          content: [{ type: "input_text", text: msg.content }],
        });
        break;
      case "user":
        if (typeof msg.content === "string") {
          result.push({
            role: "user",
            content: [{ type: "input_text", text: msg.content }],
          });
        } else {
          result.push({
            role: "user",
            content: msg.content.map((part) =>
              part.type === "text"
                ? { type: "input_text", text: part.text }
                : { type: "input_image", image_url: part.image_url.url },
            ),
          });
        }
        break;
      case "assistant":
        if (msg.content) {
          result.push({
            role: "assistant",
            content: [{ type: "output_text", text: msg.content }],
          });
        }
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            result.push({
              type: "function_call",
              call_id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
            });
          }
        }
        break;
      case "tool":
        result.push({
          type: "function_call_output",
          call_id: msg.tool_call_id,
          output: msg.content,
        });
        break;
    }
  }
  return result;
}

function buildAnthropicBody(base: string, b: BodyBuildInput) {
  const { model, request, key, maxOutput, reasoningEffort, temperature, topP } = b;
  const systemMessages = request.messages.filter(
    (m): m is Extract<ChatMessage, { role: "system" }> => m.role === "system",
  );
  const system =
    systemMessages.length > 0
      ? systemMessages.map((m) => ({ type: "text" as const, text: m.content }))
      : undefined;
  const messages = request.messages
    .filter((m) => m.role !== "system")
    .map(convertMessageToAnthropic);

  const body: Record<string, unknown> = {
    model: model.id,
    messages,
    max_tokens: maxOutput,
    stream: Boolean(request.stream),
  };
  if (system) body.system = system;
  if (temperature !== undefined) body.temperature = temperature;
  if (topP !== undefined) body.top_p = topP;
  if (request.tools) {
    body.tools = request.tools.map((t) => ({
      name: t.function.name,
      ...(t.function.description && { description: t.function.description }),
      input_schema: t.function.parameters ?? { type: "object" },
    }));
  }
  if (reasoningEffort) {
    const budget = REASONING_TO_THINKING_BUDGET[reasoningEffort];
    body.thinking = { type: "enabled", budget_tokens: budget };
  }

  return {
    url: `${base}/messages`,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  };
}

const REASONING_TO_THINKING_BUDGET: Record<ReasoningEffort, number> = {
  minimal: 1024,
  low: 4096,
  medium: 12000,
  high: 32000,
};

function convertMessageToAnthropic(msg: ChatMessage): Record<string, unknown> {
  switch (msg.role) {
    case "user": {
      if (typeof msg.content === "string") {
        return { role: "user", content: msg.content };
      }
      const content = msg.content.map((part) => {
        if (part.type === "text") return { type: "text", text: part.text };
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
      if (msg.content) content.push({ type: "text", text: msg.content });
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

// ── Top-level pipeline ─────────────────────────────────

export async function resolveRequest(input: ResolverInput): Promise<ResolverOutput> {
  const policy = input.key.policy;

  // Stage 1: privacy
  const privacy = privacyCheck(input);
  if (privacy) return privacy;

  // Stage 2+3: model selection + capability gate
  const selection = selectModel(input);
  if ("kind" in selection) return selection;
  const { model, reason: modelReason } = selection;

  // Capability sanity: the selected model must satisfy every declared/implicit cap.
  const implicitCaps: Capability[] = [...(input.request.requires ?? [])];
  if (input.request.tools?.length && !implicitCaps.includes("tool_use")) implicitCaps.push("tool_use");
  if (input.request.responseFormat && input.request.responseFormat.type !== "text" && !implicitCaps.includes("structured_output")) {
    implicitCaps.push("structured_output");
  }
  if (!matchesCapabilities(model, implicitCaps)) {
    return {
      kind: "reject",
      reason: "capability-missing-from-model",
      message: `Model "${model.id}" lacks required capabilities: ${implicitCaps.filter((c) => !model.capabilities.includes(c)).join(", ")}.`,
    };
  }

  // Stage 5: token clamp
  const tokenClamp = clampMaxOutput(
    input.request.maxOutput,
    policy?.budget.maxTokensPerRequest,
    model.context.output,
  );

  // Stage 6: reasoning clamp
  const reasoningClamp = clampReasoningEffort(
    input.request.prefer?.reasoningEffort,
    policy?.budget.maxReasoningEffort,
  );

  // Stage 7: sampling resolution (temperature + topP)
  const temp = policy ? resolveTemperature(model, input.request, policy) : { value: undefined, source: "omitted" as const };
  const topP = input.request.prefer?.topP ?? policy?.sampling?.topP;

  // Stage 4: budget — needs estimated tokens first.
  const inputTokens = estimateInputTokens(input.request.messages, input.request.tools);
  const estimatedTokens = { input: inputTokens, output: tokenClamp.effective };
  const estimatedCost = estimateCost(
    model,
    inputTokens,
    tokenClamp.effective,
    reasoningClamp.effective ? Math.floor(tokenClamp.effective / 2) : 0,
  );
  const budget = budgetCheck(model, estimatedCost, policy, input.origin, input.key.keyId);
  if (budget) return budget;

  // Stage 8: body
  const built = buildBody(
    {
      model,
      request: input.request,
      key: input.key,
      maxOutput: tokenClamp.effective,
      reasoningEffort: reasoningClamp.effective,
      temperature: temp.value,
      topP,
    },
    input.forceEndpoint,
  );
  const effectiveEndpoint: "chat" | "responses" | "anthropic" =
    input.forceEndpoint ?? model.endpoint;

  const trace: ResolverTrace = {
    modelChosen: model.id,
    modelSelectionReason: modelReason,
    endpointReason: "catalog-endpoint",
    estimatedCostUSD: estimatedCost,
    estimatedTokens,
    ...(tokenClamp.effective !== (input.request.maxOutput ?? Infinity)
      ? {
          clampedMaxOutput: {
            requested: input.request.maxOutput ?? Infinity,
            effective: tokenClamp.effective,
            limitSource: tokenClamp.limitSource,
          },
        }
      : {}),
    ...(reasoningClamp.clamped && input.request.prefer?.reasoningEffort
      ? {
          clampedReasoning: {
            requested: input.request.prefer.reasoningEffort,
            effective: reasoningClamp.effective as ReasoningEffort,
          },
        }
      : {}),
    temperatureSource: temp.source,
    ...(temp.value !== undefined ? { temperatureValue: temp.value } : {}),
    ...(input.key.policyVersion !== undefined ? { policyVersion: input.key.policyVersion } : {}),
  };

  return {
    kind: "ready",
    plan: {
      model,
      endpoint: effectiveEndpoint,
      url: built.url,
      headers: built.headers,
      body: built.body,
      estimatedCostUSD: estimatedCost,
      estimatedTokens,
      trace,
    },
  };
}

// ── Exports for tests ──────────────────────────────────

export const __test = {
  resolveTemperature,
  clampReasoningEffort,
  clampMaxOutput,
  estimateInputTokens,
  privacyCheck,
  selectModel,
  gateModel,
  findPreferredPerCapability,
  budgetCheck,
  buildBody,
};

// Unused export to keep ALL_MODELS lintable as used elsewhere.
void ALL_MODELS;
