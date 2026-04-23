import { render } from "preact";
import { useState, useEffect } from "preact/hooks";
import type {
  KeySummary,
  OriginBinding,
  IncomingRequest,
  OutgoingResponse,
  KeyDefaults,
} from "../shared/protocol.js";
import { ext } from "../shared/browser.js";
import { PRESETS, getPreset } from "../shared/presets.js";

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
  const [showActiveSwitcher, setShowActiveSwitcher] = useState(false);
  const [testResultKey, setTestResultKey] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // Add-key form fields (controlled so the preset dropdown can auto-fill
  // base URL / default model). user edits remain stable after switching.
  const [formProvider, setFormProvider] = useState<string>(DEFAULT_PRESET_ID);
  const [formLabel, setFormLabel] = useState("");
  const [formApiKey, setFormApiKey] = useState("");
  const [formBaseUrl, setFormBaseUrl] = useState(PRESETS[0].baseUrl);
  const [formDefaultModel, setFormDefaultModel] = useState(PRESETS[0].defaultModel);
  const [formTemperature, setFormTemperature] = useState<string>("");
  const [formTopP, setFormTopP] = useState<string>("");
  const [formReasoningEffort, setFormReasoningEffort] =
    useState<"" | "minimal" | "low" | "medium" | "high">("");
  const [showAdvanced, setShowAdvanced] = useState(false);

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
    setFormTemperature("");
    setFormTopP("");
    setFormReasoningEffort("");
    setShowAdvanced(false);
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
    const defaults: KeyDefaults = {};
    if (formTemperature !== "") {
      const t = Number(formTemperature);
      if (!Number.isNaN(t)) defaults.temperature = t;
    }
    if (formTopP !== "") {
      const p = Number(formTopP);
      if (!Number.isNaN(p)) defaults.topP = p;
    }
    if (formReasoningEffort !== "") defaults.reasoningEffort = formReasoningEffort;
    const res = await sendMessage({
      type: "addKey",
      provider: formProvider,
      label,
      apiKey: formApiKey,
      baseUrl: formBaseUrl,
      defaultModel: formDefaultModel,
      ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
    });
    if (res.type === "error") {
      setFormError(res.message);
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

  async function handleSetActive(keyId: string) {
    await sendMessage({ type: "setActive", keyId });
    setShowActiveSwitcher(false);
    await loadKeys();
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

  const activeKey = keys.find((k) => k.isActive) ?? null;

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

      {activeKey && (
        <div class="active-banner">
          <div class="active-banner__info">
            <span class="active-banner__label">Active key</span>
            <span class="active-banner__name">
              {activeKey.label}
              <span class="active-banner__provider"> · {activeKey.provider}</span>
            </span>
          </div>
          {keys.length > 1 && (
            <button
              class="btn btn--ghost btn--sm"
              onClick={() => setShowActiveSwitcher((v) => !v)}
            >
              Switch
            </button>
          )}
        </div>
      )}

      {activeKey && showActiveSwitcher && keys.length > 1 && (
        <div class="active-switcher">
          {keys
            .filter((k) => !k.isActive)
            .map((k) => (
              <button
                key={k.keyId}
                class="active-switcher__item"
                onClick={() => handleSetActive(k.keyId)}
              >
                <span class="active-switcher__name">{k.label}</span>
                <span class="active-switcher__meta">{k.provider}</span>
              </button>
            ))}
        </div>
      )}

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
            {list.map((k) => (
              <div key={k.keyId} class={`key-card ${k.isActive ? "key-card--active" : ""}`}>
                <div class="key-card__header">
                  <span class="key-card__label">{k.label}</span>
                  {k.isActive && (
                    <span class="key-card__badge" title="Active key">
                      ⭐
                    </span>
                  )}
                </div>
                <div class="key-card__meta">
                  <span class="key-card__hint">{k.keyHint}</span>
                  <span class="key-card__model">{k.defaultModel}</span>
                </div>
                <div class="key-card__actions">
                  {!k.isActive && (
                    <button class="btn btn--ghost btn--sm" onClick={() => handleSetActive(k.keyId)}>
                      Set active
                    </button>
                  )}
                  <button class="btn btn--secondary btn--sm" onClick={() => handleTest(k.keyId)}>
                    Test
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
              </div>
            ))}
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

            <button
              type="button"
              class="form__toggle"
              onClick={() => setShowAdvanced((v) => !v)}
              aria-expanded={showAdvanced}
            >
              {showAdvanced ? "▾" : "▸"} Advanced
            </button>

            {showAdvanced && (
              <div class="form__advanced">
                <label>
                  Base URL
                  <input
                    type="url"
                    value={formBaseUrl}
                    onInput={(e) => setFormBaseUrl((e.target as HTMLInputElement).value)}
                  />
                </label>
                <label>
                  Model
                  <input
                    type="text"
                    value={formDefaultModel}
                    list={`models-${formProvider}`}
                    placeholder={
                      getPreset(formProvider)?.defaultModel || "vendor-specific id"
                    }
                    autoComplete="off"
                    onInput={(e) => setFormDefaultModel((e.target as HTMLInputElement).value)}
                  />
                  {(getPreset(formProvider)?.models.length ?? 0) > 0 && (
                    <datalist id={`models-${formProvider}`}>
                      {getPreset(formProvider)!.models.map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                  )}
                </label>
                <label>
                  Temperature
                  <input
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                    placeholder="(provider default)"
                    value={formTemperature}
                    onInput={(e) => setFormTemperature((e.target as HTMLInputElement).value)}
                  />
                </label>
                <label>
                  Top P
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.05"
                    placeholder="(provider default)"
                    value={formTopP}
                    onInput={(e) => setFormTopP((e.target as HTMLInputElement).value)}
                  />
                </label>
                <label>
                  Reasoning effort
                  <select
                    value={formReasoningEffort}
                    onChange={(e) =>
                      setFormReasoningEffort(
                        (e.target as HTMLSelectElement).value as
                          | ""
                          | "minimal"
                          | "low"
                          | "medium"
                          | "high",
                      )
                    }
                  >
                    <option value="">(none / model default)</option>
                    <option value="minimal">minimal</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                  </select>
                </label>
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
