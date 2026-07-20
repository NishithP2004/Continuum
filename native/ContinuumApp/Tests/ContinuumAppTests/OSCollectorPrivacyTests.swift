import Foundation
import XCTest
@testable import ContinuumApp

final class OSCollectorPrivacyTests: XCTestCase {
    func testNativeSourceTogglesFailClosedIndependently() {
        let enabled = enabledPolicy()
        XCTAssertNotNil(NativePrivacyPolicyGate.apply(appEvent(), policy: enabled))
        XCTAssertNotNil(NativePrivacyPolicyGate.apply(windowEvent(), policy: enabled))
        XCTAssertNotNil(NativePrivacyPolicyGate.apply(folderEvent(), policy: enabled))

        var appsDisabled = enabled
        appsDisabled.sourceEnabled["os_app"] = false
        XCTAssertNil(NativePrivacyPolicyGate.apply(appEvent(), policy: appsDisabled))
        XCTAssertNotNil(NativePrivacyPolicyGate.apply(windowEvent(), policy: appsDisabled))
        XCTAssertNotNil(NativePrivacyPolicyGate.apply(folderEvent(), policy: appsDisabled))

        var windowsDisabled = enabled
        windowsDisabled.sourceEnabled["os_window"] = false
        XCTAssertNotNil(NativePrivacyPolicyGate.apply(appEvent(), policy: windowsDisabled))
        XCTAssertNil(NativePrivacyPolicyGate.apply(windowEvent(), policy: windowsDisabled))
        XCTAssertNotNil(NativePrivacyPolicyGate.apply(folderEvent(), policy: windowsDisabled))

        var foldersDisabled = enabled
        foldersDisabled.sourceEnabled["os_folder"] = false
        XCTAssertNotNil(NativePrivacyPolicyGate.apply(appEvent(), policy: foldersDisabled))
        XCTAssertNotNil(NativePrivacyPolicyGate.apply(windowEvent(), policy: foldersDisabled))
        XCTAssertNil(NativePrivacyPolicyGate.apply(folderEvent(), policy: foldersDisabled))
    }

    func testPersonalAndConfidentialMetadataTogglesMatchClassifications() {
        var personalDisabled = enabledPolicy()
        personalDisabled.personalMetadataEnabled = false
        XCTAssertNil(NativePrivacyPolicyGate.apply(appEvent(), policy: personalDisabled))
        XCTAssertNil(NativePrivacyPolicyGate.apply(folderEvent(), policy: personalDisabled))
        XCTAssertNotNil(NativePrivacyPolicyGate.apply(windowEvent(), policy: personalDisabled))

        var confidentialDisabled = enabledPolicy()
        confidentialDisabled.confidentialLocalCollectionEnabled = false
        XCTAssertNotNil(NativePrivacyPolicyGate.apply(appEvent(), policy: confidentialDisabled))
        XCTAssertNotNil(NativePrivacyPolicyGate.apply(folderEvent(), policy: confidentialDisabled))
        XCTAssertNil(NativePrivacyPolicyGate.apply(windowEvent(), policy: confidentialDisabled))
    }

    func testWindowTitlesRequireBothWindowControlsAndRemainLocalOnly() throws {
        var titlesDisabled = enabledPolicy()
        titlesDisabled.captureWindowTitles = false
        XCTAssertNil(NativePrivacyPolicyGate.apply(windowEvent(), policy: titlesDisabled))

        let accepted = try XCTUnwrap(
            NativePrivacyPolicyGate.apply(windowEvent(), policy: enabledPolicy(cloudSharingEnabled: true))
        )
        XCTAssertEqual(accepted.attributes["windowTitle"], "Continuum — Graph")
        XCTAssertEqual(accepted.title, "Continuum — Graph")
        XCTAssertEqual(accepted.syncEligibility, "local_only")

        var disguisedWindow = windowEvent()
        disguisedWindow.privacy.classification = "personal"
        XCTAssertNil(NativePrivacyPolicyGate.apply(disguisedWindow, policy: enabledPolicy()))
    }

