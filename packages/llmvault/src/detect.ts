/**
 * Extension detection and messaging utilities.
 *
 * Uses the content script relay pattern (window.postMessage) so that the
 * SDK works in both Chrome and Firefox without relying on
 * chrome.runtime / browser.runtime being exposed to web pages.
 *
 * Detection: content script injects <meta name="llmvault-extension-id">.
 * Messaging: SDK ↔ content script via window.postMessage, content script ↔
 *            background via runtime.sendMessage / Port.
 */

// ── Types ────────────────────────────────────────────

export interface ExtensionPort {
  name: string;
  postMessage(message: unknown): void;
  onMessage: {
    addListener(callback: (message: unknown) => void): void;
    removeListener(callback: (message: unknown) => void): void;
  };
  onDisconnect: {
    addListener(callback: () => void): void;
    removeListener(callback: () => void): void;
  };
  disconnect(): void;
}

/** @deprecated Use ExtensionPort instead. */
export type ChromePort = ExtensionPort;

// ── Extension Detection ──────────────────────────────

/**
 * Check if the LLMVault extension content script has injected its meta tag.
 */
export function hasExtensionRuntime(): boolean {
  return detectExtensionId([]) !== null;
}

/** @deprecated Use hasExtensionRuntime() instead. */
export const hasChromeRuntime = hasExtensionRuntime;

/**
 * Auto-detect extension ID from the <meta> tag injected by the content script.
 */
export function detectExtensionId(knownIds: string[]): string | null {
  if (typeof document !== "undefined") {
    const meta = document.querySelector('meta[name="llmvault-extension-id"]');
    if (meta) {
      const id = meta.getAttribute("content");
      if (id) return id;
    }
  }
  return knownIds[0] ?? null;
}

// ── Messaging via Content Script Relay ───────────────

/**
 * Send a message to the extension via the content script relay.
 * Works in both Chrome and Firefox.
 *
 * Web page posts: { type: "llmvault-request", id, payload }
 * Content script relays to background and posts back:
 *   { type: "llmvault-response", id, payload }
 */
export function sendExtensionMessage<T>(
  _extensionId: string,
  message: unknown,
  timeoutMs: number,
): Promise<T | null> {
  if (typeof window === "undefined") return Promise.resolve(null);

  return new Promise<T | null>((resolve) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      window.removeEventListener("message", handler);
      resolve(null);
    }, timeoutMs);

    function handler(event: MessageEvent) {
      if (event.source !== window) return;
      if (event.origin !== location.origin) return;
      if (event.data?.type !== "llmvault-response" || event.data.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener("message", handler);
      resolve((event.data.payload as T) ?? null);
    }

    window.addEventListener("message", handler);
    window.postMessage({ type: "llmvault-request", id, payload: message }, location.origin);
  });
}

// ── Streaming via Content Script Relay ───────────────

/**
 * Open a streaming connection to the extension via the content script relay.
 * Returns a virtual Port that mirrors the real Port API.
 *
 * Web page posts: { type: "llmvault-stream-open", id, payload }
 * Content script opens a real Port and relays events back as:
 *   { type: "llmvault-stream-event", id, payload }
 *   { type: "llmvault-stream-close", id }
 */
export function connectToExtension(_extensionId: string, _portName: string): ExtensionPort | null {
  if (typeof window === "undefined") return null;

  const id = crypto.randomUUID();
  const messageListeners: Array<(message: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  let connected = true;

  function handler(event: MessageEvent) {
    if (event.source !== window) return;
    if (event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.id !== id) return;

    if (data.type === "llmvault-stream-event") {
      for (const cb of messageListeners) cb(data.payload);
    } else if (data.type === "llmvault-stream-close") {
      connected = false;
      window.removeEventListener("message", handler);
      for (const cb of disconnectListeners) cb();
    }
  }

  window.addEventListener("message", handler);

  const port: ExtensionPort = {
    name: _portName,
    postMessage(message: unknown) {
      if (!connected) return;
      // The initial message is sent via llmvault-stream-open.
      // Subsequent messages go through a separate channel if needed.
      window.postMessage({ type: "llmvault-stream-open", id, payload: message }, location.origin);
    },
    onMessage: {
      addListener(cb: (message: unknown) => void) {
        messageListeners.push(cb);
      },
      removeListener(cb: (message: unknown) => void) {
        const idx = messageListeners.indexOf(cb);
        if (idx >= 0) messageListeners.splice(idx, 1);
      },
    },
    onDisconnect: {
      addListener(cb: () => void) {
        disconnectListeners.push(cb);
      },
      removeListener(cb: () => void) {
        const idx = disconnectListeners.indexOf(cb);
        if (idx >= 0) disconnectListeners.splice(idx, 1);
      },
    },
    disconnect() {
      connected = false;
      window.removeEventListener("message", handler);
    },
  };

  return port;
}
