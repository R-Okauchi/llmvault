import { describe, it, expect } from "vitest";
import { toPlanPreview } from "../planPreview.js";
import { getModel } from "../../shared/modelCatalog.js";

describe("toPlanPreview", () => {
  const pro = getModel("gpt-5.4-pro")!;

  it("maps a ready resolver output into the ready preview shape", () => {
    const preview = toPlanPreview(
      {
        kind: "ready",
        plan: {
          model: pro,
          endpoint: "responses",
          url: "https://api.openai.com/v1/responses",
          headers: {},
          body: "{}",
          estimatedCostUSD: 0.031,
          estimatedTokens: { input: 128, output: 512 },
          trace: {
            modelChosen: pro.id,
            modelSelectionReason: "capability-match",
            endpointReason: "catalog-endpoint",
            estimatedCostUSD: 0.031,
            estimatedTokens: { input: 128, output: 512 },
            temperatureSource: "tone",
          },
        },
      },
      "k1",
      "openai",
    );
    expect(preview.kind).toBe("ready");
    if (preview.kind !== "ready") throw new Error("expected ready");
    expect(preview.keyId).toBe("k1");
    expect(preview.provider).toBe("openai");
    expect(preview.model.id).toBe(pro.id);
    expect(preview.model.displayName).toBe(pro.displayName);
    expect(preview.model.capabilities).toEqual(pro.capabilities);
    expect(preview.model.releaseStage).toBe(pro.releaseStage);
    expect(preview.estimatedCostUSD).toBeCloseTo(0.031);
    expect(preview.selectionReason).toBe("capability-match");
    // Should NOT leak URL / headers / body / endpoint
    expect(preview as unknown as { url?: unknown }).not.toHaveProperty("url");
    expect(preview as unknown as { headers?: unknown }).not.toHaveProperty("headers");
    expect(preview as unknown as { body?: unknown }).not.toHaveProperty("body");
  });

  it("maps consent-required with an allowlist miss and enriches proposedModel from catalog", () => {
    const preview = toPlanPreview(
      {
        kind: "consent-required",
        reason: "model-outside-allowlist",
        context: {
          origin: "https://example.com",
          keyId: "k1",
          model: pro.id,
          estimatedCostUSD: 0.05,
        },
      },
      "k1",
      "openai",
    );
    expect(preview.kind).toBe("consent-required");
    if (preview.kind !== "consent-required") throw new Error("expected consent-required");
    expect(preview.reason).toBe("model-outside-allowlist");
    expect(preview.message).toContain("allowlist");
    expect(preview.proposedModel?.id).toBe(pro.id);
    expect(preview.proposedModel?.displayName).toBe(pro.displayName);
  });

  it("maps consent-required high-cost without a model id and omits proposedModel", () => {
    const preview = toPlanPreview(
      {
        kind: "consent-required",
        reason: "high-cost",
        context: {
          origin: "https://example.com",
          keyId: "k1",
          estimatedCostUSD: 0.5,
        },
      },
      "k1",
      "openai",
    );
    expect(preview.kind).toBe("consent-required");
    if (preview.kind !== "consent-required") throw new Error("expected consent-required");
    expect(preview.reason).toBe("high-cost");
    expect(preview.message).toContain("0.5000");
    expect(preview.proposedModel).toBeUndefined();
  });

  it("maps rejected resolver outputs", () => {
    const preview = toPlanPreview(
      {
        kind: "reject",
        reason: "no-model-matches-capabilities",
        message: "No allowed model satisfies the required capabilities.",
      },
      "k1",
      "openai",
    );
    expect(preview.kind).toBe("rejected");
    if (preview.kind !== "rejected") throw new Error("expected rejected");
    expect(preview.reason).toBe("no-model-matches-capabilities");
    expect(preview.message).toContain("No allowed model");
  });
});
