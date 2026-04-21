package io.llmvault.mobile

import org.json.JSONObject

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/** Parsed SSE event types matching the SecureRelay event interface. */
sealed class SSEEvent {
    data class Delta(val text: String) : SSEEvent()
    data class Card(val card: Map<String, Any>) : SSEEvent()
    data class Done(val usage: StreamUsage?) : SSEEvent()
    data class Error(val message: String) : SSEEvent()
}

data class StreamUsage(
    val promptTokens: Int,
    val completionTokens: Int,
)

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parses Server-Sent Events from an LLM provider HTTP response body.
 * Mirrors the logic from llmvault-extension streamManager.ts and the Swift SSEParser.
 *
 * Not thread-safe — callers must synchronise access if feeding from multiple threads.
 */
class SSEParser(private val isAnthropic: Boolean) {

    private var buffer = ""

    /**
     * Feed a raw chunk of text from the HTTP stream.
     * Returns zero or more fully-parsed [SSEEvent]s.
     */
    fun feed(chunk: String): List<SSEEvent> {
        buffer += chunk

        // Split on newline without discarding the trailing empty element that
        // indicates a complete line — mirrors Swift split(omittingEmptySubsequences: false).
        val lines = buffer.split("\n")

        // If the buffer ends with a newline every line is complete; otherwise the
        // last element is an incomplete line that must stay in the buffer.
        if (buffer.endsWith("\n")) {
            buffer = ""
        } else {
            buffer = lines.last() ?: ""
        }

        val completedLines = if (buffer.isEmpty()) lines else lines.dropLast(1)

        val events = mutableListOf<SSEEvent>()
        for (line in completedLines) {
            val trimmed = line.trim()
            if (trimmed.isEmpty() || trimmed == "data: [DONE]") continue
            if (!trimmed.startsWith("data: ")) continue

            val jsonStr = trimmed.removePrefix("data: ")
            val json = runCatching { JSONObject(jsonStr) }.getOrNull() ?: continue

            if (isAnthropic) {
                events.addAll(parseAnthropicEvent(json))
            } else {
                events.addAll(parseOpenAiEvent(json))
            }
        }

        return events
    }

    /** Reset the parser state for reuse. */
    fun reset() {
        buffer = ""
    }

    // -----------------------------------------------------------------------
    // OpenAI SSE parsing
    // -----------------------------------------------------------------------

    /** Mirrors streamManager.ts parseOpenAiStreamEvent */
    private fun parseOpenAiEvent(data: JSONObject): List<SSEEvent> {
        val choices = data.optJSONArray("choices") ?: return emptyList()
        if (choices.length() == 0) return emptyList()
        val choice = choices.optJSONObject(0) ?: return emptyList()

        val events = mutableListOf<SSEEvent>()
        val delta = choice.optJSONObject("delta")

        // Text delta
        val content = delta?.optString("content", null)
        if (!content.isNullOrEmpty()) {
            events.add(SSEEvent.Delta(content))
        }

        // finish_reason present (may be null JSON value — optString returns "null" string for that)
        val finishReason = choice.opt("finish_reason")
        if (finishReason != null && finishReason != JSONObject.NULL) {
            val usageObj = data.optJSONObject("usage")
            val streamUsage = usageObj?.let {
                StreamUsage(
                    promptTokens = it.optInt("prompt_tokens", 0),
                    completionTokens = it.optInt("completion_tokens", 0),
                )
            }
            events.add(SSEEvent.Done(streamUsage))
        }

        return events
    }

    // -----------------------------------------------------------------------
    // Anthropic SSE parsing
    // -----------------------------------------------------------------------

    /** Mirrors streamManager.ts parseAnthropicStreamEvent */
    private fun parseAnthropicEvent(data: JSONObject): List<SSEEvent> {
        val eventType = data.optString("type", null) ?: return emptyList()
        val events = mutableListOf<SSEEvent>()

        when (eventType) {
            "content_block_delta" -> {
                val delta = data.optJSONObject("delta") ?: return emptyList()
                if (delta.optString("type") == "text_delta") {
                    val text = delta.optString("text", null)
                    if (!text.isNullOrEmpty()) {
                        events.add(SSEEvent.Delta(text))
                    }
                }
            }

            "message_delta" -> {
                val usageObj = data.optJSONObject("usage")
                val streamUsage = usageObj?.let {
                    StreamUsage(
                        // Anthropic uses input_tokens / output_tokens in message_delta
                        promptTokens = it.optInt("input_tokens", 0),
                        completionTokens = it.optInt("output_tokens", 0),
                    )
                }
                events.add(SSEEvent.Done(streamUsage))
            }

            "error" -> {
                val errorObj = data.optJSONObject("error")
                val message = errorObj?.optString("message", null)
                if (!message.isNullOrEmpty()) {
                    events.add(SSEEvent.Error(message))
                }
            }

            // Ignore: ping, message_start, content_block_start, content_block_stop, message_stop, etc.
            else -> Unit
        }

        return events
    }
}
