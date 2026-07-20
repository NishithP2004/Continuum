import Foundation

struct EngineConfiguration: Equatable, Sendable {
    static let defaultURL = URL(string: "http://127.0.0.1:43117")!

    let baseURL: URL
    let credential: CredentialSource

    static func load(
        preferredBaseURL: String? = UserDefaults.standard.string(forKey: "continuum.daemonURL")
    ) -> EngineConfiguration {
        validated(preferredBaseURL: preferredBaseURL)
            ?? EngineConfiguration(baseURL: defaultURL, credential: CredentialLoader.load())
    }

    static func validated(preferredBaseURL: String?) -> EngineConfiguration? {
        guard let url = validatedLoopbackURL(preferredBaseURL) else { return nil }
        return EngineConfiguration(baseURL: url, credential: CredentialLoader.load())
    }

    static func validatedLoopbackURL(_ value: String?) -> URL? {
        guard let raw = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty,
              let url = URL(string: raw),
              url.scheme?.lowercased() == "http",
              ["127.0.0.1", "localhost"].contains(url.host?.lowercased() ?? ""),
              url.port == 43_117,
              url.user == nil,
              url.password == nil,
              url.query == nil,
              url.fragment == nil,
              url.path.isEmpty || url.path == "/" else {
            return nil
        }
        return url
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

    func fetchModelSettings() async throws -> ModelSettings {
        let data = try await request(path: "/v1/settings/models")
        return try decode(ModelSettings.self, from: data, envelopeKey: "settings")
    }

    func fetchPrivacy() async throws -> PrivacySummary {
        let data: Data
        do {
            data = try await request(path: "/v1/privacy/audit")
        } catch EngineClientError.httpStatus(404, _) {
            let legacy = try await request(path: "/v1/privacy")
            return try decode(PrivacySummary.self, from: legacy)
        }
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let nested = object["summary"],
               JSONSerialization.isValidJSONObject(nested),
               let nestedData = try? JSONSerialization.data(withJSONObject: nested),
               let summary = try? decoder.decode(PrivacySummary.self, from: nestedData) {
                return summary
            }
            if object["accepted"] != nil || object["droppedSecrets"] != nil || object["secretRejected"] != nil,
               let summary = try? decoder.decode(PrivacySummary.self, from: data) {
                return summary
            }
        }
        let legacy = try await request(path: "/v1/privacy")
        return try decode(PrivacySummary.self, from: legacy)
    }

    func fetchPrivacyPolicy() async throws -> PrivacyPolicyV1 {
        let data = try await request(path: "/v1/settings/privacy")
        return try decode(PrivacyPolicyV1.self, from: data, envelopeKey: "policy")
    }

    func updatePrivacyPolicy(_ policy: PrivacyPolicyV1) async throws -> PrivacyPolicyV1 {
        let data = try await request(
            path: "/v1/settings/privacy",
            method: "PATCH",
            body: try encoder.encode(policy)
        )
        guard !data.isEmpty else { return policy }
        return try decode(PrivacyPolicyV1.self, from: data, envelopeKey: "policy")
    }

    func fetchPrivacyAudit() async throws -> [PrivacyAuditEntry] {
        let data = try await request(path: "/v1/privacy/audit")
        if let direct = try? decoder.decode([PrivacyAuditEntry].self, from: data) {
            return direct
        }
        return try decode(PrivacyAuditEnvelope.self, from: data).entries
    }

    func fetchChromePairings() async throws -> [CollectorPairing] {
        let data = try await request(path: "/v1/pairing/chrome")
        if let direct = try? decoder.decode([CollectorPairing].self, from: data) {
            return direct
        }
        return try decode(CollectorPairingEnvelope.self, from: data).pairings
    }

    func approveChromePairing(id: String) async throws {
        let encodedID = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        _ = try await request(path: "/v1/pairing/chrome/\(encodedID)/approve", method: "POST")
    }

    func revokeChromePairing(id: String) async throws {
        let encodedID = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        _ = try await request(path: "/v1/pairing/chrome/\(encodedID)", method: "DELETE")
    }

    func fetchProjectIdentityConflicts() async throws -> [ProjectIdentityConflict] {
        let data = try await request(
            path: "/v1/projects/identity/conflicts",
            query: [URLQueryItem(name: "status", value: "pending")]
        )
        if let direct = try? decoder.decode([ProjectIdentityConflict].self, from: data) {
            return direct
        }
        return try decode(ProjectIdentityConflictEnvelope.self, from: data).conflicts
    }

