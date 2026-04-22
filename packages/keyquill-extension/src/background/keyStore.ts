/**
 * Key storage backed by chrome.storage.session.
 *
 * v2 schema: multi-key per provider, keyed by stable `keyId` (UUID v4).
 * Legacy v1 data (`keyquill_providers`) is migrated on first access.
 *
 * Security properties:
 * - Accessible only from extension contexts (not web pages)
 * - Cleared when the browser closes (session storage)
 * - Not synced across devices
 */

import type { KeyRecord, KeySummary } from "../shared/protocol.js";
import { ext } from "../shared/browser.js";
import { removeBindingsForKey } from "./bindingStore.js";

const STORAGE_KEY = "keyquill_keys";
const LEGACY_STORAGE_KEY = "keyquill_providers";

/** Masks the key for display: "sk-a...xyz12". */
function maskKey(apiKey: string): string {
  if (!apiKey) return "****";
  if (apiKey.length <= 8) return "****";
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`;
}

/**
 * Legacy `ProviderRecord` shape preserved here for migration only.
 * Do NOT import this from protocol.ts (it has been removed from v2).
 */
interface LegacyProviderRecord {
  provider: string;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  label?: string;
  createdAt: number;
  updatedAt: number;
}

async function migrateV1IfNeeded(): Promise<KeyRecord[] | null> {
  const legacy = await ext.storage.session.get(LEGACY_STORAGE_KEY);
  const rows = legacy[LEGACY_STORAGE_KEY];
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const migrated: KeyRecord[] = (rows as LegacyProviderRecord[]).map((r, i) => ({
    keyId: crypto.randomUUID(),
    provider: r.provider,
    label: r.label ?? r.provider,
    apiKey: r.apiKey,
    baseUrl: r.baseUrl,
    defaultModel: r.defaultModel,
    // First of each provider in the legacy list becomes default.
    isDefault: i === 0 || rows.findIndex((o: LegacyProviderRecord) => o.provider === r.provider) === i,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
  await ext.storage.session.set({ [STORAGE_KEY]: migrated });
  await ext.storage.session.remove(LEGACY_STORAGE_KEY);
  return migrated;
}

export async function getKeys(): Promise<KeyRecord[]> {
  const data = await ext.storage.session.get(STORAGE_KEY);
  const records = data[STORAGE_KEY];
  if (Array.isArray(records)) return records as KeyRecord[];
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
    isDefault: Boolean(r.isDefault),
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

export async function getDefaultKeyForProvider(provider: string): Promise<KeyRecord | null> {
  const records = await getKeys();
  const matching = records.filter((r) => r.provider === provider);
  return matching.find((r) => r.isDefault) ?? matching[0] ?? null;
}

export async function getGlobalDefaultKey(): Promise<KeyRecord | null> {
  const records = await getKeys();
  return records.find((r) => r.isDefault) ?? records[0] ?? null;
}

export interface AddKeyInput {
  provider: string;
  label: string;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  isDefault?: boolean;
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
    defaultModel: input.defaultModel,
    isDefault: input.isDefault ?? false,
    createdAt: now,
    updatedAt: now,
  };
  // If this is the very first key for this provider, auto-mark as default.
  const existingForProvider = records.filter((r) => r.provider === input.provider);
  if (existingForProvider.length === 0) {
    newRecord.isDefault = true;
  }
  // Invariant: at most one default per provider. Unset others if needed.
  let next = [...records, newRecord];
  if (newRecord.isDefault) {
    next = next.map((r) =>
      r.keyId === newRecord.keyId || r.provider !== newRecord.provider
        ? r
        : { ...r, isDefault: false },
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
    defaultModel: input.defaultModel ?? existing.defaultModel,
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

export async function deleteKey(keyId: string): Promise<void> {
  const records = await getKeys();
  const filtered = records.filter((r) => r.keyId !== keyId);
  // If we removed a default and another key for that provider remains,
  // promote the most-recently-updated one.
  const removed = records.find((r) => r.keyId === keyId);
  if (removed?.isDefault) {
    const siblings = filtered.filter((r) => r.provider === removed.provider);
    if (siblings.length > 0 && !siblings.some((s) => s.isDefault)) {
      const promote = siblings.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
      const promoteIdx = filtered.findIndex((r) => r.keyId === promote.keyId);
      filtered[promoteIdx] = { ...promote, isDefault: true };
    }
  }
  await ext.storage.session.set({ [STORAGE_KEY]: filtered });
  // Cascade: drop per-origin bindings that referenced this key so the next
  // access from those origins re-prompts consent instead of silently
  // falling back to a different default.
  await removeBindingsForKey(keyId);
}

/**
 * Mark `keyId` as the default for its provider. Demotes any sibling that
 * was previously default. Does nothing if keyId doesn't exist.
 */
export async function setDefault(keyId: string): Promise<void> {
  const records = await getKeys();
  const target = records.find((r) => r.keyId === keyId);
  if (!target) return;
  const next = records.map((r) => {
    if (r.provider !== target.provider) return r;
    return { ...r, isDefault: r.keyId === keyId };
  });
  await ext.storage.session.set({ [STORAGE_KEY]: next });
}
