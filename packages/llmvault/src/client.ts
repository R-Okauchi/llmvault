/**
 * LLMVault — SDK for communicating with the LLMVault browser extension.
 *
 * Usage:
 *   import { LLMVault } from 'llmvault';
 *   const vault = new LLMVault();
 *
 *   if (await vault.isAvailable()) {
 *     // Streaming
 *     for await (const event of vault.chatStream({ messages: [{ role: 'user', content: 'Hello' }] })) {
 *       if (event.type === 'delta') process.stdout.write(event.text);
 *     }
 *
 *     // Non-streaming
 *     const result = await vault.chat({ messages: [{ role: 'user', content: 'Hello' }] });
 *     console.log(result.content);
 *
 *     // With tools
 *     const result2 = await vault.chat({
 *       model: 'gpt-4o',
 *       messages: [{ role: 'user', content: "What's the weather?" }],
 *       tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { location: { type: 'string' } } } } }],
 *     });
 *   }
 */

import type {
  ProviderSummary,
  RegisterKeyParams,
  ChatParams,
  ChatStreamParams,
  ChatCompletion,
  StreamEvent,
  VaultRequest,
  VaultResponse,
} from "./types.js";
import { ErrorCode } from "./types.js";
import { sendExtensionMessage, connectToExtension, detectExtensionId } from "./detect.js";
import { portToStream } from "./stream.js";

export interface LLMVaultOptions {
  /** Chrome extension ID. Auto-detected if omitted. */
  extensionId?: string;
  /** Timeout for non-streaming operations (ms). Default: 5000 */
  timeout?: number;
}

export class LLMVault {
  private extensionId: string | null;
  private readonly timeout: number;
  private availableCache: boolean | null = null;
  private availableCacheTime = 0;

  constructor(options?: LLMVaultOptions) {
    this.extensionId = options?.extensionId ?? null;
    this.timeout = options?.timeout ?? 5000;
  }

  /**
   * Check if the LLMVault extension is installed and responsive.
   * Caches the result for 30 seconds.
   */
  async isAvailable(): Promise<boolean> {
    const now = Date.now();
    if (this.availableCache !== null && now - this.availableCacheTime < 30_000) {
      return this.availableCache;
    }

    const id = await this.resolveExtensionId();
    if (!id) {
      this.availableCache = false;
      this.availableCacheTime = now;
      return false;
    }

    const res = await sendExtensionMessage<VaultResponse>(
      id,
      { type: "ping" } satisfies VaultRequest,
      this.timeout,
    );

    const available = res?.type === "pong";
    this.availableCache = available;
    this.availableCacheTime = now;
    return available;
  }

  /**
   * Check if the current origin is connected (approved by the user).
   * Equivalent to `isAvailable()` + checking the `connected` flag.
   */
  async isConnected(): Promise<boolean> {
    const id = await this.resolveExtensionId();
    if (!id) return false;

    const res = await sendExtensionMessage<VaultResponse>(
      id,
      { type: "ping" } satisfies VaultRequest,
      this.timeout,
    );
    return res?.type === "pong" && res.connected === true;
  }

  /**
   * Request permission to use LLMVault from this origin.
   * Opens a consent popup if the origin is not yet approved.
   * This is the equivalent of MetaMask's `eth_requestAccounts`.
   *
   * @param timeoutMs  Timeout in ms (default: 60000). Set high because
   *                   it waits for user interaction with the consent popup.
   * @throws Error if the user denies the connection.
   *
   * @example
   * const vault = new LLMVault();
   * await vault.connect(); // opens consent popup if needed
   * const result = await vault.chat({ messages: [...] });
   */
  async connect(timeoutMs = 60_000): Promise<void> {
    const id = await this.resolveExtensionId();
    if (!id) {
      throw new Error(`[${ErrorCode.EXTENSION_NOT_FOUND}] LLMVault extension not found.`);
    }

    const res = await sendExtensionMessage<VaultResponse>(
      id,
      { type: "connect" } satisfies VaultRequest,
      timeoutMs,
    );

    if (!res) {
      throw new Error(`[${ErrorCode.TIMEOUT}] Connection timed out.`);
    }
    if (res.type === "error") {
      throw new Error(`[${res.code}] ${res.message}`);
    }
  }

  /**
   * Disconnect this origin from LLMVault (revoke the grant).
   * After disconnecting, `connect()` must be called again before
   * using any other API.
   */
  async disconnect(): Promise<void> {
    const res = await this.send({ type: "disconnect" });
    if (res.type === "error") {
      throw new Error(`[${res.code}] ${res.message}`);
    }
  }

