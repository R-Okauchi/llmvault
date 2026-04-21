import Capacitor
import Foundation
import WebKit

/// Capacitor plugin that manages LLM API keys in iOS Keychain
/// and makes direct HTTPS calls to LLM providers.
/// Keys never cross back to the JS bridge after registerKey().
@objc(SecureRelayPlugin)
public class SecureRelayPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "SecureRelayPlugin"
    public let jsName = "SecureRelay"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "registerKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listProviders", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "testKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "chatStream", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelStream", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updatePolicy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPolicy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkBiometricAvailability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setScreenSecure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "acceptPairing", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnectRelay", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getRelayStatus", returnType: CAPPluginReturnPromise),
    ]

    private let keychain = KeychainManager.shared
    private let biometric = BiometricAuth.shared
    private let httpClient = LLMHttpClient()
    private let policyEnforcer = PolicyEnforcer.shared
    private lazy var relayHandler: RelaySessionHandler = {
        let handler = RelaySessionHandler(
            keychain: keychain,
            biometric: biometric,
            httpClient: LLMHttpClient(),
            policyEnforcer: policyEnforcer
        )
        handler.onStateChange = { [weak self] state in
            // State changes are tracked internally; no separate event needed
        }
        handler.onRequestReceived = { [weak self] provider, requestId, messageCount in
            self?.notifyListeners("relayRequestReceived", data: [
                "sessionId": handler.sessionId ?? "",
                "requestId": requestId,
                "provider": provider,
                "messageCount": messageCount,
            ])
        }
        handler.onError = { [weak self] message in
            // Log without sensitive data
            print("[SecureRelay] Relay error occurred")
        }
        handler.onDisconnect = { [weak self] sessionId in
            self?.notifyListeners("relayDisconnected", data: [
                "sessionId": sessionId,
                "reason": "disconnected",
            ])
        }
        return handler
    }()

    // MARK: - registerKey

    @objc func registerKey(_ call: CAPPluginCall) {
        guard let provider = call.getString("provider"),
              let apiKey = call.getString("apiKey"),
              let baseUrl = call.getString("baseUrl"),
              let defaultModel = call.getString("defaultModel") else {
            call.reject("Missing required parameters: provider, apiKey, baseUrl, defaultModel")
            return
        }

        // Validate URL against policy
        let validation = policyEnforcer.validateBaseUrl(baseUrl)
        if case .rejected(let reason) = validation {
            call.reject("URL rejected: \(reason)")
            return
        }

        let label = call.getString("label")

        do {
            // Store key in Keychain (biometric-gated)
            try keychain.saveKey(provider: provider, apiKey: apiKey)

            // Store metadata separately (no biometric needed for listing)
            let keyHint = String(apiKey.suffix(4))
            let now = Int(Date().timeIntervalSince1970)
            let metadata = ProviderMetadata(
                provider: provider,
                baseUrl: baseUrl,
                defaultModel: defaultModel,
                keyHint: keyHint,
                label: label,
                createdAt: now,
                updatedAt: now
            )
            try keychain.saveMetadata(provider: provider, metadata: metadata)

            call.resolve()
        } catch {
            call.reject("Failed to store key: \(error.localizedDescription)")
        }
    }

    // MARK: - deleteKey

    @objc func deleteKey(_ call: CAPPluginCall) {
        guard let provider = call.getString("provider") else {
            call.reject("Missing required parameter: provider")
            return
        }

        do {
            try keychain.deleteKey(provider: provider)
            try keychain.deleteMetadata(provider: provider)
            call.resolve()
        } catch {
            call.reject("Failed to delete key: \(error.localizedDescription)")
        }
    }

    // MARK: - listProviders

    @objc func listProviders(_ call: CAPPluginCall) {
        do {
            let metadataList = try keychain.loadAllMetadata()
            let providers = metadataList.map { meta -> [String: Any] in
                var dict: [String: Any] = [
                    "provider": meta.provider,
                    "baseUrl": meta.baseUrl,
                    "defaultModel": meta.defaultModel,
                    "createdAt": meta.createdAt,
                    "updatedAt": meta.updatedAt,
                ]
                dict["keyHint"] = meta.keyHint as Any
                dict["label"] = meta.label as Any
                return dict
            }
            call.resolve(["providers": providers])
        } catch {
            call.reject("Failed to list providers: \(error.localizedDescription)")
        }
    }

    // MARK: - testKey

    @objc func testKey(_ call: CAPPluginCall) {
        guard let provider = call.getString("provider") else {
            call.reject("Missing required parameter: provider")
            return
        }

        Task {
            do {
                let context = try await biometric.authenticate(
                    reason: "Authenticate to test AI provider connectivity"
                )
                let apiKey = try keychain.loadKey(provider: provider, context: context)
                guard let metadata = try keychain.loadMetadata(provider: provider) else {
                    call.reject("Provider not found")
                    return
                }

                // Make a lightweight request to verify connectivity
                let request = try httpClient.buildRequest(
                    provider: provider,
                    baseUrl: metadata.baseUrl,
                    apiKey: apiKey,
                    model: metadata.defaultModel,
                    messages: [["role": "user", "content": "test"]],
                    systemPrompt: "Reply with 'ok'",
                    maxTokens: 1,
                    stream: false
                )

                var urlRequest = URLRequest(url: request.url)
                urlRequest.httpMethod = "POST"
                urlRequest.httpBody = request.body
                for (key, value) in request.headers {
                    urlRequest.setValue(value, forHTTPHeaderField: key)
                }

                let (_, response) = try await URLSession.shared.data(for: urlRequest)
                let httpResponse = response as? HTTPURLResponse
                let reachable = httpResponse != nil &&
                    httpResponse!.statusCode >= 200 && httpResponse!.statusCode < 500

                call.resolve(["reachable": reachable])
            } catch {
                call.resolve(["reachable": false])
            }
        }
    }

    // MARK: - chatStream

    @objc func chatStream(_ call: CAPPluginCall) {
        guard let provider = call.getString("provider"),
              let messages = call.getArray("messages") as? [[String: Any]],
              let systemPrompt = call.getString("systemPrompt") else {
            call.reject("Missing required parameters: provider, messages, systemPrompt")
            return
        }

        let maxTokens = call.getInt("maxTokens") ?? policyEnforcer.policy.maxTokensPerRequest
        let streamId = UUID().uuidString

        Task {
            do {
                // Biometric authentication
                let context = try await biometric.getAuthenticatedContext(
                    reason: "Authenticate to use AI provider",
                    autoApproveSeconds: policyEnforcer.policy.biometricAutoApproveSeconds
                )

                // Load key from Keychain
                let apiKey = try keychain.loadKey(provider: provider, context: context)
                guard let metadata = try keychain.loadMetadata(provider: provider) else {
                    call.reject("Provider not found")
                    return
                }

                // Policy check: URL
                let urlCheck = policyEnforcer.validateBaseUrl(metadata.baseUrl)
                if case .rejected(let reason) = urlCheck {
                    call.reject("Policy violation: \(reason)")
                    return
                }

                // Policy check: token limit
                let effectiveMaxTokens = min(maxTokens, policyEnforcer.policy.maxTokensPerRequest)

                // Policy check: budget
                let estimatedCost = PolicyEnforcer.estimateCost(
                    model: metadata.defaultModel,
                    promptTokens: messages.count * 100, // rough estimate
                    maxCompletionTokens: effectiveMaxTokens
                )

                let dailyCheck = policyEnforcer.checkDailyBudget(estimatedCost: estimatedCost)
                if case .overBudget = dailyCheck {
                    call.reject("Daily cost budget exceeded")
                    return
                }

                let monthlyCheck = policyEnforcer.checkMonthlyBudget(estimatedCost: estimatedCost)
                if case .overBudget = monthlyCheck {
                    call.reject("Monthly cost budget exceeded")
                    return
                }

                // Build the request
                let request = try httpClient.buildRequest(
                    provider: provider,
                    baseUrl: metadata.baseUrl,
                    apiKey: apiKey,
                    model: metadata.defaultModel,
                    messages: messages,
                    systemPrompt: systemPrompt,
                    maxTokens: effectiveMaxTokens
                )

                let isAnthropic = provider == "anthropic"

                // Return streamId immediately, then start streaming
                call.resolve(["streamId": streamId])

                // Start streaming with SSE delegate for incremental events
                httpClient.startStreamingSession(
                    request: request,
                    isAnthropic: isAnthropic,
                    streamId: streamId,
                    eventHandler: { [weak self] event in
                        self?.emitStreamEvent(streamId: streamId, event: event)
                    },
                    completion: { [weak self] error in
                        if error != nil {
                            // Log without sensitive data
                            print("[SecureRelay] Stream \(streamId) completed with error")
                        }
                        // Record estimated cost
                        self?.policyEnforcer.recordCost(estimatedCost)
                    }
                )

            } catch {
                call.reject("Stream failed: \(error.localizedDescription)")
            }
        }
    }

    // MARK: - cancelStream

    @objc func cancelStream(_ call: CAPPluginCall) {
        guard let streamId = call.getString("streamId") else {
            call.reject("Missing required parameter: streamId")
            return
        }
        httpClient.cancelStream(streamId: streamId)
        call.resolve()
    }

    // MARK: - updatePolicy

    @objc func updatePolicy(_ call: CAPPluginCall) {
        guard let policyObj = call.getObject("policy") else {
            call.reject("Missing required parameter: policy")
            return
        }

        let allowlistRaw = policyObj["providerAllowlist"] as? [[String: Any]] ?? []
        let allowlist = allowlistRaw.compactMap { entry -> RelayPolicyNative.AllowlistEntry? in
            guard let host = entry["hostPattern"] as? String else { return nil }
            return RelayPolicyNative.AllowlistEntry(
                hostPattern: host,
                httpsOnly: entry["httpsOnly"] as? Bool ?? true
            )
        }

        let newPolicy = RelayPolicyNative(
            schemaVersion: policyObj["schemaVersion"] as? Int ?? 1,
            providerAllowlist: allowlist.isEmpty ? RelayPolicyNative.defaultPolicy.providerAllowlist : allowlist,
            maxTokensPerRequest: policyObj["maxTokensPerRequest"] as? Int ?? 4096,
            dailyCostLimitMicrounits: Int64(policyObj["dailyCostLimitMicrounits"] as? Int ?? 5_000_000),
            monthlyCostLimitMicrounits: Int64(policyObj["monthlyCostLimitMicrounits"] as? Int ?? 50_000_000),
            monthlyWarningThresholdPct: policyObj["monthlyWarningThresholdPct"] as? Int ?? 80,
            highCostThresholdMicrounits: Int64(policyObj["highCostThresholdMicrounits"] as? Int ?? 500_000),
            biometricAutoApproveSeconds: policyObj["biometricAutoApproveSeconds"] as? Int ?? 3600,
            blockPrivateIps: true
        )

        policyEnforcer.updatePolicy(newPolicy)
        call.resolve()
    }

    // MARK: - getPolicy

    @objc func getPolicy(_ call: CAPPluginCall) {
        let p = policyEnforcer.policy
        let allowlist = p.providerAllowlist.map { entry -> [String: Any] in
            ["hostPattern": entry.hostPattern, "httpsOnly": entry.httpsOnly]
        }
        call.resolve([
            "policy": [
                "schemaVersion": p.schemaVersion,
                "providerAllowlist": allowlist,
                "maxTokensPerRequest": p.maxTokensPerRequest,
                "dailyCostLimitMicrounits": p.dailyCostLimitMicrounits,
                "monthlyCostLimitMicrounits": p.monthlyCostLimitMicrounits,
                "monthlyWarningThresholdPct": p.monthlyWarningThresholdPct,
                "highCostThresholdMicrounits": p.highCostThresholdMicrounits,
                "biometricAutoApproveSeconds": p.biometricAutoApproveSeconds,
                "blockPrivateIps": p.blockPrivateIps,
            ]
        ])
    }

    // MARK: - checkBiometricAvailability

    @objc func checkBiometricAvailability(_ call: CAPPluginCall) {
        let availability = biometric.checkAvailability()
        call.resolve([
            "available": availability.available,
            "biometryType": availability.biometryType,
        ])
    }

    // MARK: - setScreenSecure

    /// iOS no-op. Kept so the JS side can call the same API on every
    /// platform; the Android plugin applies FLAG_SECURE to the window.
    /// iOS does not expose an equivalent block for WKWebView content.
    @objc func setScreenSecure(_ call: CAPPluginCall) {
        _ = call.getBool("enabled") ?? true
        call.resolve()
    }

    // MARK: - Phone Wallet Relay (ADR-005)

    @objc func acceptPairing(_ call: CAPPluginCall) {
        guard let pairingToken = call.getString("pairingToken"),
              let relayUrl = call.getString("relayUrl"),
              let peerPublicKey = call.getString("peerPublicKey") else {
            call.reject("Missing required parameters: pairingToken, relayUrl, peerPublicKey")
            return
        }

        Task {
            do {
                let result = try await relayHandler.acceptPairing(
                    pairingToken: pairingToken,
                    relayUrl: relayUrl,
                    peerPublicKey: peerPublicKey
                )
                call.resolve([
                    "sessionId": result.sessionId,
                    "localPublicKey": result.localPublicKey,
                    "shortCode": result.shortCode,
                ])
            } catch {
                call.reject("Pairing failed: \(error.localizedDescription)")
            }
        }
    }

    @objc func disconnectRelay(_ call: CAPPluginCall) {
        relayHandler.disconnect()
        call.resolve()
    }

    @objc func getRelayStatus(_ call: CAPPluginCall) {
        call.resolve(relayHandler.statusInfo)
    }

    // MARK: - Lifecycle

    /// Reset biometric auth window when app goes to background.
    /// Next AI request after returning will require Face ID again.
    public override func load() {
        // Apply downstream Capacitor config overrides (see apps/mobile/capacitor.config.ts).
        // Must run before any Keychain / RelaySessionHandler access.
        if let service = getConfig().getString("keychainService"), !service.isEmpty {
            LlmvaultMobileConfig.shared.keychainService = service
        }
        if let label = getConfig().getString("pairingProtocolLabel"), !label.isEmpty {
            LlmvaultMobileConfig.shared.pairingProtocolLabel = label
        }

        // Lock down Safari Web Inspector for release builds. Keeping the
        // WebView inspectable in shipped builds would let anyone with USB
        // access snapshot bridge traffic (including registerKey payloads)
        // via a paired Mac. Capacitor may still be wiring up the webView
        // reference during load(), so we defer to the next runloop tick
        // and also re-apply when the app foregrounds — both paths are
        // idempotent and cheap.
        applyInspectableLockdown()
        DispatchQueue.main.async { [weak self] in
            self?.applyInspectableLockdown()
        }

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidEnterBackground),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
    }

    @objc private func appDidBecomeActive() {
        applyInspectableLockdown()
    }

    private func applyInspectableLockdown() {
        #if DEBUG
        // ⚠️ DEBUG builds leave the WebView inspectable via Safari Web Inspector.
        // This exposes registerKey bridge payloads (including API key values) to
        // anyone with USB access to the device.  Never distribute DEBUG builds
        // outside the development team (e.g. via TestFlight or Ad-hoc).
        #else
        if #available(iOS 16.4, *) {
            if let webView = self.bridge?.webView {
                webView.isInspectable = false
            }
        }
        #endif
    }

    @objc private func appDidEnterBackground() {
        biometric.resetAuthWindow()
    }

    // MARK: - Event Emission Helpers

    /// Emit stream events matching nativeRelay.ts listener expectations.
    private func emitStreamEvent(streamId: String, event: SSEEvent) {
        switch event {
        case .delta(let text):
            notifyListeners("secureRelayDelta", data: [
                "streamId": streamId,
                "text": text,
            ])
        case .card(let card):
            notifyListeners("secureRelayCard", data: [
                "streamId": streamId,
                "card": card,
            ])
        case .done(let usage):
            var data: [String: Any] = ["streamId": streamId]
            if let u = usage {
                data["usage"] = [
                    "promptTokens": u.promptTokens,
                    "completionTokens": u.completionTokens,
                ]
            }
            notifyListeners("secureRelayDone", data: data)
        case .error(let message):
            notifyListeners("secureRelayError", data: [
                "streamId": streamId,
                "error": message,
            ])
        }
    }
}
