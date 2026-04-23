---
"keyquill": patch
"keyquill-mobile": patch
"keyquill-relay": patch
---

Documentation refresh for the v1.0 release cycle.

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
