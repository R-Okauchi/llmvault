# keyquill

## 1.1.0

### Minor Changes

- 90f169b: Add `KeySummary.effectiveDefaultModel` — the model the resolver would pick
  for a zero-config request, computed by walking `policy.modelPolicy.defaultModel`
  → provider preset default → cheapest catalog entry.

  `KeySummary.defaultModel` is now a deprecated alias for the same value and
  will be removed in the next SDK major. No migration is required in the 1.x
  series; existing code reading `summary.defaultModel` keeps receiving the
  same resolver-chosen model it did before.

- 8b021b6: Add `vault.preview(params)` — a dry-run of the resolver that returns what
  model would service a given request, its estimated cost and token usage,
  and whether any consent prompts or policy rejections would fire. Does not
  issue a provider fetch or open a consent popup, so callers can surface
  cost previews or "this will need approval" hints ahead of time.

  Returns a `PlanPreview` discriminated union:
  - `{ kind: "ready", model, estimatedCostUSD, estimatedTokens, selectionReason, ... }`
  - `{ kind: "consent-required", reason, message, proposedModel? }`
  - `{ kind: "rejected", reason, message }`

  Also exports `PlanPreview`, `PlanPreviewModel`, `ConsentReason`, and
  `PreviewPlanRequest` from the SDK root.

## 1.0.2

### Patch Changes

- 449e962: Fix broken demo + docs that pinned `keyquill@2` — the capability-first
  "v2 API" actually ships as `keyquill@1.x` on npm. The changesets major
  bump from `0.3.2` landed at `1.0.0`, not `2.0.0`, so `esm.sh/keyquill@2`
  returns 404 and the demo site was stuck on "Checking for extension…".
  - `docs/demo/index.html` + `docs/demo/README.md`: CDN pin `@2` → `@1`
  - SDK README: migration section rewritten as `@0.3.x → @1` with a
    disambiguation note explaining that the "v1 / v2 API" product labels
    and the npm semver major version are independent axes
  - Extension README / SUBMISSION.md / submission listing copy and
    relay README: every stale `keyquill@2` reference swapped to `@1.x`
  - `streamManager.ts` source comment updated for consistency

  No runtime code change — the wire protocol already supported both v1
  and v2 shapes since Phase 10. Only the install instructions were wrong.

## 1.0.1

### Patch Changes

- b90880a: Post-v1.0 publish: demo site + store submission copy refresh.
  - `docs/demo/` now pins `keyquill@2` via esm.sh and uses the v2
    capability-first API (`tone` + `maxOutput`) in the chat call.
    Surface-level output now reports which key / provider serviced the
    request via the `start` stream event.
  - `packages/keyquill-extension/submission/` listing copy (Chrome +
    Firefox, English + Japanese) refreshed to describe the v1.0 broker
    features — policy / budget / ledger / consent / capability-first SDK
    / localized errors.
  - `SUBMISSION.md` gains a "v1.0 release notes for reviewers" section so
    store reviewers can see what changed at a glance, and the screenshot
    checklist now calls out the new UI surfaces (Policy / Audit /
    request-approval popup) that should be captured before submission.

  No code changes on the npm-published packages beyond the docs — this
  changeset exists only so the CHANGELOG captures the demo + submission
  refresh as a clear bump.

## 1.0.0

### Major Changes

