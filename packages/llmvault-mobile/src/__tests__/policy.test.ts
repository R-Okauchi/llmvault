import { describe, it, expect } from "vitest";
import {
  defaultPolicy,
  validateBaseUrl,
  estimateCost,
  checkDailyBudget,
  checkMonthlyBudget,
  requiresBiometric,
} from "../policy.js";

describe("defaultPolicy", () => {
  it("returns a valid policy with sensible defaults", () => {
    const policy = defaultPolicy();
    expect(policy.schemaVersion).toBe(1);
    expect(policy.providerAllowlist.length).toBeGreaterThan(0);
    expect(policy.maxTokensPerRequest).toBe(4096);
    expect(policy.dailyCostLimitMicrounits).toBe(5_000_000);
    expect(policy.blockPrivateIps).toBe(true);
  });

  it("pins the biometric auto-approve window at 300s", () => {
    // Regression guard. Longer windows used to be tolerated but they
    // diverge from iOS's LATouchIDAuthenticationMaximumAllowableReuseDuration
    // (300s) and from Android's time-bound Keystore validity, which means
    // the app would claim auth was still valid while the OS had already
    // cleared it. Keep this one in lock-step with the native defaults
    // in packages/secure-relay/{ios,android}/**/PolicyEnforcer.*.
    expect(defaultPolicy().biometricAutoApproveSeconds).toBe(300);
  });
});

describe("validateBaseUrl", () => {
  const policy = defaultPolicy();

  it("accepts allowed HTTPS providers", () => {
    expect(validateBaseUrl("https://api.openai.com/v1", policy)).toEqual({ ok: true });
    expect(validateBaseUrl("https://api.anthropic.com/v1", policy)).toEqual({ ok: true });
    expect(validateBaseUrl("https://api.groq.com/openai/v1", policy)).toEqual({ ok: true });
  });

  it("rejects HTTP URLs", () => {
    const result = validateBaseUrl("http://api.openai.com/v1", policy);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("HTTPS required");
  });

  it("rejects unlisted hosts", () => {
    const result = validateBaseUrl("https://evil.example.com/v1", policy);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not in the allowlist");
  });

  it("rejects private IPs", () => {
    const result = validateBaseUrl("https://192.168.1.1/v1", policy);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("Private IP addresses are blocked");
  });

  it("rejects loopback", () => {
    const result = validateBaseUrl("https://127.0.0.1/v1", policy);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("Private IP addresses are blocked");
  });

  it("rejects invalid URLs", () => {
    const result = validateBaseUrl("not-a-url", policy);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("Invalid URL");
  });
});

describe("estimateCost", () => {
  it("estimates cost for known models", () => {
    const cost = estimateCost("gpt-4o-mini", 1000, 1000);
    expect(cost).toBeGreaterThan(0);
    expect(cost).toBe(750); // (1000/1000)*150 + (1000/1000)*600 = 750
  });

  it("uses default rates for unknown models", () => {
    const cost = estimateCost("unknown-model", 1000, 1000);
    expect(cost).toBeGreaterThan(0);
  });

  it("returns 0 for 0 tokens", () => {
    const cost = estimateCost("gpt-4o", 0, 0);
    expect(cost).toBe(0);
  });
});

describe("checkDailyBudget", () => {
  const policy = defaultPolicy();

  it("allows when under limit", () => {
    const result = checkDailyBudget(1_000_000, policy);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4_000_000);
  });

  it("blocks when over limit", () => {
    const result = checkDailyBudget(6_000_000, policy);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("blocks when exactly at limit", () => {
    const result = checkDailyBudget(5_000_000, policy);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });
});

describe("checkMonthlyBudget", () => {
  const policy = defaultPolicy();

  it("allows when under limit without warning", () => {
    const result = checkMonthlyBudget(10_000_000, policy);
    expect(result.allowed).toBe(true);
    expect(result.warning).toBe(false);
  });

  it("warns at 80% threshold", () => {
    const result = checkMonthlyBudget(40_000_000, policy);
    expect(result.allowed).toBe(true);
    expect(result.warning).toBe(true);
  });

  it("blocks when over limit", () => {
    const result = checkMonthlyBudget(60_000_000, policy);
    expect(result.allowed).toBe(false);
  });
});

describe("requiresBiometric", () => {
  const policy = defaultPolicy();

  it("always requires biometric for high-cost requests", () => {
    const recentAuth = Date.now() - 10_000; // 10 seconds ago
    expect(requiresBiometric(500_000, recentAuth, policy)).toBe(true);
  });

  it("skips biometric for low-cost within auto-approve window", () => {
    const recentAuth = Date.now() - 60_000; // 1 minute ago
    expect(requiresBiometric(100, recentAuth, policy)).toBe(false);
  });

  it("requires biometric for low-cost outside auto-approve window", () => {
    const oldAuth = Date.now() - 600_000; // 10 minutes ago (> 300s default)
    expect(requiresBiometric(100, oldAuth, policy)).toBe(true);
  });
});
