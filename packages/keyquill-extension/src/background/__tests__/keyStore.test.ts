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

// crypto.randomUUID must be available on the global
let uuidCounter = 0;
if (!globalThis.crypto) {
  // @ts-expect-error — partial mock
  globalThis.crypto = {};
}
globalThis.crypto.randomUUID = () =>
  `uuid-${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`;

const { addKey, getKeys, setDefault, deleteKey, updateKey, getDefaultKeyForProvider } =
  await import("../keyStore.js");
const { getBindings, setBinding } = await import("../bindingStore.js");

function reset() {
  for (const k of Object.keys(storage)) delete storage[k];
  for (const k of Object.keys(localStorage)) delete localStorage[k];
  uuidCounter = 0;
}

describe("keyStore v2", () => {
  beforeEach(reset);

  describe("addKey", () => {
    it("creates a key and marks it as default when first for provider", async () => {
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
      expect(keys[0].isDefault).toBe(true);
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

    it("keeps first key as default when second is added without explicit flag", async () => {
      await addKey({
        provider: "openai",
        label: "Work",
        apiKey: "sk-w",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4.1-mini",
      });
      await addKey({
        provider: "openai",
        label: "Personal",
        apiKey: "sk-p",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4.1-mini",
      });
      const keys = await getKeys();
      expect(keys).toHaveLength(2);
      const work = keys.find((k) => k.label === "Work")!;
      const personal = keys.find((k) => k.label === "Personal")!;
      expect(work.isDefault).toBe(true);
      expect(personal.isDefault).toBe(false);
    });

    it("demotes sibling when new key is added with isDefault=true", async () => {
      await addKey({
        provider: "openai",
        label: "Work",
        apiKey: "sk-w",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4.1-mini",
      });
      await addKey({
        provider: "openai",
        label: "Personal",
        apiKey: "sk-p",
        baseUrl: "https://api.openai.com/v1",
        defaultModel: "gpt-4.1-mini",
        isDefault: true,
      });
      const keys = await getKeys();
      const work = keys.find((k) => k.label === "Work")!;
      const personal = keys.find((k) => k.label === "Personal")!;
      expect(personal.isDefault).toBe(true);
      expect(work.isDefault).toBe(false);
    });
  });

  describe("setDefault", () => {
    it("toggles default within the same provider, leaves other providers untouched", async () => {
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
        label: "Claude Work",
        apiKey: "ant-w",
        baseUrl: "https://api.anthropic.com/v1",
        defaultModel: "claude-sonnet-4",
      });

      await setDefault(personal.keyId);
      const keys = await getKeys();
      expect(keys.find((k) => k.label === "Personal")!.isDefault).toBe(true);
      expect(keys.find((k) => k.label === "Work")!.isDefault).toBe(false);
      // anthropic key should still be default within its provider
      expect(keys.find((k) => k.label === "Claude Work")!.isDefault).toBe(true);
    });
  });

  describe("deleteKey", () => {
    it("promotes most-recently-updated sibling when a default is deleted", async () => {
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
      expect(keys[0].isDefault).toBe(true);
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

  describe("getDefaultKeyForProvider", () => {
    it("returns the default for a given provider, ignoring others", async () => {
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

      const openai = await getDefaultKeyForProvider("openai");
      expect(openai?.label).toBe("Work");
      const anthropic = await getDefaultKeyForProvider("anthropic");
      expect(anthropic?.label).toBe("Claude");
      const missing = await getDefaultKeyForProvider("groq");
      expect(missing).toBeNull();
    });
  });

  describe("v1 migration", () => {
    it("migrates keyquill_providers → keyquill_keys with auto default", async () => {
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
      expect(keys[0].isDefault).toBe(true);
      expect(keys[0].keyId).toMatch(/^uuid-/);
      expect(storage["keyquill_providers"]).toBeUndefined();
      expect(Array.isArray(storage["keyquill_keys"])).toBe(true);
    });
  });
});