    func testApprovedFolderMustStillBeApprovedAtQueueBoundary() {
        XCTAssertNotNil(NativePrivacyPolicyGate.apply(folderEvent(), policy: enabledPolicy()))

        var noApprovedFolders = enabledPolicy()
        noApprovedFolders.approvedFolders = []
        XCTAssertNil(NativePrivacyPolicyGate.apply(folderEvent(), policy: noApprovedFolders))

        var wrongProject = folderEvent()
        wrongProject.projectId = "project-other"
        XCTAssertNil(NativePrivacyPolicyGate.apply(wrongProject, policy: enabledPolicy()))

        var traversal = folderEvent()
        traversal.attributes["relativePath"] = "../Secrets.txt"
        XCTAssertNil(NativePrivacyPolicyGate.apply(traversal, policy: enabledPolicy()))

        var ignored = enabledPolicy()
        ignored.ignoredPaths = ["**/*.pem"]
        var ignoredEvent = folderEvent()
        ignoredEvent.attributes["relativePath"] = "certificates/private.pem"
        XCTAssertNil(NativePrivacyPolicyGate.apply(ignoredEvent, policy: ignored))
    }

    func testRelativePathsAreRemovedFromEveryQueuedFieldWhenDisabled() throws {
        var policy = enabledPolicy()
        policy.includeRelativePaths = false
        let path = "Sources/PrivateFeature.swift"
        let event = folderEvent(relativePath: path)

        let accepted = try XCTUnwrap(NativePrivacyPolicyGate.apply(event, policy: policy))
        XCTAssertNil(accepted.attributes["relativePath"])
        XCTAssertEqual(accepted.title, "Approved folder activity")
        XCTAssertFalse(accepted.dedupeKey.contains(path))

        let queued = NativePrivacyPolicyGate.compliantQueue([event], policy: policy)
        let persisted = try JSONEncoder().encode(queued)
        let persistedText = try XCTUnwrap(String(data: persisted, encoding: .utf8))
        XCTAssertFalse(persistedText.contains(path))
        XCTAssertFalse(persistedText.contains("relativePath"))

    }

    func testPersonalCloudEligibilityControlsAppsAndFoldersOnly() throws {
        let localPolicy = enabledPolicy(cloudSharingEnabled: false)
        XCTAssertEqual(
            try XCTUnwrap(NativePrivacyPolicyGate.apply(appEvent(), policy: localPolicy)).syncEligibility,
            "local_only"
        )
        XCTAssertEqual(
            try XCTUnwrap(NativePrivacyPolicyGate.apply(folderEvent(), policy: localPolicy)).syncEligibility,
            "local_only"
        )

        let sharingPolicy = enabledPolicy(cloudSharingEnabled: true)
        XCTAssertEqual(
            try XCTUnwrap(NativePrivacyPolicyGate.apply(appEvent(), policy: sharingPolicy)).syncEligibility,
            "cloud_eligible"
        )
        XCTAssertEqual(
            try XCTUnwrap(NativePrivacyPolicyGate.apply(folderEvent(), policy: sharingPolicy)).syncEligibility,
            "cloud_eligible"
        )
        XCTAssertEqual(
            try XCTUnwrap(NativePrivacyPolicyGate.apply(windowEvent(), policy: sharingPolicy)).syncEligibility,
            "local_only"
        )
    }

    func testImmutableSecretAndAttributeExclusionsRunBeforePersistence() throws {
        var secret = appEvent()
        secret.attributes["appName"] = "password=super-secret-value"
        XCTAssertNil(NativePrivacyPolicyGate.apply(secret, policy: enabledPolicy()))

        var prohibitedPath = appEvent()
        prohibitedPath.attributes["rawPath"] = "/Users/example/Private.txt"
        XCTAssertNil(NativePrivacyPolicyGate.apply(prohibitedPath, policy: enabledPolicy()))

        var extraMetadata = appEvent()
        extraMetadata.attributes["debug"] = "not allowlisted"
        let accepted = try XCTUnwrap(NativePrivacyPolicyGate.apply(extraMetadata, policy: enabledPolicy()))
        XCTAssertNil(accepted.attributes["debug"])
        XCTAssertEqual(Set(accepted.attributes.keys), ["bundleId", "appName", "action"])

        var secretClassification = appEvent()
        secretClassification.privacy.classification = "secret"
        XCTAssertNil(NativePrivacyPolicyGate.apply(secretClassification, policy: enabledPolicy()))
    }

