/**
 * Keyquill SDK v2 — capability-first API.
 *
 * The SDK sends intent; the extension's broker picks a concrete model
 * based on the user's KeyPolicy, enforces budget, and writes every
 * request to an audit ledger. Developers don't pick models directly
 * unless they opt into Tier 3 via `prefer.model`.
 *
 * Three ergonomic tiers:
 *
 *   Tier 1  zero-config           — extension uses the key's defaultModel
 *     quill.chat({ messages })
 *
 *   Tier 2  capability-declared    — broker resolves best-fit model
 *     quill.chat({
 *       messages, tools,
 *       requires: ["tool_use", "long_context"],
 *       tone: "precise",
 *       maxOutput: 2048,
 *     })
 *
 *   Tier 3  full control           — explicit model / temperature etc.
 *     quill.chat({
 *       messages,
 *       prefer: { model: "gpt-5.4-pro", temperature: 1, reasoningEffort: "high" },
 *     })
 *
 * v1 (snake_case top-level `model`/`temperature`/`max_tokens`) is gone —
 * use `prefer.*` instead. v1 users can pin `keyquill@0.3.x` indefinitely.
 */

// ── OpenAI-Compatible Message Types ────────────────────

export interface TextContentPart {
  type: "text";
  text: string;
}

export interface ImageContentPart {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
}

export type ContentPart = TextContentPart | ImageContentPart;

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content?: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

// ── Tool & Response Format ─────────────────────────────

export type JsonSchema = Record<string, unknown>;

export interface FunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: JsonSchema;
    strict?: boolean;
  };
}

export type Tool = FunctionTool;

export type ToolChoice =
  | "none"
  | "auto"
  | "required"
  | { type: "function"; function: { name: string } };

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: { name: string; schema: JsonSchema; strict?: boolean } };

// ── Broker vocabulary ─────────────────────────────────

/**
 * Capabilities the app can require. The extension's broker picks a
 * model that satisfies the set, subject to the user's KeyPolicy.
 */
export type Capability =
  | "tool_use"
  | "structured_output"
  | "vision"
  | "audio"
  | "reasoning"
  | "long_context"
  | "streaming"
  | "cache"
  | "fast"
  | "cheap"
  | "multilingual"
  | "code";

export type Tone = "precise" | "balanced" | "creative";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

// ── Key Info ──────────────────────────────────────────

export interface KeyPolicySummary {
  // Thin public view of the broker policy — deliberately does NOT expose
  // rule details to untrusted web pages. Listed here so `KeySummary` can
  // advertise what a site is allowed to do.
  modelMode: "open" | "allowlist" | "denylist" | "capability-only";
  hasBudget: boolean;
}

/**
 * Safe projection of a stored key. `apiKey` is never exposed.
 */
export interface KeySummary {
  keyId: string;
  provider: string;
  label: string;
  baseUrl: string;
  /**
   * Model the resolver would pick for a zero-config request against this
   * key. Resolved via the key's policy pin → provider preset → cheapest
   * catalog entry. Undefined when the catalog has no match.
   */
  effectiveDefaultModel?: string;
  policy?: KeyPolicySummary;
  keyHint: string | null;
  status: "active" | "error";
  createdAt: number;
  updatedAt: number;
}

// ── Request Parameters (v2, capability-first) ─────────

