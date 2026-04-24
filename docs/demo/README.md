# Keyquill Demo

A minimal single-page demo that exercises the [`keyquill`](https://www.npmjs.com/package/keyquill) SDK against the Keyquill browser extension.

## Live

<https://r-okauchi.github.io/keyquill/demo/>

## Run locally

The page is pure HTML + inline JS — no build step. Serve it from any static HTTP server:

```bash
# From the repo root
python3 -m http.server 8080 --directory docs
# then open http://localhost:8080/demo/
```

`file://` mostly works too, but Chrome is stricter about some extension APIs under `file://` — prefer HTTP for a realistic test.

## Flow

1. Load the Keyquill extension (unpacked from `packages/keyquill-extension/dist-chrome/` until the Chrome Web Store listing is live).
2. Open the extension popup and register an OpenAI-compatible API key.
3. Visit the demo page — it should say "Extension ready".
4. Click **Connect extension** → approve the consent popup.
5. Type a prompt → **Send** → the response streams into the output area.

## How it imports the SDK

```html
<script type="module">
  import { Keyquill } from "https://esm.sh/keyquill@1";
</script>
```

We import directly from [esm.sh](https://esm.sh) so there's no build tooling. Pinned to major version `@1` so patch/minor updates flow automatically while breaking majors require an intentional bump. (`keyquill@1.x` on npm carries the capability-first "v2 API" — see the note in the SDK README for the naming disambiguation.)

## SDK v2 usage in this demo

The chat call uses the v2 capability-first API: it declares behavioural intent (`tone`, `maxOutput`) rather than picking a concrete model. The extension's broker resolves the request against the user's KeyPolicy and records every call in the audit ledger.

```js
for await (const event of quill.chatStream({
  messages: [{ role: "user", content: prompt }],
  tone: "balanced",   // "precise" | "balanced" | "creative"
  maxOutput: 512,     // output-token ceiling, clamped by user policy
})) {
  if (event.type === "start")
    console.log(`[key: ${event.label} · ${event.provider}]`);
  if (event.type === "delta") process.stdout.write(event.text);
}
```

To see a consent popup in action, set an allowlist on your key (Policy tab in the extension popup) and then request a model outside it via `prefer: { model: "gpt-5.4-pro" }` — the broker will surface the popup with model / estimated cost / reason and the once/always/reject choice.
