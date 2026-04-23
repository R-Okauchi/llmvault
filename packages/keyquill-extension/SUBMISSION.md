# Extension Submission Checklist

Steps for publishing `keyquill-extension` to the Chrome Web Store and Firefox AMO.

Listing copy (English + Japanese), privacy documents, and the promo tile all live under [`submission/`](./submission/) as drop-in assets. Screenshots go in [`submission/screenshots/`](./submission/screenshots/).

## v1.0 release notes for reviewers

The v1.0 release introduces substantial new user-visible features:

- **Policy editor** in the popup: per-key allowlist / denylist / budget caps / privacy rules / sampling defaults
- **Audit ledger**: every request stored locally (90-day retention) with origin, model, tokens, and cost. Export to CSV
- **Consent popup** now has a request-approval mode (model / cost / reason with once / always / reject)
- **Capability-first SDK** (`keyquill@2`) — apps declare intent, user policy picks the model
- **Localized error messages** (English + Japanese, auto-detected from browser UI language)

All storage continues to live in `chrome.storage.session` (keys, ephemeral) and `chrome.storage.local` (bindings + policy + ledger). Still no analytics, telemetry, or Keyquill-operated backend. The update flow from 0.3.x is non-destructive — legacy `KeyDefaults` migrate to `KeyPolicy` automatically on first read.

Listing copy in `submission/{chrome,firefox}/` has been refreshed to reflect these additions. Screenshots for the new Policy tab, Audit panel, and request-approval consent popup should be regenerated before final submission (see the checklist below).

## Pre-submission checklist

- [x] **Privacy policy URL live** — <https://r-okauchi.github.io/keyquill/privacy-policy>
- [x] **Promo tile 440×280** — `submission/promo/tile-440x280.png` (regenerate via `npx @resvg/resvg-js-cli --fit-width 440 submission/promo/tile-440x280.svg submission/promo/tile-440x280.png`)
- [x] **Listing copy drafted** — English + Japanese under `submission/chrome/` and `submission/firefox/`
- [x] **Extension icons** — `public/icons/icon-{16,32,48,128}.png` (regenerate via `scripts/gen-icons.sh` from `public/icons/logo.svg`)
- [ ] **Screenshots 1280×800 × 2-3** — capture into `submission/screenshots/` (see README inside). For v1.0, include: Policy tab (Model / Budget sub-panes), Audit log panel, request-approval consent popup.
- [ ] **Real logo** — current `public/icons/logo.svg` is a placeholder safe-dial. Replace before Public release if a branded logo is available.

## Firefox `gecko.id`

Current value: `keyquill@app.keyquill.dev` (in `public/manifest.firefox.json`).

This ID is **immutable** once submitted to AMO. If you change it later, AMO will treat it as a different add-on and users will not receive updates via the normal listing.

## Build & package

```bash
# From the repo root
pnpm install
pnpm --filter keyquill-extension build          # dist-chrome/
pnpm --filter keyquill-extension build:firefox  # dist-firefox/

pnpm --filter keyquill-extension zip:chrome    # keyquill-extension-chrome.zip
pnpm --filter keyquill-extension zip:firefox   # keyquill-extension-firefox.zip
```

## Chrome Web Store submission

1. Register at <https://chrome.google.com/webstore/devconsole> ($5 one-time developer fee; identity verification may be required).
2. **New item** → upload `keyquill-extension-chrome.zip`.
3. Use [`submission/README.md`](./submission/README.md) as the paste-order guide. All listing fields have pre-drafted copy in `submission/chrome/`.
4. Visibility: **Unlisted** initially. After a few days of QA with the Unlisted URL, flip to **Public**.
5. Submit for review. Typical turnaround: 1-3 business days for first submissions.

## Firefox AMO submission

1. Register at <https://addons.mozilla.org/developers/>.
2. Request API credentials (JWT issuer + secret) from **Manage API Keys**.
3. Export to your shell:
   ```bash
   export WEB_EXT_API_KEY=user:...
   export WEB_EXT_API_SECRET=...
   ```
4. Sign & upload:
   ```bash
   pnpm --filter keyquill-extension sign:firefox
   ```
   `web-ext sign --channel=listed` submits the signed build to AMO for review.
5. In the AMO dashboard, fill in the listing metadata using [`submission/firefox/`](./submission/firefox/) as paste source.
6. If AMO reviewers ask for source code, either link <https://github.com/R-Okauchi/keyquill> or upload a zip of the source at the tag corresponding to this release.

## After approval

- Update the **Install** section of the root [`README.md`](../../README.md) with the real Chrome Web Store / AMO URLs.
- Update the package [`README.md`](./README.md) `[Chrome Web Store link — coming soon]` / `[Firefox Add-ons link — coming soon]` placeholders.
- Update [`docs/index.md`](../../docs/index.md) similarly.
- Tag the extension release as `keyquill-extension-v<version>` for source-zip provenance.

## Update flow for subsequent releases

1. Bump `version` in `public/manifest.json` (must be incremented for each upload).
2. `pnpm changeset` to record the change (extension is in the `ignore` list, so this only touches its own CHANGELOG, not npm publication).
3. `pnpm --filter keyquill-extension build && zip:chrome && zip:firefox`.
4. Chrome: upload the new zip to the existing listing → submit.
5. Firefox: `pnpm --filter keyquill-extension sign:firefox` handles upload + sign.
