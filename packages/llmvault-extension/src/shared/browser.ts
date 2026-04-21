/**
 * Cross-browser runtime shim.
 * Resolves to `browser` (Firefox) or `chrome` (Chrome/Edge),
 * typed as the Chrome extension API from @types/chrome.
 */

declare const browser: typeof chrome | undefined;

export const ext: typeof chrome = (
  typeof browser !== "undefined" && browser?.runtime ? browser : chrome
) as typeof chrome;
