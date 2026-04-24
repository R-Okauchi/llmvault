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

const {
  addKey,
  getKeys,
  getKeySummaries,
  deleteKey,
  updateKey,
} = await import("../keyStore.js");
const { getBindings, setBinding } = await import("../bindingStore.js");

function reset() {
  for (const k of Object.keys(storage)) delete storage[k];
  for (const k of Object.keys(localStorage)) delete localStorage[k];
  uuidCounter = 0;
}

describe("keyStore (post-Phase-17a — no wallet-wide active)", () => {
  beforeEach(reset);

  describe("addKey", () => {
    it("stores the first key as a plain record", async () => {
      await addKey({
        provider: "openai",
        label: "Work",
        apiKey: "sk-w",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4.1-mini",
      });
      const keys = await getKeys();
      expect(keys).toHaveLength(1);
      expect(keys[0].label).toBe("Work");
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

    it("appends the second key without touching the first", async () => {
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
      expect(keys.map((k) => k.label)).toEqual(["Work", "Claude"]);
    });
  });

  describe("deleteKey", () => {
    it("removes the record and leaves siblings intact", async () => {
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
    it("migrates keyquill_providers → keyquill_keys; legacy flags are stripped", async () => {
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
      expect(keys[0].keyId).toMatch(/^uuid-/);
      expect(storage["keyquill_providers"]).toBeUndefined();
      const persisted = (storage["keyquill_keys"] as Array<
        Record<string, unknown>
      >)[0];
      expect(persisted).not.toHaveProperty("isActive");
      expect(persisted).not.toHaveProperty("defaultModel");
    });
  });

  describe("legacy active/default flags on read", () => {
    it("strips `isDefault` + `isActive` from stored v2/v3 records", async () => {
      storage["keyquill_keys"] = [
        {
          keyId: "a",
          provider: "openai",
          label: "Work",
          apiKey: "sk-w",
          baseUrl: "https://api.openai.com/v1",
          defaultModel: "gpt-4o",
          isDefault: true,
          isActive: true,
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
          isActive: false,
          createdAt: 100,
          updatedAt: 300,
        },
      ];
      const keys = await getKeys();
      expect(keys).toHaveLength(2);
      // No record exposes isActive / isDefault any more.
      for (const k of keys) {
        expect(k).not.toHaveProperty("isActive");
        expect(k).not.toHaveProperty("isDefault");
      }
      // Storage has been rewritten without the legacy flags too.
      const persisted = storage["keyquill_keys"] as Array<Record<string, unknown>>;
      for (const p of persisted) {
        expect(p).not.toHaveProperty("isActive");
        expect(p).not.toHaveProperty("isDefault");
      }
    });
  });

  describe("policy migration", () => {
    it("synthesizes a default policy for a new record", async () => {
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
      expect(keys[0].policy?.modelPolicy.defaultModel).toBe("gpt-5.4-mini");
      expect(keys[0].policy?.budget.onBudgetHit).toBe("warn");
      expect(keys[0].policy?.privacy.requireHttps).toBe(true);
      expect(keys[0].policy?.behavior.autoFallback).toBe(true);
      expect(keys[0].policy?.sampling).toBeUndefined();
      expect(keys[0].policyVersion).toBe(3);
    });

    it("addKey without defaultModel leaves policy.modelPolicy.defaultModel unset", async () => {
      // Preset providers can skip defaultModel; resolveKeyDefault falls
      // through to the preset chain at request time.
      await addKey({
        provider: "openai",
        label: "Work",
        apiKey: "sk-w",
        baseUrl: "https://api.openai.com/v1",
      });
      const keys = await getKeys();
      expect(keys[0].policy?.modelPolicy.defaultModel).toBeUndefined();
    });

    it("migrates legacy records with KeyDefaults into policy.sampling + policy.budget", async () => {
      // Pre-Phase-3 storage shape: defaults, no policy, legacy defaultModel.
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
      expect(keys[0].policy?.modelPolicy.defaultModel).toBe("gpt-4o");
      expect(keys[0].policyVersion).toBe(3);
      // Storage should be rewritten with the legacy defaultModel stripped.
      const persisted = (storage["keyquill_keys"] as Array<
        Record<string, unknown>
      >)[0];
      expect(persisted).not.toHaveProperty("defaultModel");
    });

    it("preserves an existing policy instead of overwriting on read (but still strips legacy defaultModel)", async () => {
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
            modelPolicy: {
              mode: "allowlist",
              allowedModels: ["gpt-4o"],
              onViolation: "reject",
              defaultModel: "gpt-4o",
            },
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
      expect(keys[0].policyVersion).toBe(3);
      const persisted = (storage["keyquill_keys"] as Array<
        Record<string, unknown>
      >)[0];
      expect(persisted).not.toHaveProperty("defaultModel");
    });

    it("Phase 13a backfill: copies record.defaultModel into modelPolicy.defaultModel when missing", async () => {
      storage["keyquill_keys"] = [
        {
          keyId: "k1",
          provider: "openai",
          label: "Legacy",
          apiKey: "sk-k1",
          baseUrl: "https://api.openai.com/v1",
          defaultModel: "gpt-5.4-mini",
          isActive: true,
          policy: {
            modelPolicy: { mode: "open", onViolation: "confirm" },
            budget: { onBudgetHit: "warn" },
            privacy: { requireHttps: true, logAuditEvents: true },
            behavior: { autoFallback: true, maxRetries: 2, timeoutMs: 60_000 },
          },
          policyVersion: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ];
      const keys = await getKeys();
      expect(keys[0].policy?.modelPolicy.defaultModel).toBe("gpt-5.4-mini");
      const persisted = (storage["keyquill_keys"] as Array<{
        policy: { modelPolicy: { defaultModel?: string } };
      }>)[0];
      expect(persisted.policy.modelPolicy.defaultModel).toBe("gpt-5.4-mini");
    });

    it("does not overwrite a user-set modelPolicy.defaultModel during migration", async () => {
      storage["keyquill_keys"] = [
        {
          keyId: "k1",
          provider: "openai",
          label: "Custom",
          apiKey: "sk-k1",
          baseUrl: "https://api.openai.com/v1",
          defaultModel: "gpt-5.4-mini", // record-level legacy
          isActive: true,
          policy: {
            modelPolicy: {
              mode: "allowlist",
              allowedModels: ["gpt-5.4-pro"],
              onViolation: "reject",
              defaultModel: "gpt-5.4-pro", // user's pin — wins
            },
            budget: { onBudgetHit: "warn" },
            privacy: { requireHttps: true, logAuditEvents: true },
            behavior: { autoFallback: true, maxRetries: 2, timeoutMs: 60_000 },
          },
          policyVersion: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ];
      const keys = await getKeys();
      expect(keys[0].policy?.modelPolicy.defaultModel).toBe("gpt-5.4-pro");
    });

    it("bumps policyVersion 1 → 2 and strips legacy defaultModel on read", async () => {
      storage["keyquill_keys"] = [
        {
          keyId: "k1",
          provider: "openai",
          label: "v1",
          apiKey: "sk-k1",
          baseUrl: "https://api.openai.com/v1",
          defaultModel: "gpt-4o",
          isActive: true,
          policy: {
            modelPolicy: {
              mode: "open",
              onViolation: "confirm",
              defaultModel: "gpt-4o",
            },
            budget: { onBudgetHit: "warn" },
            privacy: { requireHttps: true, logAuditEvents: true },
            behavior: { autoFallback: true, maxRetries: 2, timeoutMs: 60_000 },
          },
          policyVersion: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      ];
      await getKeys();
      const persisted = (storage["keyquill_keys"] as Array<
        Record<string, unknown>
      >)[0];
      expect(persisted.policyVersion).toBe(3);
      expect(persisted).not.toHaveProperty("defaultModel");
    });
  });

  describe("getKeySummaries effective-default computation", () => {
    it("surfaces resolveKeyDefault's pick as effectiveDefaultModel", async () => {
      await addKey({
        provider: "openai",
        label: "Work",
        apiKey: "sk-w",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-5.4-pro",
      });
      const [summary] = await getKeySummaries();
      expect(summary.effectiveDefaultModel).toBe("gpt-5.4-pro");
    });

    it("falls through to preset default when policy pin is missing", async () => {
      await addKey({
        provider: "anthropic",
        label: "Work",
        apiKey: "sk-ant",
        baseUrl: "https://api.anthropic.com/v1",
      });
      const [summary] = await getKeySummaries();
      expect(summary.effectiveDefaultModel).toBe("claude-sonnet-4-6");
    });
  });
});
