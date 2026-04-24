# keyquill-extension

**Keyquill browser extension — Chrome / Firefox (Manifest V3). v1.0: BYOK policy broker.**

A BYOK (Bring Your Own Key) wallet for web applications. Stores LLM API keys in `chrome.storage.session`, brokers every request through a user-owned policy, and records a per-key audit ledger. Developers declare what they need; users enforce what's allowed.

## What's new in v1.0

1.0 turns keyquill from a "pass-through wallet" into an **LLM access broker**:

- **Model catalogue** — structured metadata for every supported model (capabilities, pricing, endpoint routing, constraints). Replaces ad-hoc regex heuristics.
- **KeyPolicy** — per-key rules enforced by the broker. Modes: `open` / `allowlist` / `denylist` / `capability-only`. Budgets in USD (per-request / daily / monthly). Privacy (HTTPS required, provider allowlist, origin regex). Sampling defaults. Runtime behaviour (auto-fallback, retries, timeout).
- **Resolver** — 8-stage pipeline: privacy → model selection → capability check → budget → tokens → reasoning → sampling → body construction. Returns a concrete ExecutionPlan or a consent-required / reject outcome with a ResolverTrace the user can audit.
- **Audit ledger** — every request written to `chrome.storage.local` with timestamp, origin, model, token usage, cost estimate + actual. 90-day retention, CSV export, cascade-clear on key delete.
- **Consent UX** — per-request approval popup (once / always / reject) when the resolver flags a policy violation. 5-minute in-memory cache suppresses repeat popups.
- **Localised errors** — en / ja tables, auto-detect via `chrome.i18n.getUILanguage()`. All policy codes get user-actionable sentences.
- **SDK v2** — capability-first API, published as `keyquill@1.x` on npm (see the [SDK README](../keyquill/README.md) for the v1/v2-API vs. npm semver disambiguation). v1 SDK clients (`@0.3.x`) continue to work against the same extension via an in-extension wire translator.

Popup additions per key card:
- **Spend bar** (monthly total + budget progress)
- **Policy** button — 5 tabs: Model / Budget / Privacy / Sampling / Behavior
- **Audit** button — filterable ledger + CSV export

## Migration from 0.3.x

Existing keys are migrated automatically on first read:
- Legacy `defaults: { temperature, topP, reasoningEffort }` → `policy.sampling` + `policy.budget.maxReasoningEffort`
- A permissive `DEFAULT_KEY_POLICY` (mode `open`, warn-only budget) is synthesised so behaviour matches pre-1.0.
- `policyVersion: 1` is written on first migrated read. No manual action required.

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
import { Keyquill } from "keyquill"; // v2 capability-first API

const quill = new Keyquill();

if (await quill.isAvailable()) {
  if (!(await quill.isConnected())) {
    await quill.connect();  // opens consent popup
  }

  // Tier 2 — capability-declared (recommended)
  const { completion } = await quill.chat({
    messages: [{ role: "user", content: "Hello" }],
    requires: ["tool_use"],
    tone: "precise",
    maxOutput: 1024,
  });
}
```

See the [`keyquill` SDK README](../keyquill/README.md) for the full API + the three ergonomic tiers (zero-config / capability-declared / full control).

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