    func testPolicyChangesRefilterExistingOfflineQueue() throws {
        let events = [appEvent(), windowEvent(), folderEvent(relativePath: "Sources/Offline.swift")]
        var reduced = enabledPolicy()
        reduced.includeRelativePaths = false

        let refiltered = NativePrivacyPolicyGate.compliantQueue(events, policy: reduced)
        XCTAssertEqual(refiltered.count, 3)
        let encoded = try JSONEncoder().encode(refiltered)
        XCTAssertFalse(try XCTUnwrap(String(data: encoded, encoding: .utf8)).contains("Sources/Offline.swift"))

        reduced.personalMetadataEnabled = false
        let confidentialOnly = NativePrivacyPolicyGate.compliantQueue(events, policy: reduced)
        XCTAssertEqual(confidentialOnly.map(\.eventType), ["window_focused"])
        XCTAssertTrue(NativePrivacyPolicyGate.compliantQueue(events, policy: nil).isEmpty)
    }

    func testSubmitterSanitizesExistingDurableQueueBeforeItCanFlush() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("continuum-native-policy-queue-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = NativeEventQueueStore(
            fileURL: directory.appendingPathComponent("events.json"),
            maximumAge: 10 * 365 * 24 * 60 * 60
        )
        let path = "Sources/QueuedWhileOffline.swift"
        store.save([folderEvent(relativePath: path)])

        var reduced = enabledPolicy()
        reduced.includeRelativePaths = false
        _ = NativeEventSubmitter(
            configuration: EngineConfiguration(
                baseURL: EngineConfiguration.defaultURL,
                credential: CredentialSource(token: "test-token", description: "Test")
            ),
            policy: reduced,
            policyGeneration: 1,
            queueStore: store
        )

        let persisted = try JSONEncoder().encode(store.load())
        let persistedText = try XCTUnwrap(String(data: persisted, encoding: .utf8))
        XCTAssertFalse(persistedText.contains(path))
        XCTAssertFalse(persistedText.contains("relativePath"))

