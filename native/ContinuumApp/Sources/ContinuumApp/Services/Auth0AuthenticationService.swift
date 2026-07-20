import AppKit
import AuthenticationServices
import CryptoKit
import Foundation
import Security

struct PKCEChallenge: Equatable, Sendable {
    let verifier: String
    let challenge: String

    init(verifier: String) throws {
        guard verifier.range(of: #"^[A-Za-z0-9._~-]{43,128}$"#, options: .regularExpression) != nil else {
            throw RemoteAuthenticationError.invalidConfiguration("The PKCE verifier is invalid.")
        }
        self.verifier = verifier
        challenge = Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    static func generate() throws -> PKCEChallenge {
        try PKCEChallenge(verifier: base64URL(try secureRandom(count: 64)))
    }

    fileprivate static func secureRandom(count: Int) throws -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw RemoteAuthenticationError.tokenExchangeFailed("Secure random generation is unavailable.")
        }
        return Data(bytes)
    }

    fileprivate static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

@MainActor
final class Auth0AuthenticationService: NSObject, ASWebAuthenticationPresentationContextProviding {
    private let credentialStore: any RefreshCredentialStore
    private let session: URLSession
    private var browserSession: ASWebAuthenticationSession?
    private var activeConfiguration: RemoteAuthenticationConfiguration?
    private var accessSession: RemoteAccessSession?
    private lazy var fallbackAnchor = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 1, height: 1),
        styleMask: [],
        backing: .buffered,
        defer: false
    )

    init(
        credentialStore: any RefreshCredentialStore = KeychainRefreshCredentialStore(),
        session: URLSession? = nil
    ) {
        self.credentialStore = credentialStore
        self.session = session ?? URLSession(configuration: .ephemeral)
    }

    func signIn(configuration: RemoteAuthenticationConfiguration) async throws -> RemoteAccessSession {
        cancelInteractiveSignIn()
        let pkce = try PKCEChallenge.generate()
        let state = PKCEChallenge.base64URL(try PKCEChallenge.secureRandom(count: 32))
        let authorizationURL = try Self.authorizationURL(
            configuration: configuration,
            challenge: pkce.challenge,
            state: state
        )
        let callback = try await openAuthorizationSession(
            authorizationURL: authorizationURL,
            callbackScheme: configuration.callbackScheme
        )
        let code = try Self.authorizationCode(from: callback, expectedState: state)
        let response = try await tokenRequest(
            configuration: configuration,
            parameters: [
                "grant_type": "authorization_code",
                "client_id": configuration.clientID,
                "code": code,
                "code_verifier": pkce.verifier,
                "redirect_uri": configuration.callbackURL.absoluteString
            ]
        )
        guard let refreshToken = response.refreshToken?.nonEmpty else {
            throw RemoteAuthenticationError.tokenExchangeFailed(
                "Auth0 did not issue a refresh credential. Enable offline access and refresh-token rotation for this native application."
            )
        }
        let access = try response.accessSession()
        try credentialStore.write(refreshToken, account: configuration.credentialAccount)
        activeConfiguration = configuration
        accessSession = access
        return access
    }

    func restore(configuration: RemoteAuthenticationConfiguration) async throws -> RemoteAccessSession {
        if activeConfiguration == configuration, let accessSession, accessSession.isUsable() {
            return accessSession
        }
        if activeConfiguration != configuration { accessSession = nil }
        activeConfiguration = configuration
        guard let refreshToken = try credentialStore.read(account: configuration.credentialAccount)?.nonEmpty else {
            throw RemoteAuthenticationError.noRefreshCredential
        }
        do {
            let response = try await tokenRequest(
                configuration: configuration,
                parameters: [
                    "grant_type": "refresh_token",
                    "client_id": configuration.clientID,
                    "refresh_token": refreshToken
                ]
            )
            if let rotated = response.refreshToken?.nonEmpty {
                try credentialStore.write(rotated, account: configuration.credentialAccount)
            }
            let access = try response.accessSession()
            accessSession = access
            return access
        } catch let error as Auth0HTTPError where error.oauthCode == "invalid_grant" {
            try? credentialStore.delete(account: configuration.credentialAccount)
            accessSession = nil
            throw RemoteAuthenticationError.noRefreshCredential
        }
    }

    func validAccessSession() async throws -> RemoteAccessSession {
        guard let configuration = activeConfiguration else {
            throw RemoteAuthenticationError.invalidConfiguration("Remote authentication is not configured.")
        }
        if let accessSession, accessSession.isUsable() { return accessSession }
        return try await restore(configuration: configuration)
    }

    func signOut() async throws {
        cancelInteractiveSignIn()
        accessSession = nil
        guard let configuration = activeConfiguration else { return }
        let refreshToken = try credentialStore.read(account: configuration.credentialAccount)
        try credentialStore.delete(account: configuration.credentialAccount)
        guard let refreshToken = refreshToken?.nonEmpty else { return }

        var request = URLRequest(url: configuration.revocationEndpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Self.formBody([
            "client_id": configuration.clientID,
            "token": refreshToken,
            "token_type_hint": "refresh_token"
        ])
        do {
            let (_, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw RemoteAuthenticationError.tokenExchangeFailed(
                    "The local session was removed, but Auth0 could not confirm remote refresh-token revocation."
                )
            }
        } catch let error as RemoteAuthenticationError {
            throw error
        } catch {
            throw RemoteAuthenticationError.tokenExchangeFailed(
                "The local session was removed, but Auth0 could not confirm remote refresh-token revocation."
            )
        }
    }

    func cancelInteractiveSignIn() {
        browserSession?.cancel()
        browserSession = nil
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        NSApp.keyWindow ?? NSApp.windows.first(where: { $0.isVisible }) ?? fallbackAnchor
    }

    nonisolated static func authorizationURL(
        configuration: RemoteAuthenticationConfiguration,
        challenge: String,
        state: String
    ) throws -> URL {
        guard !challenge.isEmpty, !state.isEmpty,
              var components = URLComponents(url: configuration.authorizationEndpoint, resolvingAgainstBaseURL: false) else {
            throw RemoteAuthenticationError.invalidConfiguration("The Auth0 authorization request is invalid.")
        }
        components.queryItems = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "response_mode", value: "query"),
            URLQueryItem(name: "client_id", value: configuration.clientID),
            URLQueryItem(name: "redirect_uri", value: configuration.callbackURL.absoluteString),
            URLQueryItem(name: "scope", value: configuration.scopes.joined(separator: " ")),
            URLQueryItem(name: "audience", value: configuration.audience),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state)
        ]
        guard let url = components.url else {
            throw RemoteAuthenticationError.invalidConfiguration("The Auth0 authorization request is invalid.")
        }
        return url
    }

    nonisolated static func authorizationCode(from callback: URL, expectedState: String) throws -> String {
        guard let components = URLComponents(url: callback, resolvingAgainstBaseURL: false) else {
            throw RemoteAuthenticationError.callbackRejected
        }
        var values: [String: String] = [:]
        for item in components.queryItems ?? [] {
            if values[item.name] != nil,
               ["state", "code", "error"].contains(item.name) {
                throw RemoteAuthenticationError.callbackRejected
            }
            values[item.name] = item.value ?? ""
        }
        guard values["state"] == expectedState else { throw RemoteAuthenticationError.stateMismatch }
        if values["error"] != nil { throw RemoteAuthenticationError.callbackRejected }
        guard let code = values["code"]?.nonEmpty, code.count <= 8_192 else {
            throw RemoteAuthenticationError.missingAuthorizationCode
        }
        return code
    }

    private func openAuthorizationSession(
        authorizationURL: URL,
        callbackScheme: String
    ) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(
                url: authorizationURL,
                callbackURLScheme: callbackScheme
            ) { [weak self] callbackURL, error in
                Task { @MainActor in
                    self?.browserSession = nil
                    if let authenticationError = error as? ASWebAuthenticationSessionError,
                       authenticationError.code == .canceledLogin {
                        continuation.resume(throwing: RemoteAuthenticationError.browserCancelled)
                    } else if error != nil {
                        continuation.resume(throwing: RemoteAuthenticationError.callbackRejected)
                    } else if let callbackURL {
                        continuation.resume(returning: callbackURL)
                    } else {
                        continuation.resume(throwing: RemoteAuthenticationError.callbackRejected)
                    }
                }
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            browserSession = session
            guard session.start() else {
                browserSession = nil
                continuation.resume(throwing: RemoteAuthenticationError.callbackRejected)
                return
            }
        }
    }

    private func tokenRequest(
        configuration: RemoteAuthenticationConfiguration,
        parameters: [String: String]
    ) async throws -> Auth0TokenResponse {
        var request = URLRequest(url: configuration.tokenEndpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = Self.formBody(parameters)

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                throw RemoteAuthenticationError.tokenExchangeFailed("Auth0 returned an invalid token response.")
            }
            guard (200..<300).contains(http.statusCode) else {
                let oauthCode = (try? JSONDecoder().decode(Auth0ErrorResponse.self, from: data))?.error
                throw Auth0HTTPError(statusCode: http.statusCode, oauthCode: oauthCode)
            }
            return try JSONDecoder().decode(Auth0TokenResponse.self, from: data)
        } catch let error as Auth0HTTPError {
            throw error
        } catch let error as RemoteAuthenticationError {
            throw error
        } catch {
            throw RemoteAuthenticationError.tokenExchangeFailed("Could not reach Auth0 to complete sign-in.")
        }
    }

    nonisolated private static func formBody(_ parameters: [String: String]) -> Data {
        var components = URLComponents()
        components.queryItems = parameters
            .sorted { $0.key < $1.key }
            .map { URLQueryItem(name: $0.key, value: $0.value) }
        return Data((components.percentEncodedQuery ?? "").utf8)
    }
}

