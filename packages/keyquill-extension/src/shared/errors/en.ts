import type { ErrorCode } from "./codes.js";

/**
 * English messages for every stable error code. Phrased as
 * user-facing sentences — what to do next, not just what went wrong.
 */
export const ERRORS_EN: Record<ErrorCode, string> = {
  KEY_NOT_FOUND: "No Keyquill key is available for this request. Open the extension popup to add a key, then try again.",
  NOT_CONNECTED: "This site isn't connected to Keyquill. The app should call connect() on its Keyquill client to request access.",
  USER_DENIED: "You denied the connection request. Reopen the site and approve the popup to try again.",
  INVALID_KEY: "The key couldn't be saved. Double-check the API key value and the base URL.",
  INVALID_REQUEST: "The extension received an unrecognized request from this site.",
  BLOCKED: "This action is only allowed from the Keyquill extension popup.",
  UNKNOWN_ORIGIN: "The request's origin couldn't be determined. Reload the page and retry.",
  PROVIDER_UNREACHABLE: "The provider couldn't be reached. Check your network connection and the base URL.",
  PROVIDER_ERROR: "The provider returned an error. See the error detail for specifics.",
  EMPTY_BODY: "The provider returned an empty response.",
  INTERNAL: "An unexpected error occurred inside the extension.",

  POLICY_HTTPS_REQUIRED: "Your key's policy requires HTTPS endpoints. The configured base URL uses plain HTTP.",
  POLICY_ORIGIN_BLOCKED: "Your key's policy doesn't permit this origin. Review the Privacy tab in the Keyquill popup.",
  POLICY_PROVIDER_BLOCKED: "Your key's policy doesn't permit this provider. Review the Privacy tab to adjust the allowlist.",
  POLICY_NO_MODEL_MATCHES_CAPABILITIES: "No model in your allowlist satisfies all the capabilities this app needs. Add a compatible model to the allowlist in the Policy tab.",
  POLICY_MODEL_DENIED_BY_POLICY: "The requested model is on this key's denylist. Remove it from the denylist or pick a different key.",
  POLICY_MODEL_OUTSIDE_ALLOWLIST: "The requested model isn't in your allowlist. Approve it via the consent popup or add it in the Policy tab.",
  POLICY_CAPABILITY_MISSING_FROM_MODEL: "The selected model can't satisfy a capability this app requires (e.g. tool use or structured output). Pick a different model.",
  POLICY_UNKNOWN_MODEL: "The requested model isn't in the Keyquill catalog. Update the extension or pick a catalogued model.",
  POLICY_BUDGET_REQUEST_OVER_LIMIT: "This request's estimated cost exceeds your per-request budget. Raise the budget in the Policy tab or reject the request.",
  POLICY_CAPABILITY_ONLY_REQUIRES_DEVELOPER_CAPABILITIES: "Your key is in capability-only mode, but the app didn't declare which capabilities it needs.",
  POLICY_CAPABILITY_ONLY_NO_PREFERRED_MODEL: "Your key is in capability-only mode but hasn't been configured with a preferred model for the requested capability.",

  POLICY_MODEL_OUTSIDE_ALLOWLIST_REJECTED: "You rejected the request: this model is outside the key's allowlist.",
  POLICY_MODEL_IN_DENYLIST_REJECTED: "You rejected the request: this model is on the key's denylist.",
  POLICY_HIGH_COST_REJECTED: "You rejected the request: estimated cost exceeded the per-request budget.",
  POLICY_CAPABILITY_MISSING_REJECTED: "You rejected the request: the app needs a capability the model doesn't provide.",

  POLICY_MODEL_OUTSIDE_ALLOWLIST_CONSENT_REQUIRED: "Approval needed: the requested model isn't in your allowlist.",
  POLICY_MODEL_IN_DENYLIST_CONSENT_REQUIRED: "Approval needed: the requested model is on your denylist.",
  POLICY_HIGH_COST_CONSENT_REQUIRED: "Approval needed: estimated cost exceeds the per-request budget.",
  POLICY_CAPABILITY_MISSING_CONSENT_REQUIRED: "Approval needed: the request declares a capability the chosen model can't fulfill.",
};
