/**
 * Key storage backed by chrome.storage.session.
 *
 * Security properties:
 * - Accessible only from extension contexts (not web pages)
 * - Cleared when the browser closes
 * - Not synced across devices
 */

import type { ProviderRecord, ProviderSummary } from "../shared/protocol.js";
import { ext } from "../shared/browser.js";

const STORAGE_KEY = "llmvault_providers";

export async function getProviders(): Promise<ProviderRecord[]> {
  const data = await ext.storage.session.get(STORAGE_KEY);
  const records = data[STORAGE_KEY];
  if (!Array.isArray(records)) return [];
  return records as ProviderRecord[];
}

export async function getProviderSummaries(): Promise<ProviderSummary[]> {
  const records = await getProviders();
  return records.map((r) => ({
    provider: r.provider,
    baseUrl: r.baseUrl,
    defaultModel: r.defaultModel,
    status: "active" as const,
    keyHint: "****",
    label: r.label ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function getProviderWithKey(providerId: string): Promise<ProviderRecord | null> {
  const records = await getProviders();
  return records.find((r) => r.provider === providerId) ?? null;
}

export async function getFirstProvider(): Promise<ProviderRecord | null> {
  const records = await getProviders();
  return records[0] ?? null;
}

export async function setProvider(record: ProviderRecord): Promise<void> {
  const records = await getProviders();
  const idx = records.findIndex((r) => r.provider === record.provider);
  if (idx >= 0) {
    records[idx] = record;
  } else {
    records.push(record);
  }
  await ext.storage.session.set({ [STORAGE_KEY]: records });
}

export async function deleteProvider(providerId: string): Promise<void> {
  const records = await getProviders();
  const filtered = records.filter((r) => r.provider !== providerId);
  await ext.storage.session.set({ [STORAGE_KEY]: filtered });
}
