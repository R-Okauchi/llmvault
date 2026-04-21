export { RelaySessionDO } from "./RelaySessionDO.js";
export { createRelayRoutes, type CreateRelayRoutesOptions } from "./createRelayRoutes.js";

// Wire protocol types are useful to consumers mounting their own routes.
export type {
  RelayQrPayload,
  RelayPairResponse,
  RelayWsEnvelope,
  RelayInnerRequest,
  RelayInnerResponse,
  RelaySessionState,
} from "../types.js";

// Crypto utilities (e.g. for custom server-side short-code computation).
export {
  generateECDHKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSessionKey,
  encrypt,
  decrypt,
  computeShortCode,
} from "../crypto.js";
