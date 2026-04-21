/**
 * Per-origin grant storage.
 *
 * Grants are stored in chrome.storage.local (persistent across sessions).
 * This is deliberately separate from key storage (chrome.storage.session):
 *   - Keys are ephemeral (cleared on browser close)
 *   - Grants are persistent (user shouldn't re-approve every session)
 *
 * Design: mirrors MetaMask / Phantom "connected sites" model.
 */

import { ext } from "../shared/browser.js";

export interface OriginGrant {
  origin: string;
  grantedAt: number;
}

const GRANTS_KEY = "llmvault_origin_grants";

export async function getGrants(): Promise<OriginGrant[]> {
  const data = await ext.storage.local.get(GRANTS_KEY);
  const grants = data[GRANTS_KEY];
  return Array.isArray(grants) ? (grants as OriginGrant[]) : [];
}

export async function hasGrant(origin: string): Promise<boolean> {
  const grants = await getGrants();
  return grants.some((g) => g.origin === origin);
}

export async function addGrant(origin: string): Promise<void> {
  const grants = await getGrants();
  if (grants.some((g) => g.origin === origin)) return;
  grants.push({ origin, grantedAt: Date.now() });
  await ext.storage.local.set({ [GRANTS_KEY]: grants });
}

export async function removeGrant(origin: string): Promise<void> {
  const grants = await getGrants();
  const filtered = grants.filter((g) => g.origin !== origin);
  await ext.storage.local.set({ [GRANTS_KEY]: filtered });
}
