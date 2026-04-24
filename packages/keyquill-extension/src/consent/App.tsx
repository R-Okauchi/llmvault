/**
 * Consent popup — two modes:
 *   - origin-trust    : first visit binding (legacy)
 *   - request-approval: per-request model/cost approval from the broker
 *
 * Mode is chosen by the `mode` query-string param. Each mode sends its
 * own response message back to the background so the pending promise
 * there can resolve:
 *   - origin-trust    → _consentResponse
 *   - request-approval → _requestConsentResponse
 */

import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type {
  KeySummary,
  OriginBinding,
  OutgoingResponse,
} from "../shared/protocol.js";
import { ext } from "../shared/browser.js";

type RequestReason =
  | "model-outside-allowlist"
  | "model-in-denylist"
  | "high-cost"
  | "capability-missing";

function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

function readableReason(r: RequestReason, model: string, cost?: number, cap?: string): string {
  switch (r) {
    case "model-outside-allowlist":
      return `The model "${model}" is not in this key's allowlist.`;
    case "model-in-denylist":
      return `The model "${model}" is on this key's denylist.`;
    case "high-cost":
      return cost !== undefined
        ? `Estimated cost $${cost.toFixed(4)} exceeds this key's per-request budget.`
        : `This request is estimated to exceed the key's per-request budget.`;
    case "capability-missing":
      return cap
        ? `This request needs the "${cap}" capability.`
        : `This request needs a capability the current key doesn't grant.`;
    default:
      return "Review and approve this request to continue.";
  }
}

function OriginTrust({ origin }: { origin: string }) {
  const hostname = hostOf(origin);
  const [keys, setKeys] = useState<KeySummary[]>([]);
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);

  useEffect(() => {
    // Fetch keys and bindings in parallel. Preselect the key that
    // services the user's most-recently-used binding (a reasonable
    // proxy for "which key you probably meant to use"), falling back
    // to the first key in insertion order when no bindings exist yet.
    Promise.all([
      new Promise<OutgoingResponse>((resolve) => {
        ext.runtime.sendMessage({ type: "listKeys" }, (r: unknown) =>
          resolve(r as OutgoingResponse),
        );
      }),
      new Promise<OutgoingResponse>((resolve) => {
        ext.runtime.sendMessage({ type: "getBindings" }, (r: unknown) =>
          resolve(r as OutgoingResponse),
        );
      }),
    ]).then(([keysRes, bindingsRes]) => {
      if (keysRes.type !== "keys" || keysRes.keys.length === 0) return;
      setKeys(keysRes.keys);

      let preferred: KeySummary | undefined;
      if (bindingsRes.type === "bindings" && bindingsRes.bindings.length > 0) {
        const mostRecent = [...bindingsRes.bindings].sort(
          (a: OriginBinding, b: OriginBinding) =>
            (b.lastUsedAt ?? b.grantedAt) - (a.lastUsedAt ?? a.grantedAt),
        )[0];
        preferred = keysRes.keys.find((k) => k.keyId === mostRecent.keyId);
      }
      setSelectedKeyId((preferred ?? keysRes.keys[0]).keyId);
    });
  }, []);

  function respond(approved: boolean) {
    const keyId = approved ? (selectedKeyId ?? undefined) : undefined;
    ext.runtime.sendMessage(
      { type: "_consentResponse", origin, approved, keyId },
      () => setTimeout(() => window.close(), 300),
    );
  }

  const hasKeys = keys.length > 0;

  return (
    <div class="consent">
      <img class="consent__icon" src="/icons/icon-128.png" alt="Keyquill" />
      <h1>Connection Request</h1>
      <div class="origin">{hostname}</div>
      <div class="origin-full">{origin}</div>
      <p class="description">
        This site wants to use a Keyquill key to call LLM providers on your behalf.
        Your API key will never be shared with the site.
      </p>

      {hasKeys ? (
        <>
          <label class="picker-label">Which key should this site use?</label>
          <div class="picker">
            {keys.map((k) => (
              <label
                key={k.keyId}
                class={`picker__option ${selectedKeyId === k.keyId ? "picker__option--selected" : ""}`}
              >
                <input
                  type="radio"
                  name="key"
                  value={k.keyId}
                  checked={selectedKeyId === k.keyId}
                  onChange={() => setSelectedKeyId(k.keyId)}
                />
                <div class="picker__label">
                  <span class="picker__name">{k.label}</span>
                  <span class="picker__meta">
                    {k.provider} · {k.keyHint}
                  </span>
                </div>
              </label>
            ))}
          </div>
        </>
      ) : (
        <div class="empty-keys">
          No keys registered yet. Open the Keyquill popup (toolbar icon) and add one first.
        </div>
      )}

      <div class="actions">
        <button class="btn btn--secondary" onClick={() => respond(false)}>
          Deny
        </button>
        <button
          class="btn btn--primary"
          onClick={() => respond(true)}
          disabled={!hasKeys || !selectedKeyId}
        >
          Allow
        </button>
      </div>
      <p class="warning">
        You can change which key this site uses, or revoke access, from the Keyquill popup later.
      </p>
    </div>
  );
}

