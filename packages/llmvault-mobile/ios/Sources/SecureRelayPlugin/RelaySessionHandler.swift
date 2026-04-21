import Foundation
import CryptoKit

/// Manages the mobile side of a Phone Wallet Relay session (ADR-005).
///
/// Handles ECDH P-256 key exchange, AES-GCM-256 encryption, WebSocket lifecycle,
/// and AI request processing via the local LLM wallet (Keychain + native HTTPS).
///
/// Protocol (matching relayCrypto.ts):
///   1. Generate ephemeral ECDH P-256 key pair
///   2. Derive shared secret via ECDH → HKDF-SHA-256 → AES-GCM-256
///   3. All messages encrypted with AES-GCM using random 12-byte IVs
final class RelaySessionHandler: NSObject {

    // MARK: - State Machine

    enum State: String {
        case idle, connecting, keyExchanging, verifying, active, disconnected
    }

    private(set) var state: State = .idle
    private(set) var sessionId: String?
    private(set) var shortCode: String?
    private(set) var connectedAt: Date?

    // MARK: - Crypto State

    private var privateKey: P256.KeyAgreement.PrivateKey?
    private var localPublicKeyBase64: String?
    private var peerPublicKeyBase64: String?
    private var sessionKey: SymmetricKey?
    private var sequenceCounter = 0

    // MARK: - WebSocket

    private var webSocketTask: URLSessionWebSocketTask?
    private var urlSession: URLSession?
    private var heartbeatTimer: DispatchSourceTimer?

    // MARK: - Dependencies

    private let keychain: KeychainManager
    private let biometric: BiometricAuth
    private let httpClient: LLMHttpClient
    private let policyEnforcer: PolicyEnforcer

    // MARK: - Callbacks (plugin wires these to notifyListeners)

    var onStateChange: ((State) -> Void)?
    /// (provider, messageCount) — for local notification display
    var onRequestReceived: ((String, String, Int) -> Void)?
    var onError: ((String) -> Void)?
    var onDisconnect: ((String) -> Void)?

    // MARK: - Constants (must match the PC-side HKDF info in relayCrypto.ts)

    private static var hkdfInfo: Data {
        LlmvaultMobileConfig.shared.pairingProtocolLabel.data(using: .utf8)!
    }

    // MARK: - Init

    init(
        keychain: KeychainManager = .shared,
        biometric: BiometricAuth = .shared,
        httpClient: LLMHttpClient = LLMHttpClient(),
        policyEnforcer: PolicyEnforcer = .shared
    ) {
        self.keychain = keychain
        self.biometric = biometric
        self.httpClient = httpClient
        self.policyEnforcer = policyEnforcer
        super.init()
    }

    // MARK: - Accept Pairing

