import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory mock of chrome.storage.session
const storage: Record<string, unknown> = {};
const localStorage: Record<string, unknown> = {};

const mockChrome = {
  storage: {
    session: {
      get: vi.fn(async (key: string | string[]) => {
        if (typeof key === "string") return { [key]: storage[key] };
        if (Array.isArray(key)) {
          const out: Record<string, unknown> = {};
          for (const k of key) out[k] = storage[k];
          return out;
        }
        return { ...storage };
      }),
      set: vi.fn(async (obj: Record<string, unknown>) => {
        Object.assign(storage, obj);
      }),
      remove: vi.fn(async (key: string | string[]) => {
        const keys = Array.isArray(key) ? key : [key];
        for (const k of keys) delete storage[k];
      }),
    },
    local: {
      get: vi.fn(async (key: string | string[]) => {
        if (typeof key === "string") return { [key]: localStorage[key] };
        if (Array.isArray(key)) {
          const out: Record<string, unknown> = {};
          for (const k of key) out[k] = localStorage[k];
          return out;
        }
        return { ...localStorage };
      }),
      set: vi.fn(async (obj: Record<string, unknown>) => {
        Object.assign(localStorage, obj);
      }),
      remove: vi.fn(async (key: string | string[]) => {
        const keys = Array.isArray(key) ? key : [key];
        for (const k of keys) delete localStorage[k];
      }),
    },
  },
};

// @ts-expect-error — stub global
globalThis.chrome = mockChrome;

let uuidCounter = 0;
if (!globalThis.crypto) {
  // @ts-expect-error — partial mock
  globalThis.crypto = {};
}
globalThis.crypto.randomUUID = () =>
  `uuid-${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`;

const { addKey, getKeys, setActive, deleteKey, updateKey, getActiveKey } = await import(
  "../keyStore.js"
);
const { getBindings, setBinding } = await import("../bindingStore.js");

function reset() {
  for (const k of Object.keys(storage)) delete storage[k];
  for (const k of Object.keys(localStorage)) delete localStorage[k];
  uuidCounter = 0;
}

