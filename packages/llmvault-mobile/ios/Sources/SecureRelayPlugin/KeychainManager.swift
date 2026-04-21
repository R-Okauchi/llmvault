import Foundation
import Security
import LocalAuthentication

/// Manages API key storage in iOS Keychain with biometric protection.
/// Key material is stored with biometric access control; metadata is stored separately without biometric.
final class KeychainManager {

    static let shared = KeychainManager()
    private var service: String { LlmvaultMobileConfig.shared.keychainService }

    private init() {}

    // MARK: - API Key Storage (biometric-gated)

    /// Store an API key in the Keychain with biometric protection.
    func saveKey(provider: String, apiKey: String) throws {
        guard let data = apiKey.data(using: .utf8) else {
            throw KeychainError.encodingFailed
        }

        // Delete existing key first
        try? deleteKeychainItem(account: provider)

        // Create access control requiring biometric authentication
        var error: Unmanaged<CFError>?
        guard let accessControl = SecAccessControlCreateWithFlags(
            kCFAllocatorDefault,
            kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
            .biometryCurrentSet,
            &error
        ) else {
            throw KeychainError.accessControlFailed(error?.takeRetainedValue().localizedDescription ?? "unknown")
        }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: provider,
            kSecValueData as String: data,
            kSecAttrAccessControl as String: accessControl,
            kSecAttrSynchronizable as String: kCFBooleanFalse!,
        ]

        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.osStatus(status)
        }
    }

    /// Load an API key from the Keychain. Requires an authenticated LAContext.
    func loadKey(provider: String, context: LAContext) throws -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: provider,
            kSecReturnData as String: true,
            kSecUseAuthenticationContext as String: context,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        guard status == errSecSuccess, let data = result as? Data,
              let key = String(data: data, encoding: .utf8) else {
            throw KeychainError.osStatus(status)
        }

        return key
    }

    /// Delete an API key from the Keychain.
    func deleteKey(provider: String) throws {
        try deleteKeychainItem(account: provider)
    }

    // MARK: - Provider Metadata (no biometric required)

    /// Store provider metadata (no key material).
    func saveMetadata(provider: String, metadata: ProviderMetadata) throws {
        let account = "meta_\(provider)"
        let data = try JSONEncoder().encode(metadata)

        // Delete existing
        try? deleteKeychainItem(account: account)

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
            kSecAttrSynchronizable as String: kCFBooleanFalse!,
        ]

        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.osStatus(status)
        }
    }

    /// Load metadata for a single provider.
    func loadMetadata(provider: String) throws -> ProviderMetadata? {
        let account = "meta_\(provider)"
        return try loadMetadataItem(account: account)
    }

    /// Load all provider metadata entries.
    func loadAllMetadata() throws -> [ProviderMetadata] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecMatchLimit as String: kSecMatchLimitAll,
            kSecReturnAttributes as String: true,
            kSecReturnData as String: true,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecItemNotFound {
            return []
        }
        guard status == errSecSuccess, let items = result as? [[String: Any]] else {
            throw KeychainError.osStatus(status)
        }

        var metadataList: [ProviderMetadata] = []
        for item in items {
            guard let account = item[kSecAttrAccount as String] as? String,
                  account.hasPrefix("meta_"),
                  let data = item[kSecValueData as String] as? Data else {
                continue
            }
            if let meta = try? JSONDecoder().decode(ProviderMetadata.self, from: data) {
                metadataList.append(meta)
            }
        }
        return metadataList
    }

    /// Delete metadata for a provider.
    func deleteMetadata(provider: String) throws {
        try deleteKeychainItem(account: "meta_\(provider)")
    }

    // MARK: - Helpers

    private func deleteKeychainItem(account: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            throw KeychainError.osStatus(status)
        }
    }

    private func loadMetadataItem(account: String) throws -> ProviderMetadata? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess, let data = result as? Data else {
            throw KeychainError.osStatus(status)
        }
        return try JSONDecoder().decode(ProviderMetadata.self, from: data)
    }
}

// MARK: - Types

struct ProviderMetadata: Codable {
    let provider: String
    let baseUrl: String
    let defaultModel: String
    let keyHint: String?
    let label: String?
    let createdAt: Int
    let updatedAt: Int
}

enum KeychainError: Error, LocalizedError {
    case encodingFailed
    case accessControlFailed(String)
    case osStatus(OSStatus)

    var errorDescription: String? {
        switch self {
        case .encodingFailed:
            return "Failed to encode key data"
        case .accessControlFailed(let detail):
            return "Access control creation failed: \(detail)"
        case .osStatus(let status):
            return "Keychain error: \(status)"
        }
    }
}
