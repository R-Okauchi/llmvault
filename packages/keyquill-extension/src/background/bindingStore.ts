/**
 * Per-origin key binding storage.
 *
 * Subsumes the legacy per-origin grant concept: a binding's existence
 * implies consent was granted for that origin. The binding also records
 * which stored key this origin should use by default (can be overridden
 * per-request via SDK `keyId`).
 *
 * Persisted to chrome.storage.local so bindings survive browser restart
 * (unlike KeyRecords, which live in chrome.storage.session and clear on
 * close).
 *
 * Design: mirrors MetaMask "connected sites" + account switching.
 */

import type { OriginBinding } from "../shared/protocol.js";
import { ext } from "../shared/browser.js";

const BINDINGS_KEY = "keyquill_bindings";
// Legacy v1 key — migrated on first access.
const LEGACY_GRANTS_KEY = "keyquill_origin_grants";

interface LegacyGrant {
  origin: string;
  grantedAt: number;
}

export async function getBindings(): Promise<OriginBinding[]> {
  const data = await ext.storage.local.get(BINDINGS_KEY);
  const rows = data[BINDINGS_KEY];
  if (Array.isArray(rows)) return rows as OriginBinding[];
  // Migrate legacy grants: mark keyId empty, caller must re-prompt to set.
  const legacy = await ext.storage.local.get(LEGACY_GRANTS_KEY);
  const legacyRows = legacy[LEGACY_GRANTS_KEY];
  if (!Array.isArray(legacyRows) || legacyRows.length === 0) return [];
  const migrated: OriginBinding[] = (legacyRows as LegacyGrant[]).map((g) => ({
    origin: g.origin,
    keyId: "", // unset; resolveKey treats empty as "needs prompt"
    grantedAt: g.grantedAt,
    lastUsedAt: g.grantedAt,
  }));
  await ext.storage.local.set({ [BINDINGS_KEY]: migrated });
  await ext.storage.local.remove(LEGACY_GRANTS_KEY);
  return migrated;
}

export async function getBinding(origin: string): Promise<OriginBinding | null> {
  const rows = await getBindings();
  return rows.find((b) => b.origin === origin) ?? null;
}

export async function hasGrant(origin: string): Promise<boolean> {
  const binding = await getBinding(origin);
  return binding !== null;
}

export async function setBinding(origin: string, keyId: string): Promise<void> {
  const rows = await getBindings();
  const now = Date.now();
  const idx = rows.findIndex((b) => b.origin === origin);
  if (idx >= 0) {
    rows[idx] = { ...rows[idx], keyId, lastUsedAt: now };
  } else {
    rows.push({ origin, keyId, grantedAt: now, lastUsedAt: now });
  }
  await ext.storage.local.set({ [BINDINGS_KEY]: rows });
}

export async function touchBindingUsage(origin: string): Promise<void> {
  const rows = await getBindings();
  const idx = rows.findIndex((b) => b.origin === origin);
  if (idx < 0) return;
  rows[idx] = { ...rows[idx], lastUsedAt: Date.now() };
  await ext.storage.local.set({ [BINDINGS_KEY]: rows });
}

export async function removeBinding(origin: string): Promise<void> {
  const rows = await getBindings();
  const filtered = rows.filter((b) => b.origin !== origin);
  await ext.storage.local.set({ [BINDINGS_KEY]: filtered });
}

/**
 * Drop every binding that references the given keyId. Used when a key is
 * deleted so the affected origins re-prompt consent on their next access
 * instead of silently falling through to a different default key.
 */
export async function removeBindingsForKey(keyId: string): Promise<void> {
  const rows = await getBindings();
  const filtered = rows.filter((b) => b.keyId !== keyId);
  if (filtered.length === rows.length) return;
  await ext.storage.local.set({ [BINDINGS_KEY]: filtered });
}
