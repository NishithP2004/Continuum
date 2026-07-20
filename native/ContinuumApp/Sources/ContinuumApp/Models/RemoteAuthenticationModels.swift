import Foundation

enum RemoteAuthenticationPhase: String, Sendable {
    case notConfigured
    case signedOut
    case signingIn
    case refreshing
    case signedIn
    case signingOut
    case failed

    var title: String {
        switch self {
        case .notConfigured: "Not configured"
        case .signedOut: "Signed out"
        case .signingIn: "Signing in"
        case .refreshing: "Restoring session"
        case .signedIn: "Signed in"
        case .signingOut: "Signing out"
        case .failed: "Authentication failed"
        }
    }

    var isBusy: Bool {
        self == .signingIn || self == .refreshing || self == .signingOut
    }
}

struct RemoteAuthenticationState: Equatable, Sendable {
    var phase: RemoteAuthenticationPhase = .notConfigured
    var message = "Configure the self-hosted service and Auth0 native application to enable synchronization."
    var accessTokenExpiresAt: Date?

    var isAuthenticated: Bool { phase == .signedIn }
}

struct RemoteAuthenticationDraft: Equatable, Sendable {
    var serviceURL: String
    var issuer: String
    var clientID: String
    var audience: String
    var scopes: String

    static func load(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        defaults: UserDefaults = .standard
    ) -> RemoteAuthenticationDraft {
        func value(environmentKey: String, defaultsKey: String) -> String {
            let environmentValue = environment[environmentKey]?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let environmentValue, !environmentValue.isEmpty { return environmentValue }
            return defaults.string(forKey: defaultsKey) ?? ""
        }
        return RemoteAuthenticationDraft(
            serviceURL: value(environmentKey: "CONTINUUM_SYNC_URL", defaultsKey: PreferenceKey.serviceURL),
            issuer: value(environmentKey: "CONTINUUM_AUTH0_ISSUER", defaultsKey: PreferenceKey.issuer),
            clientID: value(environmentKey: "CONTINUUM_AUTH0_CLIENT_ID", defaultsKey: PreferenceKey.clientID),
            audience: value(environmentKey: "CONTINUUM_AUTH0_AUDIENCE", defaultsKey: PreferenceKey.audience),
            scopes: value(environmentKey: "CONTINUUM_AUTH0_SCOPES", defaultsKey: PreferenceKey.scopes)
                .nonEmpty ?? RemoteAuthenticationConfiguration.defaultScopes.joined(separator: " ")
        )
    }

    func configuration(callbackScheme: String = RemoteAuthenticationConfiguration.applicationCallbackScheme) throws -> RemoteAuthenticationConfiguration {
        try RemoteAuthenticationConfiguration(
            serviceURL: serviceURL,
            issuer: issuer,
            clientID: clientID,
            audience: audience,
            scopes: scopes,
            callbackScheme: callbackScheme
        )
    }

    func save(defaults: UserDefaults = .standard) {
        defaults.set(serviceURL.trimmingCharacters(in: .whitespacesAndNewlines), forKey: PreferenceKey.serviceURL)
        defaults.set(issuer.trimmingCharacters(in: .whitespacesAndNewlines), forKey: PreferenceKey.issuer)
        defaults.set(clientID.trimmingCharacters(in: .whitespacesAndNewlines), forKey: PreferenceKey.clientID)
        defaults.set(audience.trimmingCharacters(in: .whitespacesAndNewlines), forKey: PreferenceKey.audience)
        defaults.set(scopes.trimmingCharacters(in: .whitespacesAndNewlines), forKey: PreferenceKey.scopes)
    }

    private enum PreferenceKey {
        static let serviceURL = "continuum.remote.serviceURL"
        static let issuer = "continuum.remote.auth0.issuer"
        static let clientID = "continuum.remote.auth0.clientID"
        static let audience = "continuum.remote.auth0.audience"
        static let scopes = "continuum.remote.auth0.scopes"
    }
}

struct RemoteAuthenticationConfiguration: Equatable, Sendable {
    static let defaultScopes = [
        "openid",
        "profile",
        "offline_access",
        "context:read",
        "sync:read",
        "sync:write",
        "devices:write"
    ]

    static var applicationCallbackScheme: String {
        let candidate = Bundle.main.bundleIdentifier ?? "dev.continuum.app"
        return validScheme(candidate) ? candidate : "dev.continuum.app"
    }

    let serviceURL: URL
    let issuerURL: URL
    let clientID: String
    let audience: String
    let scopes: [String]
    let callbackScheme: String

