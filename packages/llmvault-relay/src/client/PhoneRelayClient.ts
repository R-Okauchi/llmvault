/**
 * Browser-side client for the Phone Wallet Relay.
 *
 * Owns the pairing lifecycle end-to-end:
 *   idle → connecting → waitingForPeer → keyExchanging → verifying → active → disconnected
 *
 * Framework-agnostic: exposes state changes via `EventTarget` so callers
 * can wrap them in their own reactive layer (signals, Zustand, Redux, etc.).
 */

import type { RelayQrPayload, RelayPairResponse, RelayWsEnvelope } from "../types.js";
import {
  generateECDHKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSessionKey,
  encrypt,
  decrypt,
  computeShortCode,
} from "../crypto.js";

export type RelayState =
  | "idle"
  | "connecting"
  | "waitingForPeer"
  | "keyExchanging"
  | "verifying"
  | "active"
  | "disconnected";

export interface PhoneRelayClientOptions {
  /** Base URL of the relay HTTP API (e.g. `https://api.example.com`). */
  apiUrl: string;
  /**
   * HKDF `info` label used to derive the AES-GCM session key.
   * MUST match the mobile side's value byte-for-byte.
   * Default: `"llmvault-relay-v1"`.
   */
  hkdfLabel?: string;
  /**
   * Relative path of the pair-creation endpoint on `apiUrl`.
   * Default: `"/v1/relay/pair"`.
   */
  pairPath?: string;
  /**
   * Additional fetch options (credentials, headers, …) applied to the
   * `POST /relay/pair` request. Useful for `credentials: "include"` or
   * for adding a Turnstile token as a body field.
   */
  pairRequestInit?: RequestInit;
  /**
   * Body payload sent with the pair-creation request. Default: `{}`.
   * Downstream apps can add `turnstileToken` etc. here.
   */
  pairRequestBody?: Record<string, unknown>;
  /** Heartbeat interval (ms). Default 60_000. Set 0 to disable. */
  heartbeatIntervalMs?: number;
}

export interface RelayStateChangeEvent {
  state: RelayState;
  error?: string;
}

type MessageHandler = (decrypted: string) => void;

/**
 * Strongly-typed EventTarget event map.
 */
export interface PhoneRelayClientEventMap {
  statechange: CustomEvent<RelayStateChangeEvent>;
  qr: CustomEvent<RelayQrPayload>;
  shortcode: CustomEvent<{ shortCode: string }>;
  message: CustomEvent<{ plaintext: string }>;
}

export class PhoneRelayClient extends EventTarget {
  // ── Public observable state (snapshot getters) ────────
  private _state: RelayState = "idle";
  private _sessionId: string | null = null;
  private _shortCode: string | null = null;
  private _qrPayload: RelayQrPayload | null = null;
  private _error: string | null = null;

  // ── Internal crypto / WS state ─────────────────────────
  private ws: WebSocket | null = null;
  private keyPair: CryptoKeyPair | null = null;
  private localPublicKeyBase64: string | null = null;
  private sessionKey: CryptoKey | null = null;
  private sequenceCounter = 0;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private messageHandler: MessageHandler | null = null;

  // ── Options with defaults ──────────────────────────────
  private readonly apiUrl: string;
  private readonly hkdfLabel: string;
  private readonly pairPath: string;
  private readonly pairRequestInit: RequestInit;
  private readonly pairRequestBody: Record<string, unknown>;
  private readonly heartbeatIntervalMs: number;

  constructor(opts: PhoneRelayClientOptions) {
    super();
    this.apiUrl = opts.apiUrl;
    this.hkdfLabel = opts.hkdfLabel ?? "llmvault-relay-v1";
    this.pairPath = opts.pairPath ?? "/v1/relay/pair";
    this.pairRequestInit = opts.pairRequestInit ?? {};
    this.pairRequestBody = opts.pairRequestBody ?? {};
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 60_000;
  }

  // ── Snapshot accessors ─────────────────────────────────

  get state(): RelayState {
    return this._state;
  }
  get sessionId(): string | null {
    return this._sessionId;
  }
  get shortCode(): string | null {
    return this._shortCode;
  }
  get qrPayload(): RelayQrPayload | null {
    return this._qrPayload;
  }
  get error(): string | null {
    return this._error;
  }
  isConnected(): boolean {
    return this._state === "active" && this.sessionKey !== null;
  }

  // ── Public API ─────────────────────────────────────────

  /** Initiate pairing: create server-side session, generate ECDH keys, emit QR. */
  async initiatePairing(): Promise<void> {
    this.cleanup();
    this.setState("connecting");
    this._error = null;

    try {
      this.keyPair = await generateECDHKeyPair();
      this.localPublicKeyBase64 = await exportPublicKey(this.keyPair.publicKey);

      const res = await fetch(this.apiUrl + this.pairPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.pairRequestBody),
        ...this.pairRequestInit,
      });

      if (!res.ok) {
        throw new Error(`Failed to create relay session: ${res.status}`);
      }

      const data = (await res.json()) as RelayPairResponse;
      this._sessionId = data.sessionId;

      this._qrPayload = {
        pairingToken: data.pairingToken,
        relayUrl: data.relayUrl,
        pcPublicKey: this.localPublicKeyBase64,
        version: 1,
      };
      this.dispatchEvent(new CustomEvent("qr", { detail: this._qrPayload }));