        store.save([appEvent()])
        _ = NativeEventSubmitter(
            configuration: EngineConfiguration(
                baseURL: EngineConfiguration.defaultURL,
                credential: CredentialSource(token: "test-token", description: "Test")
            ),
            policy: nil,
            queueStore: store
        )
        XCTAssertTrue(store.load().isEmpty)
    }

    func testSubmitterPhysicallyAppliesTightenedQueueRetention() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("continuum-native-policy-retention-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = NativeEventQueueStore(fileURL: directory.appendingPathComponent("events.json"))
        let formatter = ISO8601DateFormatter()
        let now = Date()
        var older = appEvent()
        older.id = UUID().uuidString
        older.occurredAt = formatter.string(from: now.addingTimeInterval(-2 * 60 * 60))
        older.dedupeKey = "older-than-policy-retention"
        var recent = appEvent()
        recent.id = UUID().uuidString
        recent.occurredAt = formatter.string(from: now.addingTimeInterval(-30 * 60))
        recent.dedupeKey = "recent-policy-retention"
        store.save([older, recent])

        var initial = enabledPolicy()
        initial.retentionHours = 24
        let submitter = NativeEventSubmitter(
            configuration: EngineConfiguration(
                baseURL: EngineConfiguration.defaultURL,
                credential: CredentialSource(token: "test-token", description: "Test")
            ),
            policy: initial,
            policyGeneration: 1,
            queueStore: store
        )
        var tightened = initial
        tightened.version += 1
        tightened.retentionHours = 1
        await submitter.updatePolicy(tightened, generation: 2)

        XCTAssertEqual(store.load().map(\.dedupeKey), ["recent-policy-retention"])
    }

    func testValidatedPolicyCacheSupportsOfflineUseAndMissingCacheFailsClosed() throws {
        let suiteName = "continuum-native-policy-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        XCTAssertNil(PrivacyPolicyCache.load(defaults: defaults))
        XCTAssertNil(NativePrivacyPolicyGate.apply(appEvent(), policy: PrivacyPolicyCache.load(defaults: defaults)))

        let cached = enabledPolicy(cloudSharingEnabled: true)
        PrivacyPolicyCache.save(cached, defaults: defaults)
        let offline = try XCTUnwrap(PrivacyPolicyCache.load(defaults: defaults))
        XCTAssertEqual(offline, cached)
        XCTAssertNotNil(NativePrivacyPolicyGate.apply(appEvent(), policy: offline))

        defaults.set(Data("{}".utf8), forKey: "continuum.privacyPolicy.v1")
        XCTAssertNil(PrivacyPolicyCache.load(defaults: defaults))
        let failClosed = PrivacyPolicyV1.failClosed(
            approvedFolders: PrivacyPolicyCache.loadApprovedFolders(defaults: defaults)
        )
        XCTAssertEqual(failClosed.sourceEnabled["os_app"], false)
        XCTAssertEqual(failClosed.sourceEnabled["os_window"], false)
        XCTAssertEqual(failClosed.sourceEnabled["os_folder"], false)
        XCTAssertNil(NativePrivacyPolicyGate.apply(appEvent(), policy: failClosed))
    }

    private func enabledPolicy(cloudSharingEnabled: Bool = false) -> PrivacyPolicyV1 {
        PrivacyPolicyV1(
            version: 7,
            updatedAt: "2026-07-20T12:00:00Z",
            sourceEnabled: [
                "vscode": true,
                "terminal": true,
                "git": true,
                "chrome": true,
                "os_app": true,
                "os_window": true,
                "os_folder": true
            ],
            captureWindowTitles: true,
            includeRelativePaths: true,
            personalMetadataEnabled: true,
            confidentialLocalCollectionEnabled: true,
            cloudSharingEnabled: cloudSharingEnabled,
            ignoredPaths: [],
            approvedFolders: [
                ApprovedFolder(
                    id: "approved-root-1",
                    path: "/tmp/continuum-approved",
                    projectID: "project-1",
                    projectName: "Continuum"
                )
            ]
        )
    }

    private func appEvent() -> NativeCollectedEvent {
        NativeCollectedEvent(
            id: "10000000-0000-4000-8000-000000000001",
            deviceID: "device-native-1",
            time: "2026-07-20T12:00:00Z",
            eventType: "app_activated",
            title: "Xcode app activated",
            attributes: [
                "bundleId": "com.apple.dt.Xcode",
                "appName": "Xcode",
                "action": "app_activated"
            ],
            privacyClassification: "personal",
            dedupeKey: "os:app_activated:com.apple.dt.Xcode:1",
            policyVersion: 1
        )
    }

    private func windowEvent() -> NativeCollectedEvent {
        NativeCollectedEvent(
            id: "10000000-0000-4000-8000-000000000002",
            deviceID: "device-native-1",
            time: "2026-07-20T12:00:00Z",
            eventType: "window_focused",
            title: "Continuum — Graph",
            attributes: [
                "bundleId": "com.apple.dt.Xcode",
                "appName": "Xcode",
                "windowTitle": "Continuum — Graph"
            ],
            privacyClassification: "confidential",
            dedupeKey: "os:window:com.apple.dt.Xcode:continuum-graph",
            policyVersion: 1,
            syncEligibility: "local_only"
        )
    }

    private func folderEvent(relativePath: String = "Sources/App.swift") -> NativeCollectedEvent {
        NativeCollectedEvent(
            id: "10000000-0000-4000-8000-000000000003",
            deviceID: "device-native-1",
            time: "2026-07-20T12:00:00Z",
            eventType: "folder_changed",
            projectID: "project-1",
            title: "Modified: \(relativePath)",
            attributes: [
                "changeKind": "modified",
                "approvedRootId": "approved-root-1",
                "relativePath": relativePath
            ],
            privacyClassification: "personal",
            dedupeKey: "os:folder:approved-root-1:\(relativePath):1",
            policyVersion: 1
        )
    }
}
