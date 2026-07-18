import Foundation

struct EngineConfiguration: Equatable, Sendable {
    static let defaultURL = URL(string: "http://127.0.0.1:43117")!

    let baseURL: URL
    let credential: CredentialSource

    static func load(
        preferredBaseURL: String? = UserDefaults.standard.string(forKey: "continuum.daemonURL")
    ) -> EngineConfiguration {
        let url = preferredBaseURL
            .flatMap(URL.init(string:))
            .flatMap { value in
                guard value.scheme == "http", value.host == "127.0.0.1" || value.host == "localhost" else {
                    return nil
                }
                return value
            }
            ?? defaultURL

        return EngineConfiguration(baseURL: url, credential: CredentialLoader.load())
    }
}

enum EngineClientError: LocalizedError, Equatable {
    case invalidResponse
    case httpStatus(Int, String)
    case emptyResponse
    case invalidPayload(String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            "The Continuum engine returned an invalid response."
        case let .httpStatus(status, message):
            "Engine request failed (HTTP \(status)): \(message)"
        case .emptyResponse:
            "The Continuum engine returned no data."
        case let .invalidPayload(message):
            "The engine response could not be decoded: \(message)"
        }
    }
}

actor EngineClient {
    private let configuration: EngineConfiguration
    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    init(
        configuration: EngineConfiguration = .load(),
        session: URLSession = .shared
    ) {
        self.configuration = configuration
        self.session = session

        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
    }

    func fetchState() async throws -> EngineSnapshot {
        let data = try await request(path: "/v1/state")
        return try decode(EngineSnapshot.self, from: data, envelopeKey: "state")
    }

    func fetchCheckpoints(projectID: String?) async throws -> [CheckpointSummary] {
        let query = projectID.map { [URLQueryItem(name: "projectId", value: $0)] } ?? []
        let data = try await request(path: "/v1/checkpoints", query: query)

        if let direct = try? decoder.decode([CheckpointSummary].self, from: data) {
            return direct
        }
        return try decode(CheckpointEnvelope.self, from: data).checkpoints
    }

    func fetchDiff(projectID: String?, sinceCheckpointID: String? = nil) async throws -> ContextDiffSummary {
        var query: [URLQueryItem] = []
        if let projectID {
            query.append(URLQueryItem(name: "projectId", value: projectID))
        }
        if let sinceCheckpointID {
            query.append(URLQueryItem(name: "sinceCheckpointId", value: sinceCheckpointID))
        }
        let data = try await request(path: "/v1/diff", query: query)
        return try decode(ContextDiffSummary.self, from: data, envelopeKey: "diff")
    }

    func generateBriefing(projectID: String?) async throws -> ContextDiffSummary {
        let body = try encoder.encode(BriefingRequest(projectId: projectID))
        let data = try await request(path: "/v1/diff/briefing", method: "POST", body: body)
        return try decode(ContextDiffSummary.self, from: data)
    }

    func replaySyntheticCatchUp() async throws {
        let body = try encoder.encode(DemoReplayRequest(phase: "monday"))
        _ = try await request(path: "/v1/demo/replay", method: "POST", body: body)
    }

    func fetchModelSettings() async throws -> ModelSettings {
        let data = try await request(path: "/v1/settings/models")
        return try decode(ModelSettings.self, from: data, envelopeKey: "settings")
    }

    func fetchPrivacy() async throws -> PrivacySummary {
        let data = try await request(path: "/v1/privacy")
        return try decode(PrivacySummary.self, from: data)
    }

    func revisionEvents() -> AsyncThrowingStream<Int, Error> {
        let configuration = configuration
        let session = session
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let url = configuration.baseURL.appendingPathComponent("v1/stream")
                    var request = URLRequest(url: url)
                    request.timeoutInterval = 60 * 60
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    if let token = configuration.credential.token {
                        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                    }

                    let (bytes, response) = try await session.bytes(for: request)
                    guard let httpResponse = response as? HTTPURLResponse else {
                        throw EngineClientError.invalidResponse
                    }
                    guard (200..<300).contains(httpResponse.statusCode) else {
                        throw EngineClientError.httpStatus(httpResponse.statusCode, "SSE connection rejected")
                    }

                    for try await line in bytes.lines {
                        try Task.checkCancellation()
                        guard line.hasPrefix("data:") else { continue }
                        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                        guard let data = payload.data(using: .utf8),
                              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                              let revision = object["revision"] as? Int else {
                            continue
                        }
                        continuation.yield(revision)
                    }
                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    func setCapturePaused(_ paused: Bool) async throws {
        let body = try encoder.encode(CaptureStateUpdate(capturePaused: paused))
        _ = try await request(path: "/v1/state", method: "PATCH", body: body)
    }

    func flush(projectID: String?) async throws {
        let body = try encoder.encode(FlushRequest(projectId: projectID))
        _ = try await request(path: "/v1/windows/flush", method: "POST", body: body)
    }

    func acknowledge(projectID: String, checkpointID: String?) async throws {
        let encodedProject = projectID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
            ?? projectID
        let body = try encoder.encode(AcknowledgeRequest(checkpointId: checkpointID))
        _ = try await request(
            path: "/v1/projects/\(encodedProject)/ack",
            method: "POST",
            body: body
        )
    }

    func updateModel(provider: ProviderKind, model: String) async throws -> ModelSettings {
        let current = (try? await fetchModelSettings()) ?? ModelSettings()
        let body = try encoder.encode(
            ModelUpdateRequest(
                activeCheckpointProvider: provider == .local ? "ollama" : "openai",
                ollamaModel: provider == .local ? model : current.localModel,
                openaiModel: provider == .openai ? model : current.cloudModel
            )
        )
        let data = try await request(path: "/v1/settings/models", method: "PATCH", body: body)
        if data.isEmpty {
            return ModelSettings(
                provider: provider,
                model: model,
                localModel: provider == .local ? model : "gemma3n:e2b",
                cloudModel: provider == .openai ? model : "gpt-5.6-terra"
            )
        }
        return try decode(ModelSettings.self, from: data, envelopeKey: "settings")
    }

    private func request(
        path: String,
        method: String = "GET",
        query: [URLQueryItem] = [],
        body: Data? = nil
    ) async throws -> Data {
        var components = URLComponents(
            url: configuration.baseURL.appendingPathComponent(path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))),
            resolvingAgainstBaseURL: false
        )
        if !query.isEmpty {
            components?.queryItems = query
        }
        guard let url = components?.url else {
            throw EngineClientError.invalidResponse
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 8
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = configuration.credential.token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw EngineClientError.invalidResponse
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            let message = String(data: data.prefix(512), encoding: .utf8) ?? "Unknown error"
            throw EngineClientError.httpStatus(httpResponse.statusCode, message)
        }
        return data
    }

    private func decode<Value: Decodable>(
        _ type: Value.Type,
        from data: Data,
        envelopeKey: String? = nil
    ) throws -> Value {
        guard !data.isEmpty else {
            throw EngineClientError.emptyResponse
        }
        if let direct = try? decoder.decode(type, from: data) {
            return direct
        }

        if let envelopeKey,
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let nested = object[envelopeKey],
           JSONSerialization.isValidJSONObject(nested),
           let nestedData = try? JSONSerialization.data(withJSONObject: nested),
           let value = try? decoder.decode(type, from: nestedData) {
            return value
        }

        do {
            return try decoder.decode(type, from: data)
        } catch {
            throw EngineClientError.invalidPayload(error.localizedDescription)
        }
    }
}

private struct CaptureStateUpdate: Encodable {
    let capturePaused: Bool
}

private struct FlushRequest: Encodable {
    let projectId: String?
}

private struct BriefingRequest: Encodable {
    let projectId: String?
}

private struct DemoReplayRequest: Encodable {
    let phase: String
}

private struct AcknowledgeRequest: Encodable {
    let checkpointId: String?
}

private struct ModelUpdateRequest: Encodable {
    let activeCheckpointProvider: String
    let ollamaModel: String
    let openaiModel: String
}

private struct CheckpointEnvelope: Decodable {
    let checkpoints: [CheckpointSummary]
}
