# keyquill

## 0.3.1

### Patch Changes

- 906f10f: Fix GPT-5 / o-series reasoning models rejecting `max_tokens`.

  OpenAI reasoning-family models return a 400 error when `max_tokens` is
  present (they require `max_completion_tokens` instead). Keyquill now
  detects these models by name and swaps the parameter automatically:
  - `isOpenAIReasoningModel(model)` regex: `/^(o\d+|gpt-5)/i`
    - Matches: o1, o1-mini, o3, o3-mini, o3-pro, o4-mini, and the entire
      GPT-5 family (gpt-5, gpt-5-mini, gpt-5.2, gpt-5.4, gpt-5.4-mini,
      gpt-5.4-nano, gpt-5.4-thinking, gpt-5.4-pro)
    - Excludes legacy gpt-4, gpt-4o, gpt-4.1, gpt-3.5-turbo
  - `buildOpenAiPassthrough` promotes `max_tokens` value into
    `max_completion_tokens` for reasoning models; legacy models continue
    to receive `max_tokens` only.
  - OpenAI preset default bumped `gpt-4.1-mini` → `gpt-5.4-mini` since the
    GPT-4 family is retired from ChatGPT and the cost-balanced active
    default is now in the GPT-5 family.

  Tests: 53 cases total in keyStore + providerFetch (was 35) — 17
  reasoning-detection matches against real model names, 4 reasoning-path
  body-shape assertions, plus legacy fallthrough coverage.

  No schema change, no protocol change. Additive.

## 0.3.0

### Minor Changes

- 5486554: v0.3.0 — active-key model, multi-provider presets, per-key defaults, reasoning support.

  ## BREAKING (protocol v2 → v3)

  ### Active-key model
  - `KeyRecord.isDefault?: boolean` (per-provider) replaced by `KeyRecord.isActive: boolean` (wallet-wide, exactly one true). Mirrors MetaMask's account switching: the user has a current "active key", and every chatStream resolves to it unless a keyId or per-origin binding overrides.
  - `KeySummary.isDefault` → `KeySummary.isActive` in the SDK listKeys response.
  - Message `{ type: "setDefault", keyId }` → `{ type: "setActive", keyId }`.
  - `addKey` accepts `isActive?: boolean` (was `isDefault?: boolean`).

  ### Resolution priority simplified 4 → 3
  1. `request.keyId` — explicit SDK selection
  2. Per-origin binding — persisted site choice
  3. Active key — wallet's current selection (singleton)

  `request.provider` is now advisory only — a site that needs a specific provider should pass `keyId` of a matching key; no per-provider default fallback exists anymore. Fixes v0.2.0's non-deterministic "first per-provider default" behavior.

  ### Protocol version bump 2 → 3

  SDK throws `PROTOCOL_MISMATCH` when talking to an older extension.

  ## NEW features (additive)

  ### Multi-provider presets

  Add-key form now includes 10 presets: OpenAI, Anthropic, Google Gemini, Groq, DeepSeek, Mistral, Together AI, xAI (Grok), OpenRouter, Custom (OpenAI-compatible). Selecting a preset auto-fills baseURL + default model with web-verified values. Fixes the bug where selecting Anthropic still showed OpenAI's URL.

  ### Per-key generation defaults

  `KeyRecord.defaults?: { temperature?; topP?; reasoningEffort? }` lets users pin generation preferences per key:
  - "Work" key with temperature 0.2 (analytical)
  - "Personal" key with temperature 0.9 (creative)

  Explicit request fields always override key defaults.

  ### Reasoning effort + max_completion_tokens
  - `ChatParams.reasoning_effort: "minimal" | "low" | "medium" | "high"` forwarded verbatim to OpenAI-compatible providers (OpenAI o-series / GPT-5 reasoning, Gemini 2.5+ thinking, Groq reasoning, etc.).
  - Translated to Anthropic's `thinking: { type: "enabled", budget_tokens }` (minimal=1024, low=4096, medium=12000, high=32000).
  - `ChatParams.max_completion_tokens?: number` added for OpenAI reasoning-model budget (alias of max_tokens for non-reasoning providers).

  ### Popup UI refresh
  - Active-key banner at the top of the popup with Switch button (one click to change active)
  - Advanced toggle section in the add-key form: baseURL, model, temperature, topP, reasoning effort — hidden by default to keep primary form minimal
  - "Set active" button replaces "Set default" on non-active key cards
  - Key cards show ⭐ when active

  ### Consent picker

  Unchanged structurally but pre-selects the active key (previously pre-selected per-provider default).

  ## Migration (automatic)
  - v1 `keyquill_providers` → v3 `keyquill_keys`, first entry becomes active
  - v2 `keyquill_keys` with `isDefault` → coerced on next read: the most-recently-updated per-provider default across the wallet wins the single active slot. Bindings preserved.

  ## Tests
  - **keyStore** (12): addKey / setActive / getActiveKey / deleteKey cascade / v1 + v2 migration
  - **providerFetch** (11): reasoning_effort passthrough, Anthropic thinking translation, key.defaults merge with request override, arbitrary provider IDs → OpenAI-compat
  - **SDK client** (10): wire protocol v3, start stream event, keyId forwarding
  - All 65 tests + build + typecheck + lint green across 4 workspaces

  ## Consumer migration (travel-os etc.)
  - `vault.listProviders()` removed → use `vault.listKeys()` (returns `KeySummary[]` with `keyId`, `label`, `isActive`)
  - `vault.testKey(provider)` → `vault.testKey(keyId)`
  - `vault.registerKey()` / `vault.deleteKey(provider)` removed from SDK (popup-only now)
  - `vault.chat()` returns `{ completion, keyId }` instead of just ChatCompletion
  - `chatStream()` emits a new first event `{ type: "start", keyId, provider, label }` — existing consumers can ignore or surface it
  - `ChatParams.keyId?` for explicit selection; `provider?` remains for back-compat but is advisory

  Bump your `keyquill-relay` / `keyquill-mobile` to `^0.3.0` too if you use them — fixed group.

