package io.llmvault.mobile

import android.util.Log
import android.view.WindowManager
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * Capacitor plugin that manages LLM API keys in Android Keystore
 * and makes direct HTTPS calls to LLM providers.
 * Keys never cross back to the JS bridge after registerKey().
 */
@CapacitorPlugin(name = "SecureRelay")
class SecureRelayPlugin : Plugin() {

    private lateinit var keyStore: SecureKeyStore
    private val biometric = BiometricAuthManager()
    private val httpClient = LLMHttpClient()
    private val policyEnforcer = PolicyEnforcer

    private val relayHandler by lazy {
        RelaySessionHandler(
            keyStore = keyStore,
            biometric = biometric,
            httpClient = httpClient,
            policyEnforcer = policyEnforcer,
            // Capacitor's Plugin.getActivity() already returns an AppCompatActivity
            // (FragmentActivity subclass) so no cast is required here.
            activityProvider = { activity },
        ).also { handler ->
            handler.onRequestReceived = { provider, requestId, messageCount ->
                val data = JSObject().apply {
                    put("sessionId", handler.sessionId ?: "")
                    put("requestId", requestId)
                    put("provider", provider)
                    put("messageCount", messageCount)
                }
                notifyListeners("relayRequestReceived", data)
            }
            handler.onDisconnect = { sessionId ->
                val data = JSObject().apply {
                    put("sessionId", sessionId)
                    put("reason", "disconnected")
                }
                notifyListeners("relayDisconnected", data)
            }
        }
    }

