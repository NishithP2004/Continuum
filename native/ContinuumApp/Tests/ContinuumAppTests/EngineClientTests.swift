import Foundation
import XCTest
@testable import ContinuumApp

final class EngineClientTests: XCTestCase {
    override func tearDown() {
        URLProtocolStub.handler = nil
        super.tearDown()
    }

    func testFetchStateUsesBearerTokenAndLoopbackRoute() async throws {
        URLProtocolStub.handler = { request in
            XCTAssertEqual(request.url?.absoluteString, "http://127.0.0.1:43117/v1/state")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")

            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            let body = Data(
                #"""
                {
                  "revision": 1,
                  "connected": true,
                  "capturePaused": false,
                  "projectId": null,
                  "eventCount": 0,
                  "checkpointCount": 0,
                  "droppedSecretCount": 0,
                  "retrievalMode": "hybrid",
                  "settings": {
                    "activeCheckpointProvider": "openai",
                    "ollamaModel": "gemma3n:e2b",
                    "openaiModel": "gpt-5.6-terra"
                  },
                  "providerHealth": {"ollama": "unknown", "openai": "available"}
                }
                """#.utf8
            )
            return (response, body)
        }

        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.protocolClasses = [URLProtocolStub.self]
        let session = URLSession(configuration: sessionConfiguration)
        let configuration = EngineConfiguration(
            baseURL: EngineConfiguration.defaultURL,
            credential: CredentialSource(token: "test-token", description: "Test")
        )
        let client = EngineClient(configuration: configuration, session: session)

        let state = try await client.fetchState()

        XCTAssertEqual(state.status, "ok")
        XCTAssertEqual(state.provider.provider, "openai")
        XCTAssertFalse(state.retrieval.degraded)
    }

    func testChromePairingLifecycleUsesAuthenticatedRoutes() async throws {
        let pairingID = "10000000-0000-4000-8000-000000000001"
        URLProtocolStub.handler = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/v1/pairing/chrome"):
                return (
                    response,
                    Data(
                        #"{"pairings":[{"id":"\#(pairingID)","kind":"chrome","clientId":"chrome-client-0001","status":"pending","createdAt":"2099-07-20T12:00:00Z","expiresAt":"2099-07-20T12:05:00Z"}]}"#.utf8
                    )
                )
            case ("POST", "/v1/pairing/chrome/\(pairingID)/approve"):
                return (response, Data(#"{"approved":true}"#.utf8))
            case ("DELETE", "/v1/pairing/chrome/\(pairingID)"):
                return (response, Data(#"{"revoked":true}"#.utf8))
            default:
                XCTFail("Unexpected request: \(request.httpMethod ?? "") \(request.url?.absoluteString ?? "")")
                return (response, Data())
            }
        }

        let client = makeClient()
        let pairings = try await client.fetchChromePairings()
        let pairing = try XCTUnwrap(pairings.first)

        XCTAssertEqual(pairing.clientID, "chrome-client-0001")
        XCTAssertTrue(pairing.isPending)
        try await client.approveChromePairing(id: pairing.id)
        try await client.revokeChromePairing(id: pairing.id)
    }

    func testProjectIdentityConflictRoutesSendExplicitTarget() async throws {
        let conflictID = "20000000-0000-4000-8000-000000000001"
        let targetProjectID = "30000000-0000-4000-8000-000000000001"
        let conflict = #"{"id":"\#(conflictID)","deviceId":"device-native-1","localAlias":"alias-hash","normalizedName":"continuum","repositoryFingerprint":"fingerprint","assignedProjectId":"40000000-0000-4000-8000-000000000001","candidates":[{"projectId":"\#(targetProjectID)","label":"Continuum"}],"status":"pending","createdAt":"2026-07-20T12:00:00Z","updatedAt":"2026-07-20T12:00:00Z"}"#

        URLProtocolStub.handler = { request in
            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/v1/projects/identity/conflicts"):
                XCTAssertEqual(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)?.queryItems,
                               [URLQueryItem(name: "status", value: "pending")])
                return (response, Data("{\"conflicts\":[\(conflict)]}".utf8))
            case ("POST", "/v1/projects/identity/conflicts/\(conflictID)/confirm"):
                let body = try requestBodyData(request)
                let object = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: String])
                XCTAssertEqual(object, ["targetProjectId": targetProjectID])
                let confirmed = conflict
                    .replacingOccurrences(of: #""status":"pending""#, with: #""status":"confirmed""#)
                    .dropLast()
                    + #", "confirmedProjectId":"\#(targetProjectID)"}"#
                return (response, Data("{\"conflict\":\(confirmed)}".utf8))
            default:
                XCTFail("Unexpected request: \(request.httpMethod ?? "") \(request.url?.absoluteString ?? "")")
                return (response, Data())
            }
        }

        let client = makeClient()
        let conflicts = try await client.fetchProjectIdentityConflicts()
        let pending = try XCTUnwrap(conflicts.first)
        XCTAssertEqual(pending.candidates.first?.label, "Continuum")

        let confirmed = try await client.confirmProjectIdentityConflict(
            id: pending.id,
            targetProjectID: targetProjectID
        )
        XCTAssertEqual(confirmed.status, "confirmed")
        XCTAssertEqual(confirmed.confirmedProjectID, targetProjectID)
    }

    func testChatRequestsCarryPrivacyEligibilityRunIDAndCancellation() async throws {
        let sessionID = "50000000-0000-4000-8000-000000000001"
        let runID = "60000000-0000-4000-8000-000000000001"
        URLProtocolStub.handler = { request in
            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": request.url?.path.contains("messages") == true ? "text/event-stream" : "application/json"]
            )!
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/v1/chat/sessions"):
                let object = try XCTUnwrap(
                    JSONSerialization.jsonObject(with: try requestBodyData(request)) as? [String: String]
                )
                XCTAssertEqual(object["projectId"], "project-1")
                XCTAssertEqual(object["classification"], "personal")
                XCTAssertEqual(object["syncEligibility"], "cloud_eligible")
                return (
                    response,
                    Data(
                        #"{"session":{"id":"\#(sessionID)","projectId":"project-1","title":"New conversation","classification":"personal","syncEligibility":"cloud_eligible","createdAt":"2026-07-20T12:00:00Z","updatedAt":"2026-07-20T12:00:00Z"}}"#.utf8
                    )
                )
            case ("POST", "/v1/chat/sessions/\(sessionID)/messages"):
                let object = try XCTUnwrap(
                    JSONSerialization.jsonObject(with: try requestBodyData(request)) as? [String: String]
                )
                XCTAssertEqual(object["text"], "What changed?")
                XCTAssertEqual(object["runId"], runID)
                return (
                    response,
                    Data(
                        "data: {\"type\":\"run_started\",\"runId\":\"\(runID)\",\"sessionId\":\"\(sessionID)\"}\n\ndata: {\"type\":\"delta\",\"text\":\"Grounded answer\"}\n\n".utf8
                    )
                )
            case ("POST", "/v1/chat/runs/\(runID)/cancel"):
                return (response, Data("{\"runId\":\"\(runID)\",\"cancelled\":true}".utf8))
            default:
                XCTFail("Unexpected request: \(request.httpMethod ?? "") \(request.url?.absoluteString ?? "")")
                return (response, Data())
            }
        }

        let client = makeClient()
        let session = try await client.createChatSession(
            projectID: "project-1",
            classification: "personal",
            syncEligibility: "cloud_eligible"
        )
        XCTAssertEqual(session.syncEligibility, "cloud_eligible")

        let stream = await client.chatEvents(
            sessionID: session.id,
            text: "What changed?",
            projectID: "project-1",
            runID: runID
        )
        var events: [ChatRunEvent] = []
        for try await event in stream {
            events.append(event)
        }
        XCTAssertEqual(events.first?.runID, runID)
        XCTAssertEqual(events.last?.delta, "Grounded answer")
        try await client.cancelChatRun(id: runID)
    }

    func testModelSwitchPreservesOtherProviderSelectionsWithoutFallbackFetch() async throws {
        URLProtocolStub.handler = { request in
            XCTAssertEqual(request.httpMethod, "PATCH")
            XCTAssertEqual(request.url?.path, "/v1/settings/models")
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: try requestBodyData(request)) as? [String: String]
            )
            XCTAssertEqual(object["activeCheckpointProvider"], "apple")
            XCTAssertEqual(object["activeChatProvider"], "apple")
            XCTAssertEqual(object["ollamaModel"], "custom-local")
            XCTAssertEqual(object["appleModel"], "apple-system-default")
            XCTAssertEqual(object["openaiModel"], "custom-cloud")

            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            return (
                response,
                Data(
                    #"{"settings":{"activeCheckpointProvider":"apple","activeChatProvider":"apple","ollamaModel":"custom-local","foundationModel":"apple-system-default","openaiModel":"custom-cloud"}}"#.utf8
                )
            )
        }

        let current = ModelSettings(
            provider: .local,
            chatProvider: .local,
            model: "custom-local",
            localModel: "custom-local",
            appleModel: "apple-system-default",
            cloudModel: "custom-cloud"
        )
        let selected = try await makeClient().updateModel(
            provider: .apple,
            model: "apple-system-default",
            preserving: current
        )

        XCTAssertEqual(selected.provider, .apple)
        XCTAssertEqual(selected.model, "apple-system-default")
        XCTAssertEqual(selected.localModel, "custom-local")
        XCTAssertEqual(selected.cloudModel, "custom-cloud")
    }

    private func makeClient() -> EngineClient {
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.protocolClasses = [URLProtocolStub.self]
        return EngineClient(
            configuration: EngineConfiguration(
                baseURL: EngineConfiguration.defaultURL,
                credential: CredentialSource(token: "test-token", description: "Test")
            ),
            session: URLSession(configuration: sessionConfiguration)
        )
    }
}

private func requestBodyData(_ request: URLRequest) throws -> Data {
    if let body = request.httpBody {
        return body
    }
    let stream = try XCTUnwrap(request.httpBodyStream)
    stream.open()
    defer { stream.close() }

    var result = Data()
    var buffer = [UInt8](repeating: 0, count: 4_096)
    while true {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count < 0 {
            throw stream.streamError ?? EngineClientError.invalidResponse
        }
        if count == 0 { break }
        result.append(contentsOf: buffer.prefix(count))
    }
    return result
}

private final class URLProtocolStub: URLProtocol {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: EngineClientError.invalidResponse)
            return
        }

        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