      const wsUrl = `${data.relayUrl}&role=pc&pcPublicKey=${encodeURIComponent(this.localPublicKeyBase64)}`;
      this.connectWebSocket(wsUrl);

      this.setState("waitingForPeer");
    } catch (err) {
      this._error = err instanceof Error ? err.message : "Failed to initiate pairing";
      this.setState("disconnected", this._error);
    }
  }

  /** Caller confirms the short-code matches → transition to active. */
  confirmVerification(): void {
    if (this._state === "verifying") {
      this.setState("active");
      this.startHeartbeat();
    }
  }

  /** Explicit disconnect from the peer. */
  disconnect(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const disconnect: RelayWsEnvelope = {
        type: "disconnect",
        sessionId: this._sessionId ?? "",
        reason: "user_request",
      };
      this.ws.send(JSON.stringify(disconnect));
    }
    this.cleanup();
    this.setState("disconnected");
  }

  /** Send an encrypted message to the mobile peer. Returns a requestId. */
  async sendEncrypted(plaintext: string): Promise<string> {
    if (!this.sessionKey || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Relay not connected");
    }

    const requestId = crypto.randomUUID();
    const aad = `${this._sessionId}:${requestId}`;
    const { ciphertextBase64, ivBase64 } = await encrypt(this.sessionKey, plaintext, aad);

    const envelope: RelayWsEnvelope = {
      type: "encrypted",
      sessionId: this._sessionId ?? "",
      requestId,
      ciphertextBase64,
      ivBase64,
      sequence: this.sequenceCounter++,
    };

    this.ws.send(JSON.stringify(envelope));
    return requestId;
  }

  /**
   * Register a handler for incoming decrypted messages.
   * Returns an unsubscribe function.
   */
  onMessage(handler: MessageHandler): () => void {
    this.messageHandler = handler;
    return () => {
      if (this.messageHandler === handler) this.messageHandler = null;
    };
  }

  // ── WebSocket management ───────────────────────────────

  private connectWebSocket(url: string): void {
    this.ws = new WebSocket(url);

    this.ws.onmessage = async (event) => {
      if (typeof event.data !== "string") return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      await this.handleWsMessage(msg);
    };

    this.ws.onclose = () => {
      if (this._state === "active" || this._state === "verifying") {
        this._error = "Connection lost";
        this.setState("disconnected", "Connection lost");
      }
      this.stopHeartbeat();
    };

    this.ws.onerror = () => {
      this._error = "WebSocket error";
      this.setState("disconnected", "WebSocket error");
      this.stopHeartbeat();
    };
  }

  private async handleWsMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case "keyExchange": {
        this.setState("keyExchanging");
        const mobilePublicKeyBase64 = msg.mobilePublicKey as string;
        try {
          const peerPublicKey = await importPublicKey(mobilePublicKeyBase64);
          this.sessionKey = await deriveSessionKey(
            this.keyPair!.privateKey,
            peerPublicKey,
            this.localPublicKeyBase64!,
            mobilePublicKeyBase64,
            this.hkdfLabel,
          );

          const code = await computeShortCode(this.localPublicKeyBase64!, mobilePublicKeyBase64);
          this._shortCode = code;
          this.dispatchEvent(new CustomEvent("shortcode", { detail: { shortCode: code } }));
        } catch {
          this._error = "Key exchange failed";
          this.setState("disconnected", "Key exchange failed");
        }
        break;
      }

      case "paired": {
        this.setState("verifying");
        const serverShortCode = msg.shortCode as string | undefined;
        if (serverShortCode) {
          this._shortCode = serverShortCode;
          this.dispatchEvent(
            new CustomEvent("shortcode", { detail: { shortCode: serverShortCode } }),
          );
        }
        break;
      }

      case "encrypted": {
        if (!this.sessionKey) return;
        try {
          const aad = `${msg.sessionId as string}:${msg.requestId as string}`;
          const plaintext = await decrypt(
            this.sessionKey,
            msg.ciphertextBase64 as string,
            msg.ivBase64 as string,
            aad,
          );
          this.messageHandler?.(plaintext);
          this.dispatchEvent(new CustomEvent("message", { detail: { plaintext } }));
        } catch {
          this._error = "Message decryption failed";
        }
        break;
      }

      case "pong":
        break;

      case "disconnect": {
        this._error = `Disconnected: ${msg.reason as string}`;
        this.cleanup();
        this.setState("disconnected", this._error);
        break;
      }

      case "error": {
        this._error = `Relay error: ${msg.message as string}`;
        this.dispatchEvent(
          new CustomEvent("statechange", { detail: { state: this._state, error: this._error } }),
        );
        break;
      }
    }
  }

  // ── Heartbeat / cleanup ───────────────────────────────

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (this.heartbeatIntervalMs <= 0) return;
    this.heartbeatInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private cleanup(): void {
    this.stopHeartbeat();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closed */
      }
      this.ws = null;
    }
    this.keyPair = null;
    this.localPublicKeyBase64 = null;
    this.sessionKey = null;
    this.sequenceCounter = 0;
    this._qrPayload = null;
    this._shortCode = null;
    this._sessionId = null;
    this.messageHandler = null;
  }

  private setState(next: RelayState, error?: string): void {
    this._state = next;
    this.dispatchEvent(new CustomEvent("statechange", { detail: { state: next, error } }));
  }
}
