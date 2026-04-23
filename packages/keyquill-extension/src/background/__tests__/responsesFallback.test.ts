/**
 * Verifies the /chat/completions → /responses fallback path end-to-end
 * in handleChat. Uses a real in-process Node HTTP server so the actual
 * global `fetch` is exercised; only chrome storage (keyStore) is stubbed.
 *
 * Without secrets and without network access, this test asserts that a
 * future OpenAI pro model that isn't yet in OPENAI_RESPONSES_ONLY still
 * works for end users via the runtime fallback.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import type { KeyRecord } from "../../shared/protocol.js";

// Use a catalogued chat-endpoint model as the base. Test #1 simulates
// OpenAI deprecating it to pro-only (server returns fallback 404); the
// retry must rebuild the body against /responses.
const testKey: KeyRecord = {
  keyId: "k-test",
  provider: "openai",
  label: "test",
  apiKey: "sk-test",
  baseUrl: "", // set after server boots
  defaultModel: "gpt-5.4-mini",
  createdAt: 0,
  updatedAt: 0,
};

vi.mock("../keyStore.js", () => ({
  getKey: vi.fn(async (id: string) => (id === testKey.keyId ? testKey : null)),
  getActiveKey: vi.fn(async () => null),
}));

vi.mock("../bindingStore.js", () => ({
  getBinding: vi.fn(async () => null),
  touchBindingUsage: vi.fn(async () => {}),
}));

// Ledger uses chrome.storage.local + navigator.locks; stub the module
// entirely so the 404-fallback test stays focused on endpoint routing.
vi.mock("../ledger.js", () => ({
  appendEntry: vi.fn(async () => {}),
  queryByKey: vi.fn(async () => []),
  getMonthSpend: vi.fn(async () => 0),
  getDailySpend: vi.fn(async () => 0),
  clearByKey: vi.fn(async () => {}),
  getOriginSummary: vi.fn(async () => []),
  exportCSV: vi.fn(async () => ""),
}));

type Handler = (req: {
  url: string;
  method: string;
  body: string;
}) => { status: number; body: string; headers?: Record<string, string> };

let server: Server;
let baseUrl: string;
let handler: Handler;
const calls: Array<{ url: string; method: string; body: string }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "";
      const method = req.method ?? "GET";
      calls.push({ url, method, body });
      const { status, body: respBody, headers } = handler({ url, method, body });
      res.writeHead(status, {
        "Content-Type": "application/json",
        ...(headers ?? {}),
      });
      res.end(respBody);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}/v1`;
  testKey.baseUrl = baseUrl;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe("handleChat 404 → /responses fallback", () => {
  it("retries once on /responses when /chat/completions 404s with the fallback signal", async () => {
    // Import after mocks are registered.
    const { handleChat } = await import("../streamManager.js");

    calls.length = 0;
    handler = ({ url }) => {
      if (url.endsWith("/chat/completions")) {
        return {
          status: 404,
          body: JSON.stringify({
            error: {
              message:
                "This is not a chat model and thus not supported in the v1/chat/completions endpoint. Did you mean to use v1/completions?",
              type: "invalid_request_error",
            },
          }),
        };
      }
      if (url.endsWith("/responses")) {
        return {
          status: 200,
          body: JSON.stringify({
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "pong" }],
              },
            ],
            usage: { input_tokens: 3, output_tokens: 2 },
          }),
        };
      }
      return { status: 500, body: '{"error":"unexpected"}' };
    };

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await handleChat(
      {
        type: "chat",
        keyId: testKey.keyId,
        messages: [{ role: "user", content: "hi" }],
      },
      "__internal__",
    );
    warn.mockRestore();

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("/chat/completions");
    expect(calls[1].url).toContain("/responses");
    // Verify the retry used the Responses body shape, not the chat body.
    const retryBody = JSON.parse(calls[1].body);
    expect(retryBody.input).toBeDefined();
    expect(retryBody.messages).toBeUndefined();
    expect(retryBody.max_output_tokens).toBeDefined();

    expect(res.type).toBe("chatCompletion");
    if (res.type === "chatCompletion") {
      expect(res.completion.content).toBe("pong");
    }
  });

  it("does NOT fall back on 404s whose body does not match the signal", async () => {
    const { handleChat } = await import("../streamManager.js");

    calls.length = 0;
    handler = ({ url }) => {
      if (url.endsWith("/chat/completions")) {
        return {
          status: 404,
          body: JSON.stringify({ error: { message: "model not found" } }),
        };
      }
      return { status: 500, body: '{"error":"unexpected"}' };
    };

    const res = await handleChat(
      {
        type: "chat",
        keyId: testKey.keyId,
        messages: [{ role: "user", content: "hi" }],
      },
      "__internal__",
    );
    expect(calls).toHaveLength(1);
    expect(res.type).toBe("error");
  });

  it("pro models route directly to /responses without a fallback roundtrip", async () => {
    const { handleChat } = await import("../streamManager.js");

    calls.length = 0;
    handler = ({ url }) => {
      if (url.endsWith("/responses")) {
        return {
          status: 200,
          body: JSON.stringify({
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "pong-pro" }],
              },
            ],
          }),
        };
      }
      return { status: 500, body: '{"error":"unexpected"}' };
    };

    const res = await handleChat(
      {
        type: "chat",
        keyId: testKey.keyId,
        model: "gpt-5.4-pro",
        messages: [{ role: "user", content: "hi" }],
      },
      "__internal__",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/responses");
    expect(res.type).toBe("chatCompletion");
    if (res.type === "chatCompletion") {
      expect(res.completion.content).toBe("pong-pro");
    }
  });
});
