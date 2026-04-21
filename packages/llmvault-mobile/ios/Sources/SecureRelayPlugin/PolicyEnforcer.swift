import Foundation

/// Native-side policy enforcement (defense in depth — same rules as policy.ts).
/// Validates URLs, checks budgets, and determines biometric requirements.
final class PolicyEnforcer {

    static let shared = PolicyEnforcer()

    // MARK: - Default Policy

    static let defaultAllowlist: [[String: Any]] = [
        ["hostPattern": "api.openai.com", "httpsOnly": true],
        ["hostPattern": "api.anthropic.com", "httpsOnly": true],
        ["hostPattern": "api.groq.com", "httpsOnly": true],
        ["hostPattern": "generativelanguage.googleapis.com", "httpsOnly": true],
        ["hostPattern": "api.mistral.ai", "httpsOnly": true],
    ]

    /// Current stored policy (loaded from Keychain on init).
    private(set) var policy: RelayPolicyNative

    /// Daily accumulated cost in microunits.
    private(set) var dailyAccumulated: Int64 = 0
    private var dailyResetDate: String = ""

    /// Monthly accumulated cost in microunits.
    private(set) var monthlyAccumulated: Int64 = 0
    private var monthlyResetMonth: String = ""

    private init() {
        self.policy = RelayPolicyNative.defaultPolicy
    }

    // MARK: - URL Validation

    /// Validate that a base URL is allowed by the policy.
    func validateBaseUrl(_ urlString: String) -> PolicyValidation {
        guard let url = URL(string: urlString),
              let scheme = url.scheme,
              let host = url.host else {
            return .rejected("Invalid URL")
        }

        // HTTPS only
        guard scheme == "https" else {
            return .rejected("HTTP not allowed; HTTPS required")
        }

        // Block private IPs
        if isPrivateIp(host) {
            return .rejected("Private IP addresses are blocked")
        }

        // Check allowlist
        let allowed = policy.providerAllowlist.contains { entry in
            matchesHost(pattern: entry.hostPattern, host: host)
        }

        return allowed ? .allowed : .rejected("Host \(host) not in provider allowlist")
    }

    // MARK: - Budget Checking

    func checkDailyBudget(estimatedCost: Int64) -> BudgetCheck {
        resetIfNewDay()
        let remaining = policy.dailyCostLimitMicrounits - dailyAccumulated
        if estimatedCost > remaining {
            return .overBudget(remaining: remaining)
        }
        return .withinBudget(remaining: remaining - estimatedCost)
    }

    func checkMonthlyBudget(estimatedCost: Int64) -> BudgetCheck {
        resetIfNewMonth()
        let remaining = policy.monthlyCostLimitMicrounits - monthlyAccumulated
        if estimatedCost > remaining {
            return .overBudget(remaining: remaining)
        }
        return .withinBudget(remaining: remaining - estimatedCost)
    }

    /// Record a completed request cost.
    func recordCost(_ microunits: Int64) {
        resetIfNewDay()
        resetIfNewMonth()
        dailyAccumulated += microunits
        monthlyAccumulated += microunits
    }

    // MARK: - Cost Estimation

    /// Estimate cost in microunits for a request.
    static func estimateCost(model: String, promptTokens: Int, maxCompletionTokens: Int) -> Int64 {
        let rates = costRates(for: model)
        let promptCost = Int64(promptTokens) * rates.prompt / 1000
        let completionCost = Int64(maxCompletionTokens) * rates.completion / 1000
        return promptCost + completionCost
    }

    private static func costRates(for model: String) -> (prompt: Int64, completion: Int64) {
        let costs: [String: (prompt: Int64, completion: Int64)] = [
            "gpt-4o": (2500, 10000),
            "gpt-4o-mini": (150, 600),
            "gpt-4-turbo": (10000, 30000),
            "claude-sonnet-4-20250514": (3000, 15000),
            "claude-haiku-4-20250414": (800, 4000),
        ]
        return costs[model] ?? (3000, 15000) // default
    }

    // MARK: - Biometric Requirements

    /// Check if biometric is required for this request.
    func requiresBiometric(estimatedCost: Int64, lastAuthAt: Date?) -> Bool {
        // High-cost always requires biometric
        if estimatedCost >= policy.highCostThresholdMicrounits {
            return true
        }

        // Within auto-approve window, no biometric needed
        if let lastAuth = lastAuthAt {
            let elapsed = Date().timeIntervalSince(lastAuth)
            if elapsed <= Double(policy.biometricAutoApproveSeconds) {
                return false
            }
        }

        return true
    }

