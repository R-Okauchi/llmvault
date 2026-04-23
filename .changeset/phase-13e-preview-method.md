---
"keyquill": minor
"keyquill-mobile": minor
"keyquill-relay": minor
---

Add `vault.preview(params)` — a dry-run of the resolver that returns what
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
