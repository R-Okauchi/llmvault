---
"keyquill": patch
"keyquill-mobile": patch
"keyquill-relay": patch
---

Route OpenAI `gpt-5-pro` / `o1-pro` / `o3-pro` to the Responses API
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