  /**
   * List registered providers (no key material is returned).
   */
  async listProviders(): Promise<ProviderSummary[]> {
    const res = await this.send({ type: "listProviders" });
    if (res.type === "providers") return res.providers;
    return [];
  }

  /**
   * @deprecated Use the LLMVault browser extension popup to register API keys.
   * Key registration via postMessage is disabled for security — API keys should
   * not travel through the window.postMessage channel.
   */
  async registerKey(_provider: string, _params: RegisterKeyParams): Promise<void> {
    throw new Error(
      "registerKey() is disabled in the SDK. " +
        "Use the LLMVault extension popup to register API keys securely.",
    );
  }

  /**
   * Delete a provider key.
   */
  async deleteKey(provider: string): Promise<void> {
    const res = await this.send({ type: "deleteKey", provider });
    if (res.type === "error") {
      throw new Error(`[${res.code}] ${res.message}`);
    }
  }

  /**
   * Test connectivity to a provider by sending a minimal request.
   */
  async testKey(provider: string): Promise<{ reachable: boolean }> {
    const res = await this.send({ type: "testKey", provider });
    if (res.type === "testResult") return { reachable: res.reachable };
    return { reachable: false };
  }

  /**
   * Non-streaming chat completion.
   * Returns the full response once the model finishes generating.
   *
   * @example
   * const result = await vault.chat({
   *   model: 'gpt-4o',
   *   messages: [{ role: 'user', content: 'Hello' }],
   *   tools: [{ type: 'function', function: { name: 'greet', parameters: {} } }],
   * });
   */
  async chat(params: ChatParams): Promise<ChatCompletion> {
    const res = await this.send({
      type: "chat",
      ...params,
      max_tokens: params.max_tokens ?? (params as ChatStreamParams).maxTokens,
    });
    if (res.type === "chatCompletion") return res.completion;
    if (res.type === "error") {
      throw new Error(`[${res.code}] ${res.message}`);
    }
    throw new Error("Unexpected response type");
  }

  /**
   * Stream a chat completion. Returns an AsyncGenerator of StreamEvents.
   *
   * @example
   * for await (const event of vault.chatStream({
   *   model: 'claude-sonnet-4-20250514',
   *   messages: [{ role: 'user', content: 'Hello' }],
   *   tools: [{ type: 'function', function: { name: 'greet', parameters: {} } }],
   * })) {
   *   if (event.type === 'delta') console.log(event.text);
   *   if (event.type === 'tool_call_delta') console.log(event.tool_calls);
   * }
   */
  async *chatStream(params: ChatStreamParams): AsyncGenerator<StreamEvent> {
    const id = await this.resolveExtensionId();
    if (!id) {
      yield {
        type: "error",
        code: ErrorCode.EXTENSION_NOT_FOUND,
        message: "LLMVault extension not found.",
      };
      return;
    }

    const port = connectToExtension(id, "llmvault-chat");
    if (!port) {
      yield {
        type: "error",
        code: ErrorCode.EXTENSION_NOT_FOUND,
        message: "Failed to connect to LLMVault extension.",
      };
      return;
    }

    yield* portToStream(port, {
      type: "chatStream",
      ...params,
      // Normalize maxTokens → max_tokens for the wire format
      max_tokens: params.max_tokens ?? params.maxTokens,
    });
  }

  // ── Private ──────────────────────────────────────

  private async send(message: VaultRequest): Promise<VaultResponse> {
    const id = await this.resolveExtensionId();
    if (!id) {
      return {
        type: "error",
        code: ErrorCode.EXTENSION_NOT_FOUND,
        message: "LLMVault extension not found.",
      };
    }

    const res = await sendExtensionMessage<VaultResponse>(id, message, this.timeout);
    if (!res) {
      return {
        type: "error",
        code: ErrorCode.TIMEOUT,
        message: "Extension did not respond in time.",
      };
    }
    return res;
  }

  private async resolveExtensionId(): Promise<string | null> {
    if (this.extensionId) return this.extensionId;

    // Try to detect from meta tag or well-known IDs
    const detected = detectExtensionId([]);
    if (detected) {
      // Verify it's reachable
      const res = await sendExtensionMessage<VaultResponse>(detected, { type: "ping" }, 2000);
      if (res?.type === "pong") {
        this.extensionId = detected;
        return detected;
      }
    }

    return null;
  }
}
