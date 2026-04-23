---
"keyquill": major
"keyquill-mobile": major
"keyquill-relay": major
---

**BREAKING** — `keyquill@2.0.0`: capability-first API, drop v1 top-level model/temperature/max_tokens.

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
