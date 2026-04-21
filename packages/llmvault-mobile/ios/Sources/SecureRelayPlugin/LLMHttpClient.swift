import Foundation

/// Makes direct HTTPS calls to LLM providers from the native layer.
/// API keys never leave this layer — they are decrypted from Keychain and used here only.
/// Mirrors providerFetch.ts: OpenAI passthrough and Anthropic translation.
final class LLMHttpClient {

    /// Active streaming tasks, keyed by streamId.
    private var activeTasks: [String: URLSessionDataTask] = [:]
    private let taskLock = NSLock()

    // MARK: - Request Building

    struct LLMRequest {
        let url: URL
        let headers: [String: String]
        let body: Data
    }

    /// Build provider-specific HTTP request. Mirrors providerFetch.ts buildProviderFetch.
    func buildRequest(
        provider: String,
        baseUrl: String,
        apiKey: String,
        model: String,
        messages: [[String: Any]],
        systemPrompt: String,
        maxTokens: Int,
        stream: Bool = true
    ) throws -> LLMRequest {
        if provider == "anthropic" {
            return try buildAnthropicRequest(
                baseUrl: baseUrl, apiKey: apiKey, model: model,
                messages: messages, systemPrompt: systemPrompt,
                maxTokens: maxTokens, stream: stream
            )
        }
        return try buildOpenAiRequest(
            baseUrl: baseUrl, apiKey: apiKey, model: model,
            messages: messages, systemPrompt: systemPrompt,
            maxTokens: maxTokens, stream: stream
        )
    }

    // MARK: - OpenAI Passthrough

    private func buildOpenAiRequest(
        baseUrl: String,
        apiKey: String,
        model: String,
        messages: [[String: Any]],
        systemPrompt: String,
        maxTokens: Int,
        stream: Bool
    ) throws -> LLMRequest {
        let urlString = baseUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/chat/completions"
        guard let url = URL(string: urlString) else {
            throw LLMHttpError.invalidUrl(urlString)
        }

        // Prepend system message
        var allMessages: [[String: Any]] = [
            ["role": "system", "content": systemPrompt]
        ]
        allMessages.append(contentsOf: messages)

        let body: [String: Any] = [
            "model": model,
            "messages": allMessages,
            "max_tokens": maxTokens,
            "stream": stream,
        ]

        let bodyData = try JSONSerialization.data(withJSONObject: body)

        return LLMRequest(
            url: url,
            headers: [
                "Content-Type": "application/json",
                "Authorization": "Bearer \(apiKey)",
            ],
            body: bodyData
        )
    }

    // MARK: - Anthropic Translation

    private func buildAnthropicRequest(
        baseUrl: String,
        apiKey: String,
        model: String,
        messages: [[String: Any]],
        systemPrompt: String,
        maxTokens: Int,
        stream: Bool
    ) throws -> LLMRequest {
        let urlString = baseUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/messages"
        guard let url = URL(string: urlString) else {
            throw LLMHttpError.invalidUrl(urlString)
        }

        // Filter out system messages (already handled via systemPrompt)
        let nonSystemMessages = messages.filter { msg in
            (msg["role"] as? String) != "system"
        }

        // Convert to Anthropic format
        let anthropicMessages = nonSystemMessages.map { msg -> [String: Any] in
            let role = msg["role"] as? String ?? "user"
            let content = msg["content"] as? String ?? ""
            return ["role": role, "content": content]
        }

        let body: [String: Any] = [
            "model": model,
            "messages": anthropicMessages,
            "max_tokens": maxTokens,
            "stream": stream,
            "system": [["type": "text", "text": systemPrompt]],
        ]

        let bodyData = try JSONSerialization.data(withJSONObject: body)

        return LLMRequest(
            url: url,
            headers: [
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01",
            ],
            body: bodyData
        )
    }

    // MARK: - Streaming Execution

