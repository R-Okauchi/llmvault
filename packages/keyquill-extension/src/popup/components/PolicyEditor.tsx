import { useMemo, useState } from "preact/hooks";
import type {
  IncomingRequest,
  KeyPolicy,
  KeyRecord,
  OutgoingResponse,
  ReasoningEffort,
} from "../../shared/protocol.js";
import { DEFAULT_KEY_POLICY } from "../../shared/protocol.js";
import { ext } from "../../shared/browser.js";
import { ALL_MODELS, getModel } from "../../shared/modelCatalog.js";
import { resolveKeyDefault } from "../../shared/keyDefault.js";

function sendMessage(msg: IncomingRequest): Promise<OutgoingResponse> {
  return new Promise((resolve) => {
    ext.runtime.sendMessage(msg, (res: unknown) => resolve(res as OutgoingResponse));
  });
}

type Tab = "model" | "budget" | "privacy" | "sampling" | "behavior";

interface Props {
  keyId: string;
  /** Used to sort autocomplete — models for this provider surface first. */
  provider: string;
  initial?: KeyPolicy;
  onSaved: (policy: KeyPolicy) => void;
  onCancel: () => void;
}

const EFFORTS: ReadonlyArray<ReasoningEffort> = ["minimal", "low", "medium", "high"];

function clone(p: KeyPolicy): KeyPolicy {
  return JSON.parse(JSON.stringify(p)) as KeyPolicy;
}

