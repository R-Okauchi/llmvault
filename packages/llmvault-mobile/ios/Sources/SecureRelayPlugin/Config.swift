import Foundation

/// Runtime configuration for the llmvault-mobile plugin.
///
/// Populated by `SecureRelayPlugin.load()` from the Capacitor plugin config
/// (see apps/mobile/capacitor.config.ts).  Defaults are tuned for the
/// standalone `llmvault-mobile` package; downstream apps may override them
/// to preserve existing Keychain entries or brand the biometric prompt.
final class LlmvaultMobileConfig {

    static let shared = LlmvaultMobileConfig()

    /// Keychain `kSecAttrService` value. Changing this between releases
    /// makes already-stored keys invisible, so downstream apps should
    /// pin this value across upgrades.
    var keychainService: String = "llmvault-mobile"

    /// HKDF info string used when deriving the AES-GCM session key
    /// during Phone Wallet Relay pairing.  Must match the PC-side
    /// value byte-for-byte.  Only applies to the Relay flow.
    var pairingProtocolLabel: String = "llmvault-mobile-relay-v1"

    private init() {}
}
