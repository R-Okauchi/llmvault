/**
 * Routes incoming messages from web pages and popup to the appropriate handler.
 *
 * Security model (MetaMask-style per-origin consent + key binding):
 *   - `ping` — no consent required (availability detection)
 *   - `connect` — triggers consent popup + key picker for unapproved origins
 *   - `chat`, `chatStream`, `listKeys`, `testKey` — require prior binding
 *   - `addKey`, `updateKey`, `deleteKey`, `setDefault` — popup-only
 *   - `getBindings`, `setBinding`, `revokeBinding` — popup-only
 *   - `_consentResponse` — internal (from consent popup page)
 *
 * Origin is extracted from sender.origin (tamper-proof, Chrome 80+).
 * Messages without a web origin (popup, consent page) are trusted/internal.
 */

import type {
  IncomingRequest,
  OutgoingResponse,
  ChatStreamRequest,
} from "../shared/protocol.js";
import { PROTOCOL_VERSION } from "../shared/protocol.js";
import {
  getKeySummaries,
  getKey,
  addKey,
  updateKey,
  updatePolicy,
  deleteKey,
} from "./keyStore.js";
import { queryByKey, getMonthSpend, exportCSV } from "./ledger.js";
import {
  getBindings,
  hasGrant,
  setBinding,
  removeBinding,
} from "./bindingStore.js";
import {
  requestConsent,
  handleConsentResponse,
  handleRequestConsentResponse,
} from "./consent.js";
import { handleChatStream, handleChat, resolveKey, toResolverRequest } from "./streamManager.js";
import { resolveRequest } from "./resolver.js";
import { toPlanPreview } from "./planPreview.js";
import { buildProviderTestFetch, sanitizeErrorText } from "./providerFetch.js";
import { ext } from "../shared/browser.js";

const VERSION = "0.2.0";

// ── Origin extraction ─────────────────────────────────

