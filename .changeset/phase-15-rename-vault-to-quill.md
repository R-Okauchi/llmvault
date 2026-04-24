---
"keyquill": major
"keyquill-mobile": major
"keyquill-relay": major
---

**Breaking:** SDK umbrella wire types renamed to shed the pre-rebrand
`llmvault` naming — no deprecated aliases kept. Consumers that imported
the old names must update:

- `VaultRequest`  → `KeyquillRequest`
- `VaultResponse` → `KeyquillResponse`

Method signatures and runtime behaviour are unchanged. READMEs, JSDoc
examples, store listing copy, demo, and SDK tests now use
`const quill = new Keyquill()` throughout, replacing the `vault`
convention that was a holdover from the old product name.