    /// Accept a QR pairing request from a PC browser.
    /// Generates ECDH keys, derives shared secret, connects to relay WebSocket,
    /// and returns the session info with short verification code.
    func acceptPairing(
        pairingToken: String,
        relayUrl: String,
        peerPublicKey pcPublicKeyBase64: String
    ) async throws -> (sessionId: String, localPublicKey: String, shortCode: String) {
        guard state == .idle || state == .disconnected else {
            throw RelayError.invalidState("Cannot accept pairing in state: \(state.rawValue)")
        }

        // Extract sessionId from relayUrl query string
        guard let urlComponents = URLComponents(string: relayUrl),
              let sessionParam = urlComponents.queryItems?.first(where: { $0.name == "session" }),
              let extractedSessionId = sessionParam.value else {
            throw RelayError.invalidQrPayload
        }
        self.sessionId = extractedSessionId
        setState(.connecting)

        // ── ECDH Key Pair Generation ──
        let privKey = P256.KeyAgreement.PrivateKey()
        self.privateKey = privKey
        // x963Representation = 0x04 || x || y (65 bytes), matches Web Crypto "raw" export
        let localPubB64 = base64urlEncode(Data(privKey.publicKey.x963Representation))
        self.localPublicKeyBase64 = localPubB64
        self.peerPublicKeyBase64 = pcPublicKeyBase64

        // ── Derive Session Key ──
        let pcPublicKeyData = base64urlDecode(pcPublicKeyBase64)
        let pcPublicKey = try P256.KeyAgreement.PublicKey(x963Representation: pcPublicKeyData)
        let sharedSecret = try privKey.sharedSecretFromKeyAgreement(with: pcPublicKey)

        // Salt = SHA-256(sort([localPub, peerPub]).join(""))
        let salt = computeSalt(key1: localPubB64, key2: pcPublicKeyBase64)

        self.sessionKey = sharedSecret.hkdfDerivedSymmetricKey(
            using: SHA256.self,
            salt: salt,
            sharedInfo: Self.hkdfInfo,
            outputByteCount: 32
        )

        // ── Short Verification Code ──
        let code = computeShortCode(key1: localPubB64, key2: pcPublicKeyBase64)
        self.shortCode = code

        setState(.keyExchanging)

        // ── Connect WebSocket ──
        let encodedToken = pairingToken.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? pairingToken
        let wsUrlString = "\(relayUrl)&role=mobile&token=\(encodedToken)"
        guard let wsUrl = URL(string: wsUrlString) else {
            throw RelayError.invalidQrPayload
        }

        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        self.urlSession = URLSession(configuration: config)
        self.webSocketTask = urlSession!.webSocketTask(with: wsUrl)
        webSocketTask!.resume()

        // Start background receive loop
        startReceiveLoop()

        // ── Send Our Public Key ──
        // Server will forward this to PC and compute shortCode
        let keyExchangeMsg: [String: Any] = [
            "type": "keyExchange",
            "sessionId": extractedSessionId,
            "mobilePublicKey": localPubB64,
        ]
        try await sendJson(keyExchangeMsg)

        setState(.verifying)

        return (extractedSessionId, localPubB64, code)
    }

    // MARK: - Disconnect

    func disconnect() {
        guard state != .idle && state != .disconnected else { return }

        if let ws = webSocketTask {
            // Best-effort: send disconnect message
            let msg: [String: Any] = [
                "type": "disconnect",
                "sessionId": sessionId ?? "",
                "reason": "user_request",
            ]
            if let data = try? JSONSerialization.data(withJSONObject: msg),
               let str = String(data: data, encoding: .utf8) {
                ws.send(.string(str)) { _ in }
            }
            ws.cancel(with: .normalClosure, reason: nil)
        }

        let sid = sessionId ?? ""
        cleanup()
        setState(.disconnected)
        onDisconnect?(sid)
    }

    // MARK: - Status

    var isConnected: Bool { state == .active }

    var statusInfo: [String: Any] {
        var info: [String: Any] = [
            "connected": state == .active,
            "state": state.rawValue,
        ]
        if let sid = sessionId {
            info["sessionId"] = sid
        }
        if let connectedAt = connectedAt {
            let elapsed = Date().timeIntervalSince(connectedAt)
            let remaining = max(0, 30 * 60 - elapsed)
            info["idleTimeoutSec"] = Int(remaining)
        } else {
            info["idleTimeoutSec"] = 0
        }
        return info
    }

    // MARK: - WebSocket Receive Loop

    private func startReceiveLoop() {
        webSocketTask?.receive { [weak self] result in
            guard let self = self, self.state != .disconnected else { return }

            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self.handleMessage(text)
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8) {
                        self.handleMessage(text)
                    }
                @unknown default:
                    break
                }
                // Continue receiving
                self.startReceiveLoop()