function senderOrigin(sender: chrome.runtime.MessageSender): string | null {
  const raw = (sender as { origin?: string }).origin;
  if (typeof raw === "string" && raw.length > 0) {
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

const EXT_URL_PREFIX = ext.runtime.getURL("");

function isInternal(sender: chrome.runtime.MessageSender): boolean {
  const url = sender.url ?? sender.tab?.url;
  if (url && url.startsWith(EXT_URL_PREFIX)) return true;
  if (!sender.tab && !url) return true;
  return false;
}

async function requireGrant(
  sender: chrome.runtime.MessageSender,
): Promise<{ origin: string } | OutgoingResponse> {
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
      "This site is not connected to Keyquill. Call connect() on your Keyquill client first.",
  };
}

// ── Main handler ──────────────────────────────────────

export async function handleMessage(
  request: IncomingRequest,
  sender: chrome.runtime.MessageSender,
): Promise<OutgoingResponse> {
  switch (request.type) {
    case "ping": {
      const origin = senderOrigin(sender);
      const connected = origin ? await hasGrant(origin) : false;
      return { type: "pong", version: VERSION, protocol: PROTOCOL_VERSION, connected };
    }

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
      const result = await requestConsent(origin);
      if (!result.approved) {
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
      if (origin) await removeBinding(origin);
      return { type: "ok" };
    }

    case "_consentResponse": {
      if (!isInternal(sender)) {
        return {
          type: "error",
          code: "BLOCKED",
          message: "Internal message type",
        };
      }
      await handleConsentResponse(request.origin, request.approved, request.keyId);
      return { type: "ok" };
    }

    case "_requestConsentResponse": {
      if (!isInternal(sender)) {
        return { type: "error", code: "BLOCKED", message: "Internal message type" };
      }
      await handleRequestConsentResponse(
        {
          origin: request.origin,
          keyId: request.keyId,
          model: request.model,
          reason: request.reason,
        },
        request.approved
          ? { approved: true, scope: request.scope ?? "once" }
          : { approved: false },
      );
      return { type: "ok" };
    }

    // ── Popup-only: key management ──

    case "addKey": {
      if (!isInternal(sender)) {
        return {
          type: "error",
          code: "BLOCKED",
          message: "Use the Keyquill extension popup to add API keys.",
        };
      }
      try {
        await addKey({
          provider: request.provider,
          label: request.label,
          apiKey: request.apiKey,
          baseUrl: request.baseUrl,
          defaultModel: request.defaultModel,
        });
        return { type: "ok" };
      } catch (err) {
        return {
          type: "error",
          code: "INVALID_KEY",
          message: err instanceof Error ? err.message : "Failed to add key",
        };
      }
    }

    case "updateKey": {
      if (!isInternal(sender)) {
        return {
          type: "error",
          code: "BLOCKED",
          message: "Use the Keyquill extension popup to update API keys.",
        };
      }
      try {
        const updated = await updateKey({
          keyId: request.keyId,
          label: request.label,
          baseUrl: request.baseUrl,
          apiKey: request.apiKey,
        });
        if (!updated) {
          return { type: "error", code: "KEY_NOT_FOUND", message: "Key not found" };
        }
        return { type: "ok" };
      } catch (err) {
        return {
          type: "error",
          code: "INVALID_KEY",
          message: err instanceof Error ? err.message : "Failed to update key",
        };
      }
    }

    case "deleteKey": {
      if (!isInternal(sender)) {
        return {
          type: "error",
          code: "BLOCKED",
          message: "Use the Keyquill extension popup to delete API keys.",
        };
      }
      await deleteKey(request.keyId);
      return { type: "ok" };
    }

    // ── Popup-only: policy + ledger ──

    case "updatePolicy": {
      if (!isInternal(sender)) {
        return {
          type: "error",
          code: "BLOCKED",
          message: "Key policy edits are popup-only.",
        };
      }
      const updated = await updatePolicy(request.keyId, request.policy);
      if (!updated) {
        return { type: "error", code: "KEY_NOT_FOUND", message: "Key not found" };
      }
      return { type: "ok" };
    }

    case "getLedger": {
      if (!isInternal(sender)) {
        return {
          type: "error",
          code: "BLOCKED",
          message: "Audit log is popup-only.",
        };
      }
      const entries = await queryByKey(request.keyId, request.since);
      return { type: "ledger", entries };
    }

    case "getMonthSpend": {
      if (!isInternal(sender)) {
        return {
          type: "error",
          code: "BLOCKED",
          message: "Spend queries are popup-only.",
        };
      }
      const total = await getMonthSpend(request.keyId, request.month);
      const month =
        request.month ??
        `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`;
      return { type: "spend", keyId: request.keyId, month, totalUSD: total };
    }

    case "exportLedger": {
      if (!isInternal(sender)) {
        return {
          type: "error",
          code: "BLOCKED",
          message: "Ledger export is popup-only.",
        };
      }
      const content = await exportCSV(request.keyId);
      return { type: "csv", content };
    }

    // ── Popup-only: binding management ──

    case "getBindings": {
      if (!isInternal(sender)) {
        return {
          type: "error",
          code: "BLOCKED",
          message: "Binding listing is only available from the extension popup.",
        };
      }
      return { type: "bindings", bindings: await getBindings() };
    }

    case "setBinding": {
      if (!isInternal(sender)) {
        return {
          type: "error",
          code: "BLOCKED",
          message: "Binding changes are only available from the extension popup.",
        };
      }
      await setBinding(request.origin, request.keyId);
      return { type: "ok" };
    }

    case "revokeBinding": {
      if (!isInternal(sender)) {
        return {
          type: "error",
          code: "BLOCKED",
          message: "Binding revocation is only available from the extension popup.",
        };
      }
      await removeBinding(request.origin);
      return { type: "ok" };
    }

    // ── Requires consent ──

    case "testKey": {
      // testKey accepts internal (popup) and approved web origins.
      // Probes GET /models (free, model-agnostic, no parameter constraints)
      // — works for every preset provider including reasoning-only models
      // like gpt-5-pro that don't accept /chat/completions.
      if (isInternal(sender) || (await requireGrantSilent(sender))) {
        const keyRecord = await getKey(request.keyId);
        if (!keyRecord) {
          return { type: "testResult", reachable: false };
        }
        try {
          const params = buildProviderTestFetch(keyRecord);
          const res = await fetch(params.url, {
            method: params.method,
            headers: params.headers,
          });
          if (res.ok) {
            return { type: "testResult", reachable: true, status: res.status };
          }
          const body = await res.text().catch(() => "");
          return {
            type: "testResult",
            reachable: false,
            status: res.status,
            detail: sanitizeErrorText(body.slice(0, 200)),
          };
        } catch (err) {
          return {
            type: "testResult",
            reachable: false,
            detail: err instanceof Error ? err.message : "network error",
          };
        }
      }
      return {
        type: "error",
        code: "NOT_CONNECTED",
        message:
          "This site is not connected to Keyquill. Call connect() on your Keyquill client first.",
      };
    }

    case "listKeys": {
      // Popup sees everything; web pages see only after grant.
      if (isInternal(sender)) {
        return { type: "keys", keys: await getKeySummaries() };
      }
      const gate = await requireGrant(sender);
      if ("type" in gate) return gate;
      return { type: "keys", keys: await getKeySummaries() };
    }

    case "chat": {
      const gate = await requireGrant(sender);
      if ("type" in gate) return gate;
      return await handleChat(request, gate.origin);
    }

    case "previewPlan": {
      const gate = await requireGrant(sender);
      if ("type" in gate) return gate;
      const keyRecord = await resolveKey(request, gate.origin);
      if (!keyRecord) {
        return {
          type: "error",
          code: "KEY_NOT_FOUND",
          message: "No Keyquill key available. Open the extension popup to add one.",
        };
      }
      // `stream: false` — resolver builds a plan but the preview handler
      // never issues the fetch, so the flag's only surface effect is on
      // the request body shape (ignored here).
      const resolverRequest = toResolverRequest(request, false);
      const result = await resolveRequest({
        request: resolverRequest,
        origin: gate.origin,
        key: keyRecord,
      });
      const preview = toPlanPreview(result, keyRecord.keyId, keyRecord.provider);
      return { type: "planPreview", preview };
    }

    default:
      return {
        type: "error",
        code: "INVALID_REQUEST",
        message: "Unknown request type",
      };
  }
}

async function requireGrantSilent(
  sender: chrome.runtime.MessageSender,
): Promise<boolean> {
  const origin = senderOrigin(sender);
  if (!origin) return false;
  return await hasGrant(origin);
}


/**
 * Handle a Port connection for streaming.
 */
export function handlePortConnect(port: chrome.runtime.Port): void {
  if (port.name !== "keyquill-chat") return;

  port.onMessage.addListener(async (msg: unknown) => {
    const request = msg as ChatStreamRequest;
    if (request.type !== "chatStream") return;

    const origin = port.sender
      ? senderOrigin(port.sender as chrome.runtime.MessageSender)
      : null;

    if (!origin || !(await hasGrant(origin))) {
      try {
        port.postMessage({
          type: "error",
          code: "NOT_CONNECTED",
          message:
            "This site is not connected to Keyquill. Call connect() on your Keyquill client first.",
        });
      } catch {
        // Port may already be disconnected
      }
      return;
    }

    await handleChatStream(port, request, origin);
  });
}
