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
