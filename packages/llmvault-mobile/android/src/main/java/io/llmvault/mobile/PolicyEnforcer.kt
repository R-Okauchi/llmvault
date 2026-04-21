package io.llmvault.mobile

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

data class AllowlistEntry(
    val hostPattern: String,
    val httpsOnly: Boolean,
)

data class RelayPolicyNative(
    val schemaVersion: Int,
    val providerAllowlist: List<AllowlistEntry>,
    val maxTokensPerRequest: Int,
    val dailyCostLimitMicrounits: Long,
    val monthlyCostLimitMicrounits: Long,
    val monthlyWarningThresholdPct: Int,
    val highCostThresholdMicrounits: Long,
    val biometricAutoApproveSeconds: Int = DEFAULT_BIOMETRIC_AUTO_APPROVE_SECONDS,
    val blockPrivateIps: Boolean,
) {
    companion object {
        /**
         * Default biometric auto-approve window in seconds.
         *
         * Matches the TS default in packages/secure-relay/src/policy.ts and
         * the iOS LAContext reuse cap
         * (LATouchIDAuthenticationMaximumAllowableReuseDuration = 300s).
         * Also aligns with the time-bound Keystore validity window set in
         * SecureKeyStore.ensureMasterKeyExists — so the OS, the iOS cap,
         * and our app-layer timer all agree on the same 5-minute cadence.
         */
        const val DEFAULT_BIOMETRIC_AUTO_APPROVE_SECONDS = 300

        val defaultPolicy = RelayPolicyNative(
            schemaVersion = 1,
            providerAllowlist = listOf(
                AllowlistEntry("api.openai.com", httpsOnly = true),
                AllowlistEntry("api.anthropic.com", httpsOnly = true),
                AllowlistEntry("api.groq.com", httpsOnly = true),
                AllowlistEntry("generativelanguage.googleapis.com", httpsOnly = true),
                AllowlistEntry("api.mistral.ai", httpsOnly = true),
            ),
            maxTokensPerRequest = 4096,
            dailyCostLimitMicrounits = 5_000_000L,
            monthlyCostLimitMicrounits = 50_000_000L,
            monthlyWarningThresholdPct = 80,
            highCostThresholdMicrounits = 500_000L,
            biometricAutoApproveSeconds = DEFAULT_BIOMETRIC_AUTO_APPROVE_SECONDS,
            blockPrivateIps = true,
        )
    }
}

sealed class PolicyValidation {
    object Allowed : PolicyValidation()
    data class Rejected(val reason: String) : PolicyValidation()
}

sealed class BudgetCheck {
    data class WithinBudget(val remaining: Long) : BudgetCheck()
    data class OverBudget(val remaining: Long) : BudgetCheck()
}

// ---------------------------------------------------------------------------
// Singleton enforcer
// ---------------------------------------------------------------------------

/**
 * Native-side policy enforcement (defense in depth — mirrors policy.ts and the Swift PolicyEnforcer).
 * Validates URLs, enforces daily/monthly budgets, and determines biometric requirements.
 *
 * Singleton: access via [PolicyEnforcer] directly (object declaration).
 * All public methods are @Synchronized to guard accumulated-cost state on the JVM.
 */
object PolicyEnforcer {

    // Current policy — can be replaced at runtime via [updatePolicy].
    @Volatile
    var policy: RelayPolicyNative = RelayPolicyNative.defaultPolicy
        private set

    // Daily budget state
    @Volatile
    var dailyAccumulated: Long = 0L
        private set
    private var dailyResetDate: String = ""

    // Monthly budget state
    @Volatile
    var monthlyAccumulated: Long = 0L
        private set
    private var monthlyResetMonth: String = ""

    // -----------------------------------------------------------------------
    // Private IP detection
    // -----------------------------------------------------------------------

    private val privateIpPatterns: List<Regex> = listOf(
        Regex("^10\\."),
        Regex("^172\\.(1[6-9]|2\\d|3[01])\\."),
        Regex("^192\\.168\\."),
        Regex("^127\\."),
        Regex("^0\\."),
        Regex("^169\\.254\\."),
        Regex("^::1$"),
        Regex("^fd"),
        Regex("^fc"),
        Regex("^fe80:"),
    )

    private fun isPrivateIp(host: String): Boolean =
        privateIpPatterns.any { it.containsMatchIn(host) }

    // -----------------------------------------------------------------------
    // Host matching
    // -----------------------------------------------------------------------

    /**
     * Supports exact host matches and wildcard patterns of the form "*.example.com".
     * A wildcard pattern also matches the bare root "example.com".
     */
    private fun matchesHost(pattern: String, host: String): Boolean {
        if (pattern.startsWith("*.")) {
            val suffix = pattern.removePrefix("*") // ".example.com"
            return host.endsWith(suffix) || host == pattern.removePrefix("*.")
        }
        return host == pattern
    }

    // -----------------------------------------------------------------------
    // URL validation
    // -----------------------------------------------------------------------

