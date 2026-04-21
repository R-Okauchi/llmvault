# llmvault-extension

**LLMVault browser extension — Chrome / Firefox (Manifest V3).**

A BYOK (Bring Your Own Key) wallet for web applications. Stores LLM API keys in `chrome.storage.session` and makes CORS-free calls to provider APIs from the extension service worker.

## How it works

```
Your Web App         Content Script       Service Worker        Provider
┌──────────┐         ┌──────────┐         ┌────────────┐        ┌────────┐
│ llmvault │  window │          │ chrome. │            │ fetch  │ OpenAI │
│   SDK    │◄──────►│  relay   │◄───────►│  keys +    │───────►│Anthropic│
│          │postMsg │          │ runtime │  policy    │(no CORS)│  ...   │
└──────────┘         └──────────┘         └────────────┘        └────────┘
                                           chrome.storage
                                              .session
                                         (keys stay here)
```

- **Keys never leave the extension.** The SDK only exchanges messages; the service worker talks to LLM providers directly.
- **Per-origin consent** (MetaMask-style): first use from each origin requires explicit user approval via a consent popup. Grants are stored in `chrome.storage.local` and can be revoked from the extension popup.
- **Popup-only key management**: `registerKey` / `deleteKey` can only be called from the extension popup — web pages cannot register or delete keys.

## Install

### Chrome
[Chrome Web Store link — coming soon]

### Firefox
[Firefox Add-ons link — coming soon]

### Development build
```bash
pnpm install
pnpm --filter llmvault-extension build          # dist-chrome/
pnpm --filter llmvault-extension build:firefox  # dist-firefox/
```
Load the unpacked extension from `dist-chrome/` (Chrome) or `dist-firefox/` (Firefox Developer Edition).

## Use from a web app

```bash
pnpm add llmvault
```

```typescript
import { LLMVault } from "llmvault";

const vault = new LLMVault();

if (await vault.isAvailable()) {
  if (!(await vault.isConnected())) {
    await vault.connect();  // opens consent popup
  }

  const result = await vault.chat({
    model: "gpt-4o",
    messages: [{ role: "user", content: "Hello" }],
  });
}
```

See the [`llmvault` SDK README](../llmvault/README.md) for the full API.

## Supported providers

OpenAI-compatible wire protocol. Native translation for Anthropic.

OpenAI, Anthropic, Gemini, Groq, Mistral, DeepSeek, Together AI, Fireworks, xAI, Ollama.

## Privacy

- No analytics, no telemetry, no remote logs.
- Keys stored in `chrome.storage.session` (ephemeral, cleared when the browser closes).
- Grants stored in `chrome.storage.local` (revocable via popup).
- Network calls: only to LLM providers the user configured.

Full policy: [docs/privacy-policy.md](../../docs/privacy-policy.md).

## Store submission

See [SUBMISSION.md](./SUBMISSION.md).

## License

MIT
