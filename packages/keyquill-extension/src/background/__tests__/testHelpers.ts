import type { KeyRecord, StreamEvent } from "../../shared/protocol.js";

export function mkKey(overrides: Partial<KeyRecord> = {}): KeyRecord {
  return {
    keyId: "k1",
    provider: "openai",
    label: "Work",
    apiKey: "sk-test",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1-mini",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/**
 * Minimal stand-in for chrome.runtime.Port used in stream-parser tests.
 * Records every posted message so assertions can inspect the event sequence.
 */
export function mockPort() {
  const events: StreamEvent[] = [];
  const port = {
    postMessage(e: StreamEvent) {
      events.push(e);
    },
  } as unknown as chrome.runtime.Port;
  return { port, events };
}
