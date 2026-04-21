import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for LLMVault SDK — relay-based messaging via window.postMessage.
 *
 * When extensionId is provided via constructor options, resolveExtensionId()
 * returns it immediately (no ping). Each SDK method sends exactly ONE
 * postMessage request (isAvailable sends a ping to verify reachability).
 */

type Handler = (event: { source: unknown; origin: string; data: unknown }) => void;
const handlers: Handler[] = [];
const postedMessages: Array<{ type: string; id: string; payload: unknown }> = [];

const mockMeta = { getAttribute: () => "test-ext-id" };

vi.stubGlobal("document", {
  querySelector: (selector: string) => {
    if (selector === 'meta[name="llmvault-extension-id"]') return mockMeta;
    return null;
  },
});

let uuidCounter = 0;
vi.stubGlobal("crypto", {
  randomUUID: () => `test-uuid-${++uuidCounter}`,
});

vi.stubGlobal("location", { origin: "http://localhost:3000" });

const fakeWindow = {
  addEventListener: (type: string, handler: Handler) => {
    if (type === "message") handlers.push(handler);
  },
  removeEventListener: (type: string, handler: Handler) => {
    if (type === "message") {
      const idx = handlers.indexOf(handler);
      if (idx >= 0) handlers.splice(idx, 1);
    }
  },
  postMessage: (data: unknown, _origin: string) => {
    postedMessages.push(data as { type: string; id: string; payload: unknown });
  },
};
vi.stubGlobal("window", fakeWindow);

const { LLMVault } = await import("../client.js");

function simulateResponse(payload: unknown): void {
  const request = postedMessages[postedMessages.length - 1];
  for (const handler of [...handlers]) {
    handler({
      source: fakeWindow,
      origin: "http://localhost:3000",
      data: { type: "llmvault-response", id: request.id, payload },
    });
  }
}

function simulateStreamEvents(events: unknown[]): void {
  const request = postedMessages[postedMessages.length - 1];
  for (const payload of events) {
    for (const handler of [...handlers]) {
      handler({
        source: fakeWindow,
        origin: "http://localhost:3000",
        data: { type: "llmvault-stream-event", id: request.id, payload },
      });
    }
  }
  for (const handler of [...handlers]) {
    handler({
      source: fakeWindow,
      origin: "http://localhost:3000",
      data: { type: "llmvault-stream-close", id: request.id },
    });
  }
}

describe("LLMVault", () => {
  let vault: InstanceType<typeof LLMVault>;

  beforeEach(() => {
    vi.clearAllMocks();
    postedMessages.length = 0;
    handlers.length = 0;
    uuidCounter = 0;
    vault = new LLMVault({ extensionId: "test-ext-id", timeout: 1000 });
  });

  afterEach(() => {
    vault = null as unknown as InstanceType<typeof LLMVault>;
  });

  describe("isAvailable", () => {
    it("returns true when extension responds with pong", async () => {
      const promise = vault.isAvailable();

      // extensionId is set, so resolveExtensionId returns immediately.
      // isAvailable sends ONE ping to verify reachability.
      await vi.waitFor(() => expect(postedMessages.length).toBe(1));
      expect((postedMessages[0].payload as { type: string }).type).toBe("ping");
      simulateResponse({ type: "pong", version: "0.2.0" });

      expect(await promise).toBe(true);
    });

    it("returns false when extension does not respond", async () => {
      vault = new LLMVault({ extensionId: "test-ext-id", timeout: 50 });
      expect(await vault.isAvailable()).toBe(false);
    });
  });

  describe("listProviders", () => {
    it("returns providers from extension", async () => {
      const providers = [
        {
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          defaultModel: "gpt-4.1-mini",
          status: "active",
          keyHint: "****",
          label: "My OpenAI Key",
          createdAt: 1000,
          updatedAt: 1000,
        },
      ];

      const promise = vault.listProviders();

      await vi.waitFor(() => expect(postedMessages.length).toBe(1));
      expect((postedMessages[0].payload as { type: string }).type).toBe("listProviders");
      simulateResponse({ type: "providers", providers });

      expect(await promise).toEqual(providers);
    });
  });

  describe("registerKey", () => {
    it("throws with guidance to use extension popup", async () => {
      await expect(
        vault.registerKey("openai", {
          apiKey: "sk-test",
          baseUrl: "https://api.openai.com/v1",
          defaultModel: "gpt-4.1-mini",
        }),
      ).rejects.toThrow("extension popup");
    });

    it("does not send any postMessage", async () => {
      try {
        await vault.registerKey("openai", {
          apiKey: "sk-test",
          baseUrl: "https://api.openai.com/v1",
          defaultModel: "gpt-4.1-mini",
        });
      } catch {
        // expected
      }
      expect(postedMessages).toHaveLength(0);
    });
  });

  describe("deleteKey", () => {
    it("sends deleteKey message", async () => {
      const promise = vault.deleteKey("openai");

      await vi.waitFor(() => expect(postedMessages.length).toBe(1));
      expect(postedMessages[0].payload).toEqual({
        type: "deleteKey",
        provider: "openai",
      });
      simulateResponse({ type: "ok" });

      await promise;
    });
  });

  describe("testKey", () => {
    it("returns reachable status", async () => {
      const promise = vault.testKey("openai");

      await vi.waitFor(() => expect(postedMessages.length).toBe(1));
      simulateResponse({ type: "testResult", reachable: true });

      expect(await promise).toEqual({ reachable: true });
    });
  });

  describe("chat", () => {
    it("returns chat completion from extension", async () => {
      const completion = {
        content: "Hello!",
        finish_reason: "stop",
        usage: { promptTokens: 10, completionTokens: 5 },
      };

      const promise = vault.chat({
        messages: [{ role: "user" as const, content: "Hi" }],
      });

      await vi.waitFor(() => expect(postedMessages.length).toBe(1));
      simulateResponse({ type: "chatCompletion", completion });

      expect(await promise).toEqual(completion);
    });

    it("throws on error response", async () => {
      const promise = vault.chat({
        messages: [{ role: "user" as const, content: "Hi" }],
      });

      await vi.waitFor(() => expect(postedMessages.length).toBe(1));
      simulateResponse({ type: "error", code: "PROVIDER_NOT_FOUND", message: "No provider" });

      await expect(promise).rejects.toThrow("No provider");
    });
  });

  describe("chatStream", () => {
    it("yields stream events via relay", async () => {
      const events: unknown[] = [];
      const generator = vault.chatStream({
        messages: [{ role: "user" as const, content: "Hi" }],
      });

      const consumePromise = (async () => {
        for await (const event of generator) {
          events.push(event);
          if (event.type === "done") break;
        }
      })();

      // chatStream opens a stream-open message
      await vi.waitFor(() => postedMessages.some((m) => m.type === "llmvault-stream-open"));

      simulateStreamEvents([
        { type: "delta", text: "Hello" },
        { type: "delta", text: " world" },
        { type: "done", finish_reason: "stop" },
      ]);

      await consumePromise;
      expect(events).toHaveLength(3);
      expect(events[0]).toEqual({ type: "delta", text: "Hello" });
      expect(events[1]).toEqual({ type: "delta", text: " world" });
      expect(events[2]).toEqual(expect.objectContaining({ type: "done", finish_reason: "stop" }));
    });
  });
});
