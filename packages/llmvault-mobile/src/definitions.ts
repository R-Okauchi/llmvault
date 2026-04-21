/**
 * SecureRelay Capacitor plugin interface.
 *
 * The API key crosses the JS bridge ONLY during registerKey().
 * After that, the key stays in native secure storage and all
 * LLM HTTPS calls are made entirely on the native side.
 */

import type { PluginListenerHandle } from "@capacitor/core";
import type { RelayPolicy, RelayProviderInfo } from "./types.js";

export interface SecureRelayPlugin {
  /** Store an API key in native secure storage. Key is immediately stored and never returned. */
  registerKey(options: {
    provider: string;
    apiKey: string;
    baseUrl: string;
    defaultModel: string;
    label?: string;
  }): Promise<void>;

  /** Remove a provider's key from native secure storage. */
  deleteKey(options: { provider: string }): Promise<void>;

  /** List registered providers (no key material returned, only keyHint). */
  listProviders(): Promise<{ providers: RelayProviderInfo[] }>;

  /** Test connectivity to a provider's API (decrypts key natively, sends test request). */
  testKey(options: { provider: string }): Promise<{ reachable: boolean }>;

  /**
   * Start a streaming LLM chat completion.
   * The native side decrypts the key, calls the provider directly, and emits events.
   * Returns a streamId for tracking.
   */
  chatStream(options: {
    provider: string;
    messages: Array<{ role: string; content: string }>;
    systemPrompt: string;
    maxTokens?: number;
  }): Promise<{ streamId: string }>;

  /** Cancel an active stream. */
  cancelStream(options: { streamId: string }): Promise<void>;

  /** Update the relay policy (provider allowlist, cost limits, etc.). */
  updatePolicy(options: { policy: RelayPolicy }): Promise<void>;

  /** Get the current relay policy. */
  getPolicy(): Promise<{ policy: RelayPolicy }>;

  /** Check if biometric authentication is available on this device. */
  checkBiometricAvailability(): Promise<{
    available: boolean;
    biometryType: string;
  }>;

  /**
   * Toggle a screen-capture-protection flag for the currently focused screen.
   * Android: adds/clears WindowManager FLAG_SECURE — screenshots and screen
   * recording of the app window return black frames while enabled.
   * iOS: no-op — iOS does not expose a per-screen screenshot block for
   * WKWebView. Callers still invoke it so the cross-platform surface stays
   * symmetrical; iOS will simply resolve without doing anything.
   */
  setScreenSecure(options: { enabled: boolean }): Promise<void>;

  // ─── Phone Wallet Relay (ADR-005) ───────────────────────────────

  /**
   * Accept a QR pairing request from a PC browser.
   * Validates the pairing token, performs ECDH key exchange,
   * and establishes a WebSocket connection to the relay server.
   */
  acceptPairing(options: {
    pairingToken: string;
    relayUrl: string;
    peerPublicKey: string;
  }): Promise<{
    sessionId: string;
    localPublicKey: string;
    shortCode: string;
  }>;

  /** Disconnect from an active Phone Wallet Relay session. */
  disconnectRelay(options: { sessionId: string }): Promise<void>;

  /** Get current relay session status (if any). */
  getRelayStatus(): Promise<{
    connected: boolean;
    sessionId?: string;
    peerDescription?: string;
    connectedSince?: string;
    idleTimeoutSec: number;
  }>;
  // ─── Event Listeners (Capacitor standard pattern) ────────────

  addListener(
    eventName: "secureRelayDelta",
    handler: (event: SecureRelayEvents["secureRelayDelta"]) => void,
  ): Promise<PluginListenerHandle>;

  addListener(
    eventName: "secureRelayCard",
    handler: (event: SecureRelayEvents["secureRelayCard"]) => void,
  ): Promise<PluginListenerHandle>;

  addListener(
    eventName: "secureRelayPatch",
    handler: (event: SecureRelayEvents["secureRelayPatch"]) => void,
  ): Promise<PluginListenerHandle>;

  addListener(
    eventName: "secureRelayDone",
    handler: (event: SecureRelayEvents["secureRelayDone"]) => void,
  ): Promise<PluginListenerHandle>;

  addListener(
    eventName: "secureRelayError",
    handler: (event: SecureRelayEvents["secureRelayError"]) => void,
  ): Promise<PluginListenerHandle>;

  addListener(
    eventName: "relayRequestReceived",
    handler: (event: SecureRelayEvents["relayRequestReceived"]) => void,
  ): Promise<PluginListenerHandle>;

  addListener(
    eventName: "relayDisconnected",
    handler: (event: SecureRelayEvents["relayDisconnected"]) => void,
  ): Promise<PluginListenerHandle>;

  removeAllListeners(): Promise<void>;
}

/** Event names emitted by the native plugin during chatStream. */
export interface SecureRelayEvents {
  secureRelayDelta: { streamId: string; text: string };
  secureRelayCard: { streamId: string; card: Record<string, unknown> };
  secureRelayPatch: { streamId: string; patch: Record<string, unknown> };
  secureRelayDone: {
    streamId: string;
    usage?: { promptTokens: number; completionTokens: number };
  };
  secureRelayError: { streamId: string; error: string };

  // Phone Wallet Relay events
  /** Incoming AI request from paired PC browser (phone should process it). */
  relayRequestReceived: {
    sessionId: string;
    requestId: string;
    provider: string;
    messageCount: number;
  };
  /** Relay session disconnected (idle timeout, manual, or error). */
  relayDisconnected: { sessionId: string; reason: string };
}
