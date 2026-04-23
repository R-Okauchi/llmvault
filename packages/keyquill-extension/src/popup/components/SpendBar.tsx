import { useEffect, useState } from "preact/hooks";
import type { IncomingRequest, OutgoingResponse } from "../../shared/protocol.js";
import { ext } from "../../shared/browser.js";

function sendMessage(msg: IncomingRequest): Promise<OutgoingResponse> {
  return new Promise((resolve) => {
    ext.runtime.sendMessage(msg, (res: unknown) => resolve(res as OutgoingResponse));
  });
}

interface Props {
  keyId: string;
  /** Monthly budget cap in USD. When undefined, only the raw spend value is shown. */
  budgetUSD?: number;
}

/**
 * Compact per-key monthly spend display. Shows `$X.XX this month`; if the
 * key's policy sets a monthly budget, renders a colored bar as well.
 */
export function SpendBar({ keyId, budgetUSD }: Props) {
  const [spend, setSpend] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await sendMessage({ type: "getMonthSpend", keyId });
      if (!cancelled && res.type === "spend") setSpend(res.totalUSD);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [keyId]);

  if (spend === null) return null;

  const pct = budgetUSD && budgetUSD > 0 ? Math.min(100, (spend / budgetUSD) * 100) : null;
  const barClass = pct === null
    ? ""
    : pct >= 90
      ? "spend-bar__fill spend-bar__fill--danger"
      : pct >= 70
        ? "spend-bar__fill spend-bar__fill--warn"
        : "spend-bar__fill spend-bar__fill--ok";

  return (
    <div class="spend-bar">
      <div class="spend-bar__label">
        ${spend.toFixed(4)}
        {budgetUSD !== undefined && <> / ${budgetUSD.toFixed(2)}</>}
        <span class="spend-bar__suffix"> this month</span>
      </div>
      {pct !== null && (
        <div class="spend-bar__track">
          <div class={barClass} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}
