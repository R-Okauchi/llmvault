/**
 * Consent popup lifecycle manager.
 *
 * When a request arrives from an unapproved origin, opens a small popup
 * window asking the user to approve or deny.  Concurrent requests from
 * the same origin share a single popup (deduplication).
 *
 * Communication:
 *   consent page  ──chrome.runtime.sendMessage──▸  background
 *   The consent page sends { type: "_consentResponse", origin, approved }.
 *   Background calls handleConsentResponse(), which resolves the pending
 *   promise so the original request can proceed.
 */

import { ext } from "../shared/browser.js";
import { addGrant } from "./grantStore.js";

interface PendingConsent {
  promise: Promise<boolean>;
  resolve: (approved: boolean) => void;
  windowId?: number;
}

const pending = new Map<string, PendingConsent>();

/**
 * Request user consent for an origin.
 * Returns true (approved) or false (denied / popup closed).
 * Deduplicates: concurrent callers for the same origin share one popup.
 */
export function requestConsent(origin: string): Promise<boolean> {
  const existing = pending.get(origin);
  if (existing) return existing.promise;

  let resolve!: (v: boolean) => void;
  const promise = new Promise<boolean>((r) => {
    resolve = r;
  });

  const entry: PendingConsent = { promise, resolve };
  pending.set(origin, entry);

  const url = ext.runtime.getURL(
    `src/consent/index.html?origin=${encodeURIComponent(origin)}`,
  );

  ext.windows.create(
    { url, type: "popup", width: 420, height: 340, focused: true },
    (win) => {
      if (win?.id !== undefined) {
        entry.windowId = win.id;
      }
    },
  );

  return promise;
}

/**
 * Handle the response sent by the consent popup page.
 */
export async function handleConsentResponse(
  origin: string,
  approved: boolean,
): Promise<void> {
  if (approved) {
    await addGrant(origin);
  }

  const entry = pending.get(origin);
  if (entry) {
    entry.resolve(approved);
    pending.delete(origin);
    if (entry.windowId !== undefined) {
      ext.windows.remove(entry.windowId).catch(() => {});
    }
  }
}

/**
 * Called from windows.onRemoved — treat closing the popup as denial.
 */
export function handleWindowClosed(windowId: number): void {
  for (const [origin, entry] of pending) {
    if (entry.windowId === windowId) {
      entry.resolve(false);
      pending.delete(origin);
      break;
    }
  }
}
