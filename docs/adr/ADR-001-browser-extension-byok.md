# ADR-001: Browser Extension BYOK via `chrome.storage.session`

## Status

Accepted.

## Context

Web apps that want to call LLM APIs with the user's own key face three poor options:

1. **Server-side proxy** — the app server sees the key.
2. **Direct browser calls** — blocked by CORS; LLM providers do not allow browser-origin requests.
3. **`localStorage` / `sessionStorage`** — readable from any script in the page context; a single XSS exposes every key.

A browser extension runs in a separate execution context from the page, has its own storage, and can make CORS-free network requests from its service worker. This gives us a place to put the key where the hosting web app cannot reach it.

## Decision

Ship a Manifest V3 extension (`llmvault-extension`) plus a framework-agnostic SDK (`llmvault`).

### Key storage

- Keys live in `chrome.storage.session` — ephemeral (cleared at browser close), unsynced, and invisible to web pages.
- Per-origin consent grants live in `chrome.storage.local`, revocable from the extension popup.

### Communication path

```
Web App         Content Script       Service Worker         Provider
  SDK  ───►  window.postMessage  ───►  chrome.runtime  ───► fetch()
       ◄───  (origin-checked)    ◄───  (key + policy)  ◄─── (no CORS)
```

The SDK never touches `chrome.*` APIs directly. The content script is the only bridge, and the service worker is the only code that reads keys or contacts providers.

### Consent model

First call from an origin opens a consent popup ("Allow `example.com` to use LLMVault?"). Approval is stored in `chrome.storage.local`. Users can revoke any origin from the popup.

### Privileged operations

`registerKey` and `deleteKey` are callable **only from the extension popup**. Web-page calls return `BLOCKED`. A compromised origin cannot plant a rogue key or wipe existing ones.

## Consequences

Positive:

- Keys never enter the web page's execution context. Server operators never see them.
- CORS is bypassed because the service worker's origin is the extension, not the page.
- Per-origin grants give users MetaMask-style visibility and auditability.
- SDK is zero-dependency and framework-agnostic.

Negative:

- Requires users to install an extension — higher friction than pure web.
- Subject to Chrome Web Store / Firefox AMO review.
- `chrome.storage.session` is cleared on browser restart; users may re-enter keys once per browser session (acceptable tradeoff vs. persistent disk storage).
- Content-script injection on `http://*/*` + `https://*/*` is broad; justified because the set of consuming apps is open-ended. Per-origin consent prevents abuse.

## Alternatives considered

- **Native-messaging + separate desktop companion.** Doubles the install burden and adds a platform-specific signed binary. Deferred; `chrome.storage.session` meets the threat model for now.
- **Service Worker inside the hosting web app.** Same JS execution context as the page — no isolation boundary.
- **WASM-based crypto in-browser.** Key material still accessible in page memory.

## Pointers

- SDK: [`packages/llmvault`](../../packages/llmvault)
- Extension: [`packages/llmvault-extension`](../../packages/llmvault-extension)
- Wire protocol: [`packages/llmvault-extension/src/shared/protocol.ts`](../../packages/llmvault-extension/src/shared/protocol.ts)
