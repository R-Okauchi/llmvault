# keyquill-relay

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
