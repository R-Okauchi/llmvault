import { describe, it, expect } from "vitest";
import {
  buildProviderTestFetch,
  isOpenAIReasoningModel,
  isResponsesFallbackSignal,
  parseAnthropicCompletion,
  parseOpenAiResponsesCompletion,
  sanitizeErrorText,
} from "../providerFetch.js";
import { PRESETS } from "../../shared/presets.js";
import { INTEGRATION_TARGETS } from "./integrationTargets.js";
import { mkKey } from "./testHelpers.js";

// Body construction for chat / responses / anthropic lives in resolver.ts
// since Phase 6; those paths are exercised in resolver.test.ts. This file
// only covers the shared helpers that survived the cutover.

// ── isOpenAIReasoningModel (catalog + regex fallback) ──

describe("isOpenAIReasoningModel", () => {
  it("catalog path: known reasoning models return true", () => {
    for (const m of [
      "gpt-5.4-mini",
      "gpt-5.4-pro",
      "gpt-5-mini",
      "gpt-5-pro",
      "o3-mini",
      "o3-pro",
      "o4-mini",
    ]) {
      expect(isOpenAIReasoningModel(m)).toBe(true);
    }
  });

  it("catalog path: known legacy models return false", () => {
    for (const m of ["gpt-4o", "gpt-4o-mini"]) {
      expect(isOpenAIReasoningModel(m)).toBe(false);
    }
  });

  it("catalog path: non-openai models return false even if reasoning-capable", () => {
    expect(isOpenAIReasoningModel("claude-sonnet-4-6")).toBe(false);
    expect(isOpenAIReasoningModel("deepseek-reasoner")).toBe(false);
  });

  it("fallback path: uncatalogued reasoning-style names match regex", () => {
    for (const m of ["o1", "o1-mini", "o1-preview", "gpt-5.2", "gpt-5-thinking"]) {
      expect(isOpenAIReasoningModel(m)).toBe(true);
    }
  });

  it("fallback path: unrelated names return false", () => {
    for (const m of ["gpt-3.5-turbo", "claude-sonnet-4-6", "llama-3.3", "some-future-model"]) {
      expect(isOpenAIReasoningModel(m)).toBe(false);
    }
  });
});

// ── Provider test fetch (popup Test button) ────────────

describe("buildProviderTestFetch", () => {
  it("builds GET /models with Bearer for OpenAI-compat providers", () => {
    const p = buildProviderTestFetch(
      mkKey({ provider: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-xx" }),
    );
    expect(p.url).toBe("https://api.openai.com/v1/models");
    expect(p.method).toBe("GET");
    expect(p.headers["Authorization"]).toBe("Bearer sk-xx");
  });

  it("builds GET /models with x-api-key for Anthropic", () => {
    const p = buildProviderTestFetch(
      mkKey({ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKey: "ant-xx" }),
    );
    expect(p.url).toBe("https://api.anthropic.com/v1/models");
    expect(p.headers["x-api-key"]).toBe("ant-xx");
    expect(p.headers["anthropic-version"]).toBeDefined();
    expect(p.headers["Authorization"]).toBeUndefined();
  });

  it("trims trailing slashes on baseUrl", () => {
    const p = buildProviderTestFetch(mkKey({ baseUrl: "https://api.openai.com/v1/" }));
    expect(p.url).toBe("https://api.openai.com/v1/models");
  });
});

// ── Error text sanitization ────────────────────────────

describe("sanitizeErrorText", () => {
  it("redacts Bearer tokens", () => {
    expect(sanitizeErrorText("Bearer sk-abc.def-123")).toBe("Bearer [REDACTED]");
  });

  it("redacts sk-* keys", () => {
    expect(sanitizeErrorText("key=sk-abcdefghijkl missing")).toContain("[REDACTED]");
  });

  it("preserves semantic error text", () => {
    expect(sanitizeErrorText("not a chat model; use v1/responses")).toBe(
      "not a chat model; use v1/responses",
    );
  });
});

// ── 404 fallback signal heuristic ──────────────────────

describe("isResponsesFallbackSignal", () => {
  it("matches OpenAI's 'not a chat model' 404", () => {
    expect(
      isResponsesFallbackSignal(
        404,
        JSON.stringify({ error: { message: "This is not a chat model..." } }),
      ),
    ).toBe(true);
  });

  it("matches 404 bodies mentioning v1/responses", () => {
    expect(isResponsesFallbackSignal(404, "Did you mean v1/responses?")).toBe(true);
  });

  it("ignores non-404 statuses", () => {
    expect(isResponsesFallbackSignal(400, "not a chat model")).toBe(false);
  });

  it("ignores unrelated 404 bodies", () => {
    expect(isResponsesFallbackSignal(404, "model not found")).toBe(false);
  });
});

// ── Anthropic non-streaming parser ─────────────────────

describe("parseAnthropicCompletion", () => {
  it("concatenates text content blocks", () => {
    const out = parseAnthropicCompletion({
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: " world" },
      ],
      usage: { input_tokens: 5, output_tokens: 2 },
    });
    expect(out.content).toBe("hello world");
    expect(out.finish_reason).toBe("stop");
    expect(out.usage).toEqual({ promptTokens: 5, completionTokens: 2 });
  });

  it("extracts tool_use blocks into tool_calls", () => {
    const out = parseAnthropicCompletion({
      content: [
        { type: "tool_use", id: "tc1", name: "f", input: { x: 1 } },
      ],
      stop_reason: "tool_use",
    });
    expect(out.tool_calls).toEqual([
      { id: "tc1", type: "function", function: { name: "f", arguments: '{"x":1}' } },
    ]);
    expect(out.finish_reason).toBe("tool_calls");
  });
});

// ── OpenAI Responses non-streaming parser ──────────────

describe("parseOpenAiResponsesCompletion", () => {
  it("concatenates output_text parts across message items", () => {
    const out = parseOpenAiResponsesCompletion({
      status: "completed",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "pong" },
            { type: "output_text", text: "!" },
          ],
        },
      ],
      usage: { input_tokens: 3, output_tokens: 2 },
    });
    expect(out.content).toBe("pong!");
    expect(out.finish_reason).toBe("stop");
    expect(out.usage).toEqual({ promptTokens: 3, completionTokens: 2 });
  });

  it("function_call items become tool_calls", () => {
    const out = parseOpenAiResponsesCompletion({
      status: "completed",
      output: [
        { type: "function_call", call_id: "call_1", name: "f", arguments: '{"x":1}' },
      ],
    });
    expect(out.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "f", arguments: '{"x":1}' } },
    ]);
    expect(out.finish_reason).toBe("tool_calls");
  });

  it("incomplete + max_output_tokens reason maps to length", () => {
    const out = parseOpenAiResponsesCompletion({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [],
    });
    expect(out.finish_reason).toBe("length");
  });
});

// ── Integration-target coverage guard ──────────────────

describe("integration target coverage", () => {
  it("every non-custom preset has a matching integration target", () => {
    const missing = PRESETS.filter(
      (p) => p.id !== "custom" && !INTEGRATION_TARGETS.some((t) => t.id === p.id),
    );
    expect(missing.map((p) => p.id)).toEqual([]);
  });

  it("every integration target's env var name is non-empty", () => {
    for (const t of INTEGRATION_TARGETS) {
      expect(t.env).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(t.chatModels.length).toBeGreaterThan(0);
    }
  });
});
