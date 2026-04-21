import { render } from "preact";
import { useState, useEffect } from "preact/hooks";
import type {
  ProviderSummary,
  OriginGrant,
  IncomingRequest,
  OutgoingResponse,
} from "../shared/protocol.js";
import { ext } from "../shared/browser.js";

function sendMessage(msg: IncomingRequest): Promise<OutgoingResponse> {
  return new Promise((resolve) => {
    ext.runtime.sendMessage(msg, (res: unknown) => {
      resolve(res as OutgoingResponse);
    });
  });
}

function App() {
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [grants, setGrants] = useState<OriginGrant[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  async function loadProviders() {
    const res = await sendMessage({ type: "listProviders" });
    if (res.type === "providers") setProviders(res.providers);
  }

  async function loadGrants() {
    const res = await sendMessage({ type: "getGrants" });
    if (res.type === "grants") setGrants(res.grants);
  }

  async function handleRevoke(origin: string) {
    await sendMessage({ type: "revokeGrant", origin });
    await loadGrants();
  }

  useEffect(() => {
    loadProviders();
    loadGrants();
  }, []);

  async function handleRegister(e: Event) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const fd = new FormData(form);
    const label = (fd.get("label") as string).trim();
    await sendMessage({
      type: "registerKey",
      provider: fd.get("provider") as string,
      apiKey: fd.get("apiKey") as string,
      baseUrl: fd.get("baseUrl") as string,
      defaultModel: fd.get("defaultModel") as string,
      ...(label ? { label } : {}),
    });
    setShowForm(false);
    await loadProviders();
  }

  async function handleDelete(provider: string) {
    await sendMessage({ type: "deleteKey", provider });
    await loadProviders();
  }

  async function handleTest(provider: string) {
    setTestResult("Testing...");
    const res = await sendMessage({ type: "testKey", provider });
    if (res.type === "testResult") {
      setTestResult(res.reachable ? "Connected" : "Failed");
    } else {
      setTestResult("Error");
    }
    setTimeout(() => setTestResult(null), 3000);
  }

  return (
    <div>
      <h1>
        <span class="icon">🔐</span> LLMVault
      </h1>

      {providers.length > 0 && (
        <div class="provider-list">
          {providers.map((p) => (
            <div key={p.provider} class="provider-card">
              <div class="provider-card__header">
                <span class="provider-card__name">{p.label || p.provider}</span>
                <span class="provider-card__status">{p.status}</span>
              </div>
              <div class="provider-card__meta">
                Provider: {p.provider} · {p.defaultModel}
              </div>
              <div class="provider-card__actions">
                <button class="btn btn--secondary" onClick={() => handleTest(p.provider)}>
                  Test
                </button>
                <button class="btn btn--ghost" onClick={() => handleDelete(p.provider)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
          {testResult && (
            <div
              class={`test-result ${testResult === "Connected" ? "test-result--ok" : "test-result--fail"}`}
            >
              {testResult}
            </div>
          )}
        </div>
      )}

      {!showForm ? (
        <button class="btn btn--primary" onClick={() => setShowForm(true)}>
          + Add Provider
        </button>
      ) : (
        <form class="form" onSubmit={handleRegister}>
          <label>
            Provider
            <select name="provider">
              <option value="openai">OpenAI</option>
              <option value="anthropic">Anthropic</option>
              <option value="custom">Custom (OpenAI-compatible)</option>
            </select>
          </label>
          <label>
            Label
            <input name="label" type="text" placeholder="My OpenAI Key" />
          </label>
          <label>
            API Key
            <input name="apiKey" type="password" required placeholder="sk-..." />
          </label>
          <label>
            Base URL
            <input name="baseUrl" type="url" value="https://api.openai.com/v1" required />
          </label>
          <label>
            Model
            <input name="defaultModel" type="text" value="gpt-4.1-mini" required />
          </label>
          <div class="form__actions">
            <button type="submit" class="btn btn--primary">
              Save
            </button>
            <button type="button" class="btn btn--secondary" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {providers.length === 0 && !showForm && (
        <div class="empty">
          <p>No providers registered.</p>
          <p>Add your API key to get started.</p>
        </div>
      )}

      {grants.length > 0 && (
        <section class="connected-sites">
          <h2>Connected Sites</h2>
          {grants.map((g) => {
            let hostname = g.origin;
            try {
              hostname = new URL(g.origin).hostname;
            } catch {
              /* keep raw origin */
            }
            return (
              <div key={g.origin} class="site-row">
                <div class="site-row__info">
                  <span class="site-row__host">{hostname}</span>
                  <span class="site-row__date">
                    {new Date(g.grantedAt).toLocaleDateString()}
                  </span>
                </div>
                <button
                  class="btn btn--ghost btn--sm"
                  onClick={() => handleRevoke(g.origin)}
                  aria-label={`Revoke access for ${hostname}`}
                >
                  Revoke
                </button>
              </div>
            );
          })}
        </section>
      )}

      <p class="hint">
        Keys are stored in browser session memory only. They are cleared when you close the browser
        and are never sent to any server.
      </p>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
