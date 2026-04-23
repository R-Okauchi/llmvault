/**
 * Resolve a key's effective default model.
 *
 * Lives in `shared/` rather than `background/` because both the popup
 * (for preview / autocomplete / "what would run" indicators) and the
 * resolver (for Tier-1 dispatch) need the same chain.
 *
 * Chain (highest priority first):
 *   1. Policy pin — `key.policy.modelPolicy.defaultModel` (owned by the
 *      user via the Policy editor).
 *   2. Preset default — `getPreset(key.provider).defaultModel`.
 *   3. Catalog fallback — cheapest model for this provider by
 *      `outputPer1M`.
 *   4. `null` if even the catalog has no entry.
 *
 * An unknown model string on the policy pin silently falls through to
 * the preset so typos don't hard-brick Tier 1.
 */
import type { KeyRecord } from "./protocol.js";
import {
  getModel,
  cheapestModelForProvider,
  type ModelSpec,
} from "./modelCatalog.js";
import { getPreset } from "./presets.js";

export function resolveKeyDefault(key: KeyRecord): ModelSpec | null {
  const policyDefault = key.policy?.modelPolicy.defaultModel;
  if (policyDefault) {
    const spec = getModel(policyDefault);
    if (spec) return spec;
  }

  const preset = getPreset(key.provider);
  if (preset?.defaultModel) {
    const spec = getModel(preset.defaultModel);
    if (spec) return spec;
  }

  return cheapestModelForProvider(key.provider);
}
