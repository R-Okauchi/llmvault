/**
 * Keyquill — Bring Your Own Key to any web app.
 *
 * A browser extension SDK for secure LLM API key management.
 * Keys are stored in the extension's session storage (OS-level encryption),
 * never accessible to web page JavaScript.
 *
 * @example
 * ```typescript
 * import { Keyquill } from 'keyquill';
 *
 * const vault = new Keyquill();
 *
 * if (await vault.isAvailable()) {
 *   for await (const event of vault.chatStream({
 *     messages: [{ role: 'user', content: 'Hello!' }],
 *   })) {
 *     if (event.type === 'delta') process.stdout.write(event.text);
 *   }
 * }
 * ```
 */

export { Keyquill } from "./client.js";
export type { KeyquillOptions } from "./client.js";

export type {
  // Message types
  TextContentPart,
  ImageContentPart,
  ContentPart,
  ChatMessage,
  // Tool types
  ToolCall,
  ToolCallDelta,
  JsonSchema,
  FunctionTool,
  Tool,
  ToolChoice,
  // Response format
  ResponseFormat,
  // Key info
  KeySummary,
  KeyPolicySummary,
  // Broker vocabulary
  Capability,
  Tone,
  ReasoningEffort,
  // Request params
  ChatParams,
  ChatStreamParams,
  ChatRequest,
  ChatStreamRequest,
  // Response types
  ChatCompletion,
  VaultResponse,
  // Stream events
  StreamEvent,
  // Wire types
  VaultRequest,
} from "./types.js";

export { ErrorCode, SDK_PROTOCOL_VERSION } from "./types.js";
