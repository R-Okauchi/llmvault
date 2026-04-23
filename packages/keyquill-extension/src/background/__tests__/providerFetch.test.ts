import { describe, it, expect } from "vitest";
import {
  buildProviderFetch,
  buildProviderTestFetch,
  normalizeParams,
  isOpenAIReasoningModel,
  selectOpenAIEndpoint,
  parseOpenAiResponsesCompletion,
  sanitizeErrorText,
  isResponsesFallbackSignal,
} from "../providerFetch.js";
import {
  parseOpenAiResponsesStreamEvent,
  parseOpenAiStreamEvent,
  parseAnthropicStreamEvent,
} from "../streamParsers.js";
import { PRESETS } from "../../shared/presets.js";
import { INTEGRATION_TARGETS } from "./integrationTargets.js";
import { mkKey, mockPort } from "./testHelpers.js";

describe("normalizeParams", () => {
  it("uses request values when provided", () => {
    const out = normalizeParams(
      {
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.3,
        top_p: 0.9,
        reasoning_effort: "high",
      },
      mkKey(),
    );
    expect(out.temperature).toBe(0.3);
    expect(out.top_p).toBe(0.9);
    expect(out.reasoning_effort).toBe("high");
    expect(out.temperatureExplicit).toBe(true);
  });

  it("falls back to key.defaults for each field when request omits it", () => {
    const out = normalizeParams(
      { messages: [{ role: "user", content: "hi" }] },
      mkKey({ defaults: { temperature: 0.2, topP: 0.8, reasoningEffort: "medium" } }),
    );
    expect(out.temperature).toBe(0.2);
    expect(out.top_p).toBe(0.8);
    expect(out.reasoning_effort).toBe("medium");
    expect(out.temperatureExplicit).toBe(false);
  });

  it("request value overrides each key.defaults field independently", () => {
    const out = normalizeParams(
      {
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.9, // overrides
      },
      mkKey({ defaults: { temperature: 0.2, topP: 0.8 } }),
    );
    expect(out.temperature).toBe(0.9); // from request
    expect(out.top_p).toBe(0.8); // from defaults
  });

  it("drops fields entirely when neither request nor defaults set them", () => {
    const out = normalizeParams(
      { messages: [{ role: "user", content: "hi" }] },
      mkKey(),
    );
    expect(out.temperature).toBeUndefined();
    expect(out.top_p).toBeUndefined();
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.temperatureExplicit).toBe(false);
  });
});

describe("buildProviderFetch (OpenAI path)", () => {
  it("passes through reasoning_effort on OpenAI-compat providers", () => {
    const { body, url, endpoint } = buildProviderFetch(
      mkKey({ provider: "openai" }),
      {
        messages: [{ role: "user", content: "hi" }],
        reasoning_effort: "high",
      },
      false,
    );
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(endpoint).toBe("chat");
    const parsed = JSON.parse(body);
    expect(parsed.reasoning_effort).toBe("high");
  });

  it("max_completion_tokens is forwarded when set", () => {
    const { body } = buildProviderFetch(
      mkKey({ provider: "openai" }),
      {
        messages: [{ role: "user", content: "hi" }],
        max_completion_tokens: 8000,
      },
      false,
    );
    const parsed = JSON.parse(body);
    expect(parsed.max_completion_tokens).toBe(8000);
  });

  it("applies key.defaults.temperature when request omits it", () => {
    const { body } = buildProviderFetch(
      mkKey({ defaults: { temperature: 0.1 } }),
      { messages: [{ role: "user", content: "hi" }] },
      false,
    );
    const parsed = JSON.parse(body);
    expect(parsed.temperature).toBeCloseTo(0.1);
  });

  it("treats arbitrary provider IDs (gemini, groq, etc.) as OpenAI-compat", () => {
    const { url, endpoint } = buildProviderFetch(
      mkKey({
        provider: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        defaultModel: "gemini-2.5-flash",
      }),
      { messages: [{ role: "user", content: "hi" }] },
      false,
    );
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
    expect(endpoint).toBe("chat");
  });
});