    // MARK: - Policy Update

    /// Update budget / threshold settings.
    /// `providerAllowlist` and `blockPrivateIps` are security-critical and
    /// cannot be overridden from the JS bridge — they are always preserved
    /// from the current (or default) policy.
    func updatePolicy(_ newPolicy: RelayPolicyNative) {
        self.policy = RelayPolicyNative(
            schemaVersion: newPolicy.schemaVersion,
            providerAllowlist: self.policy.providerAllowlist,
            maxTokensPerRequest: newPolicy.maxTokensPerRequest,
            dailyCostLimitMicrounits: newPolicy.dailyCostLimitMicrounits,
            monthlyCostLimitMicrounits: newPolicy.monthlyCostLimitMicrounits,
            monthlyWarningThresholdPct: newPolicy.monthlyWarningThresholdPct,
            highCostThresholdMicrounits: newPolicy.highCostThresholdMicrounits,
            biometricAutoApproveSeconds: newPolicy.biometricAutoApproveSeconds,
            blockPrivateIps: true
        )
    }

    // MARK: - Private Helpers

    private func isPrivateIp(_ host: String) -> Bool {
        let patterns = [
            "^10\\.",
            "^172\\.(1[6-9]|2\\d|3[01])\\.",
            "^192\\.168\\.",
            "^127\\.",
            "^0\\.",
            "^169\\.254\\.",
            "^::1$",
            "^fd",
            "^fc",
            "^fe80:",
        ]
        return patterns.contains { pattern in
            host.range(of: pattern, options: .regularExpression, range: nil, locale: nil) != nil
        }
    }

    private func matchesHost(pattern: String, host: String) -> Bool {
        if pattern.hasPrefix("*.") {
            let suffix = String(pattern.dropFirst(1)) // ".example.com"
            return host.hasSuffix(suffix) || host == String(pattern.dropFirst(2))
        }
        return host == pattern
    }

    private func resetIfNewDay() {
        let today = currentDateString()
        if today != dailyResetDate {
            dailyAccumulated = 0
            dailyResetDate = today
        }
    }

    private func resetIfNewMonth() {
        let month = currentMonthString()
        if month != monthlyResetMonth {
            monthlyAccumulated = 0
            monthlyResetMonth = month
        }
    }

    private func currentDateString() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: Date())
    }

    private func currentMonthString() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM"
        return formatter.string(from: Date())
    }
}

// MARK: - Types

struct RelayPolicyNative {
    let schemaVersion: Int
    let providerAllowlist: [AllowlistEntry]
    let maxTokensPerRequest: Int
    let dailyCostLimitMicrounits: Int64
    let monthlyCostLimitMicrounits: Int64
    let monthlyWarningThresholdPct: Int
    let highCostThresholdMicrounits: Int64
    let biometricAutoApproveSeconds: Int
    let blockPrivateIps: Bool

    struct AllowlistEntry {
        let hostPattern: String
        let httpsOnly: Bool
    }

    /// Default biometric auto-approve window in seconds.
    ///
    /// Mirrors the TS default in policy.ts and Android's
    /// PolicyEnforcer.DEFAULT_BIOMETRIC_AUTO_APPROVE_SECONDS. 300s is also
    /// the iOS LATouchIDAuthenticationMaximumAllowableReuseDuration hard
    /// cap so the app-layer timer cannot outlive the OS cache.
    static let defaultBiometricAutoApproveSeconds: Int = 300

    static let defaultPolicy = RelayPolicyNative(
        schemaVersion: 1,
        providerAllowlist: [
            AllowlistEntry(hostPattern: "api.openai.com", httpsOnly: true),
            AllowlistEntry(hostPattern: "api.anthropic.com", httpsOnly: true),
            AllowlistEntry(hostPattern: "api.groq.com", httpsOnly: true),
            AllowlistEntry(hostPattern: "generativelanguage.googleapis.com", httpsOnly: true),
            AllowlistEntry(hostPattern: "api.mistral.ai", httpsOnly: true),
        ],
        maxTokensPerRequest: 4096,
        dailyCostLimitMicrounits: 5_000_000,
        monthlyCostLimitMicrounits: 50_000_000,
        monthlyWarningThresholdPct: 80,
        highCostThresholdMicrounits: 500_000,
        biometricAutoApproveSeconds: defaultBiometricAutoApproveSeconds,
        blockPrivateIps: true
    )
}

enum PolicyValidation {
    case allowed
    case rejected(String)
}

enum BudgetCheck {
    case withinBudget(remaining: Int64)
    case overBudget(remaining: Int64)
}
