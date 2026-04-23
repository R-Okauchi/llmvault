# keyquill-extension

**Keyquill browser extension — Chrome / Firefox (Manifest V3).**

A BYOK (Bring Your Own Key) wallet for web applications. Stores LLM API keys in `chrome.storage.session` and makes CORS-free calls to provider APIs from the extension service worker.

## How it works

```
Your Web App         Content Script       Service Worker        Provider
┌──────────┐         ┌──────────┐         ┌────────────┐        ┌────────┐
│ keyquill │  window │          │ chrome. │            │ fetch  │ OpenAI │
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
pnpm --filter keyquill-extension build          # dist-chrome/
pnpm --filter keyquill-extension build:firefox  # dist-firefox/
```
Load the unpacked extension from `dist-chrome/` (Chrome) or `dist-firefox/` (Firefox Developer Edition).

## Use from a web app

```bash
pnpm add keyquill
```

```typescript
import { Keyquill } from "keyquill";

const vault = new Keyquill();

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

See the [`keyquill` SDK README](../keyquill/README.md) for the full API.

## Supported providers

OpenAI-compatible wire protocol. Native translation for Anthropic.

OpenAI, Anthropic, Gemini, Groq, Mistral, DeepSeek, Together AI, Fireworks, xAI, Ollama.

## Privacy

- No analytics, no telemetry, no remote logs.
- Keys stored in `chrome.storage.session` (ephemeral, cleared when the browser closes).
- Grants stored in `chrome.storage.local` (revocable via popup).
- Network calls: only to LLM providers the user configured.

Full policy: [docs/privacy-policy.md](../../docs/privacy-policy.md).

## Testing

Three tiers; pick based on what you're iterating on.

```bash
# 1. Unit tests + mock-server fallback test (fast, no network, runs on every PR)
pnpm --filter keyquill-extension test

# 2. Live-API matrix — gated per provider by env var. Missing keys just skip.
export OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-ant-...
pnpm --filter keyquill-extension test:integration

# 3. Everything (unit + integration, same vitest run)
pnpm --filter keyquill-extension test:all
```

`test:integration` exercises `GET /models`, a non-streaming chat, and a
streaming chat for every catalogued model in
[integrationTargets.ts](./src/background/__tests__/integrationTargets.ts).
A full matrix run is well under $0.05 at April 2026 rates — prompts are
single-line, output capped at 32 tokens.

**Adding a new provider preset?** Update `INTEGRATION_TARGETS` as well —
a unit-level coverage guard fails CI if you don't.

**GitHub CI.** The `check` job runs tier 1 on every PR. A separate
`integration` workflow runs tier 2 nightly + on push-to-main, reading
API keys from an `integration` GitHub Environment scoped to `main`. Fork
PRs never see secrets — the workflow has no `pull_request` trigger.
The job summary renders a provider × model × mode matrix so a red cell
pins regressions to one combination.

## Store submission

See [SUBMISSION.md](./SUBMISSION.md).

## License

MIT
