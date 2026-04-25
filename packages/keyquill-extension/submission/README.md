# Extension Store Submission Assets

Drop-in assets for submitting `keyquill-extension` to the Chrome Web Store and Firefox AMO.

## Layout

```
submission/
├─ chrome/                        Chrome Web Store form fields
│  ├─ short-description.en.txt    — "Short description" field (≤ 132 chars)
│  ├─ short-description.ja.txt    — same, Japanese listing
│  ├─ detailed-description.en.md  — "Detailed description" field (≤ 16000 chars)
│  ├─ detailed-description.ja.md
│  ├─ single-purpose.md           — "Single purpose" field
│  ├─ permissions-justification.md — Permission justifications
│  └─ data-usage.md               — Data collection disclosure + commitments
├─ firefox/                       Firefox AMO listing fields
│  ├─ summary.en.txt              — "Summary" field (≤ 250 chars)
│  ├─ summary.ja.txt
│  ├─ description.en.md           — "Description" field
│  └─ description.ja.md
├─ promo/
│  ├─ tile-440x280.svg            — source for the Chrome "Small promo tile"
│  └─ tile-440x280.png            — rendered (440×280, for upload)
└─ screenshots/                   — user-captured UI screenshots (1280×800)
   └─ (placeholder, user populates)
```

## Paste order (Chrome Web Store submission form)

1. Store listing → **Language**: add English (default) and Japanese.
2. Store listing → **Name** (per language): `Keyquill` (both).
3. Store listing → **Short description**: paste `chrome/short-description.en.txt` (English) and `chrome/short-description.ja.txt` (Japanese).
4. Store listing → **Detailed description**: paste `chrome/detailed-description.en.md` (and `.ja.md`). Chrome renders plain text with URL auto-linking; markdown like `**` is not rendered but is harmless.
5. Store listing → **Category**: Productivity.
6. Store listing → **Icon** (128×128): already baked into the extension via `manifest.json` — no upload needed.
7. Store listing → **Screenshots**: upload 2–3 images from `screenshots/` (1280×800).
8. Store listing → **Small promotional tile** (440×280): upload `promo/tile-440x280.png`.
9. Privacy practices → **Single purpose**: paste `chrome/single-purpose.md`.
10. Privacy practices → **Permission justifications**: paste `chrome/permissions-justification.md` into the `storage`, `activeTab`, and `content_scripts` rationale fields.
11. Privacy practices → **Data usage**: fill the form following `chrome/data-usage.md` (checkboxes + privacy policy URL).
12. Privacy practices → **Privacy policy URL**: `https://r-okauchi.github.io/keyquill/privacy-policy`
13. Distribution → **Visibility**: Unlisted (flip to Public after QA).
14. Distribution → **Regions**: all (default).
15. Pricing: free.
16. Submit.

## Paste order (Firefox AMO submission form)

AMO's form is different; the main pieces map as follows:

1. **Name**: `Keyquill`.
2. **Summary**: paste `firefox/summary.en.txt`. Add Japanese locale and paste `firefox/summary.ja.txt`.
3. **Description**: paste `firefox/description.en.md`. Same for Japanese.
4. **Categories**: up to 2 — recommend `Privacy & Security` + `Web Development`.
5. **Privacy Policy URL**: `https://r-okauchi.github.io/keyquill/privacy-policy`.
6. **License**: MIT (from dropdown).
7. **Support email / website**: GitHub issues URL.
8. **Screenshots**: reuse the same PNGs from `screenshots/`.
9. **Source code**: if the reviewer asks, link the GitHub repo. If they still require a zip, create one from the `keyquill-extension-v<version>` tag.

## Regenerating the promo tile

```bash
cd /Users/okauchiryota/main_desk/personal/keyquill
npx --yes @resvg/resvg-js-cli --fit-width 440 \
  packages/keyquill-extension/submission/promo/tile-440x280.svg \
  packages/keyquill-extension/submission/promo/tile-440x280.png
```

Adjust the SVG first if the user swaps in a proper logo.

## Producing the screenshots

See `submission/screenshots/README.md` (to be added by the person capturing them). The capture flow:

1. Build + load the extension unpacked from `packages/keyquill-extension/dist-chrome/`.
2. Register a test API key via the extension popup.
3. Visit <https://r-okauchi.github.io/keyquill/demo/>.
4. Screenshot: the popup with registered key (hint like `sk-t…st12` is safe to show).
5. Screenshot: the demo page in "Extension ready" state before clicking Connect.
6. Screenshot: the demo page mid-stream, response visible in the output area.
7. (Optional) Screenshot: the consent popup.

On macOS: `Cmd+Shift+5`, region selection, save to `submission/screenshots/`.
