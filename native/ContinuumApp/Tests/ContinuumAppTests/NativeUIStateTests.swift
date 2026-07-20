import XCTest
@testable import ContinuumApp

final class NativeUIStateTests: XCTestCase {
    func testEngineSessionGenerationInvalidatesInFlightWork() {
        var generation = EngineSessionGeneration()
        let first = generation.token

        XCTAssertTrue(generation.isCurrent(first))
        generation.invalidate()
        XCTAssertFalse(generation.isCurrent(first))
        XCTAssertTrue(generation.isCurrent(generation.token))
    }

    func testHealthOverviewKeepsSubsystemStatusesIndependent() throws {
        let overview = NativeHealthOverview(
            connection: .disconnected("Daemon is offline."),
            collector: ServiceHealth(status: "permissionRequired", message: "Grant Accessibility."),
            provider: ProviderHealth(status: "ready", message: "Ollama ready."),
            retrieval: RetrievalHealth(degraded: true, message: "Using FTS."),
            sync: SyncStatus(state: "notConfigured", message: "Optional."),
            projection: ServiceHealth(status: "unavailable", message: "Neo4j is offline.")
        )

        XCTAssertEqual(overview.items.map(\.subsystem), NativeHealthSubsystem.allCases)
        XCTAssertEqual(try XCTUnwrap(overview[.engine]).severity, .error)
        XCTAssertEqual(try XCTUnwrap(overview[.collectors]).severity, .warning)
        XCTAssertEqual(try XCTUnwrap(overview[.provider]).severity, .ready)
        XCTAssertEqual(try XCTUnwrap(overview[.retrieval]).severity, .warning)
        XCTAssertEqual(try XCTUnwrap(overview[.sync]).severity, .neutral)
        XCTAssertEqual(try XCTUnwrap(overview[.projection]).severity, .error)
    }

    @MainActor
    func testHealthStoreUpdatesProviderSnapshotWithoutCollapsingOtherSubsystems() {
        let collector = ServiceHealth(status: "permissionRequired", message: "Grant Accessibility.")
        let sync = SyncStatus(state: "connected", message: "Current.")
        let projection = ServiceHealth(status: "degraded", message: "Projection lagging.")
        let health = AppHealthState(
            connection: .disconnected("Daemon offline."),
            collector: collector,
            sync: sync,
            projection: projection
        )

        health.update(
            from: EngineSnapshot(
                provider: ProviderHealth(provider: "apple", model: "system", status: "ready"),
                retrieval: RetrievalHealth(mode: "hybrid", degraded: false, message: nil)
            )
        )

        XCTAssertEqual(health.provider.provider, "apple")
        XCTAssertEqual(health.retrieval.mode, "hybrid")
        XCTAssertEqual(health.connection, .disconnected("Daemon offline."))
        XCTAssertEqual(health.collector, collector)
        XCTAssertEqual(health.sync, sync)
        XCTAssertEqual(health.projection, projection)
    }

    func testWindowPermissionStateRecoversWithoutChangingPolicy() {
        var policy = PrivacyPolicyV1()
        policy.sourceEnabled["os_window"] = true
        policy.captureWindowTitles = true
        policy.confidentialLocalCollectionEnabled = true

        XCTAssertEqual(
            WindowCaptureAuthorizationState.resolve(policy: policy, isTrusted: false),
            .permissionRequired
        )
        XCTAssertEqual(
            WindowCaptureAuthorizationState.resolve(policy: policy, isTrusted: true),
            .ready
        )

        policy.confidentialLocalCollectionEnabled = false
        XCTAssertEqual(
            WindowCaptureAuthorizationState.resolve(policy: policy, isTrusted: true),
            .disabled
        )
    }

    func testCollectorHealthKeepsPermissionVisibleAndRecoversToReady() {
        let waiting = NativeCollectorHealthResolver.resolve(
            isRunning: true,
            hasValidatedPolicy: true,
            windowAuthorization: .permissionRequired,
            delivery: ServiceHealth(status: "ready"),
            folderFailureMessage: nil
        )
        XCTAssertEqual(waiting.status, "permissionRequired")
        XCTAssertTrue(waiting.message?.contains("Accessibility") == true)

        let recovered = NativeCollectorHealthResolver.resolve(
            isRunning: true,
            hasValidatedPolicy: true,
            windowAuthorization: .ready,
            delivery: ServiceHealth(status: "ready"),
            folderFailureMessage: nil
        )
        XCTAssertEqual(recovered.status, "ready")
        XCTAssertTrue(recovered.message?.contains("enabled locally") == true)
    }

