/**
 * Message protocol between the LLMVault SDK and browser extension.
 * These types define the contract — both sides must agree on them.
 *
 * The wire protocol follows OpenAI Chat Completions format.
 * OpenAI-compatible providers receive requests as-is; Anthropic
 * requests are translated by the extension before forwarding.
 */

// ── OpenAI-Compatible Message Types ────────────────────

/** Text content part */
export interface TextContentPart {
  type: "text";
  text: string;
}

/** Image content part (vision) */
export interface ImageContentPart {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
}

export type ContentPart = TextContentPart | ImageContentPart;

/** Tool call as returned by the model */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Individual message in a conversation */
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content?: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

// ── Tool & Response Format Definitions ─────────────────

/** JSON Schema subset */
export type JsonSchema = Record<string, unknown>;

/** Function tool definition (OpenAI format) */
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

/** Structured output via response_format */
export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: { name: string; schema: JsonSchema; strict?: boolean } };

// ── Provider Info ────────────────────────────────────

export interface ProviderSummary {
  provider: string;
  baseUrl: string;
  defaultModel: string;
  status: "active" | "error";
  keyHint: string | null;
  label: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RegisterKeyParams {
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  label?: string;
}

// ── Request Parameters ─────────────────────────────────

/** Full chat completion parameters (OpenAI Chat Completions shape). */
export interface ChatParams {
  /** Provider ID. Omit or "auto" to use first active provider. */
  provider?: string;

  /** Model to use. Overrides the provider's defaultModel if set. */
  model?: string;

  /** Conversation messages. */
  messages: ChatMessage[];

  // ── Generation parameters ──
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];

  // ── Tool calling ──
  tools?: Tool[];
  tool_choice?: ToolChoice;

  // ── Structured output ──
  response_format?: ResponseFormat;
}

/**
 * Streaming chat parameters.
 * Extends ChatParams with deprecated maxTokens for backward compatibility.
 */
export interface ChatStreamParams extends ChatParams {
  /**
   * @deprecated Use max_tokens instead.
   * If both maxTokens and max_tokens are set, max_tokens wins.
   */
  maxTokens?: number;
}

// ── Wire Requests (page → extension) ──────────────────

export interface ChatStreamRequest extends ChatParams {
  type: "chatStream";
  /** @deprecated Use max_tokens instead. */
  maxTokens?: number;
}

export interface ChatRequest extends ChatParams {
  type: "chat";
  /** @deprecated Use max_tokens instead. */
  maxTokens?: number;
}

export type VaultRequest =
  | { type: "ping" }
  | { type: "connect" }
  | { type: "disconnect" }
  | { type: "listProviders" }
  | {
      type: "registerKey";
      provider: string;
      apiKey: string;
      baseUrl: string;
      defaultModel: string;
      label?: string;
    }
  | { type: "deleteKey"; provider: string }
  | { type: "testKey"; provider: string }
  | ChatRequest;

// ── Response Messages (extension → page) ───────────────

/** Non-streaming chat completion result */
export interface ChatCompletion {
  content: string | null;
  tool_calls?: ToolCall[];
  finish_reason: "stop" | "tool_calls" | "length" | "content_filter";
  usage?: { promptTokens: number; completionTokens: number };
}

export type VaultResponse =
  | { type: "pong"; version: string; connected?: boolean }
  | { type: "connected"; origin: string }
  | { type: "providers"; providers: ProviderSummary[] }
  | { type: "ok" }
  | { type: "testResult"; reachable: boolean }
  | { type: "chatCompletion"; completion: ChatCompletion }
  | { type: "error"; code: string; message: string };

// ── Stream Events (extension → page, over Port) ───────

/** Delta for a tool call being streamed */
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
  NOT_CONNECTED: "NOT_CONNECTED",
  USER_DENIED: "USER_DENIED",
  PROVIDER_NOT_FOUND: "PROVIDER_NOT_FOUND",
  PROVIDER_UNREACHABLE: "PROVIDER_UNREACHABLE",
  PROVIDER_ERROR: "PROVIDER_ERROR",
  INVALID_REQUEST: "INVALID_REQUEST",
  TIMEOUT: "TIMEOUT",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