describe("isOpenAIReasoningModel", () => {
  const reasoning = [
    "o1",
    "o1-mini",
    "o1-preview",
    "o3",
    "o3-mini",
    "o3-pro",
    "o4-mini",
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-thinking",
    "gpt-5.2",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
    "gpt-5.4-thinking",
    "gpt-5.4-pro",
  ];
  const legacy = [
    "gpt-4",
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-3.5-turbo",
    "claude-sonnet-4-6",
    "llama-3.3-70b-versatile",
    "deepseek-chat",
    "grok-4-1-fast-non-reasoning",
  ];

  for (const m of reasoning) {
    it(`recognizes ${m} as reasoning`, () => {
      expect(isOpenAIReasoningModel(m)).toBe(true);
    });
  }
  for (const m of legacy) {
    it(`does not flag ${m} as reasoning`, () => {
      expect(isOpenAIReasoningModel(m)).toBe(false);
    });
  }
});

describe("buildProviderFetch (OpenAI reasoning models)", () => {
  it("sends max_completion_tokens and omits max_tokens for gpt-5.2", () => {
    const { body } = buildProviderFetch(
      mkKey({ provider: "openai", defaultModel: "gpt-5.2" }),
      { messages: [{ role: "user", content: "hi" }] },
      false,
    );
    const parsed = JSON.parse(body);
    expect(parsed.max_completion_tokens).toBe(4096);
    expect(parsed.max_tokens).toBeUndefined();
  });

  it("promotes the default max_tokens value into max_completion_tokens for o3", () => {
    const { body } = buildProviderFetch(
      mkKey({ provider: "openai", defaultModel: "o3" }),
      {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 8000,
      },
      false,
    );
    const parsed = JSON.parse(body);
    expect(parsed.max_completion_tokens).toBe(8000);
    expect(parsed.max_tokens).toBeUndefined();
  });

  it("respects explicit max_completion_tokens over max_tokens for gpt-5.4", () => {
    const { body } = buildProviderFetch(
      mkKey({ provider: "openai", defaultModel: "gpt-5.4" }),
      {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 4096,
        max_completion_tokens: 16000,
      },
      false,
    );
    const parsed = JSON.parse(body);
    expect(parsed.max_completion_tokens).toBe(16000);
    expect(parsed.max_tokens).toBeUndefined();
  });

  it("legacy gpt-4o still sends max_tokens only", () => {
    const { body } = buildProviderFetch(
      mkKey({ provider: "openai", defaultModel: "gpt-4o" }),
      { messages: [{ role: "user", content: "hi" }] },
      false,
    );
    const parsed = JSON.parse(body);
    expect(parsed.max_tokens).toBe(4096);
    expect(parsed.max_completion_tokens).toBeUndefined();
  });
});

describe("buildProviderFetch (Anthropic path)", () => {
  it("translates reasoning_effort to thinking.budget_tokens", () => {
    const cases: Array<["minimal" | "low" | "medium" | "high", number]> = [
      ["minimal", 1024],
      ["low", 4096],
      ["medium", 12000],
      ["high", 32000],
    ];
    for (const [effort, budget] of cases) {
      const { body, endpoint } = buildProviderFetch(
        mkKey({
          provider: "anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          defaultModel: "claude-sonnet-4-6",
        }),
        {
          messages: [{ role: "user", content: "hi" }],
          reasoning_effort: effort,
        },
        false,
      );
      const parsed = JSON.parse(body);
      expect(parsed.thinking).toEqual({ type: "enabled", budget_tokens: budget });
      expect(endpoint).toBe("anthropic");
    }
  });

  it("request.temperature overrides key.defaults.temperature on Anthropic too", () => {
    const { body } = buildProviderFetch(
      mkKey({
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        defaults: { temperature: 0.2 },
      }),
      {
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.9,
      },
      false,
    );
    const parsed = JSON.parse(body);
    expect(parsed.temperature).toBe(0.9);
  });

  it("uses x-api-key header (Anthropic) not Authorization Bearer", () => {
    const { headers } = buildProviderFetch(
      mkKey({
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "ant-secret",
      }),
      { messages: [{ role: "user", content: "hi" }] },
      false,
    );
    expect(headers["x-api-key"]).toBe("ant-secret");
    expect(headers["Authorization"]).toBeUndefined();
  });
});

// ── Responses API endpoint selection ───────────────────

