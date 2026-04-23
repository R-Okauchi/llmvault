/**
 * Audit ledger — per-request history the resolver writes into and the
 * popup reads from. User-owned, local-only, never leaves the browser.
 *
 * ## Storage
 *
 * chrome.storage.local under `keyquill_ledger_v1`:
 *
 *   { [keyId: string]: LedgerEntry[] }
 *
 * Per-key arrays append-only in the hot path; trim runs on every read
 * past a 90-day cutoff.  Concurrent writes serialize through `navigator.locks`
 * to prevent two service-worker wakes from clobbering each other's append.
 *
 * ## Consumers
 *
 * - Phase 6 resolver: `appendEntry` on every resolved request (success,
 *   reject, or error). Also reads `getMonthSpend` to enforce
 *   `policy.budget.monthlyBudgetUSD`.
 * - Phase 7 popup: `queryByKey` for audit log display, `exportCSV` for
 *   export button, `getMonthSpend` for budget progress bar.
 * - `keyStore.deleteKey` cascades into `clearByKey` so a removed key
 *   doesn't leave orphaned history.
 */

import type { ResolverTrace } from "./resolver.js";
import { ext } from "../shared/browser.js";

const STORAGE_KEY = "keyquill_ledger_v1";
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const LOCK_NAME = "keyquill_ledger_write";

// ── Types ──────────────────────────────────────────────

export interface LedgerEntry {
  timestamp: number;
  keyId: string;
  origin: string;
  model: string;
  endpoint: "chat" | "responses" | "anthropic";
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  estimatedCostUSD: number;
  /**
   * Actual cost computed post-response from real usage reported by the
   * provider. For streaming cancellations or errors, this falls back to
   * the estimated cost.
   */
  actualCostUSD: number;
  status: "success" | "error" | "cancelled";
  errorCode?: string;
  trace?: ResolverTrace;
}

type LedgerStorage = Record<string, LedgerEntry[]>;

// ── Mutex helper ───────────────────────────────────────

/**
 * Web Locks-based mutex. Serializes concurrent `set(storage)` operations
 * so two resolver invocations (e.g., via parallel tabs) can't read-modify-write
 * the same ledger snapshot and drop one entry on commit.
 *
 * Falls back to an in-memory promise queue if `navigator.locks` is not
 * available (some test environments / unusual browsers).
 */
let inMemoryQueue: Promise<unknown> = Promise.resolve();

async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
  if (locks) {
    return (await locks.request(LOCK_NAME, async () => fn())) as T;
  }
  // Fallback: chain on the in-memory queue.
  const next = inMemoryQueue.then(() => fn());
  inMemoryQueue = next.catch(() => {});
  return next;
}

interface LockManager {
  request<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

// ── Raw storage I/O ────────────────────────────────────

async function readRaw(): Promise<LedgerStorage> {
  const data = await ext.storage.local.get(STORAGE_KEY);
  const raw = data[STORAGE_KEY];
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as LedgerStorage;
  }
  return {};
}

async function writeRaw(storage: LedgerStorage): Promise<void> {
  await ext.storage.local.set({ [STORAGE_KEY]: storage });
}

// ── Retention trim ─────────────────────────────────────

/**
 * Drop entries older than 90 days. Runs opportunistically on read — we
 * don't schedule a background sweep because MV3 service workers sleep and
 * trims are cheap when done lazily.
 */
function trimByRetention(entries: LedgerEntry[], now = Date.now()): LedgerEntry[] {
  const cutoff = now - RETENTION_MS;
  return entries.filter((e) => e.timestamp >= cutoff);
}

// ── Public API ─────────────────────────────────────────

/**
 * Append an entry to the ledger under its keyId. Concurrency-safe.
 */
export async function appendEntry(entry: LedgerEntry): Promise<void> {
  await withWriteLock(async () => {
    const storage = await readRaw();
    const list = storage[entry.keyId] ?? [];
    list.push(entry);
    storage[entry.keyId] = trimByRetention(list);
    await writeRaw(storage);
  });
}

