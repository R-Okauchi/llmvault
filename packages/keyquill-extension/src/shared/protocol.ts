/**
 * Message protocol shared between background service worker and popup.
 * These types mirror keyquill SDK types for external messaging.
 *
 * Wire protocol follows OpenAI Chat Completions format.
 */

// Re-export the catalog's Capability enum so protocol consumers (SDK v2,
// popup, resolver) have a single import source.
export type { Capability } from "./modelCatalog.js";
import type { Capability } from "./modelCatalog.js";

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

// ── Protocol version ───────────────────────────────────

/**
 * Bumped every time the wire protocol changes in a breaking way.
 * v1: provider-keyed single-key storage (legacy; `ProviderRecord` based)
 * v2: keyId-keyed multi-key storage with per-provider defaults
 * v3: active-key model — one wallet-global active key replaces per-provider
 *     defaults (mirrors MetaMask account switching)
 */
export const PROTOCOL_VERSION = 3;

// ── Key Record ─────────────────────────────────────────

/**
 * Canonical key entry. Multiple KeyRecords may share the same `provider`.
 * `keyId` is the stable identifier used by SDK and bindings to reference
 * a specific credential.
 */

/**
 * @deprecated since policyVersion 1. Use KeyPolicy.sampling +
 * KeyPolicy.budget.maxReasoningEffort. Kept on the record for migration
 * back-compat; the broker resolver reads from `policy` starting Phase 6.
 */