describe("selectOpenAIEndpoint", () => {
  const openai = mkKey({ provider: "openai" });
  const groq = mkKey({ provider: "groq" });

  it("routes known pro models to /responses", () => {
    for (const m of [
      "gpt-5-pro",
      "gpt-5.4-pro",
      "gpt-5.2-pro",
      "gpt-5.4-pro-2026-06",
      "o1-pro",
      "o3-pro",
      "o3-pro-latest",
    ]) {
      expect(selectOpenAIEndpoint(openai, m)).toBe("responses");
    }
  });

  it("routes regular models to /chat/completions", () => {
    for (const m of [
      "gpt-5",
      "gpt-5-mini",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4.1-mini",
      "o3",
      "o3-mini",
      "o4-mini",
    ]) {
      expect(selectOpenAIEndpoint(openai, m)).toBe("chat");
    }
  });

  it("never routes non-openai providers to /responses even with a pro-named model", () => {
    expect(selectOpenAIEndpoint(groq, "gpt-5-pro")).toBe("chat");
    expect(selectOpenAIEndpoint(mkKey({ provider: "openrouter" }), "openai/gpt-5-pro")).toBe("chat");
    expect(selectOpenAIEndpoint(mkKey({ provider: "anthropic" }), "claude-sonnet-4-6")).toBe("chat");
  });
});

// ── Responses API request shape ────────────────────────

describe("buildProviderFetch (OpenAI Responses API)", () => {
  const proKey = mkKey({ provider: "openai", defaultModel: "gpt-5.4-pro" });

  it("hits /responses with endpoint tag set", () => {
    const p = buildProviderFetch(proKey, { messages: [{ role: "user", content: "hi" }] }, false);
    expect(p.url).toBe("https://api.openai.com/v1/responses");
    expect(p.endpoint).toBe("responses");
  });

  it("translates messages to input[] with input_text content parts", () => {
    const p = buildProviderFetch(
      proKey,
      {
        messages: [
          { role: "system", content: "you are terse" },
          { role: "user", content: "hi" },
        ],
      },
      false,
    );
    const body = JSON.parse(p.body);
    expect(body.messages).toBeUndefined();
    expect(body.input).toEqual([
      { role: "system", content: [{ type: "input_text", text: "you are terse" }] },
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);
  });

  it("assistant-with-text maps to output_text; assistant tool_calls become function_call items", () => {
    const p = buildProviderFetch(
      proKey,
      {
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "thinking",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "f", arguments: '{"a":1}' } },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "42" },
        ],
      },
      false,
    );
    const body = JSON.parse(p.body);
    expect(body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { role: "assistant", content: [{ type: "output_text", text: "thinking" }] },
      { type: "function_call", call_id: "call_1", name: "f", arguments: '{"a":1}' },
      { type: "function_call_output", call_id: "call_1", output: "42" },
    ]);
  });

  it("sends max_output_tokens (never max_tokens or max_completion_tokens)", () => {
    const p = buildProviderFetch(
      proKey,
      { messages: [{ role: "user", content: "hi" }], max_tokens: 5000 },
      false,
    );
    const body = JSON.parse(p.body);
    expect(body.max_output_tokens).toBe(5000);
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBeUndefined();
  });

  it("prefers max_completion_tokens over max_tokens for max_output_tokens", () => {
    const p = buildProviderFetch(
      proKey,
      {
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
        max_completion_tokens: 2000,
      },
      false,
    );
    expect(JSON.parse(p.body).max_output_tokens).toBe(2000);
  });

  it("omits temperature entirely when inherited from key defaults (guard for temp != 1)", () => {
    const p = buildProviderFetch(
      mkKey({ provider: "openai", defaultModel: "gpt-5.4-pro", defaults: { temperature: 0.7 } }),
      { messages: [{ role: "user", content: "hi" }] },
      false,
    );
    expect(JSON.parse(p.body).temperature).toBeUndefined();
  });

  it("omits temperature when explicitly set to 0.7 (API rejects non-1 for reasoning)", () => {
    const p = buildProviderFetch(
      proKey,
      { messages: [{ role: "user", content: "hi" }], temperature: 0.7 },
      false,
    );
    expect(JSON.parse(p.body).temperature).toBeUndefined();
  });

  it("passes temperature=1 through when explicitly set", () => {
    const p = buildProviderFetch(
      proKey,
      { messages: [{ role: "user", content: "hi" }], temperature: 1 },
      false,
    );
    expect(JSON.parse(p.body).temperature).toBe(1);
  });

  it("maps reasoning_effort to reasoning.effort", () => {
    const p = buildProviderFetch(
      proKey,
      { messages: [{ role: "user", content: "hi" }], reasoning_effort: "medium" },
      false,
    );
    expect(JSON.parse(p.body).reasoning).toEqual({ effort: "medium" });
  });

  it("flattens tools to the Responses flat-function shape", () => {
    const p = buildProviderFetch(
      proKey,
      {
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: {
              name: "get_time",
              description: "current time",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      },
      false,
    );
    expect(JSON.parse(p.body).tools).toEqual([
      {
        type: "function",
        name: "get_time",
        description: "current time",
        parameters: { type: "object", properties: {} },
      },
    ]);
  });

  it("nests response_format under text.format", () => {
    const p = buildProviderFetch(
      proKey,
      {
        messages: [{ role: "user", content: "hi" }],
        response_format: { type: "json_object" },
      },
      false,
    );
    expect(JSON.parse(p.body).text).toEqual({ format: { type: "json_object" } });
  });

  it("respects forceEndpoint:responses for fallback retries", () => {
    const p = buildProviderFetch(
      mkKey({ provider: "openai", defaultModel: "gpt-5-mini" }),
      { messages: [{ role: "user", content: "hi" }] },
      false,
      { forceEndpoint: "responses" },
    );
    expect(p.url).toBe("https://api.openai.com/v1/responses");
    expect(p.endpoint).toBe("responses");
  });
});