    /// Start a streaming request. Calls the eventHandler for each parsed SSE event.
    /// Returns a streamId for cancellation.
    func startStream(
        request: LLMRequest,
        isAnthropic: Bool,
        streamId: String,
        eventHandler: @escaping (SSEEvent) -> Void,
        completion: @escaping (Error?) -> Void
    ) {
        var urlRequest = URLRequest(url: request.url)
        urlRequest.httpMethod = "POST"
        urlRequest.httpBody = request.body
        for (key, value) in request.headers {
            urlRequest.setValue(value, forHTTPHeaderField: key)
        }

        let parser = SSEParser(isAnthropic: isAnthropic)

        let session = URLSession(configuration: .default)
        let task = session.dataTask(with: urlRequest) { [weak self] data, response, error in
            defer {
                self?.removeTask(streamId: streamId)
            }

            if let error = error {
                if (error as NSError).code == NSURLErrorCancelled {
                    eventHandler(.error(message: "Stream cancelled"))
                } else {
                    eventHandler(.error(message: error.localizedDescription))
                }
                completion(error)
                return
            }

            guard let httpResponse = response as? HTTPURLResponse else {
                let err = LLMHttpError.noResponse
                eventHandler(.error(message: err.localizedDescription))
                completion(err)
                return
            }

            guard httpResponse.statusCode >= 200, httpResponse.statusCode < 300 else {
                let bodyStr = data.flatMap { String(data: $0, encoding: .utf8) } ?? "unknown"
                let msg = "Provider returned \(httpResponse.statusCode): \(String(bodyStr.prefix(500)))"
                eventHandler(.error(message: msg))
                completion(LLMHttpError.providerError(httpResponse.statusCode, msg))
                return
            }

            guard let data = data else {
                eventHandler(.done(usage: nil))
                completion(nil)
                return
            }

            // Parse the entire response body as SSE
            let chunk = String(data: data, encoding: .utf8) ?? ""
            let events = parser.feed(chunk)
            for event in events {
                eventHandler(event)
            }

            // Ensure done is sent
            if !events.contains(where: { if case .done = $0 { return true }; return false }) {
                eventHandler(.done(usage: nil))
            }

            completion(nil)
        }

        taskLock.lock()
        activeTasks[streamId] = task
        taskLock.unlock()

        task.resume()
    }

    /// Start a streaming request using URLSession delegate for true SSE streaming.
    func startStreamingSession(
        request: LLMRequest,
        isAnthropic: Bool,
        streamId: String,
        eventHandler: @escaping (SSEEvent) -> Void,
        completion: @escaping (Error?) -> Void
    ) {
        var urlRequest = URLRequest(url: request.url)
        urlRequest.httpMethod = "POST"
        urlRequest.httpBody = request.body
        for (key, value) in request.headers {
            urlRequest.setValue(value, forHTTPHeaderField: key)
        }

        let delegate = SSEStreamDelegate(
            isAnthropic: isAnthropic,
            streamId: streamId,
            eventHandler: eventHandler,
            completion: { [weak self] error in
                self?.removeTask(streamId: streamId)
                completion(error)
            }
        )

        let session = URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
        let task = session.dataTask(with: urlRequest)

        taskLock.lock()
        activeTasks[streamId] = task
        taskLock.unlock()

        task.resume()
    }

    // MARK: - Cancel

    func cancelStream(streamId: String) {
        taskLock.lock()
        let task = activeTasks.removeValue(forKey: streamId)
        taskLock.unlock()
        task?.cancel()
    }

    private func removeTask(streamId: String) {
        taskLock.lock()
        activeTasks.removeValue(forKey: streamId)
        taskLock.unlock()
    }
}

// MARK: - SSE Stream Delegate (for true incremental streaming)

private class SSEStreamDelegate: NSObject, URLSessionDataDelegate {
    private let parser: SSEParser
    private let streamId: String
    private let eventHandler: (SSEEvent) -> Void
    private let completion: (Error?) -> Void
    private var hasCompleted = false

    init(isAnthropic: Bool, streamId: String,
         eventHandler: @escaping (SSEEvent) -> Void,
         completion: @escaping (Error?) -> Void) {
        self.parser = SSEParser(isAnthropic: isAnthropic)
        self.streamId = streamId
        self.eventHandler = eventHandler
        self.completion = completion
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode >= 200, httpResponse.statusCode < 300 else {
            let statusCode = (response as? HTTPURLResponse)?.statusCode ?? 0
            eventHandler(.error(message: "Provider returned \(statusCode)"))
            completionHandler(.cancel)
            completeOnce(error: LLMHttpError.providerError(statusCode, "HTTP \(statusCode)"))
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let chunk = String(data: data, encoding: .utf8) else { return }
        let events = parser.feed(chunk)
        for event in events {
            eventHandler(event)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error {
            if (error as NSError).code != NSURLErrorCancelled {
                eventHandler(.error(message: error.localizedDescription))
            }
        }
        eventHandler(.done(usage: nil))
        completeOnce(error: error)
    }

    private func completeOnce(error: Error?) {
        guard !hasCompleted else { return }
        hasCompleted = true
        completion(error)
    }
}

// MARK: - Errors

enum LLMHttpError: Error, LocalizedError {
    case invalidUrl(String)
    case noResponse
    case providerError(Int, String)

    var errorDescription: String? {
        switch self {
        case .invalidUrl(let url): return "Invalid URL: \(url)"
        case .noResponse: return "No response from provider"
        case .providerError(let code, let msg): return "Provider error \(code): \(msg)"
        }
    }
}
