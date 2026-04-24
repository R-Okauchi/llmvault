---
"keyquill": minor
"keyquill-mobile": minor
"keyquill-relay": minor
---

Rename the SDK umbrella wire types: `VaultRequest` → `KeyquillRequest`
and `VaultResponse` → `KeyquillResponse`. The old names are kept as
`@deprecated` aliases pointing at the new types, so existing code
compiles unchanged; they are scheduled for removal in the next SDK
major.

This is the final cleanup of the pre-rebrand `llmvault` name from the
SDK's example voice — READMEs, JSDoc examples, and the demo now use
`const quill = new Keyquill()` throughout.
