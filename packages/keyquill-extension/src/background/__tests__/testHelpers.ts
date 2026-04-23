import type { KeyRecord, KeyPolicy, StreamEvent } from "../../shared/protocol.js";
import { DEFAULT_KEY_POLICY, CURRENT_POLICY_VERSION } from "../../shared/protocol.js";

/**
 * Post-Phase-13d factory: the key's default model lives inside
 * `policy.modelPolicy.defaultModel`. `defaultModel` is accepted as an
 * ergonomic shortcut for tests that predated the move and still express
 * their intent as "this key points at model X".
 *
 * When the caller passes no `policy`, the factory supplies a permissive
 * default with `modelPolicy.defaultModel = "gpt-4.1-mini"` so existing
 * tests keep resolving to a known model.
 */
export function mkKey(
  overrides: Partial<KeyRecord> & { defaultModel?: string } = {},
): KeyRecord {
  const { defaultModel, policy: explicitPolicy, ...rest } = overrides;
  let policy: KeyPolicy = explicitPolicy ?? {
    ...DEFAULT_KEY_POLICY,
    modelPolicy: { ...DEFAULT_KEY_POLICY.modelPolicy, defaultModel: "gpt-4.1-mini" },
  };
  if (defaultModel !== undefined) {
    policy = {
      ...policy,
      modelPolicy: { ...policy.modelPolicy, defaultModel },
    };
  }
  return {
    keyId: "k1",
    provider: "openai",
    label: "Work",
    apiKey: "sk-test",
    baseUrl: "https://api.openai.com/v1",
    policy,
    policyVersion: CURRENT_POLICY_VERSION,
    createdAt: 1,
    updatedAt: 1,
    ...rest,
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
