import Foundation
import XCTest
@testable import ContinuumApp

final class ModelDecodingTests: XCTestCase {
    func testDecodesCanonicalEngineState() throws {
        let data = Data(
            #"""
            {
              "revision": 8,
              "connected": true,
              "capturePaused": false,
              "projectId": "continuum",
              "eventCount": 24,
              "checkpointCount": 3,
              "droppedSecretCount": 2,
              "retrievalMode": "fts_graph",
              "settings": {
                "activeCheckpointProvider": "ollama",
                "ollamaModel": "gemma3n:e2b",
                "openaiModel": "gpt-5.6-terra"
              },
              "providerHealth": {
                "ollama": "available",
                "openai": "unknown"
              }
            }
            """#.utf8
        )

        let state = try JSONDecoder().decode(EngineSnapshot.self, from: data)

        XCTAssertEqual(state.status, "ok")
        XCTAssertEqual(state.activeProject?.id, "continuum")
        XCTAssertEqual(state.pendingEvents, 24)
        XCTAssertEqual(state.privacy.droppedSecrets, 2)
        XCTAssertEqual(state.provider.provider, "ollama")
        XCTAssertEqual(state.provider.model, "gemma3n:e2b")
        XCTAssertEqual(state.provider.status, "ready")
        XCTAssertTrue(state.retrieval.degraded)
        XCTAssertEqual(state.retrieval.checkpointCount, 3)
    }

    func testDecodesCheckpointEvidenceAndGraphEntities() throws {
        let data = Data(
            #"""
            {
              "version": "1",
              "id": "checkpoint-001",
              "projectId": "continuum",
              "windowId": "window-00001",
              "eventIds": ["event-00001"],
              "goal": "Ship the MCP resume flow",
              "focus": "Validate Context Diff",
              "summary": "The baseline remains explicit.",
              "progress": [{"text": "Diff contract implemented", "eventIds": ["event-00001"]}],
              "blockers": [{"text": "Provider unavailable", "eventIds": ["event-00001"], "status": "open"}],
              "hypotheses": [{"text": "FTS fallback is sufficient", "eventIds": ["event-00001"], "status": "supported"}],
              "decisions": [],
              "questions": [],
              "entities": [
                {"kind": "file", "key": "src/server.ts", "label": "server.ts"},
                {"kind": "commit", "key": "abc1234", "label": "Wire MCP"}
              ],
              "importance": 0.9,
              "confidence": 0.8,
              "provider": "ollama",
              "model": "gemma3n:e2b",
              "createdAt": "2026-07-18T12:00:00.000Z"
            }
            """#.utf8
        )

        let checkpoint = try JSONDecoder().decode(CheckpointSummary.self, from: data)

        XCTAssertEqual(checkpoint.projectID, "continuum")
        XCTAssertEqual(checkpoint.progress.first?.evidenceEventIDs, ["event-00001"])
        XCTAssertEqual(checkpoint.blockers.first?.status, "open")
        XCTAssertEqual(checkpoint.hypotheses.first?.state, "supported")
        XCTAssertEqual(checkpoint.files, ["src/server.ts"])
        XCTAssertEqual(checkpoint.commits, ["abc1234"])
    }

    func testDecodesStructuredContextDiff() throws {
        let data = Data(
            #"""
            {
              "version": "1",
              "projectId": "continuum",
              "baselineCheckpointId": "checkpoint-001",
              "currentCheckpointId": "checkpoint-002",
              "generatedAt": "2026-07-18T13:00:00.000Z",
              "changes": [],
              "addedBlockers": [{"text": "Ollama is offline", "eventIds": ["event-00002"], "status": "open"}],
              "resolvedBlockers": [],
              "changedHypotheses": [{"text": "The token path was wrong", "eventIds": ["event-00002"], "status": "disproven"}],
              "newDecisions": [{"text": "Keep FTS fallback explicit", "eventIds": ["event-00002"]}],
              "newFiles": [{"kind": "file", "key": "src/state.ts", "label": "state.ts"}],
              "newCommits": [{"kind": "commit", "key": "def5678", "label": "Fix state"}],
              "newEntities": [{"kind": "concept", "key": "context-diff", "label": "Context Diff"}],
              "briefing": {
                "headline": "Resume the state contract",
                "summary": "One blocker appeared.",
                "nextActions": ["Start Ollama", "Run the MCP smoke test"]
              }
            }
            """#.utf8
        )

        let diff = try JSONDecoder().decode(ContextDiffSummary.self, from: data)

        XCTAssertEqual(diff.baselineCheckpointID, "checkpoint-001")
        XCTAssertEqual(diff.addedBlockers.first?.evidenceEventIDs, ["event-00002"])
        XCTAssertEqual(diff.changedHypotheses.first?.to, "disproven")
        XCTAssertEqual(diff.newFiles, ["src/state.ts"])
        XCTAssertEqual(diff.newCommits, ["def5678"])
        XCTAssertTrue(diff.briefing?.contains("Run the MCP smoke test") == true)
    }
}
