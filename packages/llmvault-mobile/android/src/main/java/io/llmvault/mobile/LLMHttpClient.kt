package io.llmvault.mobile

import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

/**
 * Provider-agnostic HTTP request descriptor.
 * All fields are plain data — no key material is stored after the call returns.
 */
data class LLMRequest(
    val url: String,
    val headers: Map<String, String>,
    val body: String,
)

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/**
 * Makes direct HTTPS calls to LLM providers from the native layer.
 *
 * API keys are accepted as parameters and used only within this class.
 * They are never stored as fields, never logged, and never forwarded across
 * the Capacitor JS bridge.
 *
 * Mirrors LLMHttpClient.swift: OpenAI passthrough and Anthropic translation.
 */
class LLMHttpClient {

    /** Active streaming calls, keyed by caller-supplied streamId. */
    private val activeTasks = ConcurrentHashMap<String, Call>()

    private val okHttpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    // -------------------------------------------------------------------------
    // Request building
    // -------------------------------------------------------------------------

    /**
     * Build a provider-specific HTTP request descriptor.
     * Mirrors LLMHttpClient.swift buildRequest / providerFetch.ts buildProviderFetch.
     *
     * @throws IllegalArgumentException if [baseUrl] is blank or malformed
     */
    fun buildRequest(
        provider: String,
        baseUrl: String,
        apiKey: String,
        model: String,
        messages: List<Map<String, Any>>,
        systemPrompt: String,
        maxTokens: Int,
        stream: Boolean = true,
    ): LLMRequest {
        return if (provider == "anthropic") {
            buildAnthropicRequest(baseUrl, apiKey, model, messages, systemPrompt, maxTokens, stream)
        } else {
            buildOpenAiRequest(baseUrl, apiKey, model, messages, systemPrompt, maxTokens, stream)
        }
    }

    // -------------------------------------------------------------------------
    // OpenAI passthrough
    // -------------------------------------------------------------------------

    private fun buildOpenAiRequest(
        baseUrl: String,
        apiKey: String,
        model: String,
        messages: List<Map<String, Any>>,
        systemPrompt: String,
        maxTokens: Int,
        stream: Boolean,
    ): LLMRequest {
        val url = baseUrl.trimEnd('/') + "/chat/completions"

        // Prepend system message, then user/assistant turns
        val allMessages = JSONArray()
        val systemMsg = JSONObject().apply {
            put("role", "system")
            put("content", systemPrompt)
        }
        allMessages.put(systemMsg)
        for (msg in messages) {
            allMessages.put(mapToJsonObject(msg))
        }

        val bodyJson = JSONObject().apply {
            put("model", model)
            put("messages", allMessages)
            put("max_tokens", maxTokens)
            put("stream", stream)
        }

        return LLMRequest(
            url = url,
            headers = mapOf(
                "Content-Type" to "application/json",
                "Authorization" to "Bearer $apiKey",
            ),
            body = bodyJson.toString(),
        )
    }

    // -------------------------------------------------------------------------
    // Anthropic translation
    // -------------------------------------------------------------------------

    private fun buildAnthropicRequest(
        baseUrl: String,
        apiKey: String,
        model: String,
        messages: List<Map<String, Any>>,
        systemPrompt: String,
        maxTokens: Int,
        stream: Boolean,
    ): LLMRequest {
        val url = baseUrl.trimEnd('/') + "/messages"

        // Filter out any system-role messages; system is sent as top-level array
        val nonSystemMessages = messages.filter { (it["role"] as? String) != "system" }
        val anthropicMessages = JSONArray()
        for (msg in nonSystemMessages) {
            anthropicMessages.put(mapToJsonObject(msg))
        }

        val systemArray = JSONArray().apply {
            put(JSONObject().apply {
                put("type", "text")
                put("text", systemPrompt)
            })
        }

        val bodyJson = JSONObject().apply {
            put("model", model)
            put("messages", anthropicMessages)
            put("max_tokens", maxTokens)
            put("stream", stream)
            put("system", systemArray)
        }

        return LLMRequest(
            url = url,
            headers = mapOf(
                "Content-Type" to "application/json",
                "x-api-key" to apiKey,
                "anthropic-version" to "2023-06-01",
            ),
            body = bodyJson.toString(),
        )
    }

    // -------------------------------------------------------------------------
    // Streaming execution
    // -------------------------------------------------------------------------

