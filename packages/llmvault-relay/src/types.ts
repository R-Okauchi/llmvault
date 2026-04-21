/**
 * Wire protocol types for the Phone Wallet Relay.
 *
 * These types are shared verbatim over the WebSocket between:
 *   - The PC browser client (./client/PhoneRelayClient)
 *   - The relay Durable Object (./server/RelaySessionDO)
 *   - The mobile side (the llmvault-mobile Capacitor plugin)
 *
 * Intentionally plain TypeScript — no Zod — so this package can be
 * published with only hono + @cloudflare/workers-types as optional peers.
 */

/** Life-cycle state of a relay session. */
export type RelaySessionState = "pending" | "paired" | "connected" | "disconnected";

/** QR-code payload handed from PC to mobile during pairing. */
export interface RelayQrPayload {
  pairingToken: string;
  relayUrl: string;
  /** Base64url-encoded ECDH P-256 raw public key (PC side). */
  pcPublicKey: string;
  version: 1;
}

/** JSON response body returned by `POST /v1/relay/pair`. */
export interface RelayPairResponse {
  pairingToken: string;
  relayUrl: string;
  sessionId: string;
  /** Unix epoch ms when the pairing token expires (server-side TTL). */
  expiresAt: number;
}

/**
 * Discriminated union of all messages that travel over the relay WebSocket.
 * The Durable Object forwards `encrypted` blobs verbatim without inspection.
 */
export type RelayWsEnvelope =
  // ECDH key exchange from mobile → relay → PC
  | {
      type: "keyExchange";
      sessionId: string;
      /** Base64url-encoded ECDH P-256 raw public key (mobile side). */
      mobilePublicKey: string;
    }
  // E2E-encrypted message, either direction
  | {
      type: "encrypted";
      sessionId: string;
      requestId: string;
      ciphertextBase64: string;
      /** 12-byte IV for AES-GCM, base64url-encoded. */
      ivBase64: string;
      /** Monotonic counter for replay protection. */
      sequence: number;
    }
  // Heartbeat
  | { type: "ping" }
  | { type: "pong" }
  // Pairing completed — relay tells both peers the short verification code
  | {
      type: "paired";
      sessionId: string;
      /** 6-digit numeric verification code for visual MITM check. */
      shortCode: string;
    }
  // One peer disconnecting
  | {
      type: "disconnect";
      sessionId: string;
      reason: string;
    }
  // Server → client error
  | {
      type: "error";
      code: string;
      message: string;
    };

/**
 * Inner decrypted request carried inside an `encrypted` envelope (PC → mobile).
 * This is the actual AI chat request to forward to the local LLM wallet.
 */
export interface RelayInnerRequest {
  type: "chatRequest";
  provider: string;
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  systemPrompt: string;
  maxTokens: number;
}

/**
 * Inner decrypted response carried inside an `encrypted` envelope (mobile → PC).
 * Streaming AI events, one per envelope.
 */
export type RelayInnerResponse =
  | { type: "delta"; text: string }
  | { type: "card"; card: Record<string, unknown> }
  | { type: "patch"; patch: Record<string, unknown> }
  | {
      type: "done";
      usage?: { promptTokens: number; completionTokens: number };
    }
  | { type: "error"; error: string };