/**
 * Read entries for a key, optionally since a given timestamp (ms).
 * Returns newest-last (append order).
 */
export async function queryByKey(keyId: string, since?: number): Promise<LedgerEntry[]> {
  const storage = await readRaw();
  const list = storage[keyId] ?? [];
  const trimmed = trimByRetention(list);
  if (since === undefined) return trimmed;
  return trimmed.filter((e) => e.timestamp >= since);
}

/**
 * Sum of `actualCostUSD` across all successful entries in the given month.
 * `month` is a `YYYY-MM` string in the caller's locale; defaults to the
 * current UTC month.
 */
export async function getMonthSpend(keyId: string, month?: string): Promise<number> {
  const target = month ?? isoMonth(new Date());
  const entries = await queryByKey(keyId);
  return entries
    .filter((e) => e.status === "success" && isoMonth(new Date(e.timestamp)) === target)
    .reduce((sum, e) => sum + e.actualCostUSD, 0);
}

/**
 * Sum of `actualCostUSD` across all successful entries on the given UTC
 * day. `day` is a `YYYY-MM-DD` string; defaults to today UTC.
 */
export async function getDailySpend(keyId: string, day?: string): Promise<number> {
  const target = day ?? isoDay(new Date());
  const entries = await queryByKey(keyId);
  return entries
    .filter((e) => e.status === "success" && isoDay(new Date(e.timestamp)) === target)
    .reduce((sum, e) => sum + e.actualCostUSD, 0);
}

/**
 * Delete all entries for a key. Called from `keyStore.deleteKey` so
 * ledger history doesn't leak across key rotations.
 */
export async function clearByKey(keyId: string): Promise<void> {
  await withWriteLock(async () => {
    const storage = await readRaw();
    if (keyId in storage) {
      delete storage[keyId];
      await writeRaw(storage);
    }
  });
}

/**
 * Summary per origin for a key. Used in the popup to show "top origins
 * by spend" for a key.
 */
export interface OriginSummary {
  origin: string;
  requestCount: number;
  totalCostUSD: number;
}

export async function getOriginSummary(keyId: string, since?: number): Promise<OriginSummary[]> {
  const entries = await queryByKey(keyId, since);
  const byOrigin = new Map<string, OriginSummary>();
  for (const e of entries) {
    if (e.status !== "success") continue;
    const s = byOrigin.get(e.origin) ?? { origin: e.origin, requestCount: 0, totalCostUSD: 0 };
    s.requestCount += 1;
    s.totalCostUSD += e.actualCostUSD;
    byOrigin.set(e.origin, s);
  }
  return [...byOrigin.values()].sort((a, b) => b.totalCostUSD - a.totalCostUSD);
}

// ── CSV export ─────────────────────────────────────────

const CSV_COLUMNS = [
  "timestamp",
  "origin",
  "model",
  "endpoint",
  "status",
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "estimatedCostUSD",
  "actualCostUSD",
  "errorCode",
] as const;

export async function exportCSV(keyId: string): Promise<string> {
  const entries = await queryByKey(keyId);
  const lines = [CSV_COLUMNS.join(",")];
  for (const e of entries) {
    const row: Array<string | number> = [
      new Date(e.timestamp).toISOString(),
      csvEscape(e.origin),
      csvEscape(e.model),
      e.endpoint,
      e.status,
      e.inputTokens,
      e.outputTokens,
      e.reasoningTokens ?? "",
      e.estimatedCostUSD.toFixed(6),
      e.actualCostUSD.toFixed(6),
      csvEscape(e.errorCode ?? ""),
    ];
    lines.push(row.join(","));
  }
  return lines.join("\n");
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ── Date helpers ───────────────────────────────────────

function isoMonth(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function isoDay(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ── Exports for tests ──────────────────────────────────

export const __test = {
  trimByRetention,
  isoMonth,
  isoDay,
  STORAGE_KEY,
  RETENTION_MS,
};