    override fun load() {
        // Apply downstream Capacitor config overrides (see apps/mobile/capacitor.config.ts).
        // Must run before any Keystore / RelaySessionHandler access.
        config.getString("keystoreAlias")?.takeIf { it.isNotEmpty() }?.let {
            LlmvaultMobileConfig.keystoreAlias = it
        }
        config.getString("biometricPromptTitle")?.takeIf { it.isNotEmpty() }?.let {
            LlmvaultMobileConfig.biometricPromptTitle = it
        }
        config.getString("pairingProtocolLabel")?.takeIf { it.isNotEmpty() }?.let {
            LlmvaultMobileConfig.pairingProtocolLabel = it
        }

        keyStore = SecureKeyStore(context)

        // Reset biometric auth window when app goes to background
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStop(owner: LifecycleOwner) {
                biometric.resetAuthWindow()
            }
        })
    }

    // ── registerKey ──────────────────────────────────

    @PluginMethod
    fun registerKey(call: PluginCall) {
        val provider = call.getString("provider") ?: return call.reject("Missing: provider")
        val apiKey = call.getString("apiKey") ?: return call.reject("Missing: apiKey")
        val baseUrl = call.getString("baseUrl") ?: return call.reject("Missing: baseUrl")
        val defaultModel = call.getString("defaultModel") ?: return call.reject("Missing: defaultModel")
        val label = call.getString("label")
        val activity = activity as? FragmentActivity ?: return call.reject("No activity")

        // Validate URL against policy
        val validation = policyEnforcer.validateBaseUrl(baseUrl)
        if (validation is PolicyValidation.Rejected) {
            return call.reject("URL rejected: ${validation.reason}")
        }

        // The SecureKeyStore master key is biometric-gated (OS-enforced). A
        // BiometricPrompt has to succeed before saveKey() can call Cipher.init
        // without UserNotAuthenticatedException. Within the policy
        // auto-approve window we skip the prompt UI; the Keystore's own
        // validity window is the backstop.
        val autoApprove = policyEnforcer.policy.biometricAutoApproveSeconds

        val doSave = {
            Thread {
                try {
                    keyStore.saveKey(provider, apiKey)

                    val keyHint = apiKey.takeLast(4)
                    val now = System.currentTimeMillis() / 1000L
                    val metadata = ProviderMetadata(
                        provider = provider,
                        baseUrl = baseUrl,
                        defaultModel = defaultModel,
                        keyHint = keyHint,
                        label = label,
                        createdAt = now,
                        updatedAt = now,
                    )
                    keyStore.saveMetadata(provider, metadata)
                    activity.runOnUiThread { call.resolve() }
                } catch (e: SecureStorageUnavailableException) {
                    // User-safe message (no lock screen / Keystore init failed).
                    activity.runOnUiThread { call.reject(e.message ?: "Secure storage unavailable") }
                } catch (e: Exception) {
                    activity.runOnUiThread { call.reject("Failed to store key: ${e.message}") }
                }
            }.start()
        }

        if (!biometric.needsAuth(autoApprove)) {
            doSave()
        } else {
            biometric.authenticateWithCallback(
                activity,
                "Authenticate to register an AI provider key",
                onSuccess = { doSave() },
                onError = { errMsg ->
                    activity.runOnUiThread { call.reject("Biometric failed: $errMsg") }
                },
            )
        }
    }

    // ── deleteKey ────────────────────────────────────

    @PluginMethod
    fun deleteKey(call: PluginCall) {
        val provider = call.getString("provider") ?: return call.reject("Missing: provider")
        try {
            keyStore.deleteKey(provider)
            keyStore.deleteMetadata(provider)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Failed to delete key: ${e.message}")
        }
    }

    // ── listProviders ────────────────────────────────

    @PluginMethod
    fun listProviders(call: PluginCall) {
        try {
            val metadataList = keyStore.loadAllMetadata()
            val providers = JSONArray()
            for (meta in metadataList) {
                val obj = JSONObject().apply {
                    put("provider", meta.provider)
                    put("baseUrl", meta.baseUrl)
                    put("defaultModel", meta.defaultModel)
                    put("createdAt", meta.createdAt)
                    put("updatedAt", meta.updatedAt)
                    put("keyHint", meta.keyHint ?: JSONObject.NULL)
                    put("label", meta.label ?: JSONObject.NULL)
                }
                providers.put(obj)
            }
            val result = JSObject()
            result.put("providers", providers)
            call.resolve(result)
        } catch (e: Exception) {
            call.reject("Failed to list providers: ${e.message}")
        }
    }

    // ── testKey ──────────────────────────────────────

    @PluginMethod
    fun testKey(call: PluginCall) {
        val provider = call.getString("provider") ?: return call.reject("Missing: provider")
        val activity = activity as? FragmentActivity ?: return call.reject("No activity")
        val autoApprove = policyEnforcer.policy.biometricAutoApproveSeconds

        val runTest = {
            Thread { executeTestKey(call, provider, activity) }.start()
        }

        if (!biometric.needsAuth(autoApprove)) {
            runTest()
        } else {
            biometric.authenticateWithCallback(
                activity,
                "Authenticate to test AI provider connectivity",
                onSuccess = { runTest() },
                onError = { errMsg ->
                    // Log without the error detail to avoid leaking KeyStore metadata to logcat.
                    Log.w("SecureRelay", "testKey biometric authentication failed")
                    activity.runOnUiThread { call.resolve(JSObject().put("reachable", false)) }
                },
            )
        }
    }

    private fun executeTestKey(call: PluginCall, provider: String, activity: FragmentActivity) {
        try {
            val cipher = keyStore.getDecryptCipher(provider)
            val apiKey = keyStore.loadKey(provider, cipher)
            val metadata = keyStore.loadMetadata(provider) ?: run {
                activity.runOnUiThread { call.resolve(JSObject().put("reachable", false)) }
                return
            }

            val request = httpClient.buildRequest(
                provider = provider,
                baseUrl = metadata.baseUrl,
                apiKey = apiKey,
                model = metadata.defaultModel,
                messages = listOf(mapOf("role" to "user", "content" to "test")),
                systemPrompt = "Reply with 'ok'",
                maxTokens = 1,
                stream = false,
            )

            val okRequest = okhttp3.Request.Builder()
                .url(request.url)
                .post(request.body.toRequestBody("application/json".toMediaType()))
                .apply { request.headers.forEach { (k, v) -> addHeader(k, v) } }
                .build()

            val response = okhttp3.OkHttpClient().newCall(okRequest).execute()
            val reachable = response.code in 200..499
            response.close()

            activity.runOnUiThread {
                call.resolve(JSObject().put("reachable", reachable))
            }
        } catch (e: Exception) {
            // Log without the exception to avoid leaking KeyStore alias / cipher info to logcat.
            Log.w("SecureRelay", "testKey connectivity check failed")
            activity.runOnUiThread {
                call.resolve(JSObject().put("reachable", false))
            }
        }
    }

    // ── chatStream ───────────────────────────────────

    @PluginMethod
    fun chatStream(call: PluginCall) {
        val provider = call.getString("provider") ?: return call.reject("Missing: provider")
        val messagesArr = call.getArray("messages") ?: return call.reject("Missing: messages")
        val systemPrompt = call.getString("systemPrompt") ?: return call.reject("Missing: systemPrompt")
        val maxTokens = call.getInt("maxTokens") ?: policyEnforcer.policy.maxTokensPerRequest
        val streamId = UUID.randomUUID().toString()
        val activity = activity as? FragmentActivity ?: return call.reject("No activity")

        val messages = mutableListOf<Map<String, Any>>()
        for (i in 0 until messagesArr.length()) {
            val obj = messagesArr.getJSONObject(i)
            messages.add(mapOf("role" to obj.optString("role"), "content" to obj.optString("content")))
        }

        val autoApprove = policyEnforcer.policy.biometricAutoApproveSeconds

        val runStream = {
            Thread {
                executeChatStream(call, provider, messages, systemPrompt, maxTokens, streamId)
            }.start()
        }

        if (!biometric.needsAuth(autoApprove)) {
            runStream()
        } else {
            biometric.authenticateWithCallback(
                activity,
                "Authenticate to use AI provider",
                onSuccess = { runStream() },
                onError = { errMsg ->
                    activity.runOnUiThread { call.reject("Biometric failed: $errMsg") }
                },
            )
        }
    }

    private fun executeChatStream(
        call: PluginCall,
        provider: String,
        messages: List<Map<String, Any>>,
        systemPrompt: String,
        maxTokens: Int,
        streamId: String,
    ) {
        try {
            val cipher = keyStore.getDecryptCipher(provider)
            val apiKey = keyStore.loadKey(provider, cipher)
            val metadata = keyStore.loadMetadata(provider) ?: run {
                call.reject("Provider not found")
                return
            }

            // Policy: URL
            val urlCheck = policyEnforcer.validateBaseUrl(metadata.baseUrl)
            if (urlCheck is PolicyValidation.Rejected) {
                call.reject("Policy violation: ${urlCheck.reason}")
                return
            }

            // Policy: tokens
            val effectiveMaxTokens = minOf(maxTokens, policyEnforcer.policy.maxTokensPerRequest)

            // Policy: budget
            val estimatedCost = PolicyEnforcer.estimateCost(metadata.defaultModel, messages.size * 100, effectiveMaxTokens)
            if (policyEnforcer.checkDailyBudget(estimatedCost) is BudgetCheck.OverBudget) {
                call.reject("Daily cost budget exceeded")
                return
            }
            if (policyEnforcer.checkMonthlyBudget(estimatedCost) is BudgetCheck.OverBudget) {
                call.reject("Monthly cost budget exceeded")
                return
            }

            val request = httpClient.buildRequest(
                provider = provider,
                baseUrl = metadata.baseUrl,
                apiKey = apiKey,
                model = metadata.defaultModel,
                messages = messages,
                systemPrompt = systemPrompt,
                maxTokens = effectiveMaxTokens,
            )

            val isAnthropic = provider == "anthropic"

            // Return streamId immediately
            activity?.runOnUiThread {
                call.resolve(JSObject().put("streamId", streamId))
            }

            httpClient.startStreamingSession(
                request = request,
                isAnthropic = isAnthropic,
                streamId = streamId,
                eventHandler = { event -> emitStreamEvent(streamId, event) },
                completion = { policyEnforcer.recordCost(estimatedCost) },
            )
        } catch (e: Exception) {
            call.reject("Stream failed: ${e.message}")
        }
    }

    // ── cancelStream ─────────────────────────────────

    @PluginMethod
    fun cancelStream(call: PluginCall) {
        val streamId = call.getString("streamId") ?: return call.reject("Missing: streamId")
        httpClient.cancelStream(streamId)
        call.resolve()
    }

    // ── updatePolicy ─────────────────────────────────

    @PluginMethod
    fun updatePolicy(call: PluginCall) {
        val policyObj = call.getObject("policy") ?: return call.reject("Missing: policy")

        val allowlistArr = policyObj.optJSONArray("providerAllowlist") ?: JSONArray()
        val allowlist = (0 until allowlistArr.length()).mapNotNull { i ->
            val entry = allowlistArr.optJSONObject(i) ?: return@mapNotNull null
            AllowlistEntry(
                hostPattern = entry.optString("hostPattern"),
                httpsOnly = entry.optBoolean("httpsOnly", true),
            )
        }

        val newPolicy = RelayPolicyNative(
            schemaVersion = policyObj.optInt("schemaVersion", 1),
            providerAllowlist = allowlist.ifEmpty { RelayPolicyNative.defaultPolicy.providerAllowlist },
            maxTokensPerRequest = policyObj.optInt("maxTokensPerRequest", 4096),
            dailyCostLimitMicrounits = policyObj.optLong("dailyCostLimitMicrounits", 5_000_000),
            monthlyCostLimitMicrounits = policyObj.optLong("monthlyCostLimitMicrounits", 50_000_000),
            monthlyWarningThresholdPct = policyObj.optInt("monthlyWarningThresholdPct", 80),
            highCostThresholdMicrounits = policyObj.optLong("highCostThresholdMicrounits", 500_000),
            biometricAutoApproveSeconds = policyObj.optInt(
                "biometricAutoApproveSeconds",
                RelayPolicyNative.defaultPolicy.biometricAutoApproveSeconds,
            ),
            blockPrivateIps = true,
        )

        policyEnforcer.updatePolicy(newPolicy)
        call.resolve()
    }

    // ── getPolicy ────────────────────────────────────

    @PluginMethod
    fun getPolicy(call: PluginCall) {
        val p = policyEnforcer.policy
        val allowlist = JSONArray()
        for (entry in p.providerAllowlist) {
            allowlist.put(JSONObject().put("hostPattern", entry.hostPattern).put("httpsOnly", entry.httpsOnly))
        }

        val result = JSObject()
        result.put("policy", JSONObject().apply {
            put("schemaVersion", p.schemaVersion)
            put("providerAllowlist", allowlist)
            put("maxTokensPerRequest", p.maxTokensPerRequest)
            put("dailyCostLimitMicrounits", p.dailyCostLimitMicrounits)
            put("monthlyCostLimitMicrounits", p.monthlyCostLimitMicrounits)
            put("monthlyWarningThresholdPct", p.monthlyWarningThresholdPct)
            put("highCostThresholdMicrounits", p.highCostThresholdMicrounits)
            put("biometricAutoApproveSeconds", p.biometricAutoApproveSeconds)
            put("blockPrivateIps", p.blockPrivateIps)
        })
        call.resolve(result)
    }

    // ── checkBiometricAvailability ────────────────────

    @PluginMethod
    fun checkBiometricAvailability(call: PluginCall) {
        val availability = biometric.checkAvailability(context)
        call.resolve(JSObject().apply {
            put("available", availability.available)
            put("biometryType", availability.biometryType)
        })
    }

    // ── setScreenSecure ──────────────────────────────

    /**
     * Toggle WindowManager.LayoutParams.FLAG_SECURE on the host activity.
     * Screenshots and screen-recording of the app window are replaced with
     * a black frame while enabled, which the API-key entry screen uses to
     * prevent shoulder-surf-via-screen-share leaks. Always runs on the UI
     * thread because window flag changes require the main looper.
     */
    @PluginMethod
    fun setScreenSecure(call: PluginCall) {
        val enabled = call.getBoolean("enabled") ?: true
        val activity = activity as? FragmentActivity ?: return call.reject("No activity")
        activity.runOnUiThread {
            if (enabled) {
                activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            } else {
                activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            }
            call.resolve()
        }
    }

    // ── Phone Wallet Relay (ADR-005) ─────────────────

    @PluginMethod
    fun acceptPairing(call: PluginCall) {
        val pairingToken = call.getString("pairingToken") ?: return call.reject("Missing: pairingToken")
        val relayUrl = call.getString("relayUrl") ?: return call.reject("Missing: relayUrl")
        val peerPublicKey = call.getString("peerPublicKey") ?: return call.reject("Missing: peerPublicKey")

        Thread {
            try {
                val (sessionId, localPublicKey, shortCode) = relayHandler.acceptPairing(pairingToken, relayUrl, peerPublicKey)
                activity?.runOnUiThread {
                    call.resolve(JSObject().apply {
                        put("sessionId", sessionId)
                        put("localPublicKey", localPublicKey)
                        put("shortCode", shortCode)
                    })
                }
            } catch (e: Exception) {
                activity?.runOnUiThread {
                    call.reject("Pairing failed: ${e.message}")
                }
            }
        }.start()
    }

    @PluginMethod
    fun disconnectRelay(call: PluginCall) {
        relayHandler.disconnect()
        call.resolve()
    }

    @PluginMethod
    fun getRelayStatus(call: PluginCall) {
        val info = relayHandler.statusInfo
        val result = JSObject()
        info.forEach { (k, v) -> result.put(k, v) }
        call.resolve(result)
    }

    // ── Event Helpers ────────────────────────────────

    private fun emitStreamEvent(streamId: String, event: SSEEvent) {
        val data = JSObject().apply { put("streamId", streamId) }
        when (event) {
            is SSEEvent.Delta -> {
                data.put("text", event.text)
                notifyListeners("secureRelayDelta", data)
            }
            is SSEEvent.Card -> {
                data.put("card", JSONObject(event.card))
                notifyListeners("secureRelayCard", data)
            }
            is SSEEvent.Done -> {
                event.usage?.let { u ->
                    data.put("usage", JSONObject().put("promptTokens", u.promptTokens).put("completionTokens", u.completionTokens))
                }
                notifyListeners("secureRelayDone", data)
            }
            is SSEEvent.Error -> {
                data.put("error", event.message)
                notifyListeners("secureRelayError", data)
            }
        }
    }
}