    init(
        serviceURL: String,
        issuer: String,
        clientID: String,
        audience: String,
        scopes: String,
        callbackScheme: String
    ) throws {
        self.serviceURL = try Self.validateServiceURL(serviceURL)
        issuerURL = try Self.validateIssuerURL(issuer)

        let normalizedClientID = clientID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedClientID.isEmpty,
              normalizedClientID.count <= 512,
              normalizedClientID.rangeOfCharacter(from: .controlCharacters) == nil else {
            throw RemoteAuthenticationError.invalidConfiguration("Enter the Auth0 native application client ID.")
        }
        self.clientID = normalizedClientID

        let normalizedAudience = audience.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedAudience.isEmpty,
              normalizedAudience.count <= 2_048,
              normalizedAudience.rangeOfCharacter(from: .controlCharacters) == nil else {
            throw RemoteAuthenticationError.invalidConfiguration("Enter the Auth0 API audience.")
        }
        self.audience = normalizedAudience

        let normalizedScopes = scopes
            .split(whereSeparator: { $0.isWhitespace })
            .map(String.init)
            .filter { !$0.isEmpty }
        guard normalizedScopes.contains("openid"),
              normalizedScopes.contains("offline_access"),
              normalizedScopes.allSatisfy({ $0.count <= 128 && $0.rangeOfCharacter(from: .controlCharacters) == nil }) else {
            throw RemoteAuthenticationError.invalidConfiguration("Scopes must include openid and offline_access.")
        }
        var seenScopes = Set<String>()
        self.scopes = normalizedScopes.filter { seenScopes.insert($0).inserted }

        guard Self.validScheme(callbackScheme) else {
            throw RemoteAuthenticationError.invalidConfiguration("The application callback scheme is invalid.")
        }
        self.callbackScheme = callbackScheme.lowercased()
    }

    var callbackURL: URL {
        URL(string: "\(callbackScheme)://auth/callback")!
    }

    var authorizationEndpoint: URL {
        issuerURL.appendingPathComponent("authorize")
    }

    var tokenEndpoint: URL {
        issuerURL.appendingPathComponent("oauth/token")
    }

    var revocationEndpoint: URL {
        issuerURL.appendingPathComponent("oauth/revoke")
    }

    var credentialAccount: String {
        "\(issuerURL.absoluteString)|\(clientID)"
    }

    private static func validateIssuerURL(_ value: String) throws -> URL {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: normalized),
              components.scheme?.lowercased() == "https",
              components.host?.isEmpty == false,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil else {
            throw RemoteAuthenticationError.invalidConfiguration("Auth0 issuer must be an HTTPS URL without credentials, query, or fragment.")
        }
        components.path = components.path.replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression)
        guard let url = components.url else {
            throw RemoteAuthenticationError.invalidConfiguration("The Auth0 issuer URL is invalid.")
        }
        return url
    }

    private static func validateServiceURL(_ value: String) throws -> URL {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: normalized),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(),
              !host.isEmpty,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil else {
            throw RemoteAuthenticationError.invalidConfiguration("Enter a valid Continuum service URL without credentials, query, or fragment.")
        }
        let ipv4 = host.split(separator: ".").compactMap { UInt8($0) }
        let loopback = host == "localhost" || host == "::1" || (ipv4.count == 4 && ipv4[0] == 127)
        guard scheme == "https" || (scheme == "http" && loopback) else {
            throw RemoteAuthenticationError.invalidConfiguration("Remote Continuum services require HTTPS. HTTP is allowed only for loopback development.")
        }
        components.path = components.path.replacingOccurrences(of: #"/+$"#, with: "", options: .regularExpression)
        guard let url = components.url else {
            throw RemoteAuthenticationError.invalidConfiguration("The Continuum service URL is invalid.")
        }
        return url
    }

    fileprivate static func validScheme(_ value: String) -> Bool {
        value.range(of: #"^[A-Za-z][A-Za-z0-9+.-]{1,127}$"#, options: .regularExpression) != nil
    }
}

enum RemoteAuthenticationError: LocalizedError, Equatable {
    case invalidConfiguration(String)
    case browserCancelled
    case callbackRejected
    case stateMismatch
    case missingAuthorizationCode
    case tokenExchangeFailed(String)
    case noRefreshCredential
    case keychainFailure(Int32)

    var errorDescription: String? {
        switch self {
        case let .invalidConfiguration(message): message
        case .browserCancelled: "Sign-in was cancelled."
        case .callbackRejected: "Auth0 returned an invalid callback."
        case .stateMismatch: "The sign-in response did not match this request. Please try again."
        case .missingAuthorizationCode: "Auth0 did not return an authorization code."
        case let .tokenExchangeFailed(message): message
        case .noRefreshCredential: "No saved Auth0 session is available. Sign in again."
        case let .keychainFailure(status): "Keychain could not update the Continuum session (status \(status))."
        }
    }
}

struct RemoteAccessSession: Sendable {
    let accessToken: String
    let expiresAt: Date

    func isUsable(at date: Date = Date(), leeway: TimeInterval = 90) -> Bool {
        expiresAt.timeIntervalSince(date) > leeway
    }
}

private extension String {
    var nonEmpty: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}
