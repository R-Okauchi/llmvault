**Keyquill** is a Bring-Your-Own-Key (BYOK) wallet for LLM APIs. You register your OpenAI, Anthropic, Gemini, or any OpenAI-compatible API key inside the extension. Approved web apps can then stream chat completions using your key — and neither the web app nor its server ever sees the key material.

### The problem

Web apps that use LLM APIs usually make you either:
- Let them store your API key on their server (trust and breach risk)
- Paste your key into `localStorage` (XSS risk)
- Go without AI features

Keyquill offers a fourth option: keep the key in an isolated extension process, and let web apps request completions through a narrow, user-approved channel.

### How it works

1. Click the Keyquill toolbar icon. Register a provider (OpenAI, Anthropic, Gemini, Groq, Mistral, DeepSeek, Together, Fireworks, xAI, Ollama, or any OpenAI-compatible endpoint) and paste your API key.
2. Visit any web app that integrates the Keyquill SDK.
3. First access triggers a consent popup showing the origin name. Approve or deny.
4. Approved apps can call for completions. The extension's service worker contacts the provider directly over HTTPS. The web page only receives the streamed response.

### Security properties

- **Keys live in `browser.storage.session`** — ephemeral, cleared when the browser closes, inaccessible to regular web-page JavaScript.
- **Per-origin consent** (MetaMask style). Every origin that uses Keyquill must be explicitly approved via a popup. Approvals are stored in `browser.storage.local` and can be revoked from the extension popup at any time.
- **Key registration and deletion are popup-only.** Web pages cannot register, delete, or exfiltrate keys.
- **Zero telemetry.** The extension opens no connections to any Keyquill-controlled server (there isn't one). Network destinations are limited to LLM providers the user has chosen.

### What's new in v1.0 — policy broker

Every request is brokered through a user-owned policy before reaching the provider:

- **Model policy**: allowlist / denylist / capability-only modes per key.
- **Budget caps**: per-request, daily, and monthly USD ceilings; choose block / confirm / warn.
- **Privacy rules**: HTTPS-only endpoints, provider allowlists, origin regex filters.
- **Capability-first API**: apps declare what they need (tool use, reasoning, long context); your policy picks the actual model.
- **Consent popups** for out-of-allowlist models or high-cost requests, with once/always/reject choices.
- **Audit ledger**: every request recorded locally with tokens + estimated + actual cost. Filter by origin, export to CSV, 90-day retention.
- **Localized errors** (English / Japanese).

### Supported providers

Anything that speaks the OpenAI Chat Completions format works out of the box. Native translation is provided for the Anthropic Messages API.

Confirmed: OpenAI, Anthropic, Google Gemini, Groq, Mistral, DeepSeek, Together AI, Fireworks AI, xAI (Grok), Ollama (local), and any OpenAI-compatible endpoint.

### For developers

Integrate Keyquill in your web app (v2 capability-first API):

```
npm install keyquill
```

```js
import { Keyquill } from "keyquill";
const quill = new Keyquill();
if (await quill.isAvailable()) {
  await quill.connect();
  const { completion } = await quill.chat({
    messages: [{ role: "user", content: "Hello" }],
    requires: ["tool_use"],
    tone: "precise",
    maxOutput: 1024,
  });
}
```

v1 SDK users can keep pinning `keyquill@0.3.x` — the extension accepts both wire shapes.

Full documentation: https://github.com/R-Okauchi/keyquill

### Links

- Live demo: https://r-okauchi.github.io/keyquill/demo/
- Source code (MIT): https://github.com/R-Okauchi/keyquill
- Privacy policy: https://r-okauchi.github.io/keyquill/privacy-policy
- Report issues: https://github.com/R-Okauchi/keyquill/issues
