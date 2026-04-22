# llmvault

## 0.1.1

### Patch Changes

- 75c102b: Establish automated release pipeline via `changesets/action`. Packages at 0.1.1 are functionally identical to 0.1.0 — this release is the first to go through the CI publish flow instead of a manual `npm publish`.

  From this release onward, new versions ship by adding a changeset (`pnpm changeset`) alongside the change and merging the auto-generated "Version Packages" PR.