interface RequestApprovalProps {
  origin: string;
  keyId: string;
  model: string;
  reason: RequestReason;
  cost?: number;
  capability?: string;
}

function RequestApproval({ origin, keyId, model, reason, cost, capability }: RequestApprovalProps) {
  const hostname = hostOf(origin);
  const persistable = reason === "model-outside-allowlist" || reason === "model-in-denylist";

  function respond(approved: boolean, scope?: "once" | "always") {
    ext.runtime.sendMessage(
      {
        type: "_requestConsentResponse",
        origin,
        keyId,
        model,
        reason,
        approved,
        ...(approved && scope ? { scope } : {}),
      },
      () => setTimeout(() => window.close(), 200),
    );
  }

  return (
    <div class="consent consent--compact">
      <h1>Approve Request</h1>
      <div class="origin">{hostname}</div>

      <div class="rq-grid">
        <div class="rq-label">Model</div>
        <div class="rq-value rq-value--mono">{model}</div>
        {cost !== undefined && (
          <>
            <div class="rq-label">Est. cost</div>
            <div class="rq-value">${cost.toFixed(4)}</div>
          </>
        )}
        {capability && (
          <>
            <div class="rq-label">Needs</div>
            <div class="rq-value rq-value--mono">{capability}</div>
          </>
        )}
      </div>

      <p class="rq-reason">{readableReason(reason, model, cost, capability)}</p>

      <div class="rq-actions">
        <button class="btn btn--secondary" onClick={() => respond(false)}>
          Reject
        </button>
        {persistable ? (
          <>
            <button class="btn btn--ghost" onClick={() => respond(true, "once")}>
              Once
            </button>
            <button class="btn btn--primary" onClick={() => respond(true, "always")}>
              Always
            </button>
          </>
        ) : (
          <button class="btn btn--primary" onClick={() => respond(true, "once")}>
            Approve
          </button>
        )}
      </div>
      <p class="warning">
        {persistable
          ? "Once approves this request. Always updates the key's policy to permit this model."
          : "Approves this request one time. Change the budget / capability policy in the Keyquill popup for persistent changes."}
      </p>
    </div>
  );
}

function ConsentApp() {
  const params = new URLSearchParams(location.search);
  const mode = params.get("mode") ?? "origin-trust";
  const origin = params.get("origin") ?? "unknown";

  if (mode === "request-approval") {
    const keyId = params.get("keyId") ?? "";
    const model = params.get("model") ?? "";
    const reason = (params.get("reason") as RequestReason) ?? "model-outside-allowlist";
    const costStr = params.get("cost");
    const cost = costStr ? Number(costStr) : undefined;
    const capability = params.get("capability") ?? undefined;
    return (
      <RequestApproval
        origin={origin}
        keyId={keyId}
        model={model}
        reason={reason}
        cost={cost}
        capability={capability}
      />
    );
  }

  return <OriginTrust origin={origin} />;
}

render(<ConsentApp />, document.getElementById("app")!);