            case .failure:
                if self.state != .disconnected {
                    let sid = self.sessionId ?? ""
                    self.cleanup()
                    self.setState(.disconnected)
                    self.onDisconnect?(sid)
                }
            }
        }
    }

    private func handleMessage(_ text: String) {
        guard let data = text.data(using: .utf8),
              let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = msg["type"] as? String else {
            return
        }

        switch type {
        case "keyExchange":
            // Server forwards pcPublicKey on connect — we already have it from QR
            if let sid = msg["sessionId"] as? String, sessionId == nil {
                sessionId = sid
            }

        case "paired":
            // Server confirms pairing — short code should match our computed one
            if let serverShortCode = msg["shortCode"] as? String {
                shortCode = serverShortCode
            }
            setState(.active)
            connectedAt = Date()
            startHeartbeat()

        case "encrypted":
            Task { [weak self] in
                await self?.handleEncryptedMessage(msg)
            }

        case "ping":
            sendPong()

        case "pong":
            break

        case "disconnect":
            let reason = msg["reason"] as? String ?? "unknown"
            let sid = sessionId ?? ""
            cleanup()
            setState(.disconnected)
            onDisconnect?(sid)
            onError?("Disconnected: \(reason)")

        case "error":
            let errorMsg = msg["message"] as? String ?? "Unknown relay error"
            onError?(errorMsg)

        default:
            break
        }
    }

    // MARK: - Process Encrypted AI Request

    private func handleEncryptedMessage(_ envelope: [String: Any]) async {
        guard let key = sessionKey,
              let ciphertextBase64 = envelope["ciphertextBase64"] as? String,
              let ivBase64 = envelope["ivBase64"] as? String,
              let requestId = envelope["requestId"] as? String else {
            return
        }

        // ── Decrypt ──
        let plaintext: String
        do {
            let aad = buildAAD(requestId: requestId)
            plaintext = try decryptMessage(ciphertextBase64: ciphertextBase64, ivBase64: ivBase64, key: key, aad: aad)
        } catch {
            await sendEncryptedResponse(requestId: requestId, response: [
                "type": "error", "error": "Decryption failed",
            ])
            return
        }

        // ── Parse Inner Request ──
        guard let reqData = plaintext.data(using: .utf8),
              let request = try? JSONSerialization.jsonObject(with: reqData) as? [String: Any],
              (request["type"] as? String) == "chatRequest",
              let provider = request["provider"] as? String,
              let messages = request["messages"] as? [[String: Any]],
              let systemPrompt = request["systemPrompt"] as? String else {
            await sendEncryptedResponse(requestId: requestId, response: [
                "type": "error", "error": "Invalid request format",
            ])
            return
        }

        let maxTokens = request["maxTokens"] as? Int ?? 4096

        // ── Resolve Provider ──
        let resolvedProvider: String
        if provider == "auto" {
            // Pick the first registered provider
            if let allMeta = try? keychain.loadAllMetadata(), let first = allMeta.first {
                resolvedProvider = first.provider
            } else {
                await sendEncryptedResponse(requestId: requestId, response: [
                    "type": "error", "error": "No providers registered on this device",
                ])
                return
            }
        } else {
            resolvedProvider = provider
        }

        // ── Notify (for local notification) ──
        onRequestReceived?(resolvedProvider, requestId, messages.count)

        // ── Process ──
        await processAiRequest(
            requestId: requestId,
            provider: resolvedProvider,
            messages: messages,
            systemPrompt: systemPrompt,
            maxTokens: maxTokens
        )
    }

    private func processAiRequest(
        requestId: String,
        provider: String,
        messages: [[String: Any]],
        systemPrompt: String,
        maxTokens: Int
    ) async {
        do {
            // Biometric authentication
            let context = try await biometric.getAuthenticatedContext(
                reason: "AI リクエストを処理するために認証が必要です",
                autoApproveSeconds: policyEnforcer.policy.biometricAutoApproveSeconds
            )

            // Load key from Keychain
            let apiKey = try keychain.loadKey(provider: provider, context: context)
            guard let metadata = try keychain.loadMetadata(provider: provider) else {
                await sendEncryptedResponse(requestId: requestId, response: [
                    "type": "error", "error": "Provider not registered: \(provider)",
                ])
                return
            }

            // Policy: URL
            let urlCheck = policyEnforcer.validateBaseUrl(metadata.baseUrl)
            if case .rejected(let reason) = urlCheck {
                await sendEncryptedResponse(requestId: requestId, response: [
                    "type": "error", "error": "Policy violation: \(reason)",
                ])
                return
            }

            // Policy: tokens
            let effectiveMaxTokens = min(maxTokens, policyEnforcer.policy.maxTokensPerRequest)

            // Policy: budget
            let estimatedCost = PolicyEnforcer.estimateCost(
                model: metadata.defaultModel,
                promptTokens: messages.count * 100,
                maxCompletionTokens: effectiveMaxTokens
            )
            if case .overBudget = policyEnforcer.checkDailyBudget(estimatedCost: estimatedCost) {
                await sendEncryptedResponse(requestId: requestId, response: [
                    "type": "error", "error": "Daily cost budget exceeded",
                ])
                return
            }

            // Build LLM request
            let llmRequest = try httpClient.buildRequest(
                provider: provider,
                baseUrl: metadata.baseUrl,
                apiKey: apiKey,
                model: metadata.defaultModel,
                messages: messages,
                systemPrompt: systemPrompt,
                maxTokens: effectiveMaxTokens
            )

            let isAnthropic = provider == "anthropic"
            let streamId = UUID().uuidString

            // Stream with SSE → encrypt each event → relay back to PC
            httpClient.startStreamingSession(
                request: llmRequest,
                isAnthropic: isAnthropic,
                streamId: streamId,
                eventHandler: { [weak self] event in
                    guard let self = self else { return }
                    Task {
                        await self.forwardStreamEvent(requestId: requestId, event: event)
                    }
                },
                completion: { [weak self] _ in
                    self?.policyEnforcer.recordCost(estimatedCost)
                }
            )

        } catch {
            await sendEncryptedResponse(requestId: requestId, response: [
                "type": "error", "error": "Authentication or key access failed",
            ])
        }
    }

    /// Convert an SSE event to a RelayInnerResponse, encrypt, and send.
    private func forwardStreamEvent(requestId: String, event: SSEEvent) async {
        let response: [String: Any]
        switch event {
        case .delta(let text):
            response = ["type": "delta", "text": text]
        case .card(let card):
            response = ["type": "card", "card": card]
        case .done(let usage):
            var resp: [String: Any] = ["type": "done"]
            if let u = usage {
                resp["usage"] = [
                    "promptTokens": u.promptTokens,
                    "completionTokens": u.completionTokens,
                ]
            }
            response = resp
        case .error(let message):
            response = ["type": "error", "error": message]
        }

        await sendEncryptedResponse(requestId: requestId, response: response)
    }

    // MARK: - Encrypted Send

    private func sendEncryptedResponse(requestId: String, response: [String: Any]) async {
        guard let key = sessionKey else { return }

        do {
            let jsonData = try JSONSerialization.data(withJSONObject: response)
            let plaintext = String(data: jsonData, encoding: .utf8) ?? ""
            let aad = buildAAD(requestId: requestId)
            let (ciphertextBase64, ivBase64) = try encryptMessage(plaintext: plaintext, key: key, aad: aad)

            let envelope: [String: Any] = [
                "type": "encrypted",
                "sessionId": sessionId ?? "",
                "requestId": requestId,
                "ciphertextBase64": ciphertextBase64,
                "ivBase64": ivBase64,
                "sequence": sequenceCounter,
            ]
            sequenceCounter += 1

            try await sendJson(envelope)
        } catch {
            // Cannot relay this error since encryption itself failed
            print("[SecureRelay] Failed to encrypt/send relay response")
        }
    }

    // MARK: - AES-GCM Encryption (matches relayCrypto.ts)

    /// Build AAD string matching the TS/Android convention: `"sessionId:requestId"`.
    private func buildAAD(requestId: String) -> Data {
        Data("\(sessionId ?? ""):\(requestId)".utf8)
    }

    private func encryptMessage(plaintext: String, key: SymmetricKey, aad: Data) throws -> (String, String) {
        let data = Data(plaintext.utf8)
        let sealedBox = try AES.GCM.seal(data, using: key, authenticating: aad)

        // Web Crypto AES-GCM encrypt returns ciphertext || tag (16 bytes)
        let combined = sealedBox.ciphertext + sealedBox.tag
        return (base64urlEncode(combined), base64urlEncode(Data(sealedBox.nonce)))
    }

    private func decryptMessage(ciphertextBase64: String, ivBase64: String, key: SymmetricKey, aad: Data) throws -> String {
        let ciphertextAndTag = base64urlDecode(ciphertextBase64)
        let iv = base64urlDecode(ivBase64)

        let nonce = try AES.GCM.Nonce(data: iv)
        let tagSize = 16
        guard ciphertextAndTag.count > tagSize else {
            throw RelayError.decryptionFailed
        }

        let ciphertextEnd = ciphertextAndTag.count - tagSize
        let ciphertext = ciphertextAndTag[0..<ciphertextEnd]
        let tag = ciphertextAndTag[ciphertextEnd...]

        let sealedBox = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
        let decrypted = try AES.GCM.open(sealedBox, using: key, authenticating: aad)

        guard let result = String(data: decrypted, encoding: .utf8) else {
            throw RelayError.decryptionFailed
        }
        return result
    }

    // MARK: - HKDF Salt & Short Code (matches relayCrypto.ts)

    /// Salt = SHA-256(sort([key1, key2]).join(""))
    private func computeSalt(key1: String, key2: String) -> Data {
        let sorted = [key1, key2].sorted().joined()
        let hash = SHA256.hash(data: Data(sorted.utf8))
        return Data(hash)
    }

    /// 6-digit code = SHA-256(sort([key1, key2]).join("")) → first 3 bytes → mod 1_000_000
    private func computeShortCode(key1: String, key2: String) -> String {
        let sorted = [key1, key2].sorted().joined()
        let hash = SHA256.hash(data: Data(sorted.utf8))
        let bytes = Array(hash)
        let num = (Int(bytes[0]) << 16) | (Int(bytes[1]) << 8) | Int(bytes[2])
        return String(format: "%06d", num % 1_000_000)
    }

    // MARK: - Base64url (matches relayCrypto.ts helpers)

    private func base64urlEncode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private func base64urlDecode(_ str: String) -> Data {
        var base64 = str
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder > 0 {
            base64 += String(repeating: "=", count: 4 - remainder)
        }
        return Data(base64Encoded: base64) ?? Data()
    }

    // MARK: - WebSocket Helpers

    private func sendJson(_ obj: [String: Any]) async throws {
        let data = try JSONSerialization.data(withJSONObject: obj)
        guard let str = String(data: data, encoding: .utf8) else {
            throw RelayError.serializationFailed
        }
        guard let ws = webSocketTask else {
            throw RelayError.notConnected
        }
        try await ws.send(.string(str))
    }

    private func sendPong() {
        webSocketTask?.send(.string("{\"type\":\"pong\"}")) { _ in }
    }

    // MARK: - Heartbeat (60s interval, matches phoneRelayClient.ts)

    private func startHeartbeat() {
        stopHeartbeat()
        let timer = DispatchSource.makeTimerSource(queue: .global())
        timer.schedule(deadline: .now() + 60, repeating: 60)
        timer.setEventHandler { [weak self] in
            self?.webSocketTask?.send(.string("{\"type\":\"ping\"}")) { _ in }
        }
        timer.resume()
        heartbeatTimer = timer
    }

    private func stopHeartbeat() {
        heartbeatTimer?.cancel()
        heartbeatTimer = nil
    }

    // MARK: - State

    private func setState(_ newState: State) {
        state = newState
        onStateChange?(newState)
    }

    // MARK: - Cleanup

    func cleanup() {
        stopHeartbeat()
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
        urlSession?.invalidateAndCancel()
        urlSession = nil
        privateKey = nil
        localPublicKeyBase64 = nil
        peerPublicKeyBase64 = nil
        sessionKey = nil
        sequenceCounter = 0
        shortCode = nil
        connectedAt = nil
    }
}

// MARK: - Errors

enum RelayError: Error, LocalizedError {
    case invalidQrPayload
    case invalidState(String)
    case notConnected
    case decryptionFailed
    case serializationFailed

    var errorDescription: String? {
        switch self {
        case .invalidQrPayload: return "Invalid QR payload"
        case .invalidState(let s): return "Invalid state: \(s)"
        case .notConnected: return "WebSocket not connected"
        case .decryptionFailed: return "AES-GCM decryption failed"
        case .serializationFailed: return "JSON serialization failed"
        }
    }
}