private struct Auth0TokenResponse: Decodable {
    let accessToken: String
    let refreshToken: String?
    let tokenType: String
    let expiresIn: TimeInterval

    private enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
        case refreshToken = "refresh_token"
        case tokenType = "token_type"
        case expiresIn = "expires_in"
    }

    func accessSession() throws -> RemoteAccessSession {
        guard tokenType.caseInsensitiveCompare("Bearer") == .orderedSame,
              accessToken.count >= 12,
              accessToken.count <= 16_384,
              accessToken.rangeOfCharacter(from: .newlines) == nil,
              expiresIn > 0 else {
            throw RemoteAuthenticationError.tokenExchangeFailed("Auth0 returned an invalid access token.")
        }
        return RemoteAccessSession(
            accessToken: accessToken,
            expiresAt: Date().addingTimeInterval(expiresIn)
        )
    }
}

private struct Auth0ErrorResponse: Decodable {
    let error: String?
}

private struct Auth0HTTPError: LocalizedError {
    let statusCode: Int
    let oauthCode: String?

    var errorDescription: String? {
        if oauthCode == "invalid_grant" {
            return "The saved Auth0 session has expired or was revoked. Sign in again."
        }
        return "Auth0 rejected the token request (HTTP \(statusCode))."
    }
}

private extension String {
    var nonEmpty: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}
