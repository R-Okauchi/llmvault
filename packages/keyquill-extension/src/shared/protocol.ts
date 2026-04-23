/**
 * Message protocol shared between background service worker and popup.
 * These types mirror keyquill SDK types for external messaging.
 *
 * Wire protocol follows OpenAI Chat Completions format.
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
export interface KeyDefaults {
  /** Sampling temperature 0.0 - 2.0. Omit to let the provider pick. */
  temperature?: number;
  /** Nucleus sampling 0.0 - 1.0. */
  topP?: number;
  /** Reasoning model effort level. Translated per-provider at fetch time. */
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
}

export interface KeyRecord {
  keyId: string;           // UUID v4, immutable
  provider: string;        // preset id: openai / anthropic / gemini / groq / ...
  label: string;           // required, user-facing name
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  isActive?: boolean;      // invariant: at most one key across the wallet is true
  defaults?: KeyDefaults;  // per-key generation defaults merged by the request handler
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
  defaults?: KeyDefaults;
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

export interface ChatParams {
  /** Explicit key selection, overrides all other resolution. */
  keyId?: string;
  /** Provider hint; used to fall back to that provider's default key. */
  provider?: string;
  model?: string;
  messages: ChatMessage[];
  max_tokens?: number;
  /**
   * OpenAI reasoning-model budget (shared between reasoning and completion).
   * Treated as an alias for `max_tokens` by non-reasoning providers.
   */
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: Tool[];
  tool_choice?: ToolChoice;
  response_format?: ResponseFormat;
  /**
   * Reasoning model effort level. Forwarded verbatim to OpenAI-compatible
   * providers (OpenAI, Gemini OpenAI-compat, Groq reasoning, etc.) and
   * translated to Anthropic's `thinking: { budget_tokens }` for the
   * Anthropic Messages API.
   */
  reasoning_effort?: "minimal" | "low" | "medium" | "high";
}

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

export type OutgoingResponse =
  | { type: "pong"; version: string; protocol: number; connected?: boolean }
  | { type: "connected"; origin: string }
  | { type: "keys"; keys: KeySummary[] }
  | { type: "ok" }
  | { type: "testResult"; reachable: boolean; status?: number; detail?: string }
  | { type: "chatCompletion"; completion: ChatCompletion; keyId: string }
  | { type: "bindings"; bindings: OriginBinding[] }
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
