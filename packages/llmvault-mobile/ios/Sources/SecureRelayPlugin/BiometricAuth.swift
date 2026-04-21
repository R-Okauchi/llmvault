import Foundation
import LocalAuthentication

/// Manages biometric authentication (Face ID / Touch ID) for key access.
final class BiometricAuth {

    static let shared = BiometricAuth()

    /// Tracks the last successful biometric auth time for auto-approve window.
    private var lastAuthAt: Date?

    /// iOS hard-caps touchIDAuthenticationAllowableReuseDuration at
    /// LATouchIDAuthenticationMaximumAllowableReuseDuration (300s).
    /// Anything larger is silently clamped by the OS; expose the cap here so
    /// the app-layer `needsAuth` timer stays consistent with what iOS honours.
    private static let osMaxReuseDurationSeconds: Int = 300

    private init() {}

    // MARK: - Availability

    struct Availability {
        let available: Bool
        let biometryType: String
    }

    func checkAvailability() -> Availability {
        let context = LAContext()
        var error: NSError?
        let available = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)

        let biometryType: String
        switch context.biometryType {
        case .faceID:
            biometryType = "faceId"
        case .touchID:
            biometryType = "touchId"
        case .opticID:
            biometryType = "opticId"
        case .none:
            biometryType = "none"
        @unknown default:
            biometryType = "none"
        }

        return Availability(available: available, biometryType: biometryType)
    }

    // MARK: - Authentication

    /// Authenticate with biometric, returning an LAContext usable for Keychain access.
    func authenticate(reason: String, reuseDuration: TimeInterval = 0) async throws -> LAContext {
        let context = LAContext()
        context.localizedReason = reason
        if reuseDuration > 0 {
            // Cap at the iOS OS maximum so the effective reuse window matches
            // what the framework actually enforces.
            context.touchIDAuthenticationAllowableReuseDuration = min(
                reuseDuration,
                Double(BiometricAuth.osMaxReuseDurationSeconds)
            )
        }

        try await context.evaluatePolicy(
            .deviceOwnerAuthenticationWithBiometrics,
            localizedReason: reason
        )

        lastAuthAt = Date()
        return context
    }

    // MARK: - Auto-Approve Window

    /// Check if biometric is required based on policy auto-approve window.
    /// Returns true if biometric auth is needed (outside the auto-approve window).
    /// The window is clamped to the iOS OS maximum so we never hand out a
    /// context that looks valid to the app but is already stale to the OS.
    func needsAuth(autoApproveSeconds: Int) -> Bool {
        guard let lastAuth = lastAuthAt else {
            return true
        }
        let effectiveWindow = min(autoApproveSeconds, BiometricAuth.osMaxReuseDurationSeconds)
        let elapsed = Date().timeIntervalSince(lastAuth)
        return elapsed > Double(effectiveWindow)
    }

    /// Get an authenticated LAContext, reusing recent auth if within auto-approve window.
    /// Within the window, iOS reuses the cached biometric result (no Face ID prompt).
    func getAuthenticatedContext(
        reason: String,
        autoApproveSeconds: Int
    ) async throws -> LAContext {
        let effectiveWindow = min(autoApproveSeconds, BiometricAuth.osMaxReuseDurationSeconds)
        let reuseDuration = Double(effectiveWindow)

        if !needsAuth(autoApproveSeconds: autoApproveSeconds) {
            // Within auto-approve window — return context with reuse duration.
            // iOS will use the cached biometric result without prompting.
            let context = LAContext()
            context.touchIDAuthenticationAllowableReuseDuration = reuseDuration
            return context
        }

        return try await authenticate(reason: reason, reuseDuration: reuseDuration)
    }

    /// Reset the auto-approve window (e.g., on explicit lock).
    func resetAuthWindow() {
        lastAuthAt = nil
    }
}
