import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for Keyquill SDK v2 — multi-key model with keyId + per-origin bindings.
 *
 * When extensionId is provided via constructor options, resolveExtensionId()
 * returns it immediately (no probing ping). Each SDK method sends exactly ONE
 * postMessage request (isAvailable sends a ping to verify reachability).
 */

type Handler = (event: { source: unknown; origin: string; data: unknown }) => void;
const handlers: Handler[] = [];
const postedMessages: Array<{ type: string; id: string; payload: unknown }> = [];

const mockMeta = { getAttribute: () => "test-ext-id" };

vi.stubGlobal("document", {
  querySelector: (selector: string) => {
    if (selector === 'meta[name="keyquill-extension-id"]') return mockMeta;
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

const { Keyquill } = await import("../client.js");

function simulateResponse(payload: unknown): void {
  const request = postedMessages[postedMessages.length - 1];
  for (const handler of [...handlers]) {
    handler({
      source: fakeWindow,
      origin: "http://localhost:3000",
      data: { type: "keyquill-response", id: request.id, payload },
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
        data: { type: "keyquill-stream-event", id: request.id, payload },
      });
    }
  }
  for (const handler of [...handlers]) {
    handler({
      source: fakeWindow,
      origin: "http://localhost:3000",
      data: { type: "keyquill-stream-close", id: request.id },
    });
  }
}

describe("Keyquill v2 SDK", () => {
  let quill: InstanceType<typeof Keyquill>;

  beforeEach(() => {
    vi.clearAllMocks();
    postedMessages.length = 0;
    handlers.length = 0;
    uuidCounter = 0;
    quill = new Keyquill({ extensionId: "test-ext-id", timeout: 1000 });
  });

  afterEach(() => {
    quill = null as unknown as InstanceType<typeof Keyquill>;
  });

  describe("isAvailable", () => {
    it("returns true when extension responds with pong", async () => {
      const promise = quill.isAvailable();

      await vi.waitFor(() => expect(postedMessages.length).toBe(1));
      expect((postedMessages[0].payload as { type: string }).type).toBe("ping");
      simulateResponse({ type: "pong", version: "0.3.0", protocol: 3 });

      expect(await promise).toBe(true);
    });

    it("returns false when extension does not respond", async () => {
      quill = new Keyquill({ extensionId: "test-ext-id", timeout: 50 });
      expect(await quill.isAvailable()).toBe(false);
    });
  });

  describe("listKeys", () => {
    it("returns key summaries from extension", async () => {
      const keys = [
        {
          keyId: "k1",
          provider: "openai",
          label: "Work",
          baseUrl: "https://api.openai.com/v1",
          effectiveDefaultModel: "gpt-4.1-mini",
          keyHint: "sk-t...est1",
          status: "active" as const,
          createdAt: 1000,
          updatedAt: 1000,
        },
        {
          keyId: "k2",
          provider: "openai",
          label: "Personal",
          baseUrl: "https://api.openai.com/v1",
          effectiveDefaultModel: "gpt-4.1-mini",
          keyHint: "sk-p...est2",
          status: "active" as const,
          createdAt: 2000,
          updatedAt: 2000,
        },
      ];

      const promise = quill.listKeys();

      await vi.waitFor(() => expect(postedMessages.length).toBe(1));
      expect((postedMessages[0].payload as { type: string }).type).toBe("listKeys");
      simulateResponse({ type: "keys", keys });

      const result = await promise;
      expect(result).toHaveLength(2);
      expect(result[0].label).toBe("Work");
      expect(result[0].effectiveDefaultModel).toBe("gpt-4.1-mini");
    });
  });

  describe("testKey", () => {
    it("tests a specific key by keyId", async () => {
      const promise = quill.testKey("key-uuid-123");

      await vi.waitFor(() => expect(postedMessages.length).toBe(1));
      expect(postedMessages[0].payload).toEqual({
        type: "testKey",
        keyId: "key-uuid-123",
      });
      simulateResponse({ type: "testResult", reachable: true });

      expect(await promise).toEqual({ reachable: true });
    });
  });

  describe("chat", () => {
    it("returns { completion, keyId } from extension", async () => {
      const completion = {
        content: "Hello!",
        finish_reason: "stop",
        usage: { promptTokens: 10, completionTokens: 5 },
      };

      const promise = quill.chat({
        messages: [{ role: "user" as const, content: "Hi" }],
      });

      await vi.waitFor(() => expect(postedMessages.length).toBe(1));
      simulateResponse({ type: "chatCompletion", completion, keyId: "k1" });

      const result = await promise;
      expect(result.completion).toEqual(completion);
      expect(result.keyId).toBe("k1");
    });

    it("forwards explicit keyId", async () => {
      const promise = quill.chat({
        keyId: "k2",
        messages: [{ role: "user" as const, content: "Hi" }],
      });

      await vi.waitFor(() => expect(postedMessages.length).toBe(1));
      expect((postedMessages[0].payload as { keyId: string }).keyId).toBe("k2");

      simulateResponse({
        type: "chatCompletion",
        completion: { content: "ok", finish_reason: "stop" },
        keyId: "k2",
      });
      const result = await promise;
      expect(result.keyId).toBe("k2");
    });

    it("throws on error response", async () => {
      const promise = quill.chat({
        messages: [{ role: "user" as const, content: "Hi" }],
      });

      await vi.waitFor(() => expect(postedMessages.length).toBe(1));
      simulateResponse({ type: "error", code: "KEY_NOT_FOUND", message: "No key" });

      await expect(promise).rejects.toThrow("No key");
    });
  });

  describe("preview", () => {
    it("sends a previewPlan request and unwraps the ready preview", async () => {
      const promise = quill.preview({
        messages: [{ role: "user" as const, content: "Hi" }],
        requires: ["reasoning"],
        tone: "precise",
      });

      await vi.waitFor(() => expect(postedMessages.length).toBe(1));
      expect((postedMessages[0].payload as { type: string }).type).toBe("previewPlan");
      expect((postedMessages[0].payload as { tone: string }).tone).toBe("precise");

      simulateResponse({
        type: "planPreview",
        preview: {
          kind: "ready",
          keyId: "k1",
          provider: "openai",
          model: {
            id: "gpt-5.4-pro",
            displayName: "GPT-5.4 Pro",
            capabilities: ["reasoning", "long_context"],
            releaseStage: "stable",
          },
          estimatedCostUSD: 0.012,
          estimatedTokens: { input: 42, output: 512 },
          selectionReason: "capability-match",
        },
      });

      const result = await promise;
      expect(result.kind).toBe("ready");
      if (result.kind !== "ready") throw new Error("expected ready");
      expect(result.model.id).toBe("gpt-5.4-pro");
      expect(result.estimatedCostUSD).toBeCloseTo(0.012);
      expect(result.selectionReason).toBe("capability-match");
    });

    it("surfaces consent-required outcomes without throwing", async () => {
      const promise = quill.preview({
        messages: [{ role: "user" as const, content: "Hi" }],
        prefer: { model: "gpt-5.4-pro" },
      });

      await vi.waitFor(() => expect(postedMessages.length).toBe(1));
      simulateResponse({
        type: "planPreview",
        preview: {
          kind: "consent-required",
          reason: "model-outside-allowlist",
          message: 'Model "gpt-5.4-pro" is not in the allowlist.',
        },
      });

      const result = await promise;
      expect(result.kind).toBe("consent-required");
      if (result.kind !== "consent-required") throw new Error("expected consent-required");
      expect(result.reason).toBe("model-outside-allowlist");
    });

    it("surfaces rejected outcomes without throwing", async () => {
      const promise = quill.preview({
        messages: [{ role: "user" as const, content: "Hi" }],
        requires: ["audio"],
      });

      await vi.waitFor(() => expect(postedMessages.length).toBe(1));
      simulateResponse({
        type: "planPreview",
        preview: {
          kind: "rejected",
          reason: "no-model-matches-capabilities",
          message: "No allowed model satisfies the required capabilities.",
        },
      });

      const result = await promise;
      expect(result.kind).toBe("rejected");
    });

    it("throws on error response", async () => {
      const promise = quill.preview({
        messages: [{ role: "user" as const, content: "Hi" }],
      });

      await vi.waitFor(() => expect(postedMessages.length).toBe(1));
      simulateResponse({ type: "error", code: "KEY_NOT_FOUND", message: "No key" });

      await expect(promise).rejects.toThrow("No key");
    });
  });

  describe("chatStream", () => {
    it("yields start event plus stream events via relay", async () => {
      const events: unknown[] = [];
      const generator = quill.chatStream({
        messages: [{ role: "user" as const, content: "Hi" }],
      });

      const consumePromise = (async () => {
        for await (const event of generator) {
          events.push(event);
          if (event.type === "done") break;
        }
      })();

      await vi.waitFor(() => postedMessages.some((m) => m.type === "keyquill-stream-open"));

      simulateStreamEvents([
        { type: "start", keyId: "k1", provider: "openai", label: "Work" },
        { type: "delta", text: "Hello" },
        { type: "delta", text: " world" },
        { type: "done", finish_reason: "stop" },
      ]);

      await consumePromise;
      expect(events).toHaveLength(4);
      expect(events[0]).toEqual({
        type: "start",
        keyId: "k1",
        provider: "openai",
        label: "Work",
      });
      expect(events[1]).toEqual({ type: "delta", text: "Hello" });
      expect(events[3]).toEqual(expect.objectContaining({ type: "done", finish_reason: "stop" }));
    });

    it("passes keyId + prefer.provider through to the port open payload", async () => {
      const generator = quill.chatStream({
        keyId: "k2",
        prefer: { provider: "anthropic" },
        messages: [{ role: "user" as const, content: "Hi" }],
      });

      const consumePromise = (async () => {
        for await (const _event of generator) {
          /* consume */
        }
      })();

      await vi.waitFor(() => postedMessages.some((m) => m.type === "keyquill-stream-open"));
      const open = postedMessages.find((m) => m.type === "keyquill-stream-open");
      expect(open).toBeDefined();
      const payload = open!.payload as { keyId?: string; prefer?: { provider?: string } };
      expect(payload.keyId).toBe("k2");
      expect(payload.prefer?.provider).toBe("anthropic");

      simulateStreamEvents([{ type: "done", finish_reason: "stop" }]);
      await consumePromise;
    });
  });
});
