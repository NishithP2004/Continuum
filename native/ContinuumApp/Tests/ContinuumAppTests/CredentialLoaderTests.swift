import Foundation
import XCTest
@testable import ContinuumApp

final class CredentialLoaderTests: XCTestCase {
    func testEnvironmentTokenTakesPriority() {
        let result = CredentialLoader.load(
            environment: [
                "CONTINUUM_AUTH_TOKEN": "  environment-secret  ",
                "CONTINUUM_TOKEN": "other-secret"
            ]
        )

        XCTAssertEqual(result.token, "environment-secret")
        XCTAssertEqual(result.description, "Environment: CONTINUUM_AUTH_TOKEN")
    }

    func testExplicitTokenFileIsReadAndTrimmed() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let tokenURL = directory.appendingPathComponent("auth.token")
        try Data("file-secret\n".utf8).write(to: tokenURL)

        let result = CredentialLoader.load(
            environment: ["CONTINUUM_TOKEN_FILE": tokenURL.path]
        )

        XCTAssertEqual(result.token, "file-secret")
        XCTAssertEqual(result.description, "Token file: \(tokenURL.path)")
    }
}
