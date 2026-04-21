/**
 * Plain TypeScript types for the llmvault-mobile Capacitor plugin.
 *
 * Intentionally zero runtime dependencies (no Zod) so this package
 * can be published to npm with only `@capacitor/core` as a peer.
 */

/** A registered LLM provider as surfaced by `listProviders()`. */
export interface RelayProviderInfo {
  provider: string;
  baseUrl: string;
  defaultModel: string;
  /** Non-sensitive hint (e.g. last 4 chars) — never the raw key. */
  keyHint: string | null;
  label: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Host pattern entry in the provider allowlist. */
export interface RelayProviderAllowlistEntry {
  hostPattern: string;
  httpsOnly: true;
}

/** Relay policy: provider allowlist, cost limits, biometric window. */
export interface RelayPolicy {
  schemaVersion: 1;
  providerAllowlist: RelayProviderAllowlistEntry[];
  maxTokensPerRequest: number;
  dailyCostLimitMicrounits: number;
  monthlyCostLimitMicrounits: number;
  monthlyWarningThresholdPct: number;
  highCostThresholdMicrounits: number;
  biometricAutoApproveSeconds: number;
  blockPrivateIps: true;
}

/** Stream events emitted by the native plugin during `chatStream()`. */
export type RelayStreamEvent =
  | { type: "delta"; streamId: string; text: string }
  | { type: "card"; streamId: string; card: Record<string, unknown> }
  | { type: "patch"; streamId: string; patch: Record<string, unknown> }
  | {
      type: "done";
      streamId: string;
      usage?: { promptTokens: number; completionTokens: number };
    }
  | { type: "error"; streamId: string; error: string };
