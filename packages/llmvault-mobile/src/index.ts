import { registerPlugin } from "@capacitor/core";
import type { SecureRelayPlugin } from "./definitions.js";

const SecureRelay = registerPlugin<SecureRelayPlugin>("SecureRelay", {
  web: () => import("./web.js").then((m) => new m.SecureRelayWeb()),
});

export { SecureRelay };
export type { SecureRelayPlugin, SecureRelayEvents } from "./definitions.js";
export type {
  RelayProviderInfo,
  RelayProviderAllowlistEntry,
  RelayPolicy,
  RelayStreamEvent,
} from "./types.js";
export {
  defaultPolicy,
  validateBaseUrl,
  estimateCost,
  checkDailyBudget,
  checkMonthlyBudget,
  requiresBiometric,
} from "./policy.js";
