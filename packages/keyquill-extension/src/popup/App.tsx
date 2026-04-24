import { render } from "preact";
import { useState, useEffect } from "preact/hooks";
import type {
  KeyPolicy,
  KeySummary,
  OriginBinding,
  IncomingRequest,
  OutgoingResponse,
} from "../shared/protocol.js";
import { ext } from "../shared/browser.js";
import { PRESETS, getPreset } from "../shared/presets.js";
import { renderError } from "../shared/errors/index.js";
import { PolicyEditor } from "./components/PolicyEditor.js";
import { AuditPanel } from "./components/AuditPanel.js";
import { SpendBar } from "./components/SpendBar.js";

function sendMessage(msg: IncomingRequest): Promise<OutgoingResponse> {
  return new Promise((resolve) => {
    ext.runtime.sendMessage(msg, (res: unknown) => {
      resolve(res as OutgoingResponse);
    });
  });
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

const DEFAULT_PRESET_ID = PRESETS[0].id;

function App() {
  const [keys, setKeys] = useState<KeySummary[]>([]);
  const [bindings, setBindings] = useState<OriginBinding[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editingBinding, setEditingBinding] = useState<string | null>(null);
  const [testResultKey, setTestResultKey] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [expandedPanel, setExpandedPanel] = useState<"policy" | "audit" | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // Add-key form fields. Presets auto-fill baseUrl/defaultModel; only the
  // `custom` preset surfaces them as user inputs. Sampling defaults and
  // other policy tweaks are edited through the Policy editor after the
  // key exists.
  const [formProvider, setFormProvider] = useState<string>(DEFAULT_PRESET_ID);
  const [formLabel, setFormLabel] = useState("");
  const [formApiKey, setFormApiKey] = useState("");
  const [formBaseUrl, setFormBaseUrl] = useState(PRESETS[0].baseUrl);
  const [formDefaultModel, setFormDefaultModel] = useState(PRESETS[0].defaultModel);

  async function loadKeys() {
    const res = await sendMessage({ type: "listKeys" });
    if (res.type === "keys") setKeys(res.keys);
  }

  async function loadBindings() {
    const res = await sendMessage({ type: "getBindings" });
    if (res.type === "bindings") setBindings(res.bindings);
  }

  useEffect(() => {
    loadKeys();
    loadBindings();
  }, []);

  function resetForm() {
    setFormProvider(DEFAULT_PRESET_ID);
    setFormLabel("");
    setFormApiKey("");
    setFormBaseUrl(PRESETS[0].baseUrl);
    setFormDefaultModel(PRESETS[0].defaultModel);
    setFormError(null);
  }

  function handleProviderChange(id: string) {
    setFormProvider(id);
    const preset = getPreset(id);
    if (preset) {
      // Only auto-fill baseURL/model if user hasn't typed something different.
      // Simplest: always overwrite on explicit preset change.
      setFormBaseUrl(preset.baseUrl);
      setFormDefaultModel(preset.defaultModel);
    }
  }

  async function handleAdd(e: Event) {
    e.preventDefault();
    setFormError(null);
    const label = formLabel.trim();
    if (!label) {
      setFormError("Label is required (e.g. Work, Personal).");
      return;
    }
    if (formProvider === "custom") {
      if (!formBaseUrl.trim()) {
        setFormError("Base URL is required for custom providers.");
        return;
      }
      if (!formDefaultModel.trim()) {
        setFormError("Default model is required for custom providers.");
        return;
      }
    }
    const res = await sendMessage({
      type: "addKey",
      provider: formProvider,
      label,
      apiKey: formApiKey,
      baseUrl: formBaseUrl,
      defaultModel: formDefaultModel,
    });
    if (res.type === "error") {
      setFormError(renderError(res.code, res.message));
      return;
    }
    setShowForm(false);
    resetForm();
    await loadKeys();
  }

  async function handleDelete(keyId: string) {
    await sendMessage({ type: "deleteKey", keyId });
    await loadKeys();
    await loadBindings();
  }

  async function handleTest(keyId: string) {
    setTestResultKey(keyId);
    setTestResult("Testing...");
    const res = await sendMessage({ type: "testKey", keyId });
    if (res.type === "testResult") {
      if (res.reachable) {
        setTestResult("Connected ✓");
      } else {
        const suffix = [res.status, res.detail].filter(Boolean).join(" ");
        setTestResult(suffix ? `Failed: ${suffix}` : "Failed");
      }
    } else {
      setTestResult("Error");
    }
    setTimeout(() => {
      setTestResult(null);
      setTestResultKey(null);
    }, 6000);
  }

  async function handleSetBinding(origin: string, keyId: string) {
    await sendMessage({ type: "setBinding", origin, keyId });
    setEditingBinding(null);
    await loadBindings();
  }

  async function handleRevokeBinding(origin: string) {
    await sendMessage({ type: "revokeBinding", origin });
    await loadBindings();
  }

  // Group keys by provider for visual organization
  const keysByProvider = new Map<string, KeySummary[]>();
  for (const k of keys) {
    const list = keysByProvider.get(k.provider) ?? [];
    list.push(k);
    keysByProvider.set(k.provider, list);
  }

  return (
    <div>
      <h1>
        <img class="icon" src="/icons/icon-48.png" alt="" /> Keyquill
      </h1>

      <section class="section">
        <h2 class="section__title">Your keys ({keys.length})</h2>

        {keys.length === 0 && !showForm && (
          <div class="empty">
            <p>No keys registered yet.</p>
            <p>Add one to get started.</p>
          </div>
        )}

        {Array.from(keysByProvider.entries()).map(([provider, list]) => (
          <div key={provider} class="provider-group">
            <div class="provider-group__header">
              {provider} ({list.length})
            </div>
            {list.map((k) => {
              const isExpanded = expandedKey === k.keyId;
              const togglePanel = (panel: "policy" | "audit") => {
                if (isExpanded && expandedPanel === panel) {
                  setExpandedKey(null);
                  setExpandedPanel(null);
                } else {
                  setExpandedKey(k.keyId);
                  setExpandedPanel(panel);
                }
              };
              return (
              <div key={k.keyId} class="key-card">
                <div class="key-card__header">
                  <span class="key-card__label">{k.label}</span>
                </div>
                <div class="key-card__meta">
                  <span class="key-card__hint">{k.keyHint}</span>
                  <span class="key-card__model">{k.effectiveDefaultModel ?? "(no default)"}</span>
                </div>
                <SpendBar keyId={k.keyId} budgetUSD={k.policy?.budget.monthlyBudgetUSD} />
                <div class="key-card__actions">
                  <button class="btn btn--secondary btn--sm" onClick={() => handleTest(k.keyId)}>
                    Test
                  </button>
                  <button
                    class={`btn btn--ghost btn--sm ${isExpanded && expandedPanel === "policy" ? "btn--active" : ""}`}
                    onClick={() => togglePanel("policy")}
                  >
                    Policy
                  </button>
                  <button
                    class={`btn btn--ghost btn--sm ${isExpanded && expandedPanel === "audit" ? "btn--active" : ""}`}
                    onClick={() => togglePanel("audit")}
                  >
                    Audit
                  </button>
                  <button class="btn btn--ghost btn--sm" onClick={() => handleDelete(k.keyId)}>
                    Delete
                  </button>
                </div>
                {testResultKey === k.keyId && testResult && (
                  <div
                    class={`test-result test-result--${testResult.includes("✓") ? "ok" : "fail"}`}
                  >
                    {testResult}
                  </div>
                )}
                {isExpanded && expandedPanel === "policy" && (
                  <PolicyEditor
                    keyId={k.keyId}
                    provider={k.provider}
                    initial={k.policy}
                    onSaved={async () => {
                      setExpandedKey(null);
                      setExpandedPanel(null);
                      await loadKeys();
                    }}
                    onCancel={() => {
                      setExpandedKey(null);
                      setExpandedPanel(null);
                    }}
                  />
                )}
                {isExpanded && expandedPanel === "audit" && (
                  <AuditPanel
                    keyId={k.keyId}
                    onClose={() => {
                      setExpandedKey(null);
                      setExpandedPanel(null);
                    }}
                  />
                )}
              </div>
              );
            })}
          </div>
        ))}

        {!showForm ? (
          <button class="btn btn--primary" onClick={() => setShowForm(true)}>
            + Add key
          </button>
        ) : (
          <form class="form" onSubmit={handleAdd}>
            <label>
              Provider
              <select
                value={formProvider}
                onChange={(e) => handleProviderChange((e.target as HTMLSelectElement).value)}
              >
                {PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Label *
              <input
                type="text"
                required
                placeholder="Work, Personal, University…"
                value={formLabel}
                onInput={(e) => setFormLabel((e.target as HTMLInputElement).value)}
                autoFocus
              />
            </label>
            <label>
              API key
              <input
                type="password"
                required
                placeholder="sk-..."
                value={formApiKey}
                onInput={(e) => setFormApiKey((e.target as HTMLInputElement).value)}
              />
            </label>

            {formProvider === "custom" && (
              <div class="form__custom-fields">
                <label>
                  Base URL *
                  <input
                    type="url"
                    required
                    placeholder="https://api.example.com/v1"
                    value={formBaseUrl}
                    onInput={(e) => setFormBaseUrl((e.target as HTMLInputElement).value)}
                  />
                </label>
                <label>
                  Model *
                  <input
                    type="text"
                    required
                    placeholder="vendor-specific id"
                    value={formDefaultModel}
                    autoComplete="off"
                    onInput={(e) => setFormDefaultModel((e.target as HTMLInputElement).value)}
                  />
                </label>
                <p class="form__hint">
                  For preset providers, these values are pre-filled. Edit the
                  default model for any key later via its Policy &gt; Model tab.
                </p>
              </div>
            )}

            {formError && <div class="form__error">{formError}</div>}
            <div class="form__actions">
              <button type="submit" class="btn btn--primary">
                Save
              </button>
              <button
                type="button"
                class="btn btn--secondary"
                onClick={() => {
                  setShowForm(false);
                  resetForm();
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </section>

      {bindings.length > 0 && (
        <section class="section">
          <h2 class="section__title">Connected sites ({bindings.length})</h2>
          {bindings.map((b) => {
            const host = hostOf(b.origin);
            const bound = keys.find((k) => k.keyId === b.keyId);
            const isEditing = editingBinding === b.origin;
            return (
              <div key={b.origin} class="binding-row">
                <div class="binding-row__info">
                  <span class="binding-row__host">{host}</span>
                  <span class="binding-row__key">
                    {bound
                      ? `→ ${bound.label} (${bound.provider})`
                      : b.keyId
                        ? "→ (key removed)"
                        : "→ (no key bound)"}
                  </span>
                </div>
                <div class="binding-row__actions">
                  {isEditing ? (
                    <select
                      class="binding-row__picker"
                      onChange={(e) => {
                        const v = (e.target as HTMLSelectElement).value;
                        if (v) handleSetBinding(b.origin, v);
                      }}
                    >
                      <option value="">Pick a key…</option>
                      {keys.map((k) => (
                        <option key={k.keyId} value={k.keyId}>
                          {k.label} ({k.provider})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <button
                      class="btn btn--ghost btn--sm"
                      onClick={() => setEditingBinding(b.origin)}
                    >
                      Change
                    </button>
                  )}
                  <button
                    class="btn btn--ghost btn--sm"
                    onClick={() => handleRevokeBinding(b.origin)}
                    aria-label={`Revoke access for ${host}`}
                  >
                    Revoke
                  </button>
                </div>
              </div>
            );
          })}
        </section>
      )}

      <p class="hint">
        Keys live in browser session memory only. They're cleared when you close the browser and
        never sent anywhere except the LLM provider you pick per key.
      </p>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
