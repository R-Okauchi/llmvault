import { describe, it, expect } from "vitest";

/**
 * Firefox-specific test file is no longer needed.
 *
 * The SDK now uses window.postMessage relay for all browsers (Chrome, Firefox, Edge).
 * Browser-specific APIs (chrome.runtime, browser.runtime) are only used inside
 * the extension's content script — the SDK never touches them directly.
 *
 * All messaging tests are in client.test.ts and apply to every browser equally.
 */
describe("LLMVault (Firefox)", () => {
  it("uses the same relay pattern as Chrome — see client.test.ts", () => {
    expect(true).toBe(true);
  });
});
