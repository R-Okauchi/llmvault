/**
 * Key storage backed by chrome.storage.session.
 *
 * v3 schema: active-key model. The wallet has multiple keys; exactly one
 * (when any exist) is marked `isActive: true`. Resolution for requests
 * without an explicit keyId or per-origin binding uses the active key.
 *
 * Phase 13d: the record-level `defaultModel` has been folded into
 * `policy.modelPolicy.defaultModel`. Records that still carry the legacy
 * field in storage are migrated on first read and rewritten.
 *
 * Legacy data:
 *   - v1 `keyquill_providers`  → migrate to v3 KeyRecord[], first entry active
 *   - v2 `keyquill_keys`       → had `isDefault`, coerced to wallet-wide `isActive`
 *   - v3 with record `defaultModel` → copied into policy, then stripped
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
 * Storage rows across v2 and v3-through-Phase-13c carried `defaultModel`
 * at the record level. This shape captures both: the legacy `isDefault`
 * flag (pre-v3 wallet-wide active model) and the pre-13d `defaultModel`.
 * Normalised into `KeyRecord` + populated policy by the read path.
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
 * v2 → v3 coercion: pick the single wallet-wide active key. Touches
 * only the `isActive` invariant; the `defaultModel`-to-policy migration
 * happens afterwards in `ensurePolicy`.
 */
function coerceV2Records(rows: LegacyStoredRecord[]): LegacyStoredRecord[] {
  const alreadyV3 = rows.some((r) => typeof r.isActive === "boolean");
  if (alreadyV3) {
    return rows.map((r) => ({ ...r, isActive: Boolean(r.isActive) }));
  }

  const defaults = rows.filter((r) => r.isDefault);
  const winner =
    defaults.length > 0
      ? defaults.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a))
      : rows[0];
  return rows.map((r) => ({
    ...r,
    isActive: winner ? r.keyId === winner.keyId : false,
  }));
}

/**
 * Synthesize a KeyPolicy from a record's legacy fields.
 *
 * - Sampling (temperature, topP) moves into `policy.sampling`
 * - reasoningEffort becomes an upper cap via `policy.budget.maxReasoningEffort`
 * - `defaultModel` (when provided) seeds `policy.modelPolicy.defaultModel`
 * - Every other policy field stays at its permissive default
 *
 * Result is equivalent to pre-v1.0 unrestricted pass-through: nothing
 * blocks, sampling defaults are honored when the developer omits them.
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
 *   - No `defaultModel` at the top level. The legacy value is copied
 *     into `policy.modelPolicy.defaultModel` unless the policy already
 *     pins one (user Policy-editor edits win over record lineage).
 *   - `policy` always populated. Synthesised from legacy `defaults` if
 *     none exists.
 *   - `policyVersion` set to CURRENT_POLICY_VERSION (2 after Phase 13d).
 *
 * The `changed` flag lets the caller decide whether to rewrite storage.
 */
function normaliseRecord(row: LegacyStoredRecord): {
  record: KeyRecord;
  changed: boolean;
} {
  const legacyDefault = row.defaultModel;
  const hadLegacyField = Object.prototype.hasOwnProperty.call(row, "defaultModel");
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
    ...(typeof row.isActive === "boolean" ? { isActive: row.isActive } : {}),
    ...(row.defaults ? { defaults: row.defaults } : {}),
    policy,
    policyVersion: CURRENT_POLICY_VERSION,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };

  const changed = hadLegacyField || !atCurrentVersion || row.policy !== policy;
  return { record, changed };
}

async function migrateV1IfNeeded(): Promise<KeyRecord[] | null> {
  const legacy = await ext.storage.session.get(LEGACY_V1_KEY);
  const rows = legacy[LEGACY_V1_KEY];
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const migrated: KeyRecord[] = (rows as LegacyV1Record[]).map((r, i) => {
    const legacyShape: LegacyStoredRecord = {
      keyId: crypto.randomUUID(),
      provider: r.provider,
      label: r.label ?? r.provider,
      apiKey: r.apiKey,
      baseUrl: r.baseUrl,
      defaultModel: r.defaultModel,
      isActive: i === 0, // first legacy entry becomes the wallet active
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
    const needsActiveCoerce = legacyRows.every(
      (r) => typeof r.isActive !== "boolean",
    );
    const afterActiveCoerce =
      needsActiveCoerce && legacyRows.length > 0
        ? coerceV2Records(legacyRows)
        : legacyRows;

    let anyChanged = needsActiveCoerce && legacyRows.length > 0;
    const normalised = afterActiveCoerce.map((row) => {
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
    // Populate both `effectiveDefaultModel` (canonical) and `defaultModel`
    // (deprecated alias) so SDK consumers from the 1.0.x line keep
    // reading a populated field while they migrate.
    const defaultModelFields = effective
      ? { effectiveDefaultModel: effective.id, defaultModel: effective.id }
      : {};
    return {
      keyId: r.keyId,
      provider: r.provider,
      label: r.label,
      baseUrl: r.baseUrl,
      ...defaultModelFields,
      isActive: Boolean(r.isActive),
      ...(r.defaults ? { defaults: r.defaults } : {}),
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
  /**
   * Seeds `policy.modelPolicy.defaultModel` for the new key. Optional
   * for preset providers (resolver falls back to the preset default);
   * required by callers for `custom` providers.
   */
  defaultModel?: string;
  isActive?: boolean;
}

export async function addKey(input: AddKeyInput): Promise<KeyRecord> {
  if (!input.label || input.label.trim().length === 0) {
    throw new Error("label is required");
  }
  const records = await getKeys();
  const now = Date.now();
  const shouldActivate = input.isActive ?? records.length === 0;
  const newRecord: KeyRecord = {
    keyId: crypto.randomUUID(),
    provider: input.provider,
    label: input.label.trim(),
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    isActive: shouldActivate,
    policy: synthesizePolicy(undefined, input.defaultModel),
    policyVersion: CURRENT_POLICY_VERSION,
    createdAt: now,
    updatedAt: now,
  };
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
  // Cascade: drop ledger entries so spend/audit history doesn't outlive
  // the key. Ledger keeps no cross-key state so this is sufficient.
  await clearLedgerForKey(keyId);
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