export interface KeyDefaults {
  /** Sampling temperature 0.0 - 2.0. Omit to let the provider pick. */
  temperature?: number;
  /** Nucleus sampling 0.0 - 1.0. */
  topP?: number;
  /** Reasoning model effort level. Translated per-provider at fetch time. */
  reasoningEffort?: ReasoningEffort;
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

// ── Key Policy (v1.0 broker) ───────────────────────────

/**
 * A key's policy — the set of rules the broker enforces when this key
 * services a request. Policy is user-owned: developers declare intent via
 * ChatParams, the broker clamps / routes / confirms against policy.
 *
 * A newly-added key starts with the permissive default
 * (`DEFAULT_KEY_POLICY`) — equivalent to today's unrestricted pass-through.
 * Users opt into stricter enforcement via the popup Policy tab (Phase 7).
 */
export interface KeyPolicy {
  modelPolicy: ModelPolicy;
  budget: BudgetPolicy;
  privacy: PrivacyPolicy;
  /** Developer-side sampling defaults applied when ChatParams omits them. */
  sampling?: SamplingPolicy;
  behavior: BehaviorPolicy;
}

export interface ModelPolicy {
  /**
   * - open: developer's `model` / `requires` wins, no user gate
   * - allowlist: developer's request must resolve to a model in allowedModels
   * - denylist: developer's request may resolve to anything EXCEPT deniedModels
   * - capability-only: developer cannot specify `model`; user maps
   *   capabilities to preferred models via `preferredPerCapability`
   */
  mode: "open" | "allowlist" | "denylist" | "capability-only";
  allowedModels?: string[];
  deniedModels?: string[];
  /** "When the dev needs `reasoning`, use `claude-sonnet-4-6`." */
  preferredPerCapability?: Partial<Record<Capability, string>>;
  /** What the broker does if the developer's request violates the mode. */
  onViolation: "reject" | "confirm";
}

export interface BudgetPolicy {
  maxTokensPerRequest?: number;
  maxCostPerRequestUSD?: number;
  dailyBudgetUSD?: number;
  monthlyBudgetUSD?: number;
  /** Enum-ordered cap: clamp dev's reasoning_effort to at most this level. */
  maxReasoningEffort?: ReasoningEffort;
  /** What the broker does when a request would exceed budget. */
  onBudgetHit: "block" | "confirm" | "warn";
}

export interface PrivacyPolicy {
  /** undefined = all providers permitted for this key. */
  allowedProviders?: string[];
  /** Regex pattern (stringified) matched against `origin`. undefined = any. */
  allowedOriginsRegex?: string;
  /** Reject requests whose baseUrl is not HTTPS (except localhost for dev). */
  requireHttps: boolean;
  /** Whether to record every request to the audit ledger. */
  logAuditEvents: boolean;
}

export interface SamplingPolicy {
  temperature?: number;
  topP?: number;
}

export interface BehaviorPolicy {
  /**
   * Allow the 404→/responses heuristic fallback when a model isn't in the
   * catalog. Turn off for strict environments that prefer failing closed.
   */
  autoFallback: boolean;
  /** Retry budget for transient provider errors (429 / 5xx). */
  maxRetries: number;
  /** Hard timeout for a single provider request. */
  timeoutMs: number;
}

/**
 * Permissive default applied to newly-added keys and during migration from
 * legacy `KeyDefaults`. Equivalent to pre-1.0 unrestricted pass-through.
 */
export const DEFAULT_KEY_POLICY: KeyPolicy = {
  modelPolicy: { mode: "open", onViolation: "confirm" },
  budget: { onBudgetHit: "warn" },
  privacy: { requireHttps: true, logAuditEvents: true },
  behavior: { autoFallback: true, maxRetries: 2, timeoutMs: 60_000 },
};

/** Policy schema version. Bumped whenever KeyPolicy shape changes. */
export const CURRENT_POLICY_VERSION = 1;

export interface KeyRecord {
  keyId: string;           // UUID v4, immutable
  provider: string;        // preset id: openai / anthropic / gemini / groq / ...
  label: string;           // required, user-facing name
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  isActive?: boolean;      // invariant: at most one key across the wallet is true
  /** @deprecated see KeyDefaults. Migrated into `policy` on read. */
  defaults?: KeyDefaults;
  /** v1.0 policy. Populated on read via migration for legacy records. */
  policy?: KeyPolicy;
  /** Schema version of `policy`. Populated when `policy` is set. */
  policyVersion?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Safe projection returned to UI / SDK — never includes `apiKey`.
 */
export interface KeySummary {
  keyId: string;
  provider: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  isActive: boolean;
  /** @deprecated migrated into `policy.sampling` + `policy.budget.maxReasoningEffort`. */
  defaults?: KeyDefaults;
  policy?: KeyPolicy;
  policyVersion?: number;
  keyHint: string | null;   // "sk-t...st12" mask, null if unavailable
  status: "active" | "error";
  createdAt: number;
  updatedAt: number;
}

// ── Per-origin binding ─────────────────────────────────

/**
 * Records which key an approved origin should use by default.
 * Persisted to chrome.storage.local so it survives browser restart.
 * Binding existence also implies consent was granted.
 */
export interface OriginBinding {
  origin: string;
  keyId: string;
  grantedAt: number;
  lastUsedAt: number;
}

// ── Request Parameters ─────────────────────────────────

/**
 * Wire-level ChatParams — the extension accepts BOTH v1 (legacy,
 * snake_case, top-level `model`/`temperature`/...) and v2 (capability-first,
 * camelCase, `requires`/`tone`/`maxOutput`/`prefer`). `toResolverRequest`
 * in streamManager prefers v2 fields when present.
 *
 * SDK v1 (frozen on npm at @keyquill 0.x.x) sends only v1 fields.
 * SDK v2 (@keyquill 2.x.x) sends only v2 fields.
 */
export interface ChatParams {
  keyId?: string;
  messages: ChatMessage[];
  tools?: Tool[];

  // ── v2 fields (capability-first) ──
  requires?: Capability[];
  tone?: Tone;
  maxOutput?: number;
  prefer?: {
    model?: string;
    provider?: string;
    reasoningEffort?: ReasoningEffort;
    temperature?: number;
    topP?: number;
  };
  toolChoice?: ToolChoice;
  responseFormat?: ResponseFormat;