## 0.2.0

### Minor Changes

- 87f34a2: Multi-key support with per-origin key binding (protocol v2).

  BREAKING changes:
  - Storage schema: `ProviderRecord[]` → `KeyRecord[]` (indexed by stable `keyId`).
    A single provider (e.g. OpenAI) can now have multiple registered keys
    (Work, Personal, University, etc.) each with its own `label`.
  - SDK API: `listProviders()` removed in favour of `listKeys()`.
    `registerKey()` / `deleteKey(provider)` removed from the SDK (popup-only).
    `testKey(keyId)` now takes a keyId instead of a provider name.
    `chat()` now returns `{ completion, keyId }` so callers can surface which
    key serviced the request.
    `chatStream()` emits a new first event `{ type: "start", keyId, provider, label }`.
  - `ChatParams` gains `keyId?` for explicit selection. `provider?` still works
    but now falls back to that provider's user-picked default key.
  - Wire protocol version bumped from 1 to 2. The SDK throws `PROTOCOL_MISMATCH`
    when it detects an outdated extension.

  NEW:
  - Per-origin key binding: the consent popup now asks "Which key should this
    site use?" and remembers the choice in `chrome.storage.local`. Sites that
    don't pass an explicit `keyId` automatically use their bound key.
  - Resolution priority: SDK-explicit keyId → per-origin binding → provider
    default → global default.
  - Popup UI: "Your keys" section grouped by provider with `Default ⭐` toggle.
    "Connected sites" section shows each origin's bound key with Change / Revoke.
  - `KeyRecord.label` is required (was optional). Legacy v1 data migrates
    automatically: provider name becomes label if the old label was empty.

  travel-os (and any other consumer of `keyquill`): update to `keyquill@0.2.0`
  alongside `keyquill-relay@0.2.0` — both ship together.
