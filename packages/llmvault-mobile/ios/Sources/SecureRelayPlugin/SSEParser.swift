import Foundation

/// Parsed SSE event types matching the SecureRelay event interface.
enum SSEEvent {
    case delta(text: String)
    case card(card: [String: Any])
    case done(usage: StreamUsage?)
    case error(message: String)
}

struct StreamUsage {
    let promptTokens: Int
    let completionTokens: Int
}

/// Parses Server-Sent Events from LLM provider HTTP response body.
/// Mirrors the logic from llmvault-extension streamManager.ts.
final class SSEParser {

    private var buffer = ""
    private let isAnthropic: Bool

    init(isAnthropic: Bool) {
        self.isAnthropic = isAnthropic
    }

    /// Feed raw data from the HTTP stream and extract SSE events.
    func feed(_ chunk: String) -> [SSEEvent] {
        buffer += chunk
        let lines = buffer.split(separator: "\n", omittingEmptySubsequences: false)

        // Keep the last incomplete line in the buffer
        if buffer.hasSuffix("\n") {
            buffer = ""
        } else {
            buffer = String(lines.last ?? "")
        }

        var events: [SSEEvent] = []
        let completedLines = buffer.isEmpty ? lines : lines.dropLast()

        for line in completedLines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty || trimmed == "data: [DONE]" { continue }
            guard trimmed.hasPrefix("data: ") else { continue }

            let jsonStr = String(trimmed.dropFirst(6))
            guard let data = jsonStr.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                continue
            }

            if isAnthropic {
                events.append(contentsOf: parseAnthropicEvent(json))
            } else {
                events.append(contentsOf: parseOpenAiEvent(json))
            }
        }

        return events
    }

    // MARK: - OpenAI SSE Parsing

    /// Mirrors streamManager.ts parseOpenAiStreamEvent
    private func parseOpenAiEvent(_ data: [String: Any]) -> [SSEEvent] {
        guard let choices = data["choices"] as? [[String: Any]],
              let choice = choices.first else {
            return []
        }

        var events: [SSEEvent] = []
        let delta = choice["delta"] as? [String: Any]

        // Text delta
        if let content = delta?["content"] as? String {
            events.append(.delta(text: content))
        }

        // Finish reason → done
        if let _ = choice["finish_reason"] as? String {
            let usage = data["usage"] as? [String: Any]
            let streamUsage: StreamUsage?
            if let u = usage {
                streamUsage = StreamUsage(
                    promptTokens: u["prompt_tokens"] as? Int ?? 0,
                    completionTokens: u["completion_tokens"] as? Int ?? 0
                )
            } else {
                streamUsage = nil
            }
            events.append(.done(usage: streamUsage))
        }

        return events
    }

    // MARK: - Anthropic SSE Parsing

    /// Mirrors streamManager.ts parseAnthropicStreamEvent
    private func parseAnthropicEvent(_ data: [String: Any]) -> [SSEEvent] {
        guard let eventType = data["type"] as? String else { return [] }
        var events: [SSEEvent] = []

        switch eventType {
        case "content_block_delta":
            if let delta = data["delta"] as? [String: Any],
               let deltaType = delta["type"] as? String,
               deltaType == "text_delta",
               let text = delta["text"] as? String {
                events.append(.delta(text: text))
            }

        case "message_delta":
            let usage = data["usage"] as? [String: Any]
            let streamUsage: StreamUsage?
            if let u = usage {
                streamUsage = StreamUsage(
                    promptTokens: u["input_tokens"] as? Int ?? 0,
                    completionTokens: u["output_tokens"] as? Int ?? 0
                )
            } else {
                streamUsage = nil
            }
            events.append(.done(usage: streamUsage))

        case "error":
            if let errorData = data["error"] as? [String: Any],
               let message = errorData["message"] as? String {
                events.append(.error(message: message))
            }

        default:
            break // Ignore ping, message_start, content_block_start, etc.
        }

        return events
    }

    /// Reset the parser state for reuse.
    func reset() {
        buffer = ""
    }
}