  // ── v1 legacy fields (snake_case) ──
  /** @deprecated v2: use `prefer.model`. */
  provider?: string;
  /** @deprecated v2: use `prefer.model`. */
  model?: string;
  /** @deprecated v2: use `maxOutput`. */
  max_tokens?: number;
  /** @deprecated v2: use `maxOutput`. */
  max_completion_tokens?: number;
  /** @deprecated v2: use `prefer.temperature` or `tone`. */
  temperature?: number;
  /** @deprecated v2: use `prefer.topP`. */
  top_p?: number;
  /** @deprecated v2: no replacement in broker (rarely used). */
  stop?: string | string[];
  /** @deprecated v2: use `toolChoice`. */
  tool_choice?: ToolChoice;
  /** @deprecated v2: use `responseFormat`. */
  response_format?: ResponseFormat;
  /** @deprecated v2: use `prefer.reasoningEffort`. */
  reasoning_effort?: ReasoningEffort;
}

export type Tone = "precise" | "balanced" | "creative";

// ── Incoming Requests (page/popup → extension) ─────────

export type IncomingRequest =
  | { type: "ping" }
  | { type: "connect" }
  | { type: "disconnect" }
  | { type: "listKeys" }
  | {
      type: "addKey";
      provider: string;
      label: string;
      apiKey: string;
      baseUrl: string;
      defaultModel: string;
      isActive?: boolean;
      defaults?: KeyDefaults;
    }
  | {
      type: "updateKey";
      keyId: string;
      label?: string;
      baseUrl?: string;
      defaultModel?: string;
      apiKey?: string;
      defaults?: KeyDefaults;
    }
  | { type: "deleteKey"; keyId: string }
  | { type: "setActive"; keyId: string }
  | { type: "testKey"; keyId: string }
  | { type: "getBindings" }
  | { type: "setBinding"; origin: string; keyId: string }
  | { type: "revokeBinding"; origin: string }
  | { type: "_consentResponse"; origin: string; approved: boolean; keyId?: string }
  // Per-request consent (v1.0 broker). Sent from the consent popup in
  // "request-approval" mode so the background can match it up with the
  // pending resolver retry.
  | {
      type: "_requestConsentResponse";
      origin: string;
      keyId: string;
      model: string;
      reason:
        | "model-outside-allowlist"
        | "model-in-denylist"
        | "high-cost"
        | "capability-missing";
      approved: boolean;
      scope?: "once" | "always";
    }
  // Popup-only: policy editor + audit log
  | { type: "updatePolicy"; keyId: string; policy: KeyPolicy }
  | { type: "getLedger"; keyId: string; since?: number }
  | { type: "getMonthSpend"; keyId: string; month?: string }
  | { type: "exportLedger"; keyId: string }
  | ChatRequestMessage;

/** Non-streaming chat (via sendMessage) */
export interface ChatRequestMessage extends ChatParams {
  type: "chat";
  maxTokens?: number;
}

/** Streaming chat (via Port) */
export interface ChatStreamRequest extends ChatParams {
  type: "chatStream";
  maxTokens?: number;
}

// ── Outgoing Responses (extension → page/popup) ────────

export interface ChatCompletion {
  content: string | null;
  tool_calls?: ToolCall[];
  finish_reason: "stop" | "tool_calls" | "length" | "content_filter";
  usage?: { promptTokens: number; completionTokens: number };
}

/**
 * Public ledger entry shape sent to the popup. Matches the internal
 * LedgerEntry but re-declared here (not imported) because protocol.ts
 * is wire-level and must not depend on background-only modules.
 */
export interface LedgerEntrySummary {
  timestamp: number;
  keyId: string;
  origin: string;
  model: string;
  endpoint: "chat" | "responses" | "anthropic";
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  estimatedCostUSD: number;
  actualCostUSD: number;
  status: "success" | "error" | "cancelled";
  errorCode?: string;
}

export type OutgoingResponse =
  | { type: "pong"; version: string; protocol: number; connected?: boolean }
  | { type: "connected"; origin: string }
  | { type: "keys"; keys: KeySummary[] }
  | { type: "ok" }
  | { type: "testResult"; reachable: boolean; status?: number; detail?: string }
  | { type: "chatCompletion"; completion: ChatCompletion; keyId: string }
  | { type: "bindings"; bindings: OriginBinding[] }
  | { type: "ledger"; entries: LedgerEntrySummary[] }
  | { type: "spend"; keyId: string; month: string; totalUSD: number }
  | { type: "csv"; content: string }
  | { type: "error"; code: string; message: string };

// ── Stream Events (extension → page, over Port) ───────

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
  /** First event. Identifies which stored key is servicing this stream. */
  | { type: "start"; keyId: string; provider: string; label: string }
  | { type: "delta"; text: string }
  | { type: "tool_call_delta"; tool_calls: ToolCallDelta[] }
  | {
      type: "done";
      finish_reason?: "stop" | "tool_calls" | "length" | "content_filter";
      usage?: { promptTokens: number; completionTokens: number };
    }
  | { type: "error"; code: string; message: string };
