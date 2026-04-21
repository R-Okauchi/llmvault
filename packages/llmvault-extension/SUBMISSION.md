# Extension Submission Checklist

Steps for publishing `llmvault-extension` to the Chrome Web Store and Firefox AMO.

## Before the first submission

### 1. Real logo

- Replace `public/icons/logo.svg` with the final LLMVault logo SVG.
- Install ImageMagick: `brew install imagemagick`.
- Run `./scripts/gen-icons.sh` from the repo root to regenerate the 16 / 32 / 48 / 128 px PNGs.

The current committed PNGs are 1×1 transparent placeholders — stores will reject them.

### 2. Listing assets

Chrome Web Store requires:
- **128×128 icon** (the `icon-128.png` file).
- At least one **1280×800** or **640×400** screenshot (recommend 2–3).
- A **440×280** promo tile (small).
- A **short description** (≤ 132 chars).
- A **detailed description** (≤ 16 000 chars). Draft in `docs/store-listing.md` (to add).

Firefox AMO requires:
- **128×128 icon** and **64×64 icon**.
- At least one screenshot.
- **Short summary** (≤ 250 chars).
- **Detailed description** (markdown-ish).

### 3. Privacy policy URL

Publish `docs/privacy-policy.md` via GitHub Pages:

1. In the GitHub repo settings, enable Pages (source: `main` branch, `docs/` folder or root).
2. Verify the URL resolves:
   - `https://R-Okauchi.github.io/llmvault/privacy-policy/`
3. Use this URL in both Chrome and Firefox submission forms.

### 4. Firefox `gecko.id`

Current value: `llmvault@app.llmvault.dev` (in `public/manifest.firefox.json`).

This ID is **immutable** once submitted to AMO. If you change it later, AMO will treat it as a different add-on and users will not receive updates via the normal listing.

## Build & package

```bash
# From the repo root
pnpm install
pnpm --filter llmvault-extension build          # dist-chrome/
pnpm --filter llmvault-extension build:firefox  # dist-firefox/

pnpm --filter llmvault-extension zip:chrome    # llmvault-extension-chrome.zip
pnpm --filter llmvault-extension zip:firefox   # llmvault-extension-firefox.zip
```

## Chrome Web Store submission

1. Register at <https://chrome.google.com/webstore/devconsole> ($5 one-time developer fee).
2. **New item** → upload `llmvault-extension-chrome.zip`.
3. Fill in:
   - Category: `Productivity` (or `Developer Tools`).
   - Privacy policy URL: from step 3 above.
   - Permissions justification for `host_permissions` / `content_scripts` on `http://*/*` + `https://*/*`:
     > LLMVault is a BYOK wallet SDK. Any web app can embed the LLMVault SDK and call the extension via a content-script bridge. Because the set of consuming apps is not known in advance, content-script injection on all HTTP/HTTPS origins is necessary. Per-origin consent is enforced by the extension itself — no origin can call the extension without the user's explicit approval via a consent popup.
4. Distribution: start with **Unlisted** for internal testing; flip to **Public** after a validation round.
5. Submit for review. Typical turnaround: 1–3 business days.

## Firefox AMO submission

1. Register at <https://addons.mozilla.org/developers/>.
2. Request API credentials (JWT issuer + secret) from the **Manage API Keys** page.
3. Export to your shell:
   ```bash
   export WEB_EXT_API_KEY=user:...
   export WEB_EXT_API_SECRET=...
   ```
4. Sign & upload:
   ```bash
   pnpm --filter llmvault-extension sign:firefox
   ```
   This uses `web-ext sign --channel=listed`, which submits the signed build to AMO for review.
5. In the AMO dashboard, fill in the listing metadata (summary, description, screenshots, privacy policy URL, categories).
6. Review typical turnaround: 1–7 days.

## After approval

- Update the **Install** section of the root [`README.md`](../../README.md) with the real Chrome Web Store / AMO URLs.
- Update the package [`README.md`](./README.md) `[Chrome Web Store link — coming soon]` / `[Firefox Add-ons link — coming soon]` placeholders.
- Tag the release in `llmvault` monorepo: `extension-v0.3.0`.

## Update flow for subsequent releases

1. Bump version in `public/manifest.json` (must be incremented for each upload).
2. Create a changeset for the `llmvault-extension` package.
3. Run the submission commands above.
4. Chrome: upload the new zip to the existing listing → submit for review.
5. Firefox: `pnpm sign:firefox` handles it automatically.
