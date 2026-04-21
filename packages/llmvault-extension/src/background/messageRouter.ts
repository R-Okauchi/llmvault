/**
 * Routes incoming messages from web pages and popup to the appropriate handler.
 *
 * Security model (MetaMask-style per-origin consent):
 *   - `ping` — no consent required (availability detection)
 *   - `connect` — triggers consent popup for unapproved origins
 *   - `chat`, `chatStream`, `listProviders`, `testKey` — require prior consent
 *   - `registerKey`, `deleteKey` — popup-only (no sender.tab)
 *   - `getGrants`, `revokeGrant` — popup-only (grant management)
 *   - `_consentResponse` — internal (from consent popup page)
 *
 * Origin is extracted from sender.tab.url (set by Chrome, tamper-proof for
 * intra-extension messages).  Messages without a tab (popup, consent page)
 * are treated as internal/trusted.
 */

import type {
  IncomingRequest,
  OutgoingResponse,
  ChatStreamRequest,
} from "../shared/protocol.js";
import {
  getProviderSummaries,
  setProvider,
  deleteProvider,
  getProviderWithKey,
} from "./keyStore.js";
import { hasGrant, getGrants, removeGrant } from "./grantStore.js";
import { requestConsent, handleConsentResponse } from "./consent.js";
import { handleChatStream, handleChat } from "./streamManager.js";
import { buildProviderFetch } from "./providerFetch.js";
import { ext } from "../shared/browser.js";

const VERSION = "0.2.0";

// ── Origin extraction ─────────────────────────────────

/**
 * Extract the origin of the frame that sent this message.
 *
 * Priority:
 *   1. `sender.origin` (Chrome 80+) — authoritative, correctly handles
 *      sandboxed iframes as opaque ("null") origins that we refuse to grant.
 *   2. `sender.url` — the frame URL (correct for iframes).
 *   3. `sender.tab?.url` — top-level tab URL (fallback only).
 *
 * Using `sender.tab.url` first is WRONG: an iframe embedded in an approved
 * origin would inherit the parent's URL and bypass the origin gate.
 */
