/**
 * LLMVault — Background Service Worker
 *
 * Listens for internal messages (from content script relay and popup)
 * and routes them to the appropriate handler.
 */

import type { IncomingRequest } from "../shared/protocol.js";
import { handleMessage, handlePortConnect } from "./messageRouter.js";
import { handleWindowClosed } from "./consent.js";
import { ext } from "../shared/browser.js";

// sendResponse + return true pattern: works across all Chrome & Firefox versions.
function onRequest(
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): true {
  const request = message as IncomingRequest;
  handleMessage(request, sender)
    .catch((err) => ({
      type: "error" as const,
      code: "EXTENSION_ERROR",
      message: err instanceof Error ? err.message : "Unknown error",
    }))
    .then(sendResponse);
  return true;
}

// Handle request-response messages (from content script relay + popup)
ext.runtime.onMessage.addListener(onRequest);

// Handle long-lived Port connections for streaming (from content script relay)
ext.runtime.onConnect.addListener(((port: Parameters<typeof handlePortConnect>[0]) => {
  handlePortConnect(port);
}) as (port: unknown) => void);

// Detect consent popup closed without responding → treat as denial
ext.windows.onRemoved.addListener((windowId: number) => {
  handleWindowClosed(windowId);
});

console.log("[LLMVault bg] service worker loaded");
