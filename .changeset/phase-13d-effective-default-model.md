---
"keyquill": minor
"keyquill-mobile": minor
"keyquill-relay": minor
---

Add `KeySummary.effectiveDefaultModel` — the model the resolver would pick
for a zero-config request, computed by walking `policy.modelPolicy.defaultModel`
→ provider preset default → cheapest catalog entry.

`KeySummary.defaultModel` is now a deprecated alias for the same value and
will be removed in the next SDK major. No migration is required in the 1.x
series; existing code reading `summary.defaultModel` keeps receiving the
same resolver-chosen model it did before.
