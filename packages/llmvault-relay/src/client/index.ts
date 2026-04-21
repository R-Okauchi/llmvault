export {
  PhoneRelayClient,
  type PhoneRelayClientOptions,
  type PhoneRelayClientEventMap,
  type RelayState,
  type RelayStateChangeEvent,
} from "./PhoneRelayClient.js";

// Re-export crypto utilities for callers that want low-level access.
export {
  generateECDHKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSessionKey,
  encrypt,
  decrypt,
  computeShortCode,
} from "../crypto.js";

// Wire protocol types are also useful to consumers of the client.
export type {
  RelayQrPayload,
  RelayPairResponse,
  RelayWsEnvelope,
  RelayInnerRequest,
  RelayInnerResponse,
  RelaySessionState,
} from "../types.js";
