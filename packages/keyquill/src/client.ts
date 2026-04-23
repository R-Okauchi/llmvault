/**
 * Keyquill — SDK for communicating with the Keyquill browser extension.
 *
 * Multi-key model (v2 protocol):
 *   - User's wallet stores multiple KeyRecords (e.g. OpenAI Work, OpenAI Personal)
 *   - Each key has a stable `keyId` (UUID) and a user-facing `label`
 *   - `chatStream` / `chat` accept `keyId` (explicit) or `provider` (default-per-provider)
 *   - When neither is specified, the extension uses the user's global default,
 *     or the origin's bound key if one was set at consent time
 *   - Every stream starts with a `{ type: "start", keyId, provider, label }` event
 *     so callers can tell which key serviced the request (useful for audit UI)
 *
 * Usage:
 *   import { Keyquill } from 'keyquill';
 *   const vault = new Keyquill();
 *   if (await vault.isAvailable()) {
 *     await vault.connect(); // shows consent popup + key picker on first use
 *     for await (const event of vault.chatStream({
 *       messages: [{ role: 'user', content: 'Hello' }],
 *     })) {
 *       if (event.type === 'start') console.log(`Using ${event.label}`);
 *       if (event.type === 'delta') process.stdout.write(event.text);
 *     }
 *   }
 */

import type {
  KeySummary,
  ChatParams,
  ChatStreamParams,
  ChatCompletion,
  StreamEvent,
  VaultRequest,
  VaultResponse,
} from "./types.js";
export type { Capability, Tone, ReasoningEffort, ChatParams, ChatStreamParams } from "./types.js";
import { ErrorCode, SDK_PROTOCOL_VERSION } from "./types.js";
import { sendExtensionMessage, connectToExtension, detectExtensionId } from "./detect.js";
import { portToStream } from "./stream.js";

export interface KeyquillOptions {
  /** Chrome extension ID. Auto-detected if omitted. */
  extensionId?: string;
  /** Timeout for non-streaming operations (ms). Default: 5000 */
  timeout?: number;
}

export class Keyquill {
  private extensionId: string | null;
  private readonly timeout: number;
  private availableCache: boolean | null = null;
  private availableCacheTime = 0;

  constructor(options?: KeyquillOptions) {
    this.extensionId = options?.extensionId ?? null;
    this.timeout = options?.timeout ?? 5000;
  }

  /**
   * Check if the Keyquill extension is installed and responsive.
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
   * Request permission to use Keyquill from this origin.
   * Opens a consent popup (with key picker) if the origin is not yet approved.
   * Equivalent to MetaMask's `eth_requestAccounts`.
   *
   * @throws Error if the user denies or if protocol versions mismatch.
   */
  async connect(timeoutMs = 60_000): Promise<void> {
    const id = await this.resolveExtensionId();
    if (!id) {
      throw new Error(`[${ErrorCode.EXTENSION_NOT_FOUND}] Keyquill extension not found.`);
    }

    // Protocol version check
    const ping = await sendExtensionMessage<VaultResponse>(
      id,
      { type: "ping" },
      this.timeout,
    );
    if (ping?.type === "pong" && ping.protocol !== SDK_PROTOCOL_VERSION) {
      throw new Error(
        `[${ErrorCode.PROTOCOL_MISMATCH}] SDK expects protocol v${SDK_PROTOCOL_VERSION} ` +
          `but extension speaks v${ping.protocol}. Update the Keyquill extension.`,
      );
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
   * Disconnect this origin from Keyquill (revoke the binding).
   * After disconnecting, `connect()` must be called again.
   */
  async disconnect(): Promise<void> {
    const res = await this.send({ type: "disconnect" });
    if (res.type === "error") {
      throw new Error(`[${res.code}] ${res.message}`);
    }
  }

  /**
   * List registered keys (no apiKey material is returned).
   * Each KeySummary includes `keyId`, `label`, `provider`, `isDefault`, etc.
   */
  async listKeys(): Promise<KeySummary[]> {
    const res = await this.send({ type: "listKeys" });
    if (res.type === "keys") return res.keys;
    return [];
  }

  /**
   * Test connectivity to the provider behind a specific stored key.
   * @param keyId stable keyId from `listKeys()`.
   */
  async testKey(keyId: string): Promise<{ reachable: boolean; status?: number; detail?: string }> {
    const res = await this.send({ type: "testKey", keyId });
    if (res.type === "testResult") {
      return {
        reachable: res.reachable,
        ...(res.status !== undefined ? { status: res.status } : {}),
        ...(res.detail !== undefined ? { detail: res.detail } : {}),
      };
    }
    return { reachable: false };
  }

  /**
   * Non-streaming chat completion.
   * Returns the full response plus the `keyId` that serviced the call.
   *
   * @example
   * const { completion, keyId } = await vault.chat({
   *   messages,
   *   requires: ["tool_use"],
   *   tone: "precise",
   * });
   */
  async chat(params: ChatParams): Promise<{ completion: ChatCompletion; keyId: string }> {
    const res = await this.send({ type: "chat", ...params });
    if (res.type === "chatCompletion") {
      return { completion: res.completion, keyId: res.keyId };
    }
    if (res.type === "error") {
      throw new Error(`[${res.code}] ${res.message}`);
    }
    throw new Error("Unexpected response type");
  }

  /**
   * Stream a chat completion.
   * First event is `{ type: "start", keyId, provider, label }`.
   *
   * @example
   * for await (const event of vault.chatStream({ messages })) {
   *   if (event.type === "delta") process.stdout.write(event.text);
   * }
   */
  async *chatStream(params: ChatStreamParams): AsyncGenerator<StreamEvent> {
    const id = await this.resolveExtensionId();
    if (!id) {
      yield {
        type: "error",
        code: ErrorCode.EXTENSION_NOT_FOUND,
        message: "Keyquill extension not found.",
      };
      return;
    }

    const port = connectToExtension(id, "keyquill-chat");
    if (!port) {
      yield {
        type: "error",
        code: ErrorCode.EXTENSION_NOT_FOUND,
        message: "Failed to connect to Keyquill extension.",
      };
      return;
    }

    yield* portToStream(port, { type: "chatStream", ...params });
  }

  // ── Private ──────────────────────────────────────

  private async send(message: VaultRequest): Promise<VaultResponse> {
    const id = await this.resolveExtensionId();
    if (!id) {
      return {
        type: "error",
        code: ErrorCode.EXTENSION_NOT_FOUND,
        message: "Keyquill extension not found.",
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

    const detected = detectExtensionId([]);
    if (detected) {
      const res = await sendExtensionMessage<VaultResponse>(detected, { type: "ping" }, 2000);
      if (res?.type === "pong") {
        this.extensionId = detected;
        return detected;
      }
    }

    return null;
  }
}