    /**
     * Validate that [urlString] is allowed by the current policy.
     * Returns [PolicyValidation.Allowed] or [PolicyValidation.Rejected] with a reason.
     */
    fun validateBaseUrl(urlString: String): PolicyValidation {
        val url = runCatching { java.net.URL(urlString) }.getOrNull()
            ?: return PolicyValidation.Rejected("Invalid URL")

        val scheme = url.protocol ?: return PolicyValidation.Rejected("Missing URL scheme")
        val host = url.host ?: return PolicyValidation.Rejected("Missing URL host")

        if (scheme != "https") {
            return PolicyValidation.Rejected("HTTP not allowed; HTTPS required")
        }

        if (policy.blockPrivateIps && isPrivateIp(host)) {
            return PolicyValidation.Rejected("Private IP addresses are blocked")
        }

        val allowed = policy.providerAllowlist.any { entry ->
            matchesHost(entry.hostPattern, host)
        }

        return if (allowed) {
            PolicyValidation.Allowed
        } else {
            PolicyValidation.Rejected("Host $host not in provider allowlist")
        }
    }

    // -----------------------------------------------------------------------
    // Budget checks
    // -----------------------------------------------------------------------

    @Synchronized
    fun checkDailyBudget(estimatedCost: Long): BudgetCheck {
        resetIfNewDay()
        val remaining = policy.dailyCostLimitMicrounits - dailyAccumulated
        return if (estimatedCost > remaining) {
            BudgetCheck.OverBudget(remaining = remaining)
        } else {
            BudgetCheck.WithinBudget(remaining = remaining - estimatedCost)
        }
    }

    @Synchronized
    fun checkMonthlyBudget(estimatedCost: Long): BudgetCheck {
        resetIfNewMonth()
        val remaining = policy.monthlyCostLimitMicrounits - monthlyAccumulated
        return if (estimatedCost > remaining) {
            BudgetCheck.OverBudget(remaining = remaining)
        } else {
            BudgetCheck.WithinBudget(remaining = remaining - estimatedCost)
        }
    }

    /** Record the actual cost of a completed request (in microunits). */
    @Synchronized
    fun recordCost(microunits: Long) {
        resetIfNewDay()
        resetIfNewMonth()
        dailyAccumulated += microunits
        monthlyAccumulated += microunits
    }

    // -----------------------------------------------------------------------
    // Cost estimation (companion-style statics via companion object)
    // -----------------------------------------------------------------------

    /**
     * Estimate cost in microunits for a request.
     * Rates are per-1000-tokens in microunits (1 USD = 1,000,000 microunits).
     */
    fun estimateCost(model: String, promptTokens: Int, maxCompletionTokens: Int): Long {
        val rates = costRates(model)
        val promptCost = promptTokens.toLong() * rates.first / 1000L
        val completionCost = maxCompletionTokens.toLong() * rates.second / 1000L
        return promptCost + completionCost
    }

    /**
     * Returns (promptRatePerKToken, completionRatePerKToken) in microunits.
     * Defaults to claude-sonnet-4 rates when the model is unrecognised.
     */
    private fun costRates(model: String): Pair<Long, Long> = when (model) {
        "gpt-4o"                      -> 2_500L to 10_000L
        "gpt-4o-mini"                 -> 150L to 600L
        "gpt-4-turbo"                 -> 10_000L to 30_000L
        "claude-sonnet-4-20250514"    -> 3_000L to 15_000L
        "claude-haiku-4-20250414"     -> 800L to 4_000L
        else                          -> 3_000L to 15_000L  // conservative default
    }

    // -----------------------------------------------------------------------
    // Biometric requirement
    // -----------------------------------------------------------------------

    /**
     * Returns true if biometric authentication is required before this request
     * may proceed.
     *
     * @param estimatedCost Cost estimate in microunits.
     * @param lastAuthAt    Timestamp of the last successful biometric authentication,
     *                      or null if never authenticated.
     */
    fun requiresBiometric(estimatedCost: Long, lastAuthAt: Date?): Boolean {
        // High-cost requests always require biometric regardless of cached auth.
        if (estimatedCost >= policy.highCostThresholdMicrounits) return true

        // Within the auto-approve window no re-authentication is needed.
        if (lastAuthAt != null) {
            val elapsedSeconds = (Date().time - lastAuthAt.time) / 1000L
            if (elapsedSeconds <= policy.biometricAutoApproveSeconds.toLong()) return false
        }

        return true
    }

    // -----------------------------------------------------------------------
    // Policy update
    // -----------------------------------------------------------------------

    /**
     * Update budget / threshold settings.
     * `providerAllowlist` and `blockPrivateIps` are security-critical and
     * cannot be overridden from the JS bridge — they are always preserved
     * from the current (or default) policy.
     */
    fun updatePolicy(newPolicy: RelayPolicyNative) {
        policy = newPolicy.copy(
            providerAllowlist = policy.providerAllowlist,
            blockPrivateIps = true,
        )
    }

    // -----------------------------------------------------------------------
    // Private date helpers
    // -----------------------------------------------------------------------

    // NOTE: SimpleDateFormat is not thread-safe; allocate per call.

    private fun currentDateString(): String =
        SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())

    private fun currentMonthString(): String =
        SimpleDateFormat("yyyy-MM", Locale.US).format(Date())

    /** Must be called inside a @Synchronized block. */
    private fun resetIfNewDay() {
        val today = currentDateString()
        if (today != dailyResetDate) {
            dailyAccumulated = 0L
            dailyResetDate = today
        }
    }

    /** Must be called inside a @Synchronized block. */
    private fun resetIfNewMonth() {
        val month = currentMonthString()
        if (month != monthlyResetMonth) {
            monthlyAccumulated = 0L
            monthlyResetMonth = month
        }
    }
}
