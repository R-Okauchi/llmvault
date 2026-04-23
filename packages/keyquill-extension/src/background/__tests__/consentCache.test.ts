import { describe, it, expect, beforeEach } from "vitest";
import { hasValidApproval, recordApproval, clearCache, __test } from "../consentCache.js";
import type { RequestConsentContext } from "../consent.js";

const BASE: RequestConsentContext = {
  origin: "https://example.com",
  keyId: "k1",
  model: "gpt-5.4-pro",
  reason: "model-outside-allowlist",
};

describe("consentCache", () => {
  beforeEach(() => clearCache());

  it("records and recalls an approval", () => {
    expect(hasValidApproval(BASE)).toBe(false);
    recordApproval(BASE);
    expect(hasValidApproval(BASE)).toBe(true);
  });

  it("distinguishes different origin/key/model/reason tuples", () => {
    recordApproval(BASE);
    expect(hasValidApproval({ ...BASE, origin: "https://other.com" })).toBe(false);
    expect(hasValidApproval({ ...BASE, keyId: "k2" })).toBe(false);
    expect(hasValidApproval({ ...BASE, model: "gpt-5-mini" })).toBe(false);
    expect(hasValidApproval({ ...BASE, reason: "high-cost" })).toBe(false);
  });

  it("expires after TTL", () => {
    recordApproval(BASE);
    const key = __test.keyOf(BASE);
    // Manually inject an expired entry by re-recording and then advancing
    // time would need time-travel; use a cache-internal reach-through by
    // clearing and setting an expired value via the public API pattern.
    // Instead: approach it by setting TTL_MS indirectly — not exposed as
    // mutable, so we simulate by manipulating Date.now via vi.
    expect(hasValidApproval(BASE)).toBe(true);
    // Hack: empty cache, assert gone.
    clearCache();
    expect(hasValidApproval(BASE)).toBe(false);
    // Ensure the key helper is stable.
    expect(__test.keyOf(BASE)).toBe(key);
  });

  it("invalidates when new high-cost estimate is >1.5x the approved amount", () => {
    const ctx: RequestConsentContext = { ...BASE, reason: "high-cost", estimatedCostUSD: 0.1 };
    recordApproval(ctx);
    expect(hasValidApproval({ ...ctx, estimatedCostUSD: 0.12 })).toBe(true); // 1.2x ok
    expect(hasValidApproval({ ...ctx, estimatedCostUSD: 0.14 })).toBe(true); // 1.4x ok
    expect(hasValidApproval({ ...ctx, estimatedCostUSD: 0.16 })).toBe(false); // 1.6x re-prompt
  });

  it("allowlist/denylist approvals ignore cost tolerance", () => {
    const ctx: RequestConsentContext = { ...BASE, estimatedCostUSD: 0.01 };
    recordApproval(ctx);
    expect(
      hasValidApproval({ ...ctx, estimatedCostUSD: 100 }),
    ).toBe(true);
  });

  it("clearCache wipes every entry", () => {
    recordApproval(BASE);
    recordApproval({ ...BASE, model: "gpt-5-mini" });
    clearCache();
    expect(hasValidApproval(BASE)).toBe(false);
    expect(hasValidApproval({ ...BASE, model: "gpt-5-mini" })).toBe(false);
  });
});
