package io.llmvault.mobile

import androidx.fragment.app.FragmentActivity
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.KeyFactory
import java.security.interfaces.ECPrivateKey
import java.security.spec.X509EncodedKeySpec
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import okhttp3.*
import org.json.JSONArray
import org.json.JSONObject

/**
 * Manages the mobile side of a Phone Wallet Relay session (ADR-005).
 *
 * Handles ECDH P-256 key exchange, AES-GCM-256 encryption, WebSocket lifecycle,
 * and AI request processing via the local LLM wallet (Keystore + native HTTPS).
 *
 * Protocol (matching relayCrypto.ts):
 *   1. Generate ephemeral ECDH P-256 key pair
 *   2. Derive shared secret via ECDH → HKDF-SHA-256 → AES-GCM-256
 *   3. All messages encrypted with AES-GCM using random 12-byte IVs
 */
class RelaySessionHandler(
    private val keyStore: SecureKeyStore,
    private val biometric: BiometricAuthManager,
    private val httpClient: LLMHttpClient,
    private val policyEnforcer: PolicyEnforcer = PolicyEnforcer,
    /**
     * Supplier that returns the currently attached FragmentActivity (or null
     * if the app is backgrounded). The relay handler needs a live
     * FragmentActivity to show BiometricPrompt when processing an incoming
     * AI request; ADR-005 requires per-request user awareness so we rely on
     * the prompt UI being visible.
     */
    private val activityProvider: () -> FragmentActivity? = { null },
) {
    // ── State Machine ────────────────────────────────
    enum class State { IDLE, CONNECTING, KEY_EXCHANGING, VERIFYING, ACTIVE, DISCONNECTED }

    var state: State = State.IDLE
        private set
    var sessionId: String? = null
        private set
    var shortCode: String? = null
        private set
    private var connectedAt: Long? = null

    // ── Crypto ───────────────────────────────────────
    private var privateKey: ECPrivateKey? = null
    private var localPublicKeyBase64: String? = null
    private var peerPublicKeyBase64: String? = null
    private var sessionKey: ByteArray? = null
    private var sequenceCounter = 0

    // ── WebSocket ────────────────────────────────────
    private var webSocket: WebSocket? = null
    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.SECONDS)
        .build()

    // ── Callbacks ────────────────────────────────────
    var onStateChange: ((State) -> Unit)? = null
    var onRequestReceived: ((String, String, Int) -> Unit)? = null
    var onError: ((String) -> Unit)? = null
    var onDisconnect: ((String) -> Unit)? = null

    companion object {
        private val HKDF_INFO: ByteArray
            get() = LlmvaultMobileConfig.pairingProtocolLabel.toByteArray(Charsets.UTF_8)
        private const val GCM_TAG_LENGTH = 128
        private const val GCM_IV_LENGTH = 12
    }

    // ── Accept Pairing ───────────────────────────────

    fun acceptPairing(
        pairingToken: String,
        relayUrl: String,
        peerPublicKeyB64: String,
    ): Triple<String, String, String> {
        check(state == State.IDLE || state == State.DISCONNECTED) {
            "Cannot accept pairing in state: $state"
        }

        // Extract sessionId from relayUrl query string
        val url = java.net.URI(relayUrl)
        val query = url.query ?: throw IllegalArgumentException("Invalid relay URL")
        val extractedSessionId = query.split("&")
            .map { it.split("=", limit = 2) }
            .firstOrNull { it[0] == "session" }?.getOrNull(1)
            ?: throw IllegalArgumentException("No session in relay URL")

        this.sessionId = extractedSessionId
        setState(State.CONNECTING)

        // ── ECDH Key Pair ──
        val kpg = KeyPairGenerator.getInstance("EC")
        kpg.initialize(ECGenParameterSpec("secp256r1"))
        val keyPair = kpg.generateKeyPair()
        this.privateKey = keyPair.private as ECPrivateKey
        val pubKey = keyPair.public as ECPublicKey
        val localPubB64 = base64urlEncode(ecPublicKeyToRaw(pubKey))
        this.localPublicKeyBase64 = localPubB64
        this.peerPublicKeyBase64 = peerPublicKeyB64

        // ── Derive Session Key ──
        val peerPubKeyData = base64urlDecode(peerPublicKeyB64)
        val peerPublicKey = rawToECPublicKey(peerPubKeyData)
        val ka = KeyAgreement.getInstance("ECDH")
        ka.init(keyPair.private)
        ka.doPhase(peerPublicKey, true)
        val sharedSecret = ka.generateSecret()

        val salt = computeSalt(localPubB64, peerPublicKeyB64)
        this.sessionKey = hkdfSha256(sharedSecret, salt, HKDF_INFO, 32)

        // ── Short Code ──
        val code = computeShortCode(localPubB64, peerPublicKeyB64)
        this.shortCode = code
        setState(State.KEY_EXCHANGING)

        // ── Connect WebSocket ──
        val encodedToken = java.net.URLEncoder.encode(pairingToken, "UTF-8")
        val wsUrlString = "$relayUrl&role=mobile&token=$encodedToken"
        val request = Request.Builder().url(wsUrlString).build()
        webSocket = client.newWebSocket(request, createWebSocketListener())

        // ── Send Key Exchange ──
        val keyExchangeMsg = JSONObject().apply {
            put("type", "keyExchange")
            put("sessionId", extractedSessionId)
            put("mobilePublicKey", localPubB64)
        }
        webSocket?.send(keyExchangeMsg.toString())
        setState(State.VERIFYING)

        return Triple(extractedSessionId, localPubB64, code)
    }

    // ── Disconnect ───────────────────────────────────

    fun disconnect() {
        if (state == State.IDLE || state == State.DISCONNECTED) return
        val sid = sessionId ?: ""
        val msg = JSONObject().apply {
            put("type", "disconnect")
            put("sessionId", sid)
            put("reason", "user_request")
        }
        webSocket?.send(msg.toString())
        webSocket?.close(1000, null)
        cleanup()
        setState(State.DISCONNECTED)
        onDisconnect?.invoke(sid)
    }

    // ── Status ───────────────────────────────────────

    val statusInfo: Map<String, Any>
        get() {
            val info = mutableMapOf<String, Any>(
                "connected" to (state == State.ACTIVE),
                "state" to state.name.lowercase(),
            )
            sessionId?.let { info["sessionId"] = it }
            val ca = connectedAt
            if (ca != null) {
                val elapsed = (System.currentTimeMillis() - ca) / 1000
                info["idleTimeoutSec"] = maxOf(0, 30 * 60 - elapsed).toInt()
            } else {
                info["idleTimeoutSec"] = 0
            }
            return info
        }

    // ── WebSocket Listener ───────────────────────────

    private fun createWebSocketListener() = object : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
            handleMessage(text)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (state != State.DISCONNECTED) {
                val sid = sessionId ?: ""
                cleanup()
                setState(State.DISCONNECTED)
                onDisconnect?.invoke(sid)
            }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (state != State.DISCONNECTED) {
                val sid = sessionId ?: ""
                cleanup()
                setState(State.DISCONNECTED)
                onDisconnect?.invoke(sid)
            }
        }
    }

    private fun handleMessage(text: String) {
        val msg = try { JSONObject(text) } catch (_: Exception) { return }
        when (msg.optString("type")) {
            "keyExchange" -> {
                if (sessionId == null) sessionId = msg.optString("sessionId")
            }
            "paired" -> {
                msg.optString("shortCode").takeIf { it.isNotEmpty() }?.let { shortCode = it }
                setState(State.ACTIVE)
                connectedAt = System.currentTimeMillis()
            }
            "encrypted" -> {
                Thread { handleEncryptedMessage(msg) }.start()
            }
            "ping" -> webSocket?.send("{\"type\":\"pong\"}")
            "pong" -> {}
            "disconnect" -> {
                val sid = sessionId ?: ""
                cleanup()
                setState(State.DISCONNECTED)
                onDisconnect?.invoke(sid)
            }
            "error" -> {
                onError?.invoke(msg.optString("message", "Unknown relay error"))
            }
        }
    }

    // ── Encrypted Message Handling ────────────────────

    private fun handleEncryptedMessage(envelope: JSONObject) {
        val key = sessionKey ?: return
        val ciphertextB64 = envelope.optString("ciphertextBase64")
        val ivB64 = envelope.optString("ivBase64")
        val requestId = envelope.optString("requestId")
        if (ciphertextB64.isEmpty() || ivB64.isEmpty() || requestId.isEmpty()) return

        val aad = buildAAD(requestId)
        val plaintext = try {
            decryptMessage(ciphertextB64, ivB64, key, aad)
        } catch (_: Exception) {
            sendEncryptedResponse(requestId, JSONObject().put("type", "error").put("error", "Decryption failed"))
            return
        }

        val request = try { JSONObject(plaintext) } catch (_: Exception) {
            sendEncryptedResponse(requestId, JSONObject().put("type", "error").put("error", "Invalid request format"))
            return
        }

        if (request.optString("type") != "chatRequest") return

        val provider = request.optString("provider")
        val messagesArr = request.optJSONArray("messages") ?: return
        val systemPrompt = request.optString("systemPrompt")
        val maxTokens = request.optInt("maxTokens", 4096)

        val messages = mutableListOf<Map<String, String>>()
        for (i in 0 until messagesArr.length()) {
            val m = messagesArr.getJSONObject(i)
            messages.add(mapOf("role" to m.optString("role"), "content" to m.optString("content")))
        }

        val resolvedProvider = if (provider == "auto") {
            val allMeta = keyStore.loadAllMetadata()
            if (allMeta.isEmpty()) {
                sendEncryptedResponse(requestId, JSONObject().put("type", "error").put("error", "No providers registered"))
                return
            }
            allMeta.first().provider
        } else provider

        onRequestReceived?.invoke(resolvedProvider, requestId, messages.size)
        processAiRequest(requestId, resolvedProvider, messages, systemPrompt, maxTokens)
    }

    private fun processAiRequest(
        requestId: String,
        provider: String,
        messages: List<Map<String, String>>,
        systemPrompt: String,
        maxTokens: Int,
    ) {
        try {
            val metadata = keyStore.loadMetadata(provider)
                ?: run {
                    sendEncryptedResponse(requestId, JSONObject().put("type", "error").put("error", "Provider not registered: $provider"))
                    return
                }

            // Policy checks
            val urlCheck = policyEnforcer.validateBaseUrl(metadata.baseUrl)
            if (urlCheck is PolicyValidation.Rejected) {
                sendEncryptedResponse(requestId, JSONObject().put("type", "error").put("error", "Policy: ${urlCheck.reason}"))
                return
            }

            val effectiveMaxTokens = minOf(maxTokens, policyEnforcer.policy.maxTokensPerRequest)
            val estimatedCost = PolicyEnforcer.estimateCost(metadata.defaultModel, messages.size * 100, effectiveMaxTokens)
            if (policyEnforcer.checkDailyBudget(estimatedCost) is BudgetCheck.OverBudget) {
                sendEncryptedResponse(requestId, JSONObject().put("type", "error").put("error", "Daily budget exceeded"))
                return
            }

            // Decrypt the provider key. ADR-005 requires the phone to surface
            // each incoming AI request to the user; when we are outside the
            // auto-approve window we show a BiometricPrompt, which serves
            // both as the consent UI and as the gate that releases the
            // time-bound Keystore key. Within the window the prompt is
            // skipped but the Keystore still enforces its own validity.
            val apiKey = decryptKeyForRelay(provider)
            if (apiKey == null) {
                sendEncryptedResponse(
                    requestId,
                    JSONObject().put("type", "error").put("error", "Biometric authentication required"),
                )
                return
            }

            val mappedMessages: List<Map<String, Any>> = messages.map { m ->
                mapOf("role" to (m["role"] ?: "user"), "content" to (m["content"] ?: ""))
            }

            val llmRequest = httpClient.buildRequest(
                provider = provider,
                baseUrl = metadata.baseUrl,
                apiKey = apiKey,
                model = metadata.defaultModel,
                messages = mappedMessages,
                systemPrompt = systemPrompt,
                maxTokens = effectiveMaxTokens,
            )

            val isAnthropic = provider == "anthropic"
            val streamId = UUID.randomUUID().toString()

            httpClient.startStreamingSession(
                request = llmRequest,
                isAnthropic = isAnthropic,
                streamId = streamId,
                eventHandler = { event -> forwardStreamEvent(requestId, event) },
                completion = { policyEnforcer.recordCost(estimatedCost) },
            )
        } catch (e: Exception) {
            sendEncryptedResponse(requestId, JSONObject().put("type", "error").put("error", "Request failed"))
        }
    }

    /**
     * Decrypt the stored API key for [provider], triggering a BiometricPrompt
     * on the UI thread when the Keystore validity window has expired.
     *
     * Runs synchronously from the WebSocket dispatch thread (already a
     * background thread in handleMessage), blocking it on a CountDownLatch
     * until the prompt resolves. Returns null if the prompt fails, is
     * cancelled, the app is backgrounded (no FragmentActivity available),
     * or decryption raises. In all failure modes the caller responds to
     * the peer with an error envelope.
     *
     * A 60-second hard timeout guards against a user who leaves the prompt
     * on-screen indefinitely while the peer is holding resources.
     */
    private fun decryptKeyForRelay(provider: String): String? {
        val autoApprove = policyEnforcer.policy.biometricAutoApproveSeconds

        if (!biometric.needsAuth(autoApprove)) {
            return runCatching {
                val cipher = keyStore.getDecryptCipher(provider)
                keyStore.loadKey(provider, cipher)
            }.getOrNull()
        }

        val activity = activityProvider() ?: return null
        val latch = CountDownLatch(1)
        val decryptedKey = AtomicReference<String?>(null)

        biometric.authenticateWithCallback(
            activity,
            "Approve AI request from paired device",
            onSuccess = {
                runCatching {
                    val cipher = keyStore.getDecryptCipher(provider)
                    keyStore.loadKey(provider, cipher)
                }.onSuccess { decryptedKey.set(it) }
                latch.countDown()
            },
            onError = { latch.countDown() },
        )

        val completed = latch.await(60, TimeUnit.SECONDS)
        return if (completed) decryptedKey.get() else null
    }

    private fun forwardStreamEvent(requestId: String, event: SSEEvent) {
        val response = when (event) {
            is SSEEvent.Delta -> JSONObject().put("type", "delta").put("text", event.text)
            is SSEEvent.Card -> JSONObject().put("type", "card").put("card", JSONObject(event.card))
            is SSEEvent.Done -> {
                val obj = JSONObject().put("type", "done")
                event.usage?.let { u ->
                    obj.put("usage", JSONObject().put("promptTokens", u.promptTokens).put("completionTokens", u.completionTokens))
                }
                obj
            }
            is SSEEvent.Error -> JSONObject().put("type", "error").put("error", event.message)
        }
        sendEncryptedResponse(requestId, response)
    }

    // ── Encrypted Send ───────────────────────────────

    private fun sendEncryptedResponse(requestId: String, response: JSONObject) {
        val key = sessionKey ?: return
        try {
            val plaintext = response.toString()
            val aad = buildAAD(requestId)
            val (ciphertextB64, ivB64) = encryptMessage(plaintext, key, aad)
            val envelope = JSONObject().apply {
                put("type", "encrypted")
                put("sessionId", sessionId ?: "")
                put("requestId", requestId)
                put("ciphertextBase64", ciphertextB64)
                put("ivBase64", ivB64)
                put("sequence", sequenceCounter++)
            }
            webSocket?.send(envelope.toString())
        } catch (_: Exception) {
            // Cannot relay since encryption failed
        }
    }

    // ── AES-GCM Encryption ───────────────────────────

    /** Build AAD string matching the TS/iOS convention: `"sessionId:requestId"`. */
    private fun buildAAD(requestId: String): ByteArray =
        "${sessionId ?: ""}:$requestId".toByteArray(Charsets.UTF_8)

    private fun encryptMessage(plaintext: String, key: ByteArray, aad: ByteArray): Pair<String, String> {
        val iv = ByteArray(GCM_IV_LENGTH).also { java.security.SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(GCM_TAG_LENGTH, iv))
        cipher.updateAAD(aad)
        val encrypted = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        return Pair(base64urlEncode(encrypted), base64urlEncode(iv))
    }

    private fun decryptMessage(ciphertextB64: String, ivB64: String, key: ByteArray, aad: ByteArray): String {
        val ciphertextAndTag = base64urlDecode(ciphertextB64)
        val iv = base64urlDecode(ivB64)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(GCM_TAG_LENGTH, iv))
        cipher.updateAAD(aad)
        val decrypted = cipher.doFinal(ciphertextAndTag)
        return String(decrypted, Charsets.UTF_8)
    }

    // ── HKDF-SHA-256 ─────────────────────────────────

    private fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        // Extract
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(salt, "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        // Expand
        val mac2 = Mac.getInstance("HmacSHA256")
        mac2.init(SecretKeySpec(prk, "HmacSHA256"))
        mac2.update(info)
        mac2.update(byteArrayOf(1))
        val okm = mac2.doFinal()
        return okm.copyOf(length)
    }

    // ── Salt & Short Code ────────────────────────────

    private fun computeSalt(key1: String, key2: String): ByteArray {
        val sorted = listOf(key1, key2).sorted().joinToString("")
        return MessageDigest.getInstance("SHA-256").digest(sorted.toByteArray(Charsets.UTF_8))
    }

    private fun computeShortCode(key1: String, key2: String): String {
        val sorted = listOf(key1, key2).sorted().joinToString("")
        val hash = MessageDigest.getInstance("SHA-256").digest(sorted.toByteArray(Charsets.UTF_8))
        val num = (hash[0].toInt() and 0xFF shl 16) or (hash[1].toInt() and 0xFF shl 8) or (hash[2].toInt() and 0xFF)
        return String.format("%06d", num % 1_000_000)
    }

    // ── EC Key Conversion (raw ↔ JCA) ────────────────

    private fun ecPublicKeyToRaw(key: ECPublicKey): ByteArray {
        val point = key.w
        val x = point.affineX.toByteArray().let { if (it.size > 32) it.takeLast(32).toByteArray() else ByteArray(32 - it.size) + it }
        val y = point.affineY.toByteArray().let { if (it.size > 32) it.takeLast(32).toByteArray() else ByteArray(32 - it.size) + it }
        return byteArrayOf(0x04) + x + y
    }

    private fun rawToECPublicKey(raw: ByteArray): ECPublicKey {
        require(raw.size == 65 && raw[0] == 0x04.toByte()) { "Invalid uncompressed EC public key" }
        val x = raw.sliceArray(1..32)
        val y = raw.sliceArray(33..64)
        val xBi = java.math.BigInteger(1, x)
        val yBi = java.math.BigInteger(1, y)
        val point = java.security.spec.ECPoint(xBi, yBi)
        val kpg = KeyPairGenerator.getInstance("EC")
        kpg.initialize(ECGenParameterSpec("secp256r1"))
        val params = (kpg.generateKeyPair().public as ECPublicKey).params
        val pubSpec = java.security.spec.ECPublicKeySpec(point, params)
        return KeyFactory.getInstance("EC").generatePublic(pubSpec) as ECPublicKey
    }

    // ── Base64url ────────────────────────────────────

    private fun base64urlEncode(data: ByteArray): String {
        return android.util.Base64.encodeToString(data, android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP)
    }

    private fun base64urlDecode(str: String): ByteArray {
        return android.util.Base64.decode(str, android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP)
    }

    // ── State ────────────────────────────────────────

    private fun setState(newState: State) {
        state = newState
        onStateChange?.invoke(newState)
    }

    // ── Cleanup ──────────────────────────────────────

    fun cleanup() {
        webSocket?.cancel()
        webSocket = null
        privateKey = null
        localPublicKeyBase64 = null
        peerPublicKeyBase64 = null
        sessionKey = null
        sequenceCounter = 0
        shortCode = null
        connectedAt = null
    }
}
