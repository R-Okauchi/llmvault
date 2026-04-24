---
"keyquill": major
"keyquill-mobile": major
"keyquill-relay": major
---

**Breaking:** the wallet-wide "active key" concept is removed. Routing
is driven entirely by per-origin bindings.

- `KeySummary.isActive` no longer exists on the type surface.
- The SDK no longer accepts a `setActive` wire message.
- `KeySummary.defaultModel` (previously a deprecated alias) and
  `KeySummary.defaults` (long-deprecated migration remnant) are also
  removed — use `effectiveDefaultModel` and `policy` instead.

### Why

In practice `isActive` was only used by the consent popup's
preselection UI; every external site that reaches the resolver already
has a binding (requireGrant gate), so the "fallback to active key" path
was dead code for web traffic. Keeping a prominent wallet-wide flag for
one UI-only role distorted the user's mental model ("is *this* the key
my site is using?") and added storage invariants that deleteKey /
addKey had to maintain. Dropping it simplifies the data model and
aligns the UI with what actually routes traffic.

### Migration

- Consumers reading `summary.isActive`, `summary.defaultModel`, or
  `summary.defaults` must update their code. `effectiveDefaultModel`
  covers the runtime "which model would run" question; the rest has no
  replacement because the concept no longer exists.
- Stored keys are migrated silently on first read: legacy `isActive` /
  `isDefault` / record-level `defaultModel` are stripped. No user
  action required; existing bindings continue to resolve.
- The consent popup now preselects whichever key services the user's
  most-recently-used binding (falling back to the first key). No more
  star badge.
