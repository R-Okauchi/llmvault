/**
 * Key storage backed by chrome.storage.session.
 *
 * v3 schema: active-key model. The wallet has multiple keys; exactly one
 * (when any exist) is marked `isActive: true`. Resolution for requests
 * without an explicit keyId or per-origin binding uses the active key.
 *
 * Legacy data:
 *   - v1 `keyquill_providers` → migrate to v3 KeyRecord[], first entry active
 *   - v2 `keyquill_keys` with `isDefault` → migrate to v3, pick first
 *     per-provider default as wallet-wide active, clear the rest
 *
 * Security properties:
 * - Accessible only from extension contexts (not web pages)
 * - Cleared when the browser closes (session storage)
 * - Not synced across devices
 */

import type {
  KeyRecord,
  KeySummary,
  KeyDefaults,
  KeyPolicy,
  SamplingPolicy,
  ReasoningEffort,
} from "../shared/protocol.js";
import { DEFAULT_KEY_POLICY, CURRENT_POLICY_VERSION } from "../shared/protocol.js";
import { ext } from "../shared/browser.js";
import { removeBindingsForKey } from "./bindingStore.js";

const STORAGE_KEY = "keyquill_keys";
const LEGACY_V1_KEY = "keyquill_providers";

function maskKey(apiKey: string): string {
  if (!apiKey) return "****";
  if (apiKey.length <= 8) return "****";
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

interface LegacyV1Record {
  provider: string;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  label?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * v2 `keyquill_keys` had `isDefault` per-provider; v3 replaces this with
 * a wallet-wide single `isActive`. When we read a v2 record we coerce it
 * here.
 */
interface LegacyV2Record {
  keyId: string;
  provider: string;
  label: string;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  isDefault?: boolean;
  isActive?: boolean;       // present when already v3
  createdAt: number;
  updatedAt: number;
}

function coerceV2Records(rows: LegacyV2Record[]): KeyRecord[] {
  // Already v3 if any row has isActive defined (even false) — trust it.
  const alreadyV3 = rows.some((r) => typeof r.isActive === "boolean");
  if (alreadyV3) {
    return rows.map((r) => ({
      keyId: r.keyId,
      provider: r.provider,
      label: r.label,
      apiKey: r.apiKey,
      baseUrl: r.baseUrl,
      defaultModel: r.defaultModel,
      isActive: Boolean(r.isActive),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));
  }

  // v2 → v3: pick the single wallet-wide active. Prefer the most-recently
  // updated `isDefault: true` entry; fall back to the first entry.
  const defaults = rows.filter((r) => r.isDefault);
  const winner =
    defaults.length > 0
      ? defaults.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a))
      : rows[0];
  return rows.map((r) => ({
    keyId: r.keyId,
    provider: r.provider,
    label: r.label,
    apiKey: r.apiKey,
    baseUrl: r.baseUrl,
    defaultModel: r.defaultModel,
    isActive: winner ? r.keyId === winner.keyId : false,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/**
 * Synthesize a KeyPolicy from a record's legacy KeyDefaults.
 *
 * - Sampling (temperature, topP) moves into `policy.sampling`
 * - reasoningEffort becomes an upper cap via `policy.budget.maxReasoningEffort`
 * - Every other policy field stays at its permissive default
 *
 * Result is equivalent to pre-v1.0 unrestricted pass-through: nothing
 * blocks, sampling defaults are honored when the developer omits them.
 */
function synthesizePolicy(defaults: KeyDefaults | undefined): KeyPolicy {
  const sampling: { temperature?: number; topP?: number } = {};
  if (defaults?.temperature !== undefined) sampling.temperature = defaults.temperature;
  if (defaults?.topP !== undefined) sampling.topP = defaults.topP;

  return {
    ...DEFAULT_KEY_POLICY,
    ...(Object.keys(sampling).length > 0 ? { sampling } : {}),
    ...(defaults?.reasoningEffort
      ? {
          budget: {
            ...DEFAULT_KEY_POLICY.budget,
            maxReasoningEffort: defaults.reasoningEffort,
          },
        }
      : {}),
  };
}

/**
 * Ensure a record has a `policy` field. Returns the same object reference
 * if it already does; otherwise returns a new object with policy
 * synthesized from the legacy `defaults`.
 */
function ensurePolicy(record: KeyRecord): KeyRecord {
  if (record.policy && typeof record.policyVersion === "number") return record;
  return {
    ...record,
    policy: synthesizePolicy(record.defaults),
    policyVersion: CURRENT_POLICY_VERSION,
  };
}

async function migrateV1IfNeeded(): Promise<KeyRecord[] | null> {
  const legacy = await ext.storage.session.get(LEGACY_V1_KEY);
  const rows = legacy[LEGACY_V1_KEY];
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const migrated: KeyRecord[] = (rows as LegacyV1Record[]).map((r, i) =>
    ensurePolicy({
      keyId: crypto.randomUUID(),
      provider: r.provider,
      label: r.label ?? r.provider,
      apiKey: r.apiKey,
      baseUrl: r.baseUrl,
      defaultModel: r.defaultModel,
      isActive: i === 0, // first legacy entry becomes the wallet active
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }),
  );
  await ext.storage.session.set({ [STORAGE_KEY]: migrated });
  await ext.storage.session.remove(LEGACY_V1_KEY);
  return migrated;
}

export async function getKeys(): Promise<KeyRecord[]> {
  const data = await ext.storage.session.get(STORAGE_KEY);
  const rows = data[STORAGE_KEY];
  if (Array.isArray(rows)) {
    // v2 → v3: isActive coercion.
    const needsCoerce = (rows as LegacyV2Record[]).every(
      (r) => typeof r.isActive !== "boolean",
    );
    const afterV3 = needsCoerce && rows.length > 0
      ? coerceV2Records(rows as LegacyV2Record[])
      : (rows as KeyRecord[]);

    // Policy migration: synthesize `policy` from legacy `defaults` on any
    // record that lacks one. Writes back only if anything changed.
    const withPolicy = afterV3.map(ensurePolicy);
    const policyChanged = withPolicy.some((r, i) => r !== afterV3[i]);
    if (needsCoerce || policyChanged) {
      await ext.storage.session.set({ [STORAGE_KEY]: withPolicy });
    }
    return withPolicy;
  }
  const migrated = await migrateV1IfNeeded();
  return migrated ?? [];
}

export async function getKeySummaries(): Promise<KeySummary[]> {
  const records = await getKeys();
  return records.map((r) => ({
    keyId: r.keyId,
    provider: r.provider,
    label: r.label,
    baseUrl: r.baseUrl,
    defaultModel: r.defaultModel,
    isActive: Boolean(r.isActive),
    ...(r.defaults ? { defaults: r.defaults } : {}),
    ...(r.policy ? { policy: r.policy } : {}),
    ...(r.policyVersion !== undefined ? { policyVersion: r.policyVersion } : {}),
    keyHint: maskKey(r.apiKey),
    status: "active" as const,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function getKey(keyId: string): Promise<KeyRecord | null> {
  const records = await getKeys();
  return records.find((r) => r.keyId === keyId) ?? null;
}

/**
 * Returns the wallet-wide active key, or null if the wallet is empty.
 * Falls back to the first key if nothing was marked active (defensive —
 * should not happen once migration runs, but keeps the contract safe).
 */
export async function getActiveKey(): Promise<KeyRecord | null> {
  const records = await getKeys();
  return records.find((r) => r.isActive) ?? records[0] ?? null;
}

export interface AddKeyInput {
  provider: string;
  label: string;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  isActive?: boolean;
  defaults?: KeyDefaults;
}

export async function addKey(input: AddKeyInput): Promise<KeyRecord> {
  if (!input.label || input.label.trim().length === 0) {
    throw new Error("label is required");
  }
  const records = await getKeys();
  const now = Date.now();
  const shouldActivate = input.isActive ?? records.length === 0;
  const newRecord: KeyRecord = ensurePolicy({
    keyId: crypto.randomUUID(),
    provider: input.provider,
    label: input.label.trim(),
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    defaultModel: input.defaultModel,
    isActive: shouldActivate,
    ...(input.defaults && Object.keys(input.defaults).length > 0
      ? { defaults: input.defaults }
      : {}),
    createdAt: now,
    updatedAt: now,
  });
  let next = [...records, newRecord];
  if (shouldActivate) {
    next = next.map((r) =>
      r.keyId === newRecord.keyId ? r : { ...r, isActive: false },
    );
  }
  await ext.storage.session.set({ [STORAGE_KEY]: next });
  return newRecord;
}

export interface UpdateKeyInput {
  keyId: string;
  label?: string;
  baseUrl?: string;
  defaultModel?: string;
  apiKey?: string;
  defaults?: KeyDefaults;
}

export async function updateKey(input: UpdateKeyInput): Promise<KeyRecord | null> {
  const records = await getKeys();
  const idx = records.findIndex((r) => r.keyId === input.keyId);
  if (idx < 0) return null;
  const existing = records[idx];
  // Merge defaults shallow: passed keys override, others preserved. To clear
  // a default, pass `defaults: {}` — fields present with `undefined` are
  // dropped.
  let mergedDefaults: KeyDefaults | undefined = existing.defaults;
  if (input.defaults) {
    const merged = { ...(existing.defaults ?? {}), ...input.defaults };
    // Strip undefined keys so callers can explicitly clear a field.
    const cleaned: KeyDefaults = {};
    if (merged.temperature !== undefined) cleaned.temperature = merged.temperature;
    if (merged.topP !== undefined) cleaned.topP = merged.topP;
    if (merged.reasoningEffort !== undefined) cleaned.reasoningEffort = merged.reasoningEffort;
    mergedDefaults = Object.keys(cleaned).length > 0 ? cleaned : undefined;
  }
  const updated: KeyRecord = {
    ...existing,
    label: input.label?.trim() ?? existing.label,
    baseUrl: input.baseUrl ?? existing.baseUrl,
    defaultModel: input.defaultModel ?? existing.defaultModel,
    apiKey: input.apiKey ?? existing.apiKey,
    ...(mergedDefaults ? { defaults: mergedDefaults } : {}),
    updatedAt: Date.now(),
  };
  // Strip `defaults` entirely when cleared.
  if (!mergedDefaults) {
    delete (updated as { defaults?: KeyDefaults }).defaults;
  }
  // Sync derived policy fields (sampling + reasoning effort cap) whenever
  // defaults change. Other policy fields (modelPolicy, budget caps,
  // privacy) are user-owned and preserved — once the popup Policy tab
  // lands in Phase 7, users edit those directly, not via defaults.
  if (input.defaults !== undefined) {
    const resynthesized = synthesizePolicy(mergedDefaults);
    updated.policy = {
      ...(existing.policy ?? DEFAULT_KEY_POLICY),
      sampling: resynthesized.sampling,
      budget: {
        ...(existing.policy?.budget ?? DEFAULT_KEY_POLICY.budget),
        ...(resynthesized.budget.maxReasoningEffort !== undefined
          ? { maxReasoningEffort: resynthesized.budget.maxReasoningEffort }
          : { maxReasoningEffort: undefined }),
      },
    };
    // Strip undefined sampling so shape stays minimal.
    if (!updated.policy.sampling) delete (updated.policy as { sampling?: SamplingPolicy }).sampling;
    if (updated.policy.budget.maxReasoningEffort === undefined) {
      delete (updated.policy.budget as { maxReasoningEffort?: ReasoningEffort }).maxReasoningEffort;
    }
    updated.policyVersion = CURRENT_POLICY_VERSION;
  }
  if (updated.label.length === 0) {
    throw new Error("label cannot be empty");
  }
  const next = [...records];
  next[idx] = updated;
  await ext.storage.session.set({ [STORAGE_KEY]: next });
  return updated;
}

export async function deleteKey(keyId: string): Promise<void> {
  const records = await getKeys();
  const filtered = records.filter((r) => r.keyId !== keyId);
  const removed = records.find((r) => r.keyId === keyId);
  // If we removed the active key and other keys remain, promote the
  // most-recently-updated one to keep the wallet in a valid state.
  if (removed?.isActive && filtered.length > 0 && !filtered.some((r) => r.isActive)) {
    const promote = filtered.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
    const idx = filtered.findIndex((r) => r.keyId === promote.keyId);
    filtered[idx] = { ...promote, isActive: true };
  }
  await ext.storage.session.set({ [STORAGE_KEY]: filtered });
  // Cascade: drop per-origin bindings referencing the deleted key so the
  // next access re-prompts consent.
  await removeBindingsForKey(keyId);
}

/**
 * Mark `keyId` as the wallet's active key. Demotes the previous active.
 * No-op if `keyId` doesn't exist.
 */
export async function setActive(keyId: string): Promise<void> {
  const records = await getKeys();
  const target = records.find((r) => r.keyId === keyId);
  if (!target) return;
  const next = records.map((r) => ({ ...r, isActive: r.keyId === keyId }));
  await ext.storage.session.set({ [STORAGE_KEY]: next });
}