// ── Responses API non-streaming response parsing ───────

describe("parseOpenAiResponsesCompletion", () => {
  it("concatenates output_text parts across message items", () => {
    const out = parseOpenAiResponsesCompletion({
      status: "completed",
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "ignored" }] },
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

  it("surfaces function_call items as tool_calls with tool_calls finish_reason", () => {
    const out = parseOpenAiResponsesCompletion({
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: "call_1",
          name: "f",
          arguments: '{"x":1}',
        },
      ],
    });
    expect(out.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "f", arguments: '{"x":1}' } },
    ]);
    expect(out.finish_reason).toBe("tool_calls");
  });

  it("maps incomplete + max_output_tokens reason to finish_reason=length", () => {
    const out = parseOpenAiResponsesCompletion({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [],
    });
    expect(out.finish_reason).toBe("length");
  });

  it("maps incomplete + content_filter reason", () => {
    const out = parseOpenAiResponsesCompletion({
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
      output: [],
    });
    expect(out.finish_reason).toBe("content_filter");
  });
});

// ── Responses API stream event translation ─────────────

describe("parseOpenAiResponsesStreamEvent", () => {
  it("emits delta events for response.output_text.delta", () => {
    const { port, events } = mockPort();
    parseOpenAiResponsesStreamEvent(port, { type: "response.output_text.delta", delta: "he" });
    parseOpenAiResponsesStreamEvent(port, { type: "response.output_text.delta", delta: "llo" });
    expect(events).toEqual([
      { type: "delta", text: "he" },
      { type: "delta", text: "llo" },
    ]);
  });

  it("emits a tool_call prologue on response.output_item.added for function_call items", () => {
    const { port, events } = mockPort();
    parseOpenAiResponsesStreamEvent(port, {
      type: "response.output_item.added",
      output_index: 1,
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "f" },
    });
    expect(events).toEqual([
      {
        type: "tool_call_delta",
        tool_calls: [
          { index: 1, id: "call_1", type: "function", function: { name: "f", arguments: "" } },
        ],
      },
    ]);
  });

  it("emits tool_call args deltas", () => {
    const { port, events } = mockPort();
    parseOpenAiResponsesStreamEvent(port, {
      type: "response.function_call_arguments.delta",
      output_index: 1,
      delta: '{"x":1}',
    });
    expect(events).toEqual([
      {
        type: "tool_call_delta",
        tool_calls: [{ index: 1, function: { arguments: '{"x":1}' } }],
      },
    ]);
  });

  it("emits done with usage on response.completed", () => {
    const { port, events } = mockPort();
    parseOpenAiResponsesStreamEvent(port, {
      type: "response.completed",
      response: {
        output: [
          { type: "message", content: [{ type: "output_text", text: "pong" }] },
        ],
        usage: { input_tokens: 3, output_tokens: 2 },
      },
    });
    expect(events).toEqual([
      {
        type: "done",
        finish_reason: "stop",
        usage: { promptTokens: 3, completionTokens: 2 },
      },
    ]);
  });

  it("emits done with finish_reason=tool_calls when output has a function_call", () => {
    const { port, events } = mockPort();
    parseOpenAiResponsesStreamEvent(port, {
      type: "response.completed",
      response: {
        output: [{ type: "function_call", call_id: "x", name: "f", arguments: "{}" }],
      },
    });
    expect(events[0]).toMatchObject({ type: "done", finish_reason: "tool_calls" });
  });

  it("ignores unknown event types", () => {
    const { port, events } = mockPort();
    parseOpenAiResponsesStreamEvent(port, { type: "response.reasoning.delta", delta: "..." });
    expect(events).toEqual([]);
  });
});