export interface ChatParams {
  messages: ChatMessage[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;

  /** Capabilities this request requires. Broker rejects if no allowed model satisfies. */
  requires?: Capability[];
  /** Behavioural abstraction over temperature. Broker maps per model family. */
  tone?: Tone;
  /** Output budget ceiling. Clamped by the key's policy.budget.maxTokensPerRequest. */
  maxOutput?: number;
  /** Tier-3 overrides — all optional. */
  prefer?: {
    model?: string;
    provider?: string;
    reasoningEffort?: ReasoningEffort;
    temperature?: number;
    topP?: number;
  };

  /** Explicit key selection, overrides all other resolution. */
  keyId?: string;
}

export type ChatStreamParams = ChatParams;

// ── Wire Requests ─────────────────────────────────────

export interface ChatRequest extends ChatParams {
  type: "chat";
}

export interface ChatStreamRequest extends ChatParams {
  type: "chatStream";
}

export interface PreviewPlanRequest extends ChatParams {
  type: "previewPlan";
}

export type KeyquillRequest =
  | { type: "ping" }
  | { type: "connect" }
  | { type: "disconnect" }
  | { type: "listKeys" }
  | { type: "testKey"; keyId: string }
  | ChatRequest
  | PreviewPlanRequest;

// ── Response Messages ─────────────────────────────────

export interface ChatCompletion {
  content: string | null;
  tool_calls?: ToolCall[];
  finish_reason: "stop" | "tool_calls" | "length" | "content_filter";
  usage?: { promptTokens: number; completionTokens: number };
}

export type KeyquillResponse =
  | { type: "pong"; version: string; protocol: number; connected?: boolean }
  | { type: "connected"; origin: string }
  | { type: "keys"; keys: KeySummary[] }
  | { type: "ok" }
  | { type: "testResult"; reachable: boolean; status?: number; detail?: string }
  | { type: "chatCompletion"; completion: ChatCompletion; keyId: string }
  | { type: "planPreview"; preview: PlanPreview }
  | { type: "error"; code: string; message: string };

// ── Plan preview (dry-run resolver) ───────────────────

export type ConsentReason =
  | "model-outside-allowlist"
  | "model-in-denylist"
  | "high-cost"
  | "capability-missing";

/**
 * Subset of the internal ModelSpec that's safe to surface to a web page.
 * Omits endpoint / pricing / constraints — those are broker-internal.
 */
export interface PlanPreviewModel {
  id: string;
  displayName: string;
  capabilities: readonly Capability[];
  releaseStage: "stable" | "preview" | "deprecated";
}

/**
 * Outcome of `quill.preview(params)` — a dry-run of the resolver that
 * does NOT issue a provider fetch or open a consent popup.
 *
 * - `ready`            — the request would execute
 * - `consent-required` — would trigger a user confirmation popup
 * - `rejected`         — would be blocked by policy or budget
 */
export type PlanPreview =
  | {
      kind: "ready";
      keyId: string;
      provider: string;
      model: PlanPreviewModel;
      estimatedCostUSD: number;
      estimatedTokens: { input: number; output: number };
      selectionReason:
        | "default"
        | "explicit"
        | "capability-match"
        | "preferred-per-capability";
    }
  | {
      kind: "consent-required";
      reason: ConsentReason;
      message: string;
      proposedModel?: PlanPreviewModel;
    }
  | {
      kind: "rejected";
      reason: string;
      message: string;
    };

// ── Stream Events ─────────────────────────────────────

export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
}

export type StreamEvent =
  /** First event in every stream. Tells the caller which key is servicing it. */
  | { type: "start"; keyId: string; provider: string; label: string }
  | { type: "delta"; text: string }
  | { type: "tool_call_delta"; tool_calls: ToolCallDelta[] }
  | {
      type: "done";
      finish_reason?: "stop" | "tool_calls" | "length" | "content_filter";
      usage?: { promptTokens: number; completionTokens: number };
    }
  | { type: "error"; code: string; message: string };

// ── Error Codes ──────────────────────────────────────

export const ErrorCode = {
  EXTENSION_NOT_FOUND: "EXTENSION_NOT_FOUND",
  PROTOCOL_MISMATCH: "PROTOCOL_MISMATCH",
  NOT_CONNECTED: "NOT_CONNECTED",
  USER_DENIED: "USER_DENIED",
  KEY_NOT_FOUND: "KEY_NOT_FOUND",
  PROVIDER_UNREACHABLE: "PROVIDER_UNREACHABLE",
  PROVIDER_ERROR: "PROVIDER_ERROR",
  INVALID_REQUEST: "INVALID_REQUEST",
  TIMEOUT: "TIMEOUT",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * SDK's expected wire-protocol version. Bumped on every breaking schema
 * change. v2 SDK speaks to extensions that expose v3 or higher — v2
 * introduced KeyPolicy, v3 is the current stable wire.
 */
export const SDK_PROTOCOL_VERSION = 3;
