import Foundation
import XCTest
@testable import ContinuumApp

final class RemoteAuthenticationTests: XCTestCase {
    override func tearDown() {
        RemoteAuthURLProtocolStub.handler = nil
        super.tearDown()
    }

    func testPKCEChallengeMatchesRFC7636Vector() throws {
        let challenge = try PKCEChallenge(
            verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        )

        XCTAssertEqual(challenge.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    func testAuthorizationRequestUsesCodePKCEAudienceAndState() throws {
        let configuration = try configuration()
        let url = try Auth0AuthenticationService.authorizationURL(
            configuration: configuration,
            challenge: "challenge-value",
            state: "state-value"
        )
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        let values = Dictionary(uniqueKeysWithValues: try XCTUnwrap(components.queryItems).map { ($0.name, $0.value ?? "") })

        XCTAssertEqual(url.scheme, "https")
        XCTAssertEqual(url.host, "tenant.example.test")
        XCTAssertEqual(url.path, "/authorize")
        XCTAssertEqual(values["response_type"], "code")
        XCTAssertEqual(values["code_challenge_method"], "S256")
        XCTAssertEqual(values["code_challenge"], "challenge-value")
        XCTAssertEqual(values["state"], "state-value")
        XCTAssertEqual(values["audience"], "https://continuum.example.test")
        XCTAssertEqual(values["redirect_uri"], "dev.continuum.app://auth/callback")
        XCTAssertTrue(try XCTUnwrap(values["scope"]).contains("offline_access"))
        XCTAssertNil(values["client_secret"])
    }

    func testCallbackRequiresMatchingStateAndAuthorizationCode() throws {
        let callback = try XCTUnwrap(URL(string: "dev.continuum.app://auth/callback?code=one-time-code&state=expected"))
        XCTAssertEqual(
            try Auth0AuthenticationService.authorizationCode(from: callback, expectedState: "expected"),
            "one-time-code"
        )
        XCTAssertThrowsError(
            try Auth0AuthenticationService.authorizationCode(from: callback, expectedState: "different")
        ) { error in
            XCTAssertEqual(error as? RemoteAuthenticationError, .stateMismatch)
        }
    }

    func testConfigurationRequiresHTTPSExceptForLoopbackService() throws {
        XCTAssertThrowsError(
            try RemoteAuthenticationConfiguration(
                serviceURL: "http://continuum.example.test",
                issuer: "https://tenant.example.test/",
                clientID: "native-client",
                audience: "https://continuum.example.test",
                scopes: "openid offline_access sync:read sync:write",
                callbackScheme: "dev.continuum.app"
            )
        )
        XCTAssertNoThrow(
            try RemoteAuthenticationConfiguration(
                serviceURL: "http://127.0.0.1:43118/",
                issuer: "https://tenant.example.test/",
                clientID: "native-client",
                audience: "https://continuum.example.test",
                scopes: "openid offline_access sync:read sync:write",
                callbackScheme: "dev.continuum.app"
            )
        )
    }

    func testPreferencesPersistOnlyNonSecretConfiguration() throws {
        let suiteName = "RemoteAuthenticationTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let draft = RemoteAuthenticationDraft(
            serviceURL: "https://continuum.example.test",
            issuer: "https://tenant.example.test",
            clientID: "native-client",
            audience: "https://continuum.example.test",
            scopes: "openid offline_access sync:read sync:write"
        )

        draft.save(defaults: defaults)
        let persisted = try XCTUnwrap(defaults.persistentDomain(forName: suiteName))
        XCTAssertEqual(persisted.count, 5)
        XCTAssertFalse(persisted.keys.contains(where: { $0.localizedCaseInsensitiveContains("token") }))
        XCTAssertFalse(persisted.keys.contains(where: { $0.localizedCaseInsensitiveContains("secret") }))
    }

    func testRestoreRotatesRefreshCredentialAndKeepsAccessTokenInMemory() async throws {
        let configuration = try configuration()
        let store = InMemoryRefreshCredentialStore()
        try store.write("old-refresh-credential", account: configuration.credentialAccount)
        RemoteAuthURLProtocolStub.handler = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://tenant.example.test/oauth/token")
            XCTAssertEqual(request.httpMethod, "POST")
            let body = try request.bodyData().utf8String
            XCTAssertTrue(body.contains("grant_type=refresh_token"))
            XCTAssertTrue(body.contains("refresh_token=old-refresh-credential"))
            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            return (
                response,
                Data(#"{"access_token":"memory-only-access-token","refresh_token":"rotated-refresh-credential","token_type":"Bearer","expires_in":3600}"#.utf8)
            )
        }
        let session = stubSession()
        let service = await MainActor.run {
            Auth0AuthenticationService(credentialStore: store, session: session)
        }

        let access = try await service.restore(configuration: configuration)

        XCTAssertEqual(access.accessToken, "memory-only-access-token")
        XCTAssertEqual(try store.read(account: configuration.credentialAccount), "rotated-refresh-credential")
        session.invalidateAndCancel()
    }

    func testSignOutDeletesLocalCredentialBeforeRemoteRevocationCompletes() async throws {
        let configuration = try configuration()
        let store = InMemoryRefreshCredentialStore()
        try store.write("refresh-to-revoke", account: configuration.credentialAccount)
        RemoteAuthURLProtocolStub.handler = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://tenant.example.test/oauth/token")
            let response = HTTPURLResponse(url: try XCTUnwrap(request.url), statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (
                response,
                Data(#"{"access_token":"memory-only-access-token","token_type":"Bearer","expires_in":3600}"#.utf8)
            )
        }
        let session = stubSession()
        let service = await MainActor.run {
            Auth0AuthenticationService(credentialStore: store, session: session)
        }
        _ = try await service.restore(configuration: configuration)
        RemoteAuthURLProtocolStub.handler = { request in
            XCTAssertEqual(request.url?.absoluteString, "https://tenant.example.test/oauth/revoke")
            XCTAssertNil(try store.read(account: configuration.credentialAccount))
            let body = try request.bodyData().utf8String
            XCTAssertTrue(body.contains("token=refresh-to-revoke"))
            return (
                HTTPURLResponse(url: try XCTUnwrap(request.url), statusCode: 200, httpVersion: nil, headerFields: nil)!,
                Data()
            )
        }

        try await service.signOut()

        XCTAssertNil(try store.read(account: configuration.credentialAccount))
        session.invalidateAndCancel()
    }

    private func configuration() throws -> RemoteAuthenticationConfiguration {
        try RemoteAuthenticationConfiguration(
            serviceURL: "https://continuum.example.test/",
            issuer: "https://tenant.example.test/",
            clientID: "native-client",
            audience: "https://continuum.example.test",
            scopes: "openid profile offline_access context:read sync:read sync:write",
            callbackScheme: "dev.continuum.app"
        )
    }

    private func stubSession() -> URLSession {
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.protocolClasses = [RemoteAuthURLProtocolStub.self]
        return URLSession(configuration: sessionConfiguration)
    }
}

private final class InMemoryRefreshCredentialStore: RefreshCredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]

    func read(account: String) throws -> String? {
        lock.withLock { values[account] }
    }

    func write(_ credential: String, account: String) throws {
        lock.withLock { values[account] = credential }
    }

    func delete(account: String) throws {
        lock.withLock { _ = values.removeValue(forKey: account) }
    }
}

private final class RemoteAuthURLProtocolStub: URLProtocol {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: RemoteAuthenticationError.callbackRejected)
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

private extension Data {
    var utf8String: String {
        String(data: self, encoding: .utf8) ?? ""
    }
}

private extension URLRequest {
    func bodyData() throws -> Data {
        if let httpBody { return httpBody }
        guard let stream = httpBodyStream else {
            throw RemoteAuthenticationError.callbackRejected
        }
        stream.open()
        defer { stream.close() }
        var result = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { throw stream.streamError ?? RemoteAuthenticationError.callbackRejected }
            if count == 0 { break }
            result.append(buffer, count: count)
        }
        return result
    }
}
