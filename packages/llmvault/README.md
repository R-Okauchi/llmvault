# LLMVault

**Bring Your Own Key to any web app — without trusting their server.**

A browser extension + SDK that lets users securely use their own LLM API keys from any web application. Keys never leave the browser extension — no server relay needed.

## The Problem

Web apps that use LLM APIs face a dilemma:

1. **Server-side proxy**: The app server sees the user's API key (security risk)
2. **Direct browser calls**: Blocked by CORS (LLM providers don't allow browser-origin requests)
3. **Store key in localStorage**: Vulnerable to XSS attacks

## The Solution

```
Your Web App                    LLMVault Extension                  LLM Provider
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
npm install llmvault
```

### 2. Use in your app

```typescript
import { LLMVault } from "llmvault";

const vault = new LLMVault();

if (await vault.isAvailable()) {
  // Request permission (opens a consent popup the first time)
  // Subsequent calls return instantly if already connected.
  if (!(await vault.isConnected())) {
    try {
      await vault.connect(); // user approves in popup
    } catch (err) {
      // USER_DENIED / TIMEOUT — handle gracefully
      return;
    }
  }

  // Non-streaming chat
  const result = await vault.chat({
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hello!" }],
  });
  console.log(result.content);

  // Streaming chat
  for await (const event of vault.chatStream({
    messages: [{ role: "user", content: "Hello!" }],
  })) {
    if (event.type === "delta") process.stdout.write(event.text);
  }

  // Tool calling
  const result2 = await vault.chat({
    model: "gpt-4o",
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
  if (result2.tool_calls) {
    console.log(result2.tool_calls[0].function.name); // "get_weather"
  }

  // Vision (multimodal)
  for await (const event of vault.chatStream({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,..." } },
        ],
      },
    ],
  })) {
    if (event.type === "delta") process.stdout.write(event.text);
  }
}
```

### 3. Install the extension

Load the extension from `packages/llmvault-extension/dist/` in Chrome:

1. Go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `dist` folder

## API Reference

### `new LLMVault(options?)`

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

### `vault.chat(params): Promise<ChatCompletion>`

Non-streaming chat completion. Returns the full response.

```typescript
const result = await vault.chat({
  provider: "openai",       // optional — defaults to first registered
  model: "gpt-4o",          // optional — overrides provider default
  messages: [{ role: "user", content: "Hello" }],
  tools: [...],             // optional — function calling
  temperature: 0.7,         // optional
  response_format: { type: "json_object" }, // optional — structured output
});

// result: { content, tool_calls?, finish_reason, usage? }
```

### `vault.chatStream(params): AsyncGenerator<StreamEvent>`

Stream a chat completion. Returns an `AsyncGenerator` that yields events:

```typescript
type StreamEvent =
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
  provider?: string; // Provider ID or "auto"
  model?: string; // Model override
  messages: ChatMessage[]; // Conversation (supports text, vision, tool results)
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  tools?: Tool[]; // Function calling
  tool_choice?: ToolChoice; // "none" | "auto" | "required" | specific function
  response_format?: ResponseFormat; // "text" | "json_object" | "json_schema"
}
```

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
| **LLMVault**   | **Extension storage** | **Yes**  | **Not needed** | **Bypassed** |

## Framework Support

Zero dependencies. Works with any framework:

- React / Next.js
- Vue / Nuxt
- Svelte / SvelteKit
- Preact
- Vanilla JavaScript/TypeScript

## License

MIT