function parseNum(s: string): number | undefined {
  if (s.trim() === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function parseList(s: string): string[] | undefined {
  const items = s
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  return items.length > 0 ? items : undefined;
}

function joinList(xs: string[] | undefined): string {
  return xs?.join("\n") ?? "";
}

export function PolicyEditor({
  keyId,
  provider,
  initial,
  onSaved,
  onCancel,
}: Props) {
  const [policy, setPolicy] = useState<KeyPolicy>(clone(initial ?? DEFAULT_KEY_POLICY));
  const [tab, setTab] = useState<Tab>("model");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function mut(f: (p: KeyPolicy) => void): void {
    const next = clone(policy);
    f(next);
    setPolicy(next);
  }

  // Autocomplete options: provider's own models first (cheapest by
  // output price), then everything else. Keeps the common case on top
  // without hiding cross-provider alternatives that users sometimes
  // want (e.g., Anthropic-compatible endpoint running OpenRouter).
  const catalogOptions = useMemo(() => {
    const own = ALL_MODELS.filter((m) => m.provider === provider).sort(
      (a, b) => a.pricing.outputPer1M - b.pricing.outputPer1M,
    );
    const others = ALL_MODELS.filter((m) => m.provider !== provider).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    return [...own, ...others];
  }, [provider]);

  // Effective default preview: what the resolver would pick right now
  // given the (possibly unsaved) policy. Used as placeholder text when
  // the user leaves the field blank.
  const effectiveDefault = useMemo(() => {
    const syntheticKey: KeyRecord = {
      keyId,
      provider,
      label: "",
      apiKey: "",
      baseUrl: "",
      policy,
      policyVersion: 3,
      createdAt: 0,
      updatedAt: 0,
    };
    return resolveKeyDefault(syntheticKey);
  }, [keyId, provider, policy]);

  const defaultModelInput = policy.modelPolicy.defaultModel ?? "";
  const catalogHit = defaultModelInput ? getModel(defaultModelInput) : null;
  const isUnknownInCatalog = defaultModelInput !== "" && !catalogHit;
  const allowedModels = policy.modelPolicy.allowedModels ?? [];
  const needsAllowlistAdd =
    defaultModelInput !== "" &&
    (policy.modelPolicy.mode === "allowlist" ||
      policy.modelPolicy.mode === "capability-only") &&
    !allowedModels.includes(defaultModelInput);

  function addDefaultToAllowlist() {
    mut((p) => {
      const next = p.modelPolicy.allowedModels ?? [];
      if (defaultModelInput && !next.includes(defaultModelInput)) {
        p.modelPolicy.allowedModels = [...next, defaultModelInput];
      }
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    const res = await sendMessage({ type: "updatePolicy", keyId, policy });
    setSaving(false);
    if (res.type === "ok") {
      onSaved(policy);
    } else if (res.type === "error") {
      setError(res.message);
    } else {
      setError("Unexpected response");
    }
  }

  return (
    <div class="policy-editor">
      <div class="policy-editor__tabs">
        {(["model", "budget", "privacy", "sampling", "behavior"] as Tab[]).map((t) => (
          <button
            key={t}
            class={`policy-editor__tab ${tab === t ? "policy-editor__tab--active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "model" && (
        <div class="policy-editor__pane">
          <label>
            Mode
            <select
              value={policy.modelPolicy.mode}
              onChange={(e) =>
                mut((p) => {
                  p.modelPolicy.mode = (e.target as HTMLSelectElement).value as KeyPolicy["modelPolicy"]["mode"];
                })
              }
            >
              <option value="open">open — any model</option>
              <option value="allowlist">allowlist — listed only</option>
              <option value="denylist">denylist — all except listed</option>
              <option value="capability-only">capability-only — user maps per-cap</option>
            </select>
          </label>
          <label>
            Default model
            <input
              type="text"
              list={`catalog-models-${keyId}`}
              placeholder={
                effectiveDefault
                  ? `(blank → ${effectiveDefault.id})`
                  : "(no catalog fallback — enter a model ID)"
              }
              value={defaultModelInput}
              onInput={(e) =>
                mut((p) => {
                  const v = (e.target as HTMLInputElement).value.trim();
                  p.modelPolicy.defaultModel = v.length > 0 ? v : undefined;
                })
              }
            />
          </label>
          <datalist id={`catalog-models-${keyId}`}>
            {catalogOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName} · {m.provider}
              </option>
            ))}
          </datalist>
          {isUnknownInCatalog && (
            <div class="policy-editor__hint policy-editor__hint--warn">
              "{defaultModelInput}" isn't in the catalog — cost estimates and
              capability checks won't be available. Double-check the spelling.
            </div>
          )}
          {needsAllowlistAdd && (
            <div class="policy-editor__hint policy-editor__hint--warn">
              "{defaultModelInput}" isn't in your allowlist below —
              requests would be rejected / prompt confirmation.{" "}
              <button
                type="button"
                class="policy-editor__inline-btn"
                onClick={addDefaultToAllowlist}
              >
                Add to allowlist
              </button>
            </div>
          )}
          {(policy.modelPolicy.mode === "allowlist" ||
            policy.modelPolicy.mode === "capability-only") && (
            <label>
              Allowed models (one per line)
              <textarea
                rows={4}
                value={joinList(policy.modelPolicy.allowedModels)}
                onInput={(e) =>
                  mut((p) => {
                    p.modelPolicy.allowedModels = parseList((e.target as HTMLTextAreaElement).value);
                  })
                }
              />
            </label>
          )}
          {policy.modelPolicy.mode === "denylist" && (
            <label>
              Denied models (one per line)
              <textarea
                rows={4}
                value={joinList(policy.modelPolicy.deniedModels)}
                onInput={(e) =>
                  mut((p) => {
                    p.modelPolicy.deniedModels = parseList((e.target as HTMLTextAreaElement).value);
                  })
                }
              />
            </label>
          )}
          <label>
            On violation
            <select
              value={policy.modelPolicy.onViolation}
              onChange={(e) =>
                mut((p) => {
                  p.modelPolicy.onViolation = (e.target as HTMLSelectElement).value as KeyPolicy["modelPolicy"]["onViolation"];
                })
              }
            >
              <option value="confirm">confirm — ask me</option>
              <option value="reject">reject — error out</option>
            </select>
          </label>
        </div>
      )}

      {tab === "budget" && (
        <div class="policy-editor__pane">
          <label>
            Max tokens per request
            <input
              type="number"
              min="1"
              placeholder="(no cap)"
              value={policy.budget.maxTokensPerRequest ?? ""}
              onInput={(e) =>
                mut((p) => {
                  p.budget.maxTokensPerRequest = parseNum((e.target as HTMLInputElement).value);
                })
              }
            />
          </label>
          <label>
            Max cost per request (USD)
            <input
              type="number"
              min="0"
              step="0.001"
              placeholder="(no cap)"
              value={policy.budget.maxCostPerRequestUSD ?? ""}
              onInput={(e) =>
                mut((p) => {
                  p.budget.maxCostPerRequestUSD = parseNum((e.target as HTMLInputElement).value);
                })
              }
            />
          </label>
          <label>
            Daily budget (USD)
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="(no cap)"
              value={policy.budget.dailyBudgetUSD ?? ""}
              onInput={(e) =>
                mut((p) => {
                  p.budget.dailyBudgetUSD = parseNum((e.target as HTMLInputElement).value);
                })
              }
            />
          </label>
          <label>
            Monthly budget (USD)
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="(no cap)"
              value={policy.budget.monthlyBudgetUSD ?? ""}
              onInput={(e) =>
                mut((p) => {
                  p.budget.monthlyBudgetUSD = parseNum((e.target as HTMLInputElement).value);
                })
              }
            />
          </label>
          <label>
            Max reasoning effort
            <select
              value={policy.budget.maxReasoningEffort ?? ""}
              onChange={(e) =>
                mut((p) => {
                  const v = (e.target as HTMLSelectElement).value as ReasoningEffort | "";
                  p.budget.maxReasoningEffort = v === "" ? undefined : v;
                })
              }
            >
              <option value="">(unlimited)</option>
              {EFFORTS.map((ef) => (
                <option key={ef} value={ef}>
                  {ef}
                </option>
              ))}
            </select>
          </label>
          <label>
            On budget hit
            <select
              value={policy.budget.onBudgetHit}
              onChange={(e) =>
                mut((p) => {
                  p.budget.onBudgetHit = (e.target as HTMLSelectElement).value as KeyPolicy["budget"]["onBudgetHit"];
                })
              }
            >
              <option value="warn">warn only</option>
              <option value="confirm">confirm before proceeding</option>
              <option value="block">block entirely</option>
            </select>
          </label>
        </div>
      )}

      {tab === "privacy" && (
        <div class="policy-editor__pane">
          <label class="policy-editor__checkbox">
            <input
              type="checkbox"
              checked={policy.privacy.requireHttps}
              onChange={(e) =>
                mut((p) => {
                  p.privacy.requireHttps = (e.target as HTMLInputElement).checked;
                })
              }
            />
            Require HTTPS for provider endpoint
          </label>
          <label class="policy-editor__checkbox">
            <input
              type="checkbox"
              checked={policy.privacy.logAuditEvents}
              onChange={(e) =>
                mut((p) => {
                  p.privacy.logAuditEvents = (e.target as HTMLInputElement).checked;
                })
              }
            />
            Record every request to audit log
          </label>
          <label>
            Allowed providers (one per line — blank = any)
            <textarea
              rows={3}
              value={joinList(policy.privacy.allowedProviders)}
              onInput={(e) =>
                mut((p) => {
                  p.privacy.allowedProviders = parseList((e.target as HTMLTextAreaElement).value);
                })
              }
            />
          </label>
          <label>
            Allowed origins (regex — blank = any)
            <input
              type="text"
              placeholder="^https://trusted\\.com"
              value={policy.privacy.allowedOriginsRegex ?? ""}
              onInput={(e) =>
                mut((p) => {
                  const v = (e.target as HTMLInputElement).value.trim();
                  p.privacy.allowedOriginsRegex = v || undefined;
                })
              }
            />
          </label>
        </div>
      )}

      {tab === "sampling" && (
        <div class="policy-editor__pane">
          <p class="policy-editor__hint">
            Default sampling applied when the caller doesn't specify tone / temperature.
          </p>
          <label>
            Temperature (0.0 - 2.0)
            <input
              type="number"
              min="0"
              max="2"
              step="0.1"
              placeholder="(provider default)"
              value={policy.sampling?.temperature ?? ""}
              onInput={(e) =>
                mut((p) => {
                  const v = parseNum((e.target as HTMLInputElement).value);
                  if (!p.sampling) p.sampling = {};
                  p.sampling.temperature = v;
                  if (!p.sampling.temperature && !p.sampling.topP) p.sampling = undefined;
                })
              }
            />
          </label>
          <label>
            Top P (0.0 - 1.0)
            <input
              type="number"
              min="0"
              max="1"
              step="0.05"
              placeholder="(provider default)"
              value={policy.sampling?.topP ?? ""}
              onInput={(e) =>
                mut((p) => {
                  const v = parseNum((e.target as HTMLInputElement).value);
                  if (!p.sampling) p.sampling = {};
                  p.sampling.topP = v;
                  if (!p.sampling.temperature && !p.sampling.topP) p.sampling = undefined;
                })
              }
            />
          </label>
        </div>
      )}

      {tab === "behavior" && (
        <div class="policy-editor__pane">
          <label class="policy-editor__checkbox">
            <input
              type="checkbox"
              checked={policy.behavior.autoFallback}
              onChange={(e) =>
                mut((p) => {
                  p.behavior.autoFallback = (e.target as HTMLInputElement).checked;
                })
              }
            />
            Auto-fallback on 404 (chat → /responses for pro models)
          </label>
          <label>
            Max retries (on transient provider errors)
            <input
              type="number"
              min="0"
              max="5"
              value={policy.behavior.maxRetries}
              onInput={(e) =>
                mut((p) => {
                  const v = parseNum((e.target as HTMLInputElement).value);
                  if (v !== undefined) p.behavior.maxRetries = v;
                })
              }
            />
          </label>
          <label>
            Request timeout (ms)
            <input
              type="number"
              min="1000"
              step="1000"
              value={policy.behavior.timeoutMs}
              onInput={(e) =>
                mut((p) => {
                  const v = parseNum((e.target as HTMLInputElement).value);
                  if (v !== undefined) p.behavior.timeoutMs = v;
                })
              }
            />
          </label>
        </div>
      )}

      {error && <div class="form__error">{error}</div>}
      <div class="policy-editor__actions">
        <button class="btn btn--primary btn--sm" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save policy"}
        </button>
        <button class="btn btn--ghost btn--sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