- b67ba88: **BREAKING** — `keyquill@2.0.0`: capability-first API, drop v1 top-level model/temperature/max_tokens.

  ### What changes for callers

  ```ts
  // v1 (0.3.x — frozen, still on npm if you pin)
  await vault.chat({
    messages,
    model: "gpt-5.4-pro",
    max_tokens: 2048,
    temperature: 1,
    reasoning_effort: "high",
  });

  // v2 (2.0.0)
  await vault.chat({
    messages,
    // Option A: capability-declared (recommended)
    requires: ["reasoning", "long_context"],
    tone: "precise",
    maxOutput: 2048,

    // Option B: full control
    prefer: {
      model: "gpt-5.4-pro",
      temperature: 1,
      reasoningEffort: "high",
    },
  });
  ```

  ### New fields on `ChatParams`
  - `requires?: Capability[]` — capability requirements; broker picks the best matching model
  - `tone?: "precise" | "balanced" | "creative"` — behavioral abstraction over `temperature`
  - `maxOutput?: number` — replaces `max_tokens` / `max_completion_tokens`
  - `prefer?: { model?, provider?, temperature?, topP?, reasoningEffort? }` — Tier-3 explicit overrides

  ### Removed from `ChatParams`

  Top-level `model`, `temperature`, `top_p`, `max_tokens`, `max_completion_tokens`,
  `reasoning_effort`, `stop`, `provider`, `tool_choice`, `response_format` are
  gone from the SDK type surface. Use `prefer.*` or their camelCase v2
  equivalents (`toolChoice`, `responseFormat`).

  ### Migration

  If you're pinned to `keyquill@0.3.x`, nothing changes — v1 SDK keeps
  working against the extension indefinitely. When you want the new
  capability API:
  1. `npm install keyquill@2`
  2. Rewrite any `chat({ model, temperature, ... })` to use `prefer`
  3. Rename `tool_choice` → `toolChoice`, `response_format` → `responseFormat`
  4. Rename `reasoning_effort` → `prefer.reasoningEffort`
  5. Rename `max_tokens` / `max_completion_tokens` → `maxOutput`

  The extension (`keyquill-extension@0.3.x+`) accepts both wire shapes — v1
  SDK and v2 SDK clients coexist on the same installed extension.

  ### Extension side (internal)
  - `ChatParams` wire type extended with v2 fields alongside deprecated v1 ones
  - `toResolverRequest` in `streamManager.ts` prefers v2 fields when present, falls back to v1

  No extension-side user action required; users who update the SDK don't
  need to re-add their keys or reapprove origins.

### Patch Changes

- 0e032ef: Documentation refresh for the v1.0 release cycle.
  - `keyquill` README rewritten for the capability-first v2 API with three
    ergonomic tiers (zero-config / capability-declared / full control) and
    a v1→v2 migration table.
  - `keyquill-extension` README introduces the v1.0 broker feature set —
    model catalogue, KeyPolicy, resolver, audit ledger, consent UX, i18n
    errors — and the automatic legacy-defaults migration.
  - `keyquill-mobile` and `keyquill-relay` READMEs add a note that they
    are on a parallel track and have not yet adopted the broker
    architecture; unifying them is tracked as a future arc.

  No code changes in the SDK / mobile / relay packages — these bumps exist
  only so the CHANGELOG captures the docs refresh.

## 0.3.2

### Patch Changes

- bf4ce1a: Fix 400 errors when both `max_tokens` and `max_completion_tokens` are set
  on non-reasoning OpenAI-compatible requests.

  Gemini's OpenAI-compat endpoint rejects the combo outright
  (`"max_tokens and max_completion_tokens cannot both be set"`) and OpenAI
  tightened the same check for `gpt-4o-mini` in April 2026. The SDK's
  `buildOpenAiPassthrough` was sending both when the caller supplied
  both — now sends only `max_completion_tokens` when it is explicitly set,
  else only `max_tokens`. Reasoning-model behaviour is unchanged
  (`max_completion_tokens` only, per existing contract).

  Also relaxes the live-API integration test's non-streaming content
  assertion for OpenAI reasoning models. Under a 32-token budget, reasoning
  models can consume the full budget on internal reasoning tokens and
  return an empty content with `finish_reason=length`; that is a successful
  end-to-end call and no longer fails the test. The stream branch was
  already lenient and is unchanged.

- edee8cc: Route OpenAI `gpt-5-pro` / `o1-pro` / `o3-pro` to the Responses API
  (`/v1/responses`). These models only accept chat requests via Responses,
  not `/v1/chat/completions`, so the previous passthrough returned a 404
  with "This is not a chat model". Detection is a pattern table in
  `providerFetch.ts`; a runtime 404 fallback (with `console.warn`) catches
  future pro models added before the table is updated.

  Popup "Test" button now probes `GET /models` instead of a 1-token chat
  completion. Free, model-agnostic, and avoids the reasoning-model failure
  modes (empty-reasoning budget, temperature≠1 rejection) that broke the
  test for `gpt-5-mini` even when the demo worked. Failure detail (status
  code + sanitized error body) is surfaced so auth vs. endpoint issues are
  distinguishable.

  Temperature is now omitted on Responses API requests unless explicitly
  set to 1 — reasoning models reject temperature≠1 and previously inherited
  per-key `defaults.temperature` could silently break pro requests.

  Live-API integration test matrix (`providerFetch.integration.test.ts`)
  runs against every preset provider and catalogued model, gated per-env
  var so forks skip gracefully. CI workflow `integration.yml` runs it
  nightly and on push-to-main with secrets from GitHub Environments.

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