    func confirmProjectIdentityConflict(
        id: String,
        targetProjectID: String
    ) async throws -> ProjectIdentityConflict {
        let encodedID = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        let data = try await request(
            path: "/v1/projects/identity/conflicts/\(encodedID)/confirm",
            method: "POST",
            body: try encoder.encode(ProjectIdentityConfirmationRequest(targetProjectId: targetProjectID))
        )
        return try decode(ProjectIdentityConflict.self, from: data, envelopeKey: "conflict")
    }

    func fetchGraph(_ query: GraphQuery) async throws -> GraphSnapshot {
        let data = try await request(
            path: "/v1/graph/query",
            method: "POST",
            body: try encoder.encode(query)
        )
        return try decode(GraphSnapshot.self, from: data, envelopeKey: "graph")
    }

    func fetchSyncStatus() async throws -> SyncStatus {
        let data = try await request(path: "/v1/sync/status")
        return try decode(SyncStatus.self, from: data, envelopeKey: "sync")
    }

    func configureRemoteSync(endpoint: URL, accessToken: String) async throws -> SyncStatus {
        let data = try await request(
            path: "/v1/settings/sync",
            method: "PATCH",
            body: try encoder.encode(
                SyncSettingsUpdate(
                    endpoint: endpoint.absoluteString,
                    accessToken: accessToken,
                    disconnect: nil
                )
            )
        )
        return try decode(SyncStatus.self, from: data, envelopeKey: "sync")
    }

    func disconnectRemoteSync() async throws -> SyncStatus {
        let data = try await request(
            path: "/v1/settings/sync",
            method: "PATCH",
            body: try encoder.encode(SyncSettingsUpdate(endpoint: nil, accessToken: nil, disconnect: true))
        )
        return try decode(SyncStatus.self, from: data, envelopeKey: "sync")
    }

    func fetchDevices() async throws -> [DeviceSummary] {
        let data = try await request(path: "/v1/sync/devices")
        if let direct = try? decoder.decode([DeviceSummary].self, from: data) {
            return direct
        }
        return try decode(DeviceEnvelope.self, from: data).devices
    }

    func revokeDevice(id: String) async throws {
        let encodedID = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        _ = try await request(path: "/v1/sync/devices/\(encodedID)", method: "DELETE")
    }

    func reconnectSync() async throws {
        _ = try await request(path: "/v1/sync/reconnect", method: "POST")
    }

    func submit(events: [NativeCollectedEvent]) async throws {
        guard !events.isEmpty else { return }
        let body = try encoder.encode(EventBatchRequest(events: events))
        _ = try await request(path: "/v1/events/batch", method: "POST", body: body)
    }

    func createChatSession(
        projectID: String?,
        classification: String,
        syncEligibility: String
    ) async throws -> ChatSession {
        let body = try encoder.encode(
            CreateChatSessionRequest(
                projectId: projectID,
                classification: classification,
                syncEligibility: syncEligibility
            )
        )
        let data = try await request(path: "/v1/chat/sessions", method: "POST", body: body)
        return try decode(ChatSession.self, from: data, envelopeKey: "session")
    }

