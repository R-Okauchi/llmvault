/**
 * Message protocol shared between background service worker and popup.
 * These types mirror llmvault SDK types for external messaging.
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

// ── Provider Record ────────────────────────────────────

export interface ProviderRecord {
  provider: string;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  label?: string;
  createdAt: number;
  updatedAt: number;
}

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

// ── Request Parameters ─────────────────────────────────

export interface ChatParams {
  provider?: string;
  model?: string;
  messages: ChatMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: Tool[];
  tool_choice?: ToolChoice;
  response_format?: ResponseFormat;
}

// ── Origin Grant ──────────────────────────────────────

export interface OriginGrant {
  origin: string;
  grantedAt: number;
}

// ── Incoming Requests (page/popup → extension) ─────────

export type IncomingRequest =
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
  | { type: "getGrants" }
  | { type: "revokeGrant"; origin: string }
  | { type: "_consentResponse"; origin: string; approved: boolean }
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
  | { type: "pong"; version: string; connected?: boolean }
  | { type: "connected"; origin: string }
  | { type: "providers"; providers: ProviderSummary[] }
  | { type: "ok" }
  | { type: "testResult"; reachable: boolean }
  | { type: "chatCompletion"; completion: ChatCompletion }
  | { type: "grants"; grants: OriginGrant[] }
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
  | { type: "delta"; text: string }
  | { type: "tool_call_delta"; tool_calls: ToolCallDelta[] }
  | {
      type: "done";
      finish_reason?: "stop" | "tool_calls" | "length" | "content_filter";
      usage?: { promptTokens: number; completionTokens: number };
    }
  | { type: "error"; code: string; message: string };
