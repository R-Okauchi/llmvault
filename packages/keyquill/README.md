# Keyquill

**Bring Your Own Key to any web app — without trusting their server.**

A browser extension + SDK that lets users securely use their own LLM API keys from any web application. Keys never leave the browser extension — no server relay needed.

## The Problem

Web apps that use LLM APIs face a dilemma:

1. **Server-side proxy**: The app server sees the user's API key (security risk)
2. **Direct browser calls**: Blocked by CORS (LLM providers don't allow browser-origin requests)
3. **Store key in localStorage**: Vulnerable to XSS attacks

## The Solution

```
Your Web App                    Keyquill Extension                  LLM Provider
┌──────────┐                    ┌─────────────────────┐             ┌──────────┐
│          │  chrome.runtime    │                     │   fetch()   │          │
│  SDK     │───────────────────>│  Service Worker     │────────────>│  OpenAI  │
│          │  (messages only)   │  + Key Storage      │  (no CORS)  │ Anthropic│
│          │<───────────────────│                     │<────────────│  Gemini  │
│          │  Port (streaming)  │  chrome.storage     │   SSE       │  etc.    │
└──────────┘                    │  .session           │             └──────────┘
                                └─────────────────────┘
                                Keys stay HERE. Always.
```

**Security properties:**

- API keys stored in `chrome.storage.session` — inaccessible to web page JavaScript
- Keys cleared automatically when the browser closes
- Extension service worker makes CORS-free calls to LLM providers
- **Per-origin consent** (MetaMask-style): first use from each origin requires explicit user approval via a consent popup. Grants are stored in `chrome.storage.local` and can be revoked from the extension popup.
- Key management (`registerKey` / `deleteKey`) is restricted to the extension popup — web pages cannot register or delete keys
- Web app never sees the key — only sends messages and receives streamed text

## Quick Start

### 1. Install the SDK

```bash
npm install keyquill
```

### 2. Use in your app (v2 capability-first API)

`keyquill@2` uses a **capability-first** API — the app declares what it needs, the user's policy picks the actual model. Three ergonomic tiers:

```typescript
import { Keyquill } from "keyquill";

const vault = new Keyquill();

if (await vault.isAvailable()) {
  if (!(await vault.isConnected())) {
    try {
      await vault.connect();
    } catch (err) {
      // USER_DENIED / TIMEOUT — handle gracefully
      return;
    }
  }

  // ── Tier 1: zero-config ──────────────────────────────
  // Uses the key's default model. Simplest possible chat.
  const { completion } = await vault.chat({
    messages: [{ role: "user", content: "Hello!" }],
  });
  console.log(completion.content);

  // ── Tier 2: capability-declared (recommended) ────────
  // The broker picks the best model in the user's allowlist that
  // satisfies every capability. `tone` abstracts over temperature.
  for await (const event of vault.chatStream({
    messages: [{ role: "user", content: "Debug this code..." }],
    requires: ["reasoning", "long_context"],
    tone: "precise",
    maxOutput: 2048,
  })) {
    if (event.type === "delta") process.stdout.write(event.text);
  }

  // Tool calling — `tool_use` is implied by passing `tools`.
  const { completion: res } = await vault.chat({
    messages: [{ role: "user", content: "What's the weather in Tokyo?" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get current weather",
          parameters: {
            type: "object",
            properties: { location: { type: "string" } },
            required: ["location"],
          },
        },
      },
    ],
  });
  if (res.tool_calls) {
    console.log(res.tool_calls[0].function.name); // "get_weather"
  }

  // ── Tier 3: full control ─────────────────────────────
  // Pin the exact model + parameters.
  const { completion: pro } = await vault.chat({
    messages: [{ role: "user", content: "Prove the central limit theorem." }],
    prefer: {
      model: "gpt-5.4-pro",
      reasoningEffort: "high",
      temperature: 1, // reasoning models require 1
    },
  });

  // Vision (multimodal) — `vision` is implied by an image ContentPart.
  for await (const event of vault.chatStream({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,..." } },
        ],
      },
    ],
    requires: ["vision"],
  })) {
    if (event.type === "delta") process.stdout.write(event.text);
  }
}
```

### 3. Install the extension

Load the extension from `packages/keyquill-extension/dist/` in Chrome:

1. Go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `dist` folder

## API Reference

### `new Keyquill(options?)`

| Option        | Type     | Default     | Description                               |
| ------------- | -------- | ----------- | ----------------------------------------- |
| `extensionId` | `string` | auto-detect | Chrome extension ID                       |
| `timeout`     | `number` | `5000`      | Timeout for non-streaming operations (ms) |

### `vault.isAvailable(): Promise<boolean>`

Check if the extension is installed and responsive. Result is cached for 30 seconds.

### `vault.isConnected(): Promise<boolean>`

Check whether the current origin has an active consent grant. Call this before
deciding whether to show a "Connect" button.

### `vault.connect(timeoutMs?: number): Promise<void>`

Request permission for the current origin. Opens a consent popup the first time
(60 second default timeout for user interaction). Resolves when the user approves,
throws with `USER_DENIED` or `TIMEOUT` otherwise. Subsequent calls return
instantly if the grant is already present.

```typescript
try {
  await vault.connect();
} catch (err) {
  // User denied or timed out — show a "Try again" prompt
}
```

### `vault.disconnect(): Promise<void>`

Revoke the current origin's grant. The user will be prompted again on the next
`connect()` call.

### `vault.listProviders(): Promise<ProviderSummary[]>`

List registered providers. No key material is returned — only hints like `sk-t...st12`.
Requires an active connection (call `connect()` first).

### `vault.registerKey(provider, params): Promise<void>`

> **Popup-only.** Calling this from a web page throws `BLOCKED`. API key
> material must not travel through the web-page channel. Users register keys
> via the extension popup (toolbar icon).

### `vault.deleteKey(provider): Promise<void>`

> **Popup-only.** Same rationale as `registerKey`: a compromised origin should
> not be able to wipe user keys. Users delete via the extension popup.

### `vault.testKey(provider): Promise<{ reachable: boolean }>`

Test connectivity to a provider.

### `vault.chat(params): Promise<{ completion; keyId }>`

Non-streaming chat completion. Returns the full response plus the `keyId` that serviced it.

### `vault.chatStream(params): AsyncGenerator<StreamEvent>`

Stream a chat completion. First event is always `{ type: "start", keyId, provider, label }` so callers can tell which key serviced the request.

```typescript
type StreamEvent =
  | { type: "start"; keyId: string; provider: string; label: string }
  | { type: "delta"; text: string }
  | { type: "tool_call_delta"; tool_calls: ToolCallDelta[] }
  | {
      type: "done";
      finish_reason?: string;
      usage?: { promptTokens: number; completionTokens: number };
    }
  | { type: "error"; code: string; message: string };
```

### ChatParams (shared by `chat` and `chatStream`)

```typescript
interface ChatParams {
  messages: ChatMessage[];     // conversation (text / vision / tool results)
  tools?: Tool[];              // function calling
  toolChoice?: ToolChoice;     // "none" | "auto" | "required" | specific
  responseFormat?: ResponseFormat; // "text" | "json_object" | "json_schema"

  // v2 capability-first fields
  requires?: Capability[];     // capabilities the broker must satisfy
  tone?: "precise" | "balanced" | "creative";
  maxOutput?: number;          // max output tokens (clamped by policy)
  prefer?: {
    model?: string;            // Tier 3 explicit model pin
    provider?: string;         // narrow to a specific provider
    temperature?: number;
    topP?: number;
    reasoningEffort?: "minimal" | "low" | "medium" | "high";
  };

  keyId?: string;              // explicit key selection
}

type Capability =
  | "tool_use" | "structured_output" | "vision" | "audio"
  | "reasoning" | "long_context" | "streaming" | "cache"
  | "fast" | "cheap" | "multilingual" | "code";
```

## Migrating from keyquill@1 → keyquill@2

v1 (`keyquill@0.3.x`) remains available on npm — pin it if you're not ready to migrate. v2 deletes v1 top-level fields in favour of the capability-first surface:

| v1 (`@0.3.x`) | v2 (`@2`) |
| --- | --- |
| `model: "gpt-4o"` | `prefer: { model: "gpt-4o" }` |
| `temperature: 0.7` | `prefer: { temperature: 0.7 }` &nbsp;— or&nbsp; `tone: "balanced"` |
| `top_p: 0.9` | `prefer: { topP: 0.9 }` |
| `max_tokens: 2048` | `maxOutput: 2048` |
| `max_completion_tokens: 2048` | `maxOutput: 2048` |
| `reasoning_effort: "high"` | `prefer: { reasoningEffort: "high" }` |
| `tool_choice: "required"` | `toolChoice: "required"` |
| `response_format: { type: "json_object" }` | `responseFormat: { type: "json_object" }` |
| `provider: "openai"` | `prefer: { provider: "openai" }` |
| `stop: [...]` | (removed — not commonly used, re-request if needed) |

The extension (`keyquill-extension@1.0+`) accepts **both wire shapes simultaneously** via an internal translator. So you can migrate one app at a time, on your own schedule — existing v1 apps keep running unchanged against the same installed extension.

## Supported Providers

The wire protocol is OpenAI Chat Completions format. Any OpenAI-compatible provider works out of the box.

| Provider    | Base URL                                                  | Type       |
| ----------- | --------------------------------------------------------- | ---------- |
| OpenAI      | `https://api.openai.com/v1`                               | Native     |
| Anthropic   | `https://api.anthropic.com/v1`                            | Translated |
| Gemini      | `https://generativelanguage.googleapis.com/v1beta/openai` | Compatible |
| Groq        | `https://api.groq.com/openai/v1`                          | Compatible |
| Mistral     | `https://api.mistral.ai/v1`                               | Compatible |
| DeepSeek    | `https://api.deepseek.com/v1`                             | Compatible |
| Together AI | `https://api.together.xyz/v1`                             | Compatible |
| Fireworks   | `https://api.fireworks.ai/inference/v1`                   | Compatible |
| xAI (Grok)  | `https://api.x.ai/v1`                                     | Compatible |
| Ollama      | `http://localhost:11434/v1`                               | Compatible |

**Anthropic** is the only provider requiring translation (OpenAI format → Messages API). All others receive requests as-is.

## Comparison with Alternatives

| Approach       | Key Location          | XSS Safe | Server Trust   | CORS         |
| -------------- | --------------------- | -------- | -------------- | ------------ |
| Server proxy   | Server memory         | Yes      | Required       | N/A          |
| localStorage   | Browser JS            | No       | N/A            | Blocked      |
| sessionStorage | Browser JS            | No       | N/A            | Blocked      |
| **Keyquill**   | **Extension storage** | **Yes**  | **Not needed** | **Bypassed** |

## Framework Support

Zero dependencies. Works with any framework:

- React / Next.js
- Vue / Nuxt
- Svelte / SvelteKit
- Preact
- Vanilla JavaScript/TypeScript

## License

MIT
