import { useEffect, useMemo, useState } from "preact/hooks";
import type {
  IncomingRequest,
  LedgerEntrySummary,
  OutgoingResponse,
} from "../../shared/protocol.js";
import { ext } from "../../shared/browser.js";

function sendMessage(msg: IncomingRequest): Promise<OutgoingResponse> {
  return new Promise((resolve) => {
    ext.runtime.sendMessage(msg, (res: unknown) => resolve(res as OutgoingResponse));
  });
}

interface Props {
  keyId: string;
  onClose: () => void;
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Per-key audit log viewer. Shows recent entries, filter by origin, and
 * a CSV export button.
 */
export function AuditPanel({ keyId, onClose }: Props) {
  const [entries, setEntries] = useState<LedgerEntrySummary[] | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await sendMessage({ type: "getLedger", keyId });
      if (!cancelled && res.type === "ledger") setEntries(res.entries);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [keyId]);

  const filtered = useMemo(() => {
    if (!entries) return null;
    const f = filter.trim().toLowerCase();
    const list = f
      ? entries.filter(
          (e) => e.origin.toLowerCase().includes(f) || e.model.toLowerCase().includes(f),
        )
      : entries;
    // Newest first
    return [...list].sort((a, b) => b.timestamp - a.timestamp);
  }, [entries, filter]);

  async function handleExport() {
    const res = await sendMessage({ type: "exportLedger", keyId });
    if (res.type !== "csv") return;
    const blob = new Blob([res.content], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `keyquill-ledger-${keyId}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  if (entries === null) {
    return <div class="audit-panel audit-panel--loading">Loading audit log…</div>;
  }

  return (
    <div class="audit-panel">
      <div class="audit-panel__header">
        <input
          type="text"
          class="audit-panel__filter"
          placeholder="Filter by origin or model"
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
        />
        <button class="btn btn--secondary btn--sm" onClick={handleExport}>
          Export CSV
        </button>
        <button class="btn btn--ghost btn--sm" onClick={onClose}>
          Close
        </button>
      </div>
      {filtered && filtered.length === 0 ? (
        <div class="audit-panel__empty">No matching entries.</div>
      ) : (
        <div class="audit-panel__list">
          {filtered?.slice(0, 50).map((e) => (
            <div
              key={`${e.timestamp}-${e.origin}-${e.model}`}
              class={`audit-row audit-row--${e.status}`}
            >
              <div class="audit-row__head">
                <span class="audit-row__time">{formatTime(e.timestamp)}</span>
                <span class="audit-row__host">{hostOf(e.origin)}</span>
                <span class="audit-row__cost">${e.actualCostUSD.toFixed(4)}</span>
              </div>
              <div class="audit-row__meta">
                <span class="audit-row__model">{e.model}</span>
                <span class="audit-row__endpoint">{e.endpoint}</span>
                <span class="audit-row__tokens">
                  {e.inputTokens}→{e.outputTokens}
                  {e.reasoningTokens !== undefined && <> + {e.reasoningTokens}r</>}
                </span>
                {e.status !== "success" && (
                  <span class="audit-row__status">
                    {e.status}
                    {e.errorCode ? ` · ${e.errorCode}` : ""}
                  </span>
                )}
              </div>
            </div>
          ))}
          {filtered && filtered.length > 50 && (
            <div class="audit-panel__overflow">
              …{filtered.length - 50} more entries (use CSV export for full log)
            </div>
          )}
        </div>
      )}
    </div>
  );
}
