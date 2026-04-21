/**
 * Content script: extension announcement + message relay.
 *
 * 1. Injects a <meta> tag so the SDK can detect the extension.
 * 2. Relays messages between the web page (window.postMessage) and the
 *    extension background (runtime.sendMessage / Port), enabling cross-browser
 *    communication that works in both Chrome and Firefox.
 *
 * Runs at document_start, so document.head may not exist yet.
 *
 * Security notes:
 * - registerKey is blocked from the postMessage channel (popup-only).
 * - Remaining message types (chat, chatStream, listProviders, deleteKey, testKey)
 *   do not carry raw API key material. Keys stay in chrome.storage.session.
 * - Nonce/challenge was considered but deemed unnecessary: same-origin +
 *   same-window checks prevent cross-origin replay, and a same-page attacker
 *   could bypass any nonce by calling the content script directly.
 *
 * NOTE: Content scripts are loaded as classic scripts (not ESM modules),
 * so we inline the browser detection instead of importing from shared/browser.ts.
 */

declare const browser: typeof chrome | undefined;

const ext = typeof browser !== "undefined" && browser?.runtime ? browser : chrome;

// ── Meta tag injection ───────────────────────────────

function injectMeta(): void {
  const meta = document.createElement("meta");
  meta.name = "llmvault-extension-id";
  meta.content = ext.runtime.id;
  (document.head ?? document.documentElement).appendChild(meta);
}

if (document.head) {
  injectMeta();
} else {
  const observer = new MutationObserver(() => {
    if (document.head) {
      observer.disconnect();
      injectMeta();
    }
  });
  observer.observe(document.documentElement, { childList: true });
}

window.dispatchEvent(
  new CustomEvent("llmvault-available", {
    detail: { extensionId: ext.runtime.id },
  }),
);

// ── Message relay: web page ↔ background ─────────────

/**
 * Request-response relay.
 * Web page sends: { type: "llmvault-request", id, payload }
 * Content script forwards payload to background via runtime.sendMessage,
 * then posts back: { type: "llmvault-response", id, payload }
 */
window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  if (event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.type !== "llmvault-request") return;

  const { id, payload } = data;

  // Security: block sensitive operations from the postMessage channel.
  // - registerKey / deleteKey: key material must stay out of the page.
  // - _consentResponse: forging this would grant arbitrary origins.
  // - getGrants / revokeGrant: popup-only (info disclosure / DoS).
  // Background enforces the same rules; this is defense in depth.
  const BLOCKED_TYPES = new Set([
    "registerKey",
    "deleteKey",
    "_consentResponse",
    "getGrants",
    "revokeGrant",
  ]);
  if (payload?.type && BLOCKED_TYPES.has(payload.type)) {
    window.postMessage(
      {
        type: "llmvault-response",
        id,
        payload: {
          type: "error",
          code: "BLOCKED",
          message: "This operation is only available from the LLMVault extension popup.",
        },
      },
      location.origin,
    );
    return;
  }

  // Forward to background — use callback pattern for Chrome compatibility
  ext.runtime.sendMessage(payload, (response: unknown) => {
    window.postMessage(
      { type: "llmvault-response", id, payload: response ?? null },
      location.origin,
    );
  });
});

/**
 * Streaming relay.
 * Web page sends: { type: "llmvault-stream-open", id, payload }
 * Content script opens a Port to background, forwards the payload,
 * then relays all messages back as: { type: "llmvault-stream-event", id, payload }
 * When done/disconnected: { type: "llmvault-stream-close", id }
 */
window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  if (event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.type !== "llmvault-stream-open") return;

  const { id, payload } = data;

  const port = ext.runtime.connect({ name: "llmvault-chat" });

  port.onMessage.addListener((msg: unknown) => {
    window.postMessage({ type: "llmvault-stream-event", id, payload: msg }, location.origin);
  });

  port.onDisconnect.addListener(() => {
    window.postMessage({ type: "llmvault-stream-close", id }, location.origin);
  });

  // Send the chat request through the port
  port.postMessage(payload);
});