function senderOrigin(sender: chrome.runtime.MessageSender): string | null {
  const raw = (sender as { origin?: string }).origin;
  if (typeof raw === "string" && raw.length > 0) {
    // Opaque origins (sandboxed iframes) come through as the string "null".
    // Never grant access to opaque origins.
    return raw === "null" ? null : raw;
  }
  const url = sender.url ?? sender.tab?.url;
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * True for messages sent from our own extension pages (action popup, consent
 * popup, options, any internal page).
 *
 * Why not just `!sender.tab`? The consent popup is opened via
 * `chrome.windows.create({ type: "popup", url })`, which creates a new window
 * containing a tab — so `sender.tab` IS defined for messages from that page.
 * We distinguish extension pages from web pages by matching the sender URL
 * against our extension's URL prefix (e.g. `chrome-extension://<id>/`).
 */
const EXT_URL_PREFIX = ext.runtime.getURL("");

function isInternal(sender: chrome.runtime.MessageSender): boolean {
  const url = sender.url ?? sender.tab?.url;
  if (url && url.startsWith(EXT_URL_PREFIX)) return true;
  // Action popup (toolbar icon) may send with no URL at all.
  if (!sender.tab && !url) return true;
  return false;
}

// ── Origin gate ───────────────────────────────────────

async function requireGrant(
  sender: chrome.runtime.MessageSender,
): Promise<{ origin: string } | OutgoingResponse> {
  // Internal callers (extension popup, consent page) are trusted and
  // skip the origin gate — they have no tab URL and pose no origin risk.
  if (isInternal(sender)) {
    return { origin: "__internal__" };
  }
  const origin = senderOrigin(sender);
  if (!origin) {
    return {
      type: "error",
      code: "UNKNOWN_ORIGIN",
      message: "Cannot determine request origin.",
    };
  }
  if (await hasGrant(origin)) {
    return { origin };
  }
  return {
    type: "error",
    code: "NOT_CONNECTED",
    message:
      "This site is not connected to LLMVault. Call vault.connect() first.",
  };
}

// ── Main handler ──────────────────────────────────────

/**
 * Handle a short request-response message.
 */
export async function handleMessage(
  request: IncomingRequest,
  sender: chrome.runtime.MessageSender,
): Promise<OutgoingResponse> {
  switch (request.type) {
    // ── No consent needed ──

    case "ping": {
      const origin = senderOrigin(sender);
      const connected = origin ? await hasGrant(origin) : false;
      return { type: "pong", version: VERSION, connected };
    }

    // ── Consent flow ──

    case "connect": {
      const origin = senderOrigin(sender);
      if (!origin) {
        return {
          type: "error",
          code: "UNKNOWN_ORIGIN",
          message: "Cannot determine request origin.",
        };
      }
      if (await hasGrant(origin)) {
        return { type: "connected", origin };
      }
      // Open consent popup and wait for user decision
      const approved = await requestConsent(origin);
      if (!approved) {
        return {
          type: "error",
          code: "USER_DENIED",
          message: "Connection denied by user.",
        };
      }
      return { type: "connected", origin };
    }

    case "disconnect": {
      const origin = senderOrigin(sender);
      if (origin) await removeGrant(origin);
      return { type: "ok" };
    }

    // ── Internal: consent popup response ──

    case "_consentResponse": {
      // CRITICAL: restrict to internal (no tab) or a web page could forge
      // arbitrary grants by sending this message.
      if (!isInternal(sender)) {
        return {
          type: "error",
          code: "BLOCKED",
          message: "Internal message type",
        };
      }
      await handleConsentResponse(request.origin, request.approved);
      return { type: "ok" };
    }

    // ── Popup-only: key management ──

    case "registerKey": {
      if (!isInternal(sender)) {
        return {
          type: "error",
          code: "BLOCKED",
          message: "Use the LLMVault extension popup to register API keys.",
        };
      }
      const now = Date.now();
      await setProvider({
        provider: request.provider,
        apiKey: request.apiKey,
        baseUrl: request.baseUrl,
        defaultModel: request.defaultModel,
        label: request.label,
        createdAt: now,
        updatedAt: now,
      });
      return { type: "ok" };
    }

    case "deleteKey": {
      if (!isInternal(sender)) {
        return {
          type: "error",
          code: "BLOCKED",
          message: "Use the LLMVault extension popup to delete API keys.",
        };
      }
      await deleteProvider(request.provider);
      return { type: "ok" };
    }

    // ── Popup-only: grant management ──

    case "getGrants": {
      // Info disclosure: reveals which other sites the user has approved.
      if (!isInternal(sender)) {
        return {
          type: "error",
          code: "BLOCKED",
          message: "Grant listing is only available from the extension popup.",
        };
      }
      return { type: "grants", grants: await getGrants() };
    }

    case "revokeGrant": {
      // DoS: a malicious site could revoke other sites' access.
      if (!isInternal(sender)) {
        return {
          type: "error",
          code: "BLOCKED",
          message: "Grant revocation is only available from the extension popup.",
        };
      }
      await removeGrant(request.origin);
      return { type: "ok" };
    }

    // ── Requires consent: provider operations ──

    case "testKey": {
      const gate = await requireGrant(sender);
      if ("type" in gate) return gate; // error response

      const provider = await getProviderWithKey(request.provider);
      if (!provider) {
        return { type: "testResult", reachable: false };
      }
      try {
        const params = buildProviderFetch(
          provider,
          { messages: [{ role: "user", content: "hi" }], max_tokens: 1 },
          false,
        );
        const res = await fetch(params.url, {
          method: "POST",
          headers: params.headers,
          body: params.body,
        });
        return { type: "testResult", reachable: res.ok };
      } catch {
        return { type: "testResult", reachable: false };
      }
    }

    case "listProviders": {
      const gate = await requireGrant(sender);
      if ("type" in gate) return gate;
      return { type: "providers", providers: await getProviderSummaries() };
    }

    case "chat": {
      const gate = await requireGrant(sender);
      if ("type" in gate) return gate;
      return await handleChat(request);
    }

    default:
      return {
        type: "error",
        code: "INVALID_REQUEST",
        message: "Unknown request type",
      };
  }
}

/**
 * Handle a Port connection for streaming.
 * Requires that the origin is already approved (no auto-consent for streams).
 */
export function handlePortConnect(port: chrome.runtime.Port): void {
  if (port.name !== "llmvault-chat") return;

  port.onMessage.addListener(async (msg: unknown) => {
    const request = msg as ChatStreamRequest;
    if (request.type !== "chatStream") return;

    // Check origin grant. Mirror the sender-origin logic from handleMessage:
    // prefer sender.origin (Chrome 80+), fall back to frame URL, reject
    // opaque ("null") origins.
    const origin = port.sender
      ? senderOrigin(port.sender as chrome.runtime.MessageSender)
      : null;

    if (!origin || !(await hasGrant(origin))) {
      try {
        port.postMessage({
          type: "error",
          code: "NOT_CONNECTED",
          message:
            "This site is not connected to LLMVault. Call vault.connect() first.",
        });
      } catch {
        // Port may already be disconnected
      }
      return;
    }

    await handleChatStream(port, request);
  });
}
