/**
 * Policy engine for the Secure Relay plugin.
 * Pure TypeScript — used for UI display and pre-flight checks on the JS side.
 * The native side has its own enforcement (defense in depth).
 */

import type { RelayPolicy } from "./types.js";
import {
  DEFAULT_PROVIDER_ALLOWLIST,
  PRIVATE_IP_PATTERNS,
  COST_PER_1K_TOKENS,
} from "./constants.js";

/** Create a default policy with sensible limits. */
export function defaultPolicy(): RelayPolicy {
  return {
    schemaVersion: 1,
    providerAllowlist: DEFAULT_PROVIDER_ALLOWLIST,
    maxTokensPerRequest: 4096,
    dailyCostLimitMicrounits: 5_000_000,
    monthlyCostLimitMicrounits: 50_000_000,
    monthlyWarningThresholdPct: 80,
    highCostThresholdMicrounits: 500_000,
    // 300s matches the iOS LAContext OS cap
    // (LATouchIDAuthenticationMaximumAllowableReuseDuration). Keeping the JS
    // default aligned avoids the situation where the app-layer timer is longer
    // than what iOS will actually honour. Android enforces the same window via
    // a time-bound Keystore key (see SecureKeyStore.ensureMasterKeyExists).
    biometricAutoApproveSeconds: 300,
    blockPrivateIps: true,
  };
}

/** Validate a base URL against the policy's provider allowlist. */
export function validateBaseUrl(
  url: string,
  policy: RelayPolicy,
): { ok: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "Invalid URL" };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "HTTPS required" };
  }

  if (policy.blockPrivateIps) {
    const host = parsed.hostname;
    for (const pattern of PRIVATE_IP_PATTERNS) {
      if (pattern.test(host)) {
        return { ok: false, reason: "Private IP addresses are blocked" };
      }
    }
  }

  const hostMatch = policy.providerAllowlist.some((entry) => {
    if (entry.hostPattern.startsWith("*.")) {
      const suffix = entry.hostPattern.slice(1);
      return parsed.hostname.endsWith(suffix) || parsed.hostname === entry.hostPattern.slice(2);
    }
    return parsed.hostname === entry.hostPattern;
  });

  if (!hostMatch) {
    return { ok: false, reason: `Host ${parsed.hostname} is not in the allowlist` };
  }

  return { ok: true };
}

/** Estimate cost in microunits for a request. */
export function estimateCost(
  model: string,
  promptTokens: number,
  maxCompletionTokens: number,
): number {
  const rates = COST_PER_1K_TOKENS[model] ?? COST_PER_1K_TOKENS.default;
  const promptCost = (promptTokens / 1000) * rates.prompt;
  const completionCost = (maxCompletionTokens / 1000) * rates.completion;
  return Math.ceil(promptCost + completionCost);
}

/** Check if a request fits within the daily budget. */
export function checkDailyBudget(
  accumulatedMicrounits: number,
  policy: RelayPolicy,
): { allowed: boolean; remaining: number } {
  const remaining = policy.dailyCostLimitMicrounits - accumulatedMicrounits;
  return { allowed: remaining > 0, remaining: Math.max(0, remaining) };
}

/** Check if a request fits within the monthly budget. */
export function checkMonthlyBudget(
  accumulatedMicrounits: number,
  policy: RelayPolicy,
): { allowed: boolean; remaining: number; warning: boolean } {
  const remaining = policy.monthlyCostLimitMicrounits - accumulatedMicrounits;
  const warningThreshold =
    policy.monthlyCostLimitMicrounits * (policy.monthlyWarningThresholdPct / 100);
  return {
    allowed: remaining > 0,
    remaining: Math.max(0, remaining),
    warning: accumulatedMicrounits >= warningThreshold,
  };
}

/** Determine if biometric authentication is required for this request. */
export function requiresBiometric(
  estimatedCostMicrounits: number,
  lastBiometricAuthAt: number,
  policy: RelayPolicy,
): boolean {
  // High-cost requests always require biometric
  if (estimatedCostMicrounits >= policy.highCostThresholdMicrounits) {
    return true;
  }

  // Low-cost requests: check if within auto-approve window
  const elapsed = (Date.now() - lastBiometricAuthAt) / 1000;
  return elapsed > policy.biometricAutoApproveSeconds;
}
