/**
 * Consent popup lifecycle manager.
 *
 * Two consent flavors share the same popup window + response message:
 *
 *   1. Origin trust (legacy): first visit from an origin.
 *      Popup asks the user to approve the origin AND pick which stored
 *      key to bind. Successful approval creates an OriginBinding.
 *
 *   2. Request approval (v1.0 broker): the resolver returned
 *      consent-required for a specific request — e.g., the chosen model
 *      is outside the key's allowlist, or the estimated cost exceeds the
 *      per-request cap. Popup shows model / cost / reason and three
 *      options: once / always / reject. "Always" mutates the key policy
 *      to persist the approval.
 *
 * Both flavors open `src/consent/index.html` — the popup UI inspects
 * query-string params to decide which view to render.
 */

import type { KeyPolicy } from "../shared/protocol.js";
import { ext } from "../shared/browser.js";
import { setBinding } from "./bindingStore.js";
import { getKey, updatePolicy } from "./keyStore.js";

// ── Origin-trust flow ─────────────────────────────────

export interface ConsentResult {
  approved: boolean;
  keyId?: string;
}

interface PendingConsent {
  kind: "origin-trust";
  promise: Promise<ConsentResult>;
  resolve: (result: ConsentResult) => void;
  windowId?: number;
}

// ── Request-approval flow ─────────────────────────────

export interface RequestConsentContext {
  origin: string;
  keyId: string;
  model: string;
  estimatedCostUSD?: number;
  reason:
    | "model-outside-allowlist"
    | "model-in-denylist"
    | "high-cost"
    | "capability-missing";
  capability?: string;
}

export type RequestConsentDecision =
  | { approved: true; scope: "once" | "always" }
  | { approved: false };

interface PendingRequestConsent {
  kind: "request-approval";
  context: RequestConsentContext;
  promise: Promise<RequestConsentDecision>;
  resolve: (result: RequestConsentDecision) => void;
  windowId?: number;
}

type PendingEntry = PendingConsent | PendingRequestConsent;

// Key: for origin-trust, the origin. For request-approval, a composite
// "<origin>::<keyId>::<model>::<reason>" so distinct decisions don't
// dedupe against each other.
const pending = new Map<string, PendingEntry>();

// ── Public API ────────────────────────────────────────

/**
 * Request user consent for an origin (first-visit binding flow).
 * Deduplicates concurrent callers for the same origin.
 */
export function requestConsent(origin: string): Promise<ConsentResult> {
  const existing = pending.get(origin);
  if (existing && existing.kind === "origin-trust") return existing.promise;

  let resolve!: (v: ConsentResult) => void;
  const promise = new Promise<ConsentResult>((r) => {
    resolve = r;
  });

  const entry: PendingConsent = { kind: "origin-trust", promise, resolve };
  pending.set(origin, entry);

  const url = ext.runtime.getURL(
    `src/consent/index.html?mode=origin-trust&origin=${encodeURIComponent(origin)}`,
  );

  ext.windows.create(
    { url, type: "popup", width: 420, height: 460, focused: true },
    (win) => {
      if (win?.id !== undefined) entry.windowId = win.id;
    },
  );

  return promise;
}

function requestConsentKey(ctx: RequestConsentContext): string {
  return `${ctx.origin}::${ctx.keyId}::${ctx.model}::${ctx.reason}`;
}

/**
 * Request user approval for a specific request the resolver flagged. The
 * popup shows the breakdown (model / cost / reason) and three buttons.
 * Returns the user's decision once they click or close the window.
 */
export function requestRequestConsent(
  ctx: RequestConsentContext,
): Promise<RequestConsentDecision> {
  const key = requestConsentKey(ctx);
  const existing = pending.get(key);
  if (existing && existing.kind === "request-approval") return existing.promise;

  let resolve!: (v: RequestConsentDecision) => void;
  const promise = new Promise<RequestConsentDecision>((r) => {
    resolve = r;
  });

  const entry: PendingRequestConsent = {
    kind: "request-approval",
    context: ctx,
    promise,
    resolve,
  };
  pending.set(key, entry);

  const params = new URLSearchParams({
    mode: "request-approval",
    origin: ctx.origin,
    keyId: ctx.keyId,
    model: ctx.model,
    reason: ctx.reason,
  });
  if (ctx.estimatedCostUSD !== undefined) {
    params.set("cost", ctx.estimatedCostUSD.toString());
  }
  if (ctx.capability) params.set("capability", ctx.capability);

  const url = ext.runtime.getURL(`src/consent/index.html?${params.toString()}`);

  ext.windows.create(
    { url, type: "popup", width: 460, height: 360, focused: true },
    (win) => {
      if (win?.id !== undefined) entry.windowId = win.id;
    },
  );

  return promise;
}

// ── Response handlers ─────────────────────────────────

/**
 * Handle origin-trust popup response.
 */
export async function handleConsentResponse(
  origin: string,
  approved: boolean,
  keyId?: string,
): Promise<void> {
  if (approved && keyId) {
    await setBinding(origin, keyId);
  }

  const entry = pending.get(origin);
  if (entry && entry.kind === "origin-trust") {
    entry.resolve({ approved, keyId });
    pending.delete(origin);
    if (entry.windowId !== undefined) {
      ext.windows.remove(entry.windowId).catch(() => {});
    }
  }
}

/**
 * Handle request-approval popup response. When scope === "always" and
 * the reason was a model-list violation, the key's policy is mutated to
 * persist the approval so future requests skip the popup.
 */
export async function handleRequestConsentResponse(
  ctx: RequestConsentContext,
  decision: RequestConsentDecision,
): Promise<void> {
  const key = requestConsentKey(ctx);
  const entry = pending.get(key);
  if (!entry || entry.kind !== "request-approval") return;

  if (decision.approved && decision.scope === "always") {
    await persistAlwaysApproval(ctx);
  }

  entry.resolve(decision);
  pending.delete(key);
  if (entry.windowId !== undefined) {
    ext.windows.remove(entry.windowId).catch(() => {});
  }
}

async function persistAlwaysApproval(ctx: RequestConsentContext): Promise<void> {
  const keyRecord = await getKey(ctx.keyId);
  if (!keyRecord?.policy) return;
  const policy: KeyPolicy = JSON.parse(JSON.stringify(keyRecord.policy));

  if (ctx.reason === "model-outside-allowlist") {
    const list = new Set(policy.modelPolicy.allowedModels ?? []);
    list.add(ctx.model);
    policy.modelPolicy.allowedModels = [...list];
  } else if (ctx.reason === "model-in-denylist") {
    policy.modelPolicy.deniedModels = (policy.modelPolicy.deniedModels ?? []).filter(
      (m) => m !== ctx.model,
    );
  }
  // For "high-cost" and "capability-missing" the right persistent action
  // is nuanced (raise budget cap? add capability grant?). For now those
  // cases behave as one-time bypass even when user picks "always" — the
  // popup UI hides the "always" button for them.
  await updatePolicy(ctx.keyId, policy);
}

/**
 * Called from windows.onRemoved — treat closing the popup as denial.
 */
export function handleWindowClosed(windowId: number): void {
  for (const [key, entry] of pending) {
    if (entry.windowId === windowId) {
      if (entry.kind === "origin-trust") {
        entry.resolve({ approved: false });
      } else {
        entry.resolve({ approved: false });
      }
      pending.delete(key);
      break;
    }
  }
}