    func testModelSelectionPreservesEveryOtherProviderModel() throws {
        let current = ModelSettings(
            provider: .local,
            chatProvider: .local,
            model: "gemma3n:e2b",
            localModel: "gemma3n:e2b",
            appleModel: "apple-system-default",
            cloudModel: "gpt-5.6-terra"
        )

        let selected = try XCTUnwrap(current.selecting(provider: .openai, model: "  gpt-5.6-sol  "))
        XCTAssertEqual(selected.provider, .openai)
        XCTAssertEqual(selected.chatProvider, .openai)
        XCTAssertEqual(selected.model, "gpt-5.6-sol")
        XCTAssertEqual(selected.localModel, current.localModel)
        XCTAssertEqual(selected.appleModel, current.appleModel)
        XCTAssertEqual(selected.cloudModel, "gpt-5.6-sol")
        XCTAssertNil(current.selecting(provider: .apple, model: "   "))
        XCTAssertNil(current.selecting(provider: .local, model: String(repeating: "m", count: 201)))
    }

    func testPrivacyRuleInputNormalizesDomainsAndRejectsUnsafeGlobs() {
        XCTAssertEqual(
            PrivacyRuleInput.normalizedDomain(" HTTPS://Docs.Example.com/guide "),
            "docs.example.com"
        )
        XCTAssertEqual(PrivacyRuleInput.normalizedDomain("localhost"), "localhost")
        XCTAssertNil(PrivacyRuleInput.normalizedDomain("not a domain"))
        XCTAssertEqual(PrivacyRuleInput.normalizedRelativeGlob(" **/dist/** "), "**/dist/**")
        XCTAssertNil(PrivacyRuleInput.normalizedRelativeGlob("../secrets"))
        XCTAssertNil(PrivacyRuleInput.normalizedRelativeGlob("/Users/example"))
    }

    @MainActor
    func testGraphSelectionCreatesBoundedChatDraftAndNavigationRequest() throws {
        let navigation = InspectorNavigationState()
        let node = GraphNode(
            id: String(repeating: "node-id-", count: 40),
            label: String(repeating: "Selected decision ", count: 20),
            kind: "decision"
        )

        let request = try XCTUnwrap(navigation.openChat(for: node))

        XCTAssertEqual(navigation.requestedSection, .chat)
        XCTAssertEqual(navigation.requestID, 1)
        XCTAssertEqual(navigation.chatDraftRequest, request)
        XCTAssertLessThan(request.text.count, 500)
        XCTAssertTrue(request.text.contains("Selected decision"))
        XCTAssertTrue(request.text.contains("supporting checkpoints"))
    }

    @MainActor
    func testGraphSelectionOmitsSecretLikeContext() {
        let navigation = InspectorNavigationState()
        let node = GraphNode(
            id: "access_token=abcdefghijklmnop",
            label: "api_key=abcdefghijklmnop",
            kind: "file"
        )

        XCTAssertNil(navigation.openChat(for: node))
        XCTAssertEqual(navigation.requestedSection, .now)
        XCTAssertNil(navigation.chatDraftRequest)
    }

    func testDaemonConfigurationAcceptsOnlyPlainLoopbackHTTPOrigins() {
        XCTAssertEqual(
            EngineConfiguration.validatedLoopbackURL("http://127.0.0.1:43117")?.port,
            43_117
        )
        XCTAssertNotNil(EngineConfiguration.validatedLoopbackURL("http://localhost:43117/"))
        XCTAssertNil(EngineConfiguration.validatedLoopbackURL("http://localhost:43118"))
        XCTAssertNil(EngineConfiguration.validatedLoopbackURL("http://localhost"))
        XCTAssertNil(EngineConfiguration.validatedLoopbackURL("https://continuum.example.com"))
        XCTAssertNil(EngineConfiguration.validatedLoopbackURL("http://localhost:43117/v1"))
        XCTAssertNil(EngineConfiguration.validatedLoopbackURL("http://user:secret@localhost:43117"))
    }
}
