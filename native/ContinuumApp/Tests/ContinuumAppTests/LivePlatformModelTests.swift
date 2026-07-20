import Foundation
import XCTest
@testable import ContinuumApp

final class LivePlatformModelTests: XCTestCase {
    func testPrivacyPolicyDefaultsKeepWindowTitlesOffAndRetentionBounded() throws {
        let data = Data(
            #"""
            {
              "version":"1",
              "revision":3,
              "updatedAt":"2026-07-20T12:00:00Z",
              "sources":{"osApps":true,"osWindows":false,"approvedFolders":true,"vscode":true,"terminal":true,"git":true,"chrome":true},
              "metadata":{"relativeFilePaths":true,"urlHosts":true,"urlPaths":false,"commandNames":true,"commandFlagNames":false,"personalMetadata":true,"confidentialLocalCollection":true,"personalCloudEligibility":false},
              "retentionHours":72,
              "allowedDomains":[],
              "ignoredDomains":[],
              "ignoredPathPatterns":["**/.env*"],
              "immutableProtections":{"secretDetection":true,"attributeAllowlist":true,"prohibitedContentExclusion":true,"confidentialCloudBlock":true}
            }
            """#.utf8
        )
        let policy = try JSONDecoder().decode(PrivacyPolicyV1.self, from: data)

        XCTAssertEqual(policy.version, 3)
        XCTAssertEqual(policy.retentionHours, 24)
        XCTAssertFalse(policy.captureWindowTitles)
        XCTAssertEqual(policy.sourceEnabled["os_app"], true)

        let encoded = try JSONEncoder().encode(policy)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertNotNil(object["sources"])
        XCTAssertNotNil(object["metadata"])
        XCTAssertNil(object["sourceEnabled"])
        XCTAssertNil(object["approvedFolders"])
    }

    func testGraphSnapshotDecodesAlternateNodeAndEdgeKeys() throws {
        let data = Data(
            #"""
            {
              "nodes": [
                {"id":"project:one","name":"Continuum","type":"project"},
                {"id":"file:app","label":"App.swift","kind":"file"}
              ],
              "edges": [
                {"sourceId":"project:one","targetId":"file:app","type":"contains"}
              ]
            }
            """#.utf8
        )

        let graph = try JSONDecoder().decode(GraphSnapshot.self, from: data)

        XCTAssertEqual(graph.nodes.map(\.label), ["Continuum", "App.swift"])
        XCTAssertEqual(graph.edges.first?.relation, "contains")
        XCTAssertFalse(graph.truncated)
    }

    func testChatModelsDefaultMissingStreamingFields() throws {
        let data = Data(
            #"""
            {
              "id":"session-1",
              "projectId":"project-1",
              "classification":"personal",
              "syncEligibility":"cloud_eligible",
              "updatedAt":"2026-07-20T12:01:00Z",
              "messages":[{
                "id":"message-1",
                "role":"assistant",
                "content":"Continue from checkpoint cp-1.",
                "citations":[{"checkpointId":"cp-1"}]
              }]
            }
            """#.utf8
        )

        let session = try JSONDecoder().decode(ChatSession.self, from: data)

        XCTAssertEqual(session.projectID, "project-1")
        XCTAssertEqual(session.messages.first?.text, "Continue from checkpoint cp-1.")
        XCTAssertEqual(session.messages.first?.citations.first?.label, "cp-1")
        XCTAssertFalse(try XCTUnwrap(session.messages.first).isStreaming)
        XCTAssertEqual(session.classification, "personal")
        XCTAssertEqual(session.syncEligibility, "cloud_eligible")
        XCTAssertEqual(session.updatedAt, "2026-07-20T12:01:00Z")
    }

    func testNativeEventEncodingUsesV2WireNamesAndOmitsProjectWhenUnassigned() throws {
        let event = NativeCollectedEvent(
            deviceID: "device-1",
            eventType: "app_activated",
            title: "Xcode app activated",
            dedupeKey: "os:app:xcode:1",
            policyVersion: 4
        )
        let encoded = try JSONEncoder().encode(event)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])

        XCTAssertEqual(object["version"] as? String, "2")
        XCTAssertEqual(object["deviceId"] as? String, "device-1")
        XCTAssertEqual(object["policyVersion"] as? Int, 4)
        XCTAssertNil(object["projectId"])
        XCTAssertNotNil(object["occurredAt"])
        XCTAssertTrue((object["hlc"] as? String)?.hasSuffix(":device-1") == true)
        XCTAssertEqual((object["privacy"] as? [String: Any])?["classification"] as? String, "personal")
        XCTAssertEqual((object["relevance"] as? [String: Any])?["decision"] as? String, "keep")
        XCTAssertEqual(object["syncEligibility"] as? String, "cloud_eligible")
        XCTAssertNil(object["time"])
        XCTAssertNil(object["privacyClassification"])
    }

    func testNativeOfflineQueuePersistsOnlyLiveSanitizedEvents() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("continuum-native-queue-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = NativeEventQueueStore(fileURL: directory.appendingPathComponent("events.json"))
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-07-20T12:00:00Z"))
        let expired = NativeCollectedEvent(
            deviceID: "device-queue",
            time: "2026-07-19T11:59:59Z",
            eventType: "app_activated",
            title: "Old safe metadata",
            dedupeKey: "old",
            policyVersion: 1
        )
        let live = NativeCollectedEvent(
            deviceID: "device-queue",
            time: "2026-07-20T11:59:59Z",
            eventType: "app_activated",
            title: "Current safe metadata",
            dedupeKey: "live",
            policyVersion: 2
        )

        store.save([expired, live])
        let retained = store.load(now: now)

        XCTAssertEqual(retained.map(\.dedupeKey), ["live"])
        let attributes = try FileManager.default.attributesOfItem(atPath: store.fileURL.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }

    func testNativeOfflineQueueIsBoundedToNewestFiveHundredEvents() {
        let now = Date()
        let formatter = ISO8601DateFormatter()
        let events = (0..<520).map { index in
            NativeCollectedEvent(
                deviceID: "device-queue",
                time: formatter.string(from: now.addingTimeInterval(Double(index - 520))),
                eventType: "app_activated",
                title: "Safe metadata",
                dedupeKey: "event-\(index)",
                policyVersion: 1
            )
        }

        let retained = NativeEventQueueStore.liveEvents(events, now: now)

        XCTAssertEqual(retained.count, 500)
        XCTAssertEqual(retained.first?.dedupeKey, "event-20")
        XCTAssertEqual(retained.last?.dedupeKey, "event-519")
    }

    func testGraphQueryUsesStrictDaemonKeys() throws {
        let query = GraphQuery(
            projectID: "project-1",
            query: "settings",
            nodeKinds: ["file"],
            relations: ["contains"]
        )
        let data = try JSONEncoder().encode(query)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(object["kinds"] as? [String], ["file"])
        XCTAssertEqual(object["edgeKinds"] as? [String], ["contains"])
        XCTAssertNil(object["nodeKinds"])
        XCTAssertNil(object["relations"])
    }

    func testChatRunEventsDecodeDaemonSSEShapes() throws {
        let delta = try JSONDecoder().decode(
            ChatRunEvent.self,
            from: Data(#"{"type":"delta","text":"Continue "}"#.utf8)
        )
        let citation = try JSONDecoder().decode(
            ChatRunEvent.self,
            from: Data(#"{"type":"citation","citation":{"kind":"file","id":"Sources/App.swift","label":"App.swift","checkpointIds":["cp-1"]}}"#.utf8)
        )
        let action = try JSONDecoder().decode(
            ChatRunEvent.self,
            from: Data(#"{"type":"action_proposed","action":{"id":"action-1","name":"create_checkpoint","mutating":true,"status":"proposed"}}"#.utf8)
        )
        let started = try JSONDecoder().decode(
            ChatRunEvent.self,
            from: Data(#"{"type":"run_started","runId":"60000000-0000-4000-8000-000000000001","sessionId":"50000000-0000-4000-8000-000000000001"}"#.utf8)
        )

        XCTAssertEqual(delta.delta, "Continue ")
        XCTAssertEqual(citation.citations?.first?.file, "Sources/App.swift")
        XCTAssertEqual(citation.citations?.first?.checkpointID, "cp-1")
        XCTAssertEqual(action.action?.kind, "create_checkpoint")
        XCTAssertTrue(action.action?.requiresConfirmation == true)
        XCTAssertEqual(started.runID, "60000000-0000-4000-8000-000000000001")
    }

    func testCollectorPairingAndIdentityConflictDecodeLiveDaemonShapes() throws {
        let pairing = try JSONDecoder().decode(
            CollectorPairing.self,
            from: Data(
                #"{"id":"pairing-1","kind":"chrome","clientId":"chrome-native-1","status":"paired","createdAt":"2026-07-20T12:00:00Z","expiresAt":"2026-07-20T12:05:00Z","approvedAt":"2026-07-20T12:01:00Z","resolvedProject":{"id":"project-1","name":"Continuum"}}"#.utf8
            )
        )
        XCTAssertTrue(pairing.isConnected)
        XCTAssertEqual(pairing.resolvedProject?.name, "Continuum")
        XCTAssertNotNil(pairing.expiryDate)

        let conflict = try JSONDecoder().decode(
            ProjectIdentityConflict.self,
            from: Data(
                #"{"id":"conflict-1","deviceId":"device-native-1","localAlias":"local-path-hash","normalizedName":"continuum","repositoryFingerprint":"fingerprint","assignedProjectId":"project-provisional","candidates":[{"projectId":"project-global","label":"Continuum"}],"status":"pending","createdAt":"2026-07-20T12:00:00Z","updatedAt":"2026-07-20T12:01:00Z"}"#.utf8
            )
        )
        XCTAssertEqual(conflict.deviceID, "device-native-1")
        XCTAssertEqual(conflict.candidates.first?.projectID, "project-global")
        XCTAssertEqual(conflict.updatedAt, "2026-07-20T12:01:00Z")
    }

    func testChatEligibilityRequiresOpenAIAndExplicitCloudSharing() {
        XCTAssertEqual(
            AppStore.resolvedChatSyncEligibility(provider: .openai, cloudSharingEnabled: true),
            "cloud_eligible"
        )
        XCTAssertEqual(
            AppStore.resolvedChatSyncEligibility(provider: .openai, cloudSharingEnabled: false),
            "local_only"
        )
        XCTAssertEqual(
            AppStore.resolvedChatSyncEligibility(provider: .local, cloudSharingEnabled: true),
            "local_only"
        )

        let localSession = ChatSession(
            id: "session-local",
            projectID: "project-1",
            classification: "personal",
            syncEligibility: "local_only"
        )
        XCTAssertTrue(
            AppStore.canReuseChatSession(
                localSession,
                projectID: "project-1",
                classification: "personal",
                syncEligibility: "local_only"
            )
        )
        XCTAssertFalse(
            AppStore.canReuseChatSession(
                localSession,
                projectID: "project-1",
                classification: "personal",
                syncEligibility: "cloud_eligible"
            )
        )
    }

    func testSyncStatusDecodesLocalDaemonShape() throws {
        let data = Data(
            #"{"configured":true,"connected":true,"syncing":false,"pendingOperations":3,"lastPushAt":"2026-07-20T10:00:00Z","lastPullAt":"2026-07-20T11:00:00Z"}"#.utf8
        )
        let status = try JSONDecoder().decode(SyncStatus.self, from: data)

        XCTAssertEqual(status.state, "connected")
        XCTAssertEqual(status.pendingOperations, 3)
        XCTAssertEqual(status.lastSyncedAt, "2026-07-20T11:00:00Z")
    }

    func testSyncStatusAndDeviceDecodeCloudProxyShapes() throws {
        let statusData = Data(
            #"{"deviceId":"device-current","configured":true,"connected":true,"syncing":false,"pendingOperations":0}"#.utf8
        )
        let status = try JSONDecoder().decode(SyncStatus.self, from: statusData)
        XCTAssertEqual(status.currentDeviceID, "device-current")

        let deviceData = Data(
            #"{"id":"device-revoked","name":"Old Mac","platform":"macos","lastSeenAt":"2026-07-01T10:00:00Z","revokedAt":"2026-07-02T10:00:00Z"}"#.utf8
        )
        let device = try JSONDecoder().decode(DeviceSummary.self, from: deviceData)
        XCTAssertEqual(device.status, "revoked")
    }

    func testGraphLayoutIsDeterministic() {
        let nodes = [
            GraphNode(id: "p", label: "Project", kind: "project"),
            GraphNode(id: "f", label: "File", kind: "file")
        ]
        let first = GraphLayoutEngine.layout(nodes: nodes, edges: [])
        let second = GraphLayoutEngine.layout(nodes: Array(nodes.reversed()), edges: [])

        XCTAssertEqual(first, second)
        XCTAssertEqual(first.count, 2)
    }

    func testNavigationContainsLivePlatformSections() {
        XCTAssertTrue(InspectorSection.allCases.contains(.chat))
        XCTAssertTrue(InspectorSection.allCases.contains(.graph))
        XCTAssertTrue(InspectorSection.allCases.contains(.devices))
    }
}
