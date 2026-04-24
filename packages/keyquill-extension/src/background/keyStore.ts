/**
 * Key storage backed by chrome.storage.session.
 *
 * Schema after Phase 17a: the wallet is an unordered set of keys with
 * no wallet-wide "active" flag. Routing is driven entirely by
 * per-origin bindings (see bindingStore); the only wallet-level
 * operation on a key is add / update / delete / updatePolicy.
 *
 * Legacy schemas carried either `isDefault` (v2 per-provider) or
 * `isActive` (v3 wallet-wide). Both are ignored on read and stripped on
 * the first write-back; nothing depends on them anymore.
 *
 * Phase 13d: the record-level `defaultModel` has been folded into
 * `policy.modelPolicy.defaultModel`. Records that still carry the
 * legacy field in storage are migrated on first read and rewritten.
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
import { clearByKey as clearLedgerForKey } from "./ledger.js";
import { resolveKeyDefault } from "../shared/keyDefault.js";

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
 * Storage rows from any prior schema. We accept all of:
 *   - pre-13d `defaultModel` on the record
 *   - v2 `isDefault` per-provider flag
 *   - v3 wallet-wide `isActive` flag
 * …and strip them on read. The normalised output carries none of them.
 */
interface LegacyStoredRecord {
  keyId: string;
  provider: string;
  label: string;
  apiKey: string;
  baseUrl: string;
  defaultModel?: string;
  isDefault?: boolean;
  isActive?: boolean;
  defaults?: KeyDefaults;
  policy?: KeyPolicy;
  policyVersion?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Synthesize a KeyPolicy from a record's legacy fields.
 *
 * - Sampling (temperature, topP) moves into `policy.sampling`
 * - reasoningEffort becomes an upper cap via `policy.budget.maxReasoningEffort`
 * - `defaultModel` (when provided) seeds `policy.modelPolicy.defaultModel`
 * - Every other policy field stays at its permissive default
 */
function synthesizePolicy(
  defaults: KeyDefaults | undefined,
  defaultModel?: string,
): KeyPolicy {
  const sampling: { temperature?: number; topP?: number } = {};
  if (defaults?.temperature !== undefined) sampling.temperature = defaults.temperature;
  if (defaults?.topP !== undefined) sampling.topP = defaults.topP;

  const modelPolicy =
    defaultModel && defaultModel.trim().length > 0
      ? { ...DEFAULT_KEY_POLICY.modelPolicy, defaultModel }
      : DEFAULT_KEY_POLICY.modelPolicy;

  return {
    ...DEFAULT_KEY_POLICY,
    modelPolicy,
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
 * Normalise a raw stored row (any schema vintage) into the current
 * `KeyRecord` shape:
 *
 *   - Strips `isActive` / `isDefault` (Phase 17a — wallet-wide active
 *     is gone; per-origin bindings own routing).
 *   - Strips record-level `defaultModel`, copying it into
 *     `policy.modelPolicy.defaultModel` unless the policy already pins
 *     one (Phase 13d).
 *   - `policy` always populated. Synthesised from legacy `defaults` if
 *     none exists.
 *   - `policyVersion` bumped to CURRENT_POLICY_VERSION.
 *
 * The `changed` flag lets the caller decide whether to rewrite storage.
 */
function normaliseRecord(row: LegacyStoredRecord): {
  record: KeyRecord;
  changed: boolean;
} {
  const legacyDefault = row.defaultModel;
  const hadDefaultModelField = Object.prototype.hasOwnProperty.call(
    row,
    "defaultModel",
  );
  const hadIsActiveField = Object.prototype.hasOwnProperty.call(row, "isActive");
  const hadIsDefaultField = Object.prototype.hasOwnProperty.call(row, "isDefault");
  const atCurrentVersion = row.policyVersion === CURRENT_POLICY_VERSION;

  let policy = row.policy;
  if (!policy) {
    policy = synthesizePolicy(row.defaults, legacyDefault);
  } else if (!policy.modelPolicy.defaultModel && legacyDefault) {
    policy = {
      ...policy,
      modelPolicy: {
        ...policy.modelPolicy,
        defaultModel: legacyDefault,
      },
    };
  }

  const record: KeyRecord = {
    keyId: row.keyId,
    provider: row.provider,
    label: row.label,
    apiKey: row.apiKey,
    baseUrl: row.baseUrl,
    ...(row.defaults ? { defaults: row.defaults } : {}),
    policy,
    policyVersion: CURRENT_POLICY_VERSION,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };

  const changed =
    hadDefaultModelField ||
    hadIsActiveField ||
    hadIsDefaultField ||
    !atCurrentVersion ||
    row.policy !== policy;
  return { record, changed };
}

async function migrateV1IfNeeded(): Promise<KeyRecord[] | null> {
  const legacy = await ext.storage.session.get(LEGACY_V1_KEY);
  const rows = legacy[LEGACY_V1_KEY];
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const migrated: KeyRecord[] = (rows as LegacyV1Record[]).map((r) => {
    const legacyShape: LegacyStoredRecord = {
      keyId: crypto.randomUUID(),
      provider: r.provider,
      label: r.label ?? r.provider,
      apiKey: r.apiKey,
      baseUrl: r.baseUrl,
      defaultModel: r.defaultModel,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
    return normaliseRecord(legacyShape).record;
  });
  await ext.storage.session.set({ [STORAGE_KEY]: migrated });
  await ext.storage.session.remove(LEGACY_V1_KEY);
  return migrated;
}

export async function getKeys(): Promise<KeyRecord[]> {
  const data = await ext.storage.session.get(STORAGE_KEY);
  const rows = data[STORAGE_KEY];
  if (Array.isArray(rows)) {
    const legacyRows = rows as LegacyStoredRecord[];
    let anyChanged = false;
    const normalised = legacyRows.map((row) => {
      const { record, changed } = normaliseRecord(row);
      if (changed) anyChanged = true;
      return record;
    });
    if (anyChanged) {
      await ext.storage.session.set({ [STORAGE_KEY]: normalised });
    }
    return normalised;
  }
  const migrated = await migrateV1IfNeeded();
  return migrated ?? [];
}

export async function getKeySummaries(): Promise<KeySummary[]> {
  const records = await getKeys();
  return records.map((r) => {
    const effective = resolveKeyDefault(r);
    return {
      keyId: r.keyId,
      provider: r.provider,
      label: r.label,
      baseUrl: r.baseUrl,
      ...(effective ? { effectiveDefaultModel: effective.id } : {}),
      ...(r.policy ? { policy: r.policy } : {}),
      ...(r.policyVersion !== undefined ? { policyVersion: r.policyVersion } : {}),
      keyHint: maskKey(r.apiKey),
      status: "active" as const,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });
}

export async function getKey(keyId: string): Promise<KeyRecord | null> {
  const records = await getKeys();
  return records.find((r) => r.keyId === keyId) ?? null;
}

/**
 * Returns the first key in the wallet (by insertion order), or null if
 * empty. Used by the resolver only as a defensive fallback — in the
 * normal flow every external request reaches the resolver with either
 * an explicit `keyId` or a per-origin binding already resolved to a
 * key, so this fallback is effectively unreachable for web traffic.
 */
export async function getFirstKey(): Promise<KeyRecord | null> {
  const records = await getKeys();
  return records[0] ?? null;
}

export interface AddKeyInput {
  provider: string;
  label: string;
  apiKey: string;
  baseUrl: string;
  /**
   * Seeds `policy.modelPolicy.defaultModel` for the new key. Optional
   * for preset providers (resolver falls back to the preset default);
   * required by callers for `custom` providers.
   */
  defaultModel?: string;
}

export async function addKey(input: AddKeyInput): Promise<KeyRecord> {
  if (!input.label || input.label.trim().length === 0) {
    throw new Error("label is required");
  }
  const records = await getKeys();
  const now = Date.now();
  const newRecord: KeyRecord = {
    keyId: crypto.randomUUID(),
    provider: input.provider,
    label: input.label.trim(),
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    policy: synthesizePolicy(undefined, input.defaultModel),
    policyVersion: CURRENT_POLICY_VERSION,
    createdAt: now,
    updatedAt: now,
  };
  const next = [...records, newRecord];
  await ext.storage.session.set({ [STORAGE_KEY]: next });
  return newRecord;
}

export interface UpdateKeyInput {
  keyId: string;
  label?: string;
  baseUrl?: string;
  apiKey?: string;
}

export async function updateKey(input: UpdateKeyInput): Promise<KeyRecord | null> {
  const records = await getKeys();
  const idx = records.findIndex((r) => r.keyId === input.keyId);
  if (idx < 0) return null;
  const existing = records[idx];
  const updated: KeyRecord = {
    ...existing,
    label: input.label?.trim() ?? existing.label,
    baseUrl: input.baseUrl ?? existing.baseUrl,
    apiKey: input.apiKey ?? existing.apiKey,
    updatedAt: Date.now(),
  };
  if (updated.label.length === 0) {
    throw new Error("label cannot be empty");
  }
  const next = [...records];
  next[idx] = updated;
  await ext.storage.session.set({ [STORAGE_KEY]: next });
  return updated;
}

/**
 * Replace a key's full KeyPolicy. Called from the popup Policy editor.
 * Bumps policyVersion to the current schema on save so stale shapes are
 * upgraded transparently. Also strips sampling / reasoningEffort scraps
 * that were produced by older `synthesizePolicy` paths so the policy
 * shape stays minimal.
 */
export async function updatePolicy(keyId: string, policy: KeyPolicy): Promise<KeyRecord | null> {
  const records = await getKeys();
  const idx = records.findIndex((r) => r.keyId === keyId);
  if (idx < 0) return null;
  const existing = records[idx];
  const cleanPolicy: KeyPolicy = { ...policy };
  if (cleanPolicy.sampling && Object.keys(cleanPolicy.sampling).length === 0) {
    delete (cleanPolicy as { sampling?: SamplingPolicy }).sampling;
  }
  if (cleanPolicy.budget && cleanPolicy.budget.maxReasoningEffort === undefined) {
    delete (cleanPolicy.budget as { maxReasoningEffort?: ReasoningEffort }).maxReasoningEffort;
  }
  const updated: KeyRecord = {
    ...existing,
    policy: cleanPolicy,
    policyVersion: CURRENT_POLICY_VERSION,
    updatedAt: Date.now(),
  };
  const next = [...records];
  next[idx] = updated;
  await ext.storage.session.set({ [STORAGE_KEY]: next });
  return updated;
}

export async function deleteKey(keyId: string): Promise<void> {
  const records = await getKeys();
  const filtered = records.filter((r) => r.keyId !== keyId);
  await ext.storage.session.set({ [STORAGE_KEY]: filtered });
  // Cascade: drop per-origin bindings referencing the deleted key so
  // the next access re-prompts consent.
  await removeBindingsForKey(keyId);
  // Cascade: drop ledger entries so spend/audit history doesn't outlive
  // the key. Ledger keeps no cross-key state so this is sufficient.
  await clearLedgerForKey(keyId);
}
