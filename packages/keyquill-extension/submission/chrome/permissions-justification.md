# Permissions justification

## `storage`

Used for two separate stores, both strictly local to the user's browser:

1. **`chrome.storage.session`** — holds the API keys the user has registered via the extension popup. Session storage is automatically cleared when the browser closes, so the keys are ephemeral by default. This storage is inaccessible to regular web-page JavaScript.
2. **`chrome.storage.local`** — holds per-origin consent grants (which web origins the user has approved to use Keyquill). No API keys, no user-identifying data.

Neither store is ever synced or transmitted off the device.

## `content_scripts` on `http://*/*` and `https://*/*`

Keyquill is a BYOK wallet SDK. The set of web apps that may want to request LLM completions via Keyquill is open-ended — we can't enumerate the origins in advance. The content script's role is extremely narrow: it exposes a `window.postMessage` bridge between the host page and the extension's service worker.

**Per-origin consent gates every call.** When a page posts an Keyquill request, the extension's service worker checks whether the origin has an approved grant in `chrome.storage.local`. If not, the service worker opens a consent popup showing the origin, and the user explicitly approves or denies. Denied and unapproved origins get a `BLOCKED` response; no key material or grant state leaks.

This is the same threat model as MetaMask's `eth_requestAccounts` flow.

## `activeTab`

Used by the extension popup to identify which site the user is currently on, so the popup can surface:

- the host (`example.com`) of the active tab
- which stored key (if any) is bound to that origin
- one-click actions to change the bound key or disconnect the site

`activeTab` is a narrower alternative to `tabs` + `<all_urls>` — it grants access only when the user explicitly invokes the extension (clicks the toolbar icon to open the popup). No background polling, no history access, no script injection into arbitrary pages.

The popup only reads `tab.url` to extract the origin. No page content or DOM is accessed.

## What we do NOT request

- No `host_permissions` or `<all_urls>` in the permissions field.
- No `tabs`, `history`, `cookies`, `identity`, or `webRequest`.
- No access to page DOM. The content script only relays messages.

The extension's service worker contacts LLM provider APIs (api.openai.com, etc.) via `fetch` using the standard CORS-exempt service-worker path; no additional host permission is required.