    func chatEvents(
        sessionID: String,
        text: String,
        projectID: String?,
        runID: String
    ) -> AsyncThrowingStream<ChatRunEvent, Error> {
        let configuration = configuration
        let session = session
        let encoder = encoder
        let decoder = decoder

        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let encodedSession = sessionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
                        ?? sessionID
                    let url = configuration.baseURL
                        .appendingPathComponent("v1/chat/sessions/\(encodedSession)/messages")
                    var request = URLRequest(url: url)
                    request.httpMethod = "POST"
                    request.timeoutInterval = 5 * 60
                    request.setValue("text/event-stream, application/json", forHTTPHeaderField: "Accept")
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    if let token = configuration.credential.token {
                        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                    }
                    request.httpBody = try encoder.encode(
                        ChatMessageRequest(text: text, projectId: projectID, runId: runID)
                    )

                    let (bytes, response) = try await session.bytes(for: request)
                    guard let httpResponse = response as? HTTPURLResponse else {
                        throw EngineClientError.invalidResponse
                    }
                    guard (200..<300).contains(httpResponse.statusCode) else {
                        throw EngineClientError.httpStatus(httpResponse.statusCode, "Chat request rejected")
                    }

                    for try await line in bytes.lines {
                        try Task.checkCancellation()
                        let raw: String
                        if line.hasPrefix("data:") {
                            raw = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                        } else {
                            raw = line
                        }
                        guard !raw.isEmpty, raw != "[DONE]", let data = raw.data(using: .utf8) else {
                            continue
                        }
                        if let event = try? decoder.decode(ChatRunEvent.self, from: data) {
                            continuation.yield(event)
                        } else if let message = try? decoder.decode(ChatMessage.self, from: data) {
                            continuation.yield(ChatRunEvent(type: "message", message: message))
                        }
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

    func cancelChatRun(id: String) async throws {
        let encodedID = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        do {
            _ = try await request(path: "/v1/chat/runs/\(encodedID)/cancel", method: "POST")
        } catch EngineClientError.httpStatus(404, _) {
            // The response may have finished between clicking Stop and the
            // cancellation request reaching the local daemon.
        }
    }

    func confirmAction(sessionID _: String, actionID: String) async throws -> ContextAction {
        let encodedAction = actionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
            ?? actionID
        let data = try await request(
            path: "/v1/chat/actions/\(encodedAction)/confirm",
            method: "POST"
        )
        return try decode(ContextAction.self, from: data, envelopeKey: "action")
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

    func updateModel(
        provider: ProviderKind,
        model: String,
        preserving currentSettings: ModelSettings? = nil
    ) async throws -> ModelSettings {
        let current: ModelSettings
        if let currentSettings {
            current = currentSettings
        } else {
            current = try await fetchModelSettings()
        }
        guard let selected = current.selecting(provider: provider, model: model) else {
            throw EngineClientError.invalidPayload(
                "Choose a non-empty model identifier of at most 200 characters."
            )
        }
        let body = try encoder.encode(
            ModelUpdateRequest(
                activeCheckpointProvider: provider.engineValue,
                activeChatProvider: provider.engineValue,
                ollamaModel: selected.localModel,
                appleModel: selected.appleModel,
                openaiModel: selected.cloudModel
            )
        )
        let data = try await request(path: "/v1/settings/models", method: "PATCH", body: body)
        if data.isEmpty {
            return selected
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
        if let envelopeKey,
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let nested = object[envelopeKey],
           JSONSerialization.isValidJSONObject(nested),
           let nestedData = try? JSONSerialization.data(withJSONObject: nested),
           let value = try? decoder.decode(type, from: nestedData) {
            return value
        }

        if let direct = try? decoder.decode(type, from: data) {
            return direct
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

private struct AcknowledgeRequest: Encodable {
    let checkpointId: String?
}

private struct ModelUpdateRequest: Encodable {
    let activeCheckpointProvider: String
    let activeChatProvider: String
    let ollamaModel: String
    let appleModel: String
    let openaiModel: String
}

private struct SyncSettingsUpdate: Encodable {
    let endpoint: String?
    let accessToken: String?
    let disconnect: Bool?
}

private struct CheckpointEnvelope: Decodable {
    let checkpoints: [CheckpointSummary]
}

private struct PrivacyAuditEnvelope: Decodable {
    let entries: [PrivacyAuditEntry]

    private enum CodingKeys: String, CodingKey { case entries, audit }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        entries = try values.decodeIfPresent([PrivacyAuditEntry].self, forKey: .entries)
            ?? values.decodeIfPresent([PrivacyAuditEntry].self, forKey: .audit)
            ?? []
    }
}

private struct CollectorPairingEnvelope: Decodable {
    let pairings: [CollectorPairing]
}

private struct ProjectIdentityConflictEnvelope: Decodable {
    let conflicts: [ProjectIdentityConflict]
}

private struct ProjectIdentityConfirmationRequest: Encodable {
    let targetProjectId: String
}

private struct DeviceEnvelope: Decodable {
    let devices: [DeviceSummary]
}

private struct EventBatchRequest: Encodable {
    let events: [NativeCollectedEvent]
}

private struct CreateChatSessionRequest: Encodable {
    let projectId: String?
    let classification: String
    let syncEligibility: String
}

private struct ChatMessageRequest: Encodable {
    let text: String
    let projectId: String?
    let runId: String
}
