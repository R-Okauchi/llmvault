/**
 * llmvault-relay — zero-knowledge E2E-encrypted WebSocket relay
 * for pairing a browser with a mobile LLM wallet.
 *
 * Use the sub-path entry points:
 *   - `llmvault-relay/client` — PC browser client (`PhoneRelayClient`)
 *   - `llmvault-relay/server` — Cloudflare Durable Object + Hono route factory
 *
 * This root entry re-exports the wire protocol types only.
 */

export type {
  RelayQrPayload,
  RelayPairResponse,
  RelayWsEnvelope,
  RelayInnerRequest,
  RelayInnerResponse,
  RelaySessionState,
} from "./types.js";
