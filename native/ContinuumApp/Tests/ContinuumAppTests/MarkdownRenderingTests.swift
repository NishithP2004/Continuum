import XCTest
@testable import ContinuumApp

final class MarkdownRenderingTests: XCTestCase {
    func testParsesCommonChatMarkdownBlocks() {
        let source = """
        # Resume plan

        Review **two** files:
        - `EngineClient.swift`
        - [MCP](https://modelcontextprotocol.io)

        1. Run tests
        2. Inspect output

        > Keep hypotheses unverified.

        ```swift
        let ready = true
        ```
        """

        XCTAssertEqual(ChatMarkdownParser.parse(source), [
            .heading(level: 1, text: "Resume plan"),
            .paragraph("Review **two** files:"),
            .unorderedList(["`EngineClient.swift`", "[MCP](https://modelcontextprotocol.io)"]),
            .orderedList(["Run tests", "Inspect output"]),
            .quote("Keep hypotheses unverified."),
            .code(language: "swift", text: "let ready = true")
        ])
    }

    func testStripsUnsafeInlineLinkSchemes() {
        let value = ChatMarkdownParser.attributed("[unsafe](javascript:alert(1)) and [safe](https://example.com)")
        let links = value.runs.compactMap(\.link)
        XCTAssertEqual(links.map(\.scheme), ["https"])
    }
}