// ── Chat completions stream events (regression) ────────

describe("parseOpenAiStreamEvent", () => {
  it("emits delta and then done on finish_reason", () => {
    const { port, events } = mockPort();
    parseOpenAiStreamEvent(port, {
      choices: [{ delta: { content: "pong" }, finish_reason: null }],
    });
    parseOpenAiStreamEvent(port, {
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    });
    expect(events).toEqual([
      { type: "delta", text: "pong" },
      { type: "done", finish_reason: "stop", usage: { promptTokens: 3, completionTokens: 2 } },
    ]);
  });
});

describe("parseAnthropicStreamEvent", () => {
  it("emits text deltas on content_block_delta", () => {
    const { port, events } = mockPort();
    parseAnthropicStreamEvent(port, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "pong" },
    });
    expect(events).toEqual([{ type: "delta", text: "pong" }]);
  });
});

// ── Test button helper (GET /models) ───────────────────

describe("buildProviderTestFetch", () => {
  it("builds GET /models with Bearer for OpenAI-compat", () => {
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

// ── Integration coverage guard ─────────────────────────
// Fails CI if a new provider preset lands without a matching entry in
// INTEGRATION_TARGETS — keeps the "comprehensive" promise honest.

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

// ── Catalog guard: every preset must produce a valid fetch ─────

describe("preset catalog", () => {
  const msg = { role: "user" as const, content: "hi" };

  it("every non-custom preset's models[] includes its defaultModel", () => {
    const drift = PRESETS.filter(
      (p) => p.id !== "custom" && !p.models.includes(p.defaultModel),
    ).map((p) => `${p.id}: default "${p.defaultModel}" missing from models[]`);
    expect(drift).toEqual([]);
  });

  it("custom preset has empty models[] (no suggestions)", () => {
    expect(PRESETS.find((p) => p.id === "custom")?.models).toEqual([]);
  });

  for (const preset of PRESETS) {
    if (preset.id === "custom") continue; // custom has empty baseUrl/model by design
    it(`${preset.id}: buildProviderFetch produces a valid URL + auth + JSON body`, () => {
      const p = buildProviderFetch(
        {
          keyId: "k",
          provider: preset.id,
          label: "test",
          apiKey: "x",
          baseUrl: preset.baseUrl,
          defaultModel: preset.defaultModel,
          createdAt: 0,
          updatedAt: 0,
        },
        { messages: [msg] },
        false,
      );
      expect(p.url.startsWith("https://")).toBe(true);
      if (preset.id === "anthropic") {
        expect(p.headers["x-api-key"]).toBeDefined();
      } else {
        expect(p.headers["Authorization"]).toMatch(/^Bearer /);
      }
      const body = JSON.parse(p.body);
      expect(body.model).toBe(preset.defaultModel);
    });

    it(`${preset.id}: buildProviderTestFetch produces /models GET with correct auth`, () => {
      const p = buildProviderTestFetch({
        keyId: "k",
        provider: preset.id,
        label: "test",
        apiKey: "x",
        baseUrl: preset.baseUrl,
        defaultModel: preset.defaultModel,
        createdAt: 0,
        updatedAt: 0,
      });
      expect(p.url.endsWith("/models")).toBe(true);
      expect(p.method).toBe("GET");
      if (preset.id === "anthropic") {
        expect(p.headers["x-api-key"]).toBeDefined();
      } else {
        expect(p.headers["Authorization"]).toMatch(/^Bearer /);
      }
    });
  }
});