    /**
     * Start a streaming HTTPS request.
     *
     * OkHttp's async [Call.enqueue] is used. The response body is read
     * incrementally via [ResponseBody.source] (Okio [BufferedSource]) so that
     * tokens are forwarded to [eventHandler] as each SSE line arrives — the
     * response is never fully buffered in memory.
     *
     * The [streamId] is stored in [activeTasks] so that [cancelStream] can
     * abort the in-flight call.
     *
     * [eventHandler] and [completion] are called on OkHttp's internal
     * dispatcher thread — callers that interact with the Capacitor bridge must
     * marshal back to the main thread themselves (identical to the iOS pattern).
     *
     * @param request    Descriptor produced by [buildRequest].
     * @param isAnthropic Whether to use Anthropic SSE parsing rules.
     * @param streamId   Caller-assigned identifier used for cancellation.
     * @param eventHandler Invoked for each [SSEEvent] as it is parsed.
     * @param completion  Invoked exactly once when the stream ends (null = success).
     */
    fun startStreamingSession(
        request: LLMRequest,
        isAnthropic: Boolean,
        streamId: String,
        eventHandler: (SSEEvent) -> Unit,
        completion: (Exception?) -> Unit,
    ) {
        val requestBody = request.body.toRequestBody(jsonMediaType)
        val okRequest = Request.Builder()
            .url(request.url)
            .post(requestBody)
            .apply { request.headers.forEach { (k, v) -> addHeader(k, v) } }
            .build()

        val call = okHttpClient.newCall(okRequest)
        activeTasks[streamId] = call

        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                activeTasks.remove(streamId)
                if (call.isCanceled()) {
                    eventHandler(SSEEvent.Error("Stream cancelled"))
                } else {
                    eventHandler(SSEEvent.Error(e.message ?: "Network error"))
                }
                completion(e)
            }

            override fun onResponse(call: Call, response: Response) {
                activeTasks.remove(streamId)

                if (!response.isSuccessful) {
                    val statusCode = response.code
                    val bodyPreview = runCatching {
                        response.body?.string()?.take(500) ?: "empty body"
                    }.getOrElse { "unreadable body" }
                    response.close()
                    val msg = "Provider returned $statusCode: $bodyPreview"
                    eventHandler(SSEEvent.Error(msg))
                    completion(IOException(msg))
                    return
                }

                val responseBody = response.body
                if (responseBody == null) {
                    eventHandler(SSEEvent.Done(usage = null))
                    completion(null)
                    return
                }

                readStreamingBody(responseBody, isAnthropic, streamId, eventHandler, completion)
            }
        })
    }

    /**
     * Read the response body incrementally using Okio's [BufferedSource].
     *
     * Each UTF-8 line is fed to [SSEParser] as it arrives. A [SSEEvent.Done]
     * is emitted after the source is exhausted if the parser did not already
     * produce one (e.g. when the provider closes the stream without a terminal
     * event).
     */
    private fun readStreamingBody(
        responseBody: ResponseBody,
        isAnthropic: Boolean,
        streamId: String,
        eventHandler: (SSEEvent) -> Unit,
        completion: (Exception?) -> Unit,
    ) {
        val parser = SSEParser(isAnthropic)
        var doneSent = false

        try {
            responseBody.source().use { source ->
                val sink = okio.Buffer()
                // Read one UTF-8 line at a time without buffering the full body.
                while (!source.exhausted()) {
                    // indexOf('\n') advances source up to and including the newline.
                    val newlineIndex = source.indexOf('\n'.code.toByte())
                    if (newlineIndex == -1L) {
                        // No more newlines — read whatever remains.
                        source.readAll(sink)
                        val remaining = sink.readUtf8()
                        if (remaining.isNotEmpty()) {
                            val events = parser.feed(remaining)
                            for (event in events) {
                                if (event is SSEEvent.Done) doneSent = true
                                eventHandler(event)
                            }
                        }
                        break
                    }
                    // +1 to include the '\n' itself so the parser sees complete lines.
                    source.read(sink, newlineIndex + 1)
                    val line = sink.readUtf8()
                    val events = parser.feed(line)
                    for (event in events) {
                        if (event is SSEEvent.Done) doneSent = true
                        eventHandler(event)
                    }
                }
            }

            if (!doneSent) {
                eventHandler(SSEEvent.Done(usage = null))
            }
            completion(null)
        } catch (e: IOException) {
            if (activeTasks.containsKey(streamId)) {
                // Not cancelled — genuine read error.
                eventHandler(SSEEvent.Error(e.message ?: "Stream read error"))
                completion(e)
            } else {
                // Call was cancelled via cancelStream(); suppress the spurious IOException.
                eventHandler(SSEEvent.Error("Stream cancelled"))
                completion(IOException("Stream cancelled"))
            }
        }
    }

    // -------------------------------------------------------------------------
    // Cancellation
    // -------------------------------------------------------------------------

    /**
     * Cancel an in-flight stream identified by [streamId].
     * No-op if the stream has already completed or the id is unknown.
     */
    fun cancelStream(streamId: String) {
        activeTasks.remove(streamId)?.cancel()
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    /** Convert a plain [Map] to a [JSONObject], handling nested types. */
    private fun mapToJsonObject(map: Map<String, Any>): JSONObject {
        val obj = JSONObject()
        for ((k, v) in map) {
            when (v) {
                is Map<*, *> -> {
                    @Suppress("UNCHECKED_CAST")
                    obj.put(k, mapToJsonObject(v as Map<String, Any>))
                }
                is List<*> -> obj.put(k, JSONArray(v))
                else -> obj.put(k, v)
            }
        }
        return obj
    }
}
