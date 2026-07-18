import Foundation

struct CredentialSource: Equatable, Sendable {
    let token: String?
    let description: String
}

enum CredentialLoader {
    static func load(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        fileManager: FileManager = .default
    ) -> CredentialSource {
        for key in ["CONTINUUM_AUTH_TOKEN", "CONTINUUM_TOKEN"] {
            if let token = normalized(environment[key]) {
                return CredentialSource(token: token, description: "Environment: \(key)")
            }
        }

        let candidates = tokenFileCandidates(environment: environment, fileManager: fileManager)
        for url in candidates {
            guard let contents = try? String(contentsOf: url, encoding: .utf8),
                  let token = normalized(contents) else {
                continue
            }
            return CredentialSource(token: token, description: "Token file: \(url.path)")
        }

        return CredentialSource(
            token: nil,
            description: "Missing token (set CONTINUUM_AUTH_TOKEN or CONTINUUM_TOKEN_FILE)"
        )
    }

    static func tokenFileCandidates(
        environment: [String: String],
        fileManager: FileManager
    ) -> [URL] {
        var candidates: [URL] = []

        if let explicit = normalized(environment["CONTINUUM_TOKEN_FILE"]) {
            candidates.append(URL(fileURLWithPath: explicit))
        }

        if let dataDirectory = normalized(environment["CONTINUUM_DATA_DIR"]) {
            candidates.append(
                URL(fileURLWithPath: dataDirectory, isDirectory: true)
                    .appendingPathComponent("auth.token")
            )
        }

        let home = fileManager.homeDirectoryForCurrentUser
        candidates.append(
            home
                .appendingPathComponent("Library/Application Support/Continuum", isDirectory: true)
                .appendingPathComponent("auth.token")
        )
        candidates.append(
            home
                .appendingPathComponent("Library/Application Support/Continuum", isDirectory: true)
                .appendingPathComponent("auth-token")
        )
        candidates.append(
            home
                .appendingPathComponent(".continuum", isDirectory: true)
                .appendingPathComponent("token")
        )

        let workingDirectory = URL(
            fileURLWithPath: fileManager.currentDirectoryPath,
            isDirectory: true
        )
        candidates.append(
            workingDirectory
                .appendingPathComponent(".continuum", isDirectory: true)
                .appendingPathComponent("token")
        )
        candidates.append(
            workingDirectory
                .appendingPathComponent("data", isDirectory: true)
                .appendingPathComponent("auth.token")
        )
        candidates.append(
            workingDirectory
                .appendingPathComponent("data", isDirectory: true)
                .appendingPathComponent("auth-token")
        )

        var seen = Set<String>()
        return candidates.filter { seen.insert($0.standardizedFileURL.path).inserted }
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
