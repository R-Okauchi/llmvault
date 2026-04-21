/**
 * LLMVault — Bring Your Own Key to any web app.
 *
 * A browser extension SDK for secure LLM API key management.
 * Keys are stored in the extension's session storage (OS-level encryption),
 * never accessible to web page JavaScript.
 *
 * @example
 * ```typescript
 * import { LLMVault } from 'llmvault';
 *
 * const vault = new LLMVault();
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

export { LLMVault } from "./client.js";
export type { LLMVaultOptions } from "./client.js";

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
  // Provider info
  ProviderSummary,
  RegisterKeyParams,
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

export { ErrorCode } from "./types.js";
