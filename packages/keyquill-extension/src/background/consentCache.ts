/**
 * In-memory consent cache (suppresses repeat popups).
 *
 * When the user grants a "once" approval for a particular
 * (origin, keyId, model, reason) combination, cache it for 5 minutes so
 * the next identical request doesn't immediately re-prompt.
 *
 * Intentionally non-persistent: "once" should NOT survive a browser
 * restart or service-worker sleep. Users who want persistent approvals
 * click "always" in the popup, which mutates the key's KeyPolicy (handled
 * by consent.ts, not this cache).
 *
 * Cost spikes (high-cost reason) additionally invalidate the cache when
 * the new estimate exceeds ~1.5x the approved amount — a retroactive
 * guardrail against a single approval authorising an unbounded stream
 * of expensive requests.
 */

import type { RequestConsentContext } from "./consent.js";

interface CacheEntry {
  expiresAt: number;
  reason: RequestConsentContext["reason"];
  approvedCostUSD?: number;
}

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const COST_TOLERANCE = 1.5;

const cache = new Map<string, CacheEntry>();

function keyOf(ctx: RequestConsentContext): string {
  return `${ctx.origin}::${ctx.keyId}::${ctx.model}::${ctx.reason}`;
}

/**
 * True if a prior "once" approval still applies to the given context.
 */
export function hasValidApproval(ctx: RequestConsentContext): boolean {
  const key = keyOf(ctx);
  const entry = cache.get(key);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return false;
  }
  // Cost check: if this is a high-cost approval and the new estimate is
  // more than 1.5x what the user approved, re-prompt.
  if (
    entry.reason === "high-cost" &&
    entry.approvedCostUSD !== undefined &&
    ctx.estimatedCostUSD !== undefined &&
    ctx.estimatedCostUSD > entry.approvedCostUSD * COST_TOLERANCE
  ) {
    return false;
  }
  return true;
}

/**
 * Record a "once" approval so subsequent identical requests within the
 * TTL don't re-prompt.
 */
export function recordApproval(ctx: RequestConsentContext): void {
  cache.set(keyOf(ctx), {
    expiresAt: Date.now() + TTL_MS,
    reason: ctx.reason,
    approvedCostUSD: ctx.estimatedCostUSD,
  });
}

/**
 * Clear all cached approvals. Used by tests and a potential manual
 * "reset consent" action in the popup.
 */
export function clearCache(): void {
  cache.clear();
}

export const __test = { TTL_MS, COST_TOLERANCE, keyOf };
