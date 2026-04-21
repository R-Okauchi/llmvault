# LLMVault Privacy Policy

**Last updated:** 2026-04-21

LLMVault is a family of client-side libraries and a browser extension that lets you use your own LLM API keys without trusting any intermediary server. This policy explains what the LLMVault software does — and, more importantly, what it does **not** do — with your data.

## What we collect

**Nothing.**

- No analytics.
- No telemetry.
- No crash reports sent off-device.
- No logs sent to any server we operate.

## Where your API keys live

### Browser extension (`llmvault-extension`)

- Keys are stored in **`chrome.storage.session`** (Chrome) / `browser.storage.session` (Firefox).
- This storage is **ephemeral**: keys are erased when the browser closes.
- Keys are never synced across devices.
- Keys are **inaccessible to web pages**. Only the extension's service worker can read them.

### Mobile plugin (`llmvault-mobile`)

- Keys are stored in **iOS Keychain** (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`) / **Android Keystore**, hardware-backed where available.
- **Biometric authentication** (Face ID / Touch ID / fingerprint) is required before each use.
- Keys never leave the native layer of your app.

### Phone Wallet Relay (`llmvault-relay`)

- Used only when you pair a PC browser with your phone wallet.
- All messages are **end-to-end encrypted** (ECDH P-256 + HKDF-SHA-256 + AES-GCM-256).
- The relay server sees **only ciphertext**. It cannot read your API keys, prompts, or responses.

## Who your API keys are shared with

Only the LLM provider **you** configured (OpenAI, Anthropic, Gemini, etc.).

- The browser extension makes HTTPS requests directly from its service worker to the provider API.
- The mobile plugin makes HTTPS requests directly from native code to the provider API.
- Nothing passes through any LLMVault-operated server.

## Per-origin consent (browser extension)

The first time a web app requests LLMVault access, the extension shows a consent popup asking you to approve that origin. Approved origins are stored in `chrome.storage.local` and can be revoked at any time from the extension popup.

- Key registration (`registerKey`) and deletion (`deleteKey`) are **only** available from the extension popup. Web pages cannot register or delete keys.

## Permissions used by the browser extension

| Permission | Why |
|---|---|
| `storage` | To persist per-origin consent grants (`chrome.storage.local`) and to hold keys ephemerally (`chrome.storage.session`). |
| `content_scripts` on `http://*/*` + `https://*/*` | To let the SDK on any web app communicate with the extension via a content-script relay. A page script without our content script cannot call the extension. |

We do **not** request:
- `tabs` / `activeTab`
- `webRequest`
- `history`
- `cookies`
- `identity`

## Third parties

The only third parties that receive any data are the LLM providers **you** choose to use. Please review their privacy policies separately.

## Contact

Report issues or questions via GitHub: <https://github.com/R-Okauchi/llmvault/issues>.

## Changes to this policy

Material changes will be reflected in the commit history at <https://github.com/R-Okauchi/llmvault> and noted in the `Last updated` date above.
