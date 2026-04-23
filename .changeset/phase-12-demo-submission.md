---
"keyquill": patch
"keyquill-mobile": patch
"keyquill-relay": patch
---

Post-v1.0 publish: demo site + store submission copy refresh.

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
