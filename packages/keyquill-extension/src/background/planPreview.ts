/**
 * Pure converter from the resolver's internal `ResolverOutput` to the
 * wire-level `PlanPreview`. Strips background-only fields (endpoint, URL,
 * headers, full trace) and keeps just what a web-page caller needs to
 * decide whether to proceed.
 *
 * Lives in its own file (no chrome.* imports) so unit tests can exercise
 * it without bootstrapping the full extension context.
 */

import type { PlanPreview, PlanPreviewModel } from "../shared/protocol.js";
import { getModel } from "../shared/modelCatalog.js";
import type { ResolverOutput } from "./resolver.js";

export function toPlanPreview(
  result: ResolverOutput,
  keyId: string,
  provider: string,
): PlanPreview {
  if (result.kind === "ready") {
    const { model, estimatedCostUSD, estimatedTokens, trace } = result.plan;
    return {
      kind: "ready",
      keyId,
      provider,
      model: {
        id: model.id,
        displayName: model.displayName,
        capabilities: model.capabilities,
        releaseStage: model.releaseStage,
      },
      estimatedCostUSD,
      estimatedTokens,
      selectionReason: trace.modelSelectionReason,
    };
  }
  if (result.kind === "consent-required") {
    let proposedModel: PlanPreviewModel | undefined;
    if (result.context.model) {
      const spec = getModel(result.context.model);
      if (spec) {
        proposedModel = {
          id: spec.id,
          displayName: spec.displayName,
          capabilities: spec.capabilities,
          releaseStage: spec.releaseStage,
        };
      }
    }
    return {
      kind: "consent-required",
      reason: result.reason,
      message:
        result.reason === "model-outside-allowlist"
          ? `Model "${result.context.model ?? "?"}" is not in the allowlist for this key; a consent prompt will appear.`
          : result.reason === "model-in-denylist"
            ? `Model "${result.context.model ?? "?"}" is on this key's denylist; a consent prompt will appear.`
            : result.reason === "high-cost"
              ? `Estimated cost ${result.context.estimatedCostUSD?.toFixed(4) ?? "?"} USD would exceed the per-request budget; a consent prompt will appear.`
              : "This request would require user consent.",
      ...(proposedModel ? { proposedModel } : {}),
    };
  }
  return {
    kind: "rejected",
    reason: result.reason,
    message: result.message,
  };
}
