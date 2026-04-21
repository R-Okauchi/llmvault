import { WebPlugin } from "@capacitor/core";
import type { SecureRelayPlugin } from "./definitions.js";
import type { RelayPolicy, RelayProviderInfo } from "./types.js";

/**
 * Web fallback for SecureRelay.
 * All methods throw — secure relay is only available on native platforms.
 * This aligns with ADR-003 Option A (web = deterministic-only).
 */
export class SecureRelayWeb extends WebPlugin implements SecureRelayPlugin {
  private unsupported(): never {
    throw new Error(
      "SecureRelay is only available on native platforms. Use the mobile app for AI features.",
    );
  }

  async registerKey(): Promise<void> {
    this.unsupported();
  }

  async deleteKey(): Promise<void> {
    this.unsupported();
  }

  async listProviders(): Promise<{ providers: RelayProviderInfo[] }> {
    this.unsupported();
  }

  async testKey(): Promise<{ reachable: boolean }> {
    this.unsupported();
  }

  async chatStream(): Promise<{ streamId: string }> {
    this.unsupported();
  }

  async cancelStream(): Promise<void> {
    this.unsupported();
  }

  async updatePolicy(): Promise<void> {
    this.unsupported();
  }

  async getPolicy(): Promise<{ policy: RelayPolicy }> {
    this.unsupported();
  }

  async checkBiometricAvailability(): Promise<{
    available: boolean;
    biometryType: string;
  }> {
    return { available: false, biometryType: "none" };
  }

  async setScreenSecure(): Promise<void> {
    // No-op on the web. Browsers do not offer a per-page screenshot block
    // and the native API is only meaningful inside the Capacitor shell.
  }

  async acceptPairing(): Promise<{
    sessionId: string;
    localPublicKey: string;
    shortCode: string;
  }> {
    this.unsupported();
  }

  async disconnectRelay(): Promise<void> {
    this.unsupported();
  }

  async getRelayStatus(): Promise<{
    connected: boolean;
    sessionId?: string;
    peerDescription?: string;
    connectedSince?: string;
    idleTimeoutSec: number;
  }> {
    return { connected: false, idleTimeoutSec: 0 };
  }
}