describe("keyStore v3 (active-key model)", () => {
  beforeEach(reset);

  describe("addKey", () => {
    it("marks the first key as active automatically", async () => {
      await addKey({
        provider: "openai",
        label: "Work",
        apiKey: "sk-w",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4.1-mini",
      });
      const keys = await getKeys();
      expect(keys).toHaveLength(1);
      expect(keys[0].isActive).toBe(true);
    });

    it("rejects empty label", async () => {
      await expect(
        addKey({
          provider: "openai",
          label: "",
          apiKey: "sk-x",
          baseUrl: "https://api.openai.com/v1",
          defaultModel: "gpt-4.1-mini",
        }),
      ).rejects.toThrow(/label is required/);
    });

    it("leaves the existing active key alone when a second is added without flag", async () => {
      await addKey({
        provider: "openai",
        label: "Work",
        apiKey: "sk-w",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4.1-mini",
      });
      await addKey({
        provider: "anthropic",
        label: "Claude",
        apiKey: "ant-k",
        baseUrl: "https://api.anthropic.com/v1",
        defaultModel: "claude-sonnet-4",
      });
      const keys = await getKeys();
      expect(keys).toHaveLength(2);
      expect(keys.find((k) => k.label === "Work")!.isActive).toBe(true);
      expect(keys.find((k) => k.label === "Claude")!.isActive).toBe(false);
    });

    it("demotes the previous active when a new key is added with isActive=true", async () => {
      await addKey({
        provider: "openai",
        label: "Work",
        apiKey: "sk-w",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4.1-mini",
      });
      await addKey({
        provider: "anthropic",
        label: "Claude",
        apiKey: "ant-k",
        baseUrl: "https://api.anthropic.com/v1",
        defaultModel: "claude-sonnet-4",
        isActive: true,
      });
      const keys = await getKeys();
      expect(keys.find((k) => k.label === "Work")!.isActive).toBe(false);
      expect(keys.find((k) => k.label === "Claude")!.isActive).toBe(true);
    });
  });

  describe("setActive", () => {
    it("switches the wallet-wide active key exclusively", async () => {
      await addKey({
        provider: "openai",
        label: "Work",
        apiKey: "sk-w",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4.1-mini",
      });
      const personal = await addKey({
        provider: "openai",
        label: "Personal",
        apiKey: "sk-p",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4.1-mini",
      });
      await addKey({
        provider: "anthropic",
        label: "Claude",
        apiKey: "ant-k",
        baseUrl: "https://api.anthropic.com/v1",
        defaultModel: "claude-sonnet-4",
      });

      await setActive(personal.keyId);
      const keys = await getKeys();
      expect(keys.filter((k) => k.isActive).map((k) => k.label)).toEqual(["Personal"]);
    });
  });

  describe("getActiveKey", () => {
    it("returns the active key, regardless of provider", async () => {
      await addKey({
        provider: "openai",
        label: "Work",
        apiKey: "sk-w",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4.1-mini",
      });
      const anth = await addKey({
        provider: "anthropic",
        label: "Claude",
        apiKey: "ant-k",
        baseUrl: "https://api.anthropic.com/v1",
        defaultModel: "claude-sonnet-4",
        isActive: true,
      });
      const active = await getActiveKey();
      expect(active?.keyId).toBe(anth.keyId);
      expect(active?.label).toBe("Claude");
    });

    it("returns null for empty wallet", async () => {
      const active = await getActiveKey();
      expect(active).toBeNull();
    });
  });

  describe("deleteKey", () => {
    it("promotes most-recently-updated sibling when the active key is deleted", async () => {
      const work = await addKey({
        provider: "openai",
        label: "Work",
        apiKey: "sk-w",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4.1-mini",
      });
      const personal = await addKey({
        provider: "openai",
        label: "Personal",
        apiKey: "sk-p",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4.1-mini",
      });
      await updateKey({ keyId: personal.keyId, label: "Personal (updated)" });
      await deleteKey(work.keyId);
      const keys = await getKeys();
      expect(keys).toHaveLength(1);
      expect(keys[0].label).toBe("Personal (updated)");
      expect(keys[0].isActive).toBe(true);
    });

    it("cascades: drops bindings that referenced the deleted key", async () => {
      const work = await addKey({
        provider: "openai",
        label: "Work",
        apiKey: "sk-w",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4.1-mini",
      });
      const personal = await addKey({
        provider: "openai",
        label: "Personal",
        apiKey: "sk-p",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4.1-mini",
      });
      await setBinding("https://github.com", work.keyId);
      await setBinding("https://claude.ai", work.keyId);
      await setBinding("https://example.com", personal.keyId);

      await deleteKey(work.keyId);

      const bindings = await getBindings();
      expect(bindings).toHaveLength(1);
      expect(bindings[0].origin).toBe("https://example.com");
      expect(bindings[0].keyId).toBe(personal.keyId);
    });
  });

  describe("v1 migration", () => {
    it("migrates keyquill_providers → keyquill_keys with first entry active", async () => {
      storage["keyquill_providers"] = [
        {
          provider: "openai",
          apiKey: "sk-old",
          baseUrl: "https://api.openai.com/v1",
          defaultModel: "gpt-4o",
          label: "Legacy",
          createdAt: 100,
          updatedAt: 100,
        },
      ];
      const keys = await getKeys();
      expect(keys).toHaveLength(1);
      expect(keys[0].label).toBe("Legacy");
      expect(keys[0].isActive).toBe(true);
      expect(keys[0].keyId).toMatch(/^uuid-/);
      expect(storage["keyquill_providers"]).toBeUndefined();
    });
  });

  describe("v2 migration (isDefault → isActive)", () => {
    it("coerces v2 records: most-recently-updated per-provider default becomes active", async () => {
      storage["keyquill_keys"] = [
        {
          keyId: "a",
          provider: "openai",
          label: "Work",
          apiKey: "sk-w",
          baseUrl: "https://api.openai.com/v1",
          defaultModel: "gpt-4o",
          isDefault: true,
          createdAt: 100,
          updatedAt: 200,
        },
        {
          keyId: "b",
          provider: "anthropic",
          label: "Claude",
          apiKey: "ant-k",
          baseUrl: "https://api.anthropic.com/v1",
          defaultModel: "claude-sonnet-4",
          isDefault: true,
          createdAt: 100,
          updatedAt: 300, // more recent
        },
      ];
      const keys = await getKeys();
      expect(keys.find((k) => k.keyId === "a")!.isActive).toBe(false);
      expect(keys.find((k) => k.keyId === "b")!.isActive).toBe(true);
    });

    it("v2 records with no defaults → first entry becomes active", async () => {
      storage["keyquill_keys"] = [
        {
          keyId: "a",
          provider: "openai",
          label: "Work",
          apiKey: "sk-w",
          baseUrl: "https://api.openai.com/v1",
          defaultModel: "gpt-4o",
          createdAt: 100,
          updatedAt: 100,
        },
        {
          keyId: "b",
          provider: "anthropic",
          label: "Claude",
          apiKey: "ant-k",
          baseUrl: "https://api.anthropic.com/v1",
          defaultModel: "claude-sonnet-4",
          createdAt: 200,
          updatedAt: 200,
        },
      ];
      const keys = await getKeys();
      expect(keys[0].isActive).toBe(true);
      expect(keys[1].isActive).toBe(false);
    });
  });

  describe("policy migration (Phase 3)", () => {
    it("synthesizes a default policy for a new record with no defaults", async () => {
      await addKey({
        provider: "openai",
        label: "Work",
        apiKey: "sk-w",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-5.4-mini",
      });
      const keys = await getKeys();
      expect(keys[0].policy).toBeDefined();
      expect(keys[0].policy?.modelPolicy.mode).toBe("open");
      expect(keys[0].policy?.budget.onBudgetHit).toBe("warn");
      expect(keys[0].policy?.privacy.requireHttps).toBe(true);
      expect(keys[0].policy?.behavior.autoFallback).toBe(true);
      expect(keys[0].policy?.sampling).toBeUndefined();
      expect(keys[0].policyVersion).toBe(1);
    });

    it("maps KeyDefaults.temperature → policy.sampling.temperature", async () => {
      await addKey({
        provider: "openai",
        label: "Work",
        apiKey: "sk-w",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4o",
        defaults: { temperature: 0.3, topP: 0.9 },
      });
      const keys = await getKeys();
      expect(keys[0].policy?.sampling).toEqual({ temperature: 0.3, topP: 0.9 });
    });

    it("maps KeyDefaults.reasoningEffort → policy.budget.maxReasoningEffort", async () => {
      await addKey({
        provider: "openai",
        label: "Work",
        apiKey: "sk-w",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-5.4-pro",
        defaults: { reasoningEffort: "medium" },
      });
      const keys = await getKeys();
      expect(keys[0].policy?.budget.maxReasoningEffort).toBe("medium");
    });

    it("backfills policy on legacy records (pre-policy storage read)", async () => {
      // Pretend storage was written by a pre-Phase-3 build: defaults, no policy.
      storage["keyquill_keys"] = [
        {
          keyId: "legacy-1",
          provider: "openai",
          label: "Legacy",
          apiKey: "sk-old",
          baseUrl: "https://api.openai.com/v1",
          defaultModel: "gpt-4o",
          isActive: true,
          defaults: { temperature: 0.7, reasoningEffort: "high" },
          createdAt: 1,
          updatedAt: 1,
        },
      ];
      const keys = await getKeys();
      expect(keys[0].policy).toBeDefined();
      expect(keys[0].policy?.sampling?.temperature).toBe(0.7);
      expect(keys[0].policy?.budget.maxReasoningEffort).toBe("high");
      expect(keys[0].policyVersion).toBe(1);
      // Storage should be rewritten with policy in place so subsequent
      // reads don't re-synthesize.
      const persisted = (storage["keyquill_keys"] as Array<{ policy?: unknown }>)[0];
      expect(persisted.policy).toBeDefined();
    });

    it("preserves an existing policy instead of overwriting on read", async () => {
      storage["keyquill_keys"] = [
        {
          keyId: "k1",
          provider: "openai",
          label: "Custom",
          apiKey: "sk-k1",
          baseUrl: "https://api.openai.com/v1",
          defaultModel: "gpt-4o",
          isActive: true,
          policy: {
            modelPolicy: { mode: "allowlist", allowedModels: ["gpt-4o"], onViolation: "reject" },
            budget: { monthlyBudgetUSD: 5, onBudgetHit: "block" },
            privacy: { requireHttps: true, logAuditEvents: true },
            behavior: { autoFallback: false, maxRetries: 0, timeoutMs: 30_000 },
          },
          policyVersion: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ];
      const keys = await getKeys();
      expect(keys[0].policy?.modelPolicy.mode).toBe("allowlist");
      expect(keys[0].policy?.budget.monthlyBudgetUSD).toBe(5);
      expect(keys[0].policy?.behavior.autoFallback).toBe(false);
    });

    it("updateKey re-syncs policy.sampling when defaults change", async () => {
      const k = await addKey({
        provider: "openai",
        label: "Work",
        apiKey: "sk-w",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4o",
        defaults: { temperature: 0.5 },
      });
      await updateKey({ keyId: k.keyId, defaults: { temperature: 0.9, topP: 0.5 } });
      const after = await getKeys();
      expect(after[0].policy?.sampling).toEqual({ temperature: 0.9, topP: 0.5 });
    });

    it("updateKey clears policy.sampling when every default is set undefined", async () => {
      const k = await addKey({
        provider: "openai",
        label: "Work",
        apiKey: "sk-w",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4o",
        defaults: { temperature: 0.5 },
      });
      // updateKey treats input.defaults as a shallow merge; explicitly
      // setting a key to undefined strips it. To clear all sampling,
      // undefine each field.
      await updateKey({
        keyId: k.keyId,
        defaults: { temperature: undefined, topP: undefined, reasoningEffort: undefined },
      });
      const after = await getKeys();
      expect(after[0].policy?.sampling).toBeUndefined();
    });

    it("updateKey preserves user-edited modelPolicy even when defaults change", async () => {
      // Seed a record that has both defaults AND a custom modelPolicy.
      storage["keyquill_keys"] = [
        {
          keyId: "k1",
          provider: "openai",
          label: "Custom",
          apiKey: "sk-k1",
          baseUrl: "https://api.openai.com/v1",
          defaultModel: "gpt-4o",
          isActive: true,
          defaults: { temperature: 0.5 },
          policy: {
            modelPolicy: { mode: "allowlist", allowedModels: ["gpt-4o"], onViolation: "reject" },
            budget: { onBudgetHit: "warn" },
            privacy: { requireHttps: true, logAuditEvents: true },
            sampling: { temperature: 0.5 },
            behavior: { autoFallback: true, maxRetries: 2, timeoutMs: 60_000 },
          },
          policyVersion: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ];
      await updateKey({ keyId: "k1", defaults: { temperature: 0.9 } });
      const after = await getKeys();
      // sampling updated…
      expect(after[0].policy?.sampling?.temperature).toBe(0.9);
      // …but modelPolicy.mode preserved.
      expect(after[0].policy?.modelPolicy.mode).toBe("allowlist");
      expect(after[0].policy?.modelPolicy.allowedModels).toEqual(["gpt-4o"]);
    });
  });
});
