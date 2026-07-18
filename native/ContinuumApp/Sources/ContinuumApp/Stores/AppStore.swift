import Foundation
import Observation

enum EngineConnectionStatus: Equatable, Sendable {
    case connecting
    case connected
    case degraded(String)
    case disconnected(String)

    var label: String {
        switch self {
        case .connecting: "Connecting"
        case .connected: "Connected"
        case .degraded: "Degraded"
        case .disconnected: "Disconnected"
        }
    }

    var systemImage: String {
        switch self {
        case .connecting: "circle.dotted"
        case .connected: "circle.fill"
        case .degraded: "exclamationmark.triangle.fill"
        case .disconnected: "bolt.slash.fill"
        }
    }

    var detail: String? {
        switch self {
        case let .degraded(message), let .disconnected(message): message
        default: nil
        }
    }
}

@MainActor
@Observable
final class AppStore {
    private(set) var connection: EngineConnectionStatus = .connecting
    private(set) var snapshot = EngineSnapshot()
    private(set) var checkpoints: [CheckpointSummary] = []
    private(set) var contextDiff = ContextDiffSummary()
    private(set) var modelSettings = ModelSettings()
    private(set) var lastUpdated: Date?
    private(set) var isRefreshing = false
    private(set) var isPerformingAction = false
    private(set) var operationError: String?
    private(set) var credentialDescription: String

    var requestedInspectorSection: InspectorSection = .now
    var inspectorRequestID = 0

    @ObservationIgnored private var client: EngineClient
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var streamTask: Task<Void, Never>?

    init(configuration: EngineConfiguration = .load()) {
        client = EngineClient(configuration: configuration)
        credentialDescription = configuration.credential.description
    }

    var activeProjectID: String? {
        snapshot.activeProject?.id ?? snapshot.currentCheckpoint?.projectID ?? checkpoints.last?.projectID
    }

    var currentCheckpoint: CheckpointSummary? {
        snapshot.currentCheckpoint ?? checkpoints.last
    }

    var capturePaused: Bool { snapshot.capturePaused }

    func startPolling() {
        guard pollTask == nil, streamTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refresh()
                try? await Task.sleep(for: .seconds(15))
            }
        }
        streamTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let stream = await self.client.revisionEvents()
                do {
                    for try await _ in stream {
                        guard !Task.isCancelled else { return }
                        await self.refresh()
                    }
                } catch {
                    if self.lastUpdated == nil {
                        self.connection = .disconnected("Live updates unavailable: \(error.localizedDescription)")
                    } else {
                        self.connection = .degraded("Live updates reconnecting; periodic refresh remains active.")
                    }
                }
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
        streamTask?.cancel()
        streamTask = nil
    }

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }

        let activeClient = client
        do {
            let newSnapshot = try await activeClient.fetchState()
            snapshot = newSnapshot
            lastUpdated = Date()
            operationError = nil

            var degradationMessages: [String] = []
            if newSnapshot.retrieval.degraded {
                degradationMessages.append(
                    newSnapshot.retrieval.message ?? "Retrieval is running without vector search."
                )
            }
            if ["degraded", "unavailable"].contains(newSnapshot.provider.status.lowercased()) {
                degradationMessages.append(newSnapshot.provider.message ?? "Checkpoint provider is degraded.")
            }

            do {
                checkpoints = try await activeClient.fetchCheckpoints(projectID: activeProjectID)
            } catch {
                degradationMessages.append("Timeline unavailable: \(error.localizedDescription)")
            }

            do {
                modelSettings = try await activeClient.fetchModelSettings()
            } catch {
                degradationMessages.append("Model settings unavailable: \(error.localizedDescription)")
            }

            do {
                contextDiff = try await activeClient.fetchDiff(projectID: activeProjectID)
            } catch {
                degradationMessages.append("Context Diff unavailable: \(error.localizedDescription)")
            }

            do {
                snapshot.privacy = try await activeClient.fetchPrivacy()
            } catch {
                degradationMessages.append("Privacy audit unavailable: \(error.localizedDescription)")
            }

            if degradationMessages.isEmpty {
                connection = .connected
            } else {
                connection = .degraded(degradationMessages.joined(separator: " "))
            }
        } catch {
            connection = .disconnected(error.localizedDescription)
            operationError = error.localizedDescription
        }
    }

    func toggleCapture() async {
        let previous = snapshot.capturePaused
        snapshot.capturePaused.toggle()
        await performAction {
            try await self.client.setCapturePaused(!previous)
        }
        if operationError != nil {
            snapshot.capturePaused = previous
        } else {
            await refresh()
        }
    }

    func flushCheckpoint() async {
        let projectID = activeProjectID
        await performAction {
            try await self.client.flush(projectID: projectID)
        }
        if operationError == nil {
            await refresh()
        }
    }

    func acknowledgeCurrentCheckpoint() async {
        guard let projectID = activeProjectID else {
            operationError = "There is no active project to acknowledge."
            return
        }
        let checkpointID = currentCheckpoint?.id
        await performAction {
            try await self.client.acknowledge(projectID: projectID, checkpointID: checkpointID)
        }
        if operationError == nil {
            await refresh()
        }
    }

    func generateBriefing() async {
        let projectID = activeProjectID
        await performAction {
            self.contextDiff = try await self.client.generateBriefing(projectID: projectID)
        }
    }

    func loadSyntheticCatchUp() async {
        await performAction {
            try await self.client.replaySyntheticCatchUp()
        }
        if operationError == nil {
            await refresh()
        }
    }

    func updateModel(provider: ProviderKind, model: String) async {
        await performAction {
            let settings = try await self.client.updateModel(provider: provider, model: model)
            self.modelSettings = settings
        }
        if operationError == nil {
            await refresh()
        }
    }

    func reconfigure(baseURLString: String) {
        UserDefaults.standard.set(baseURLString, forKey: "continuum.daemonURL")
        let configuration = EngineConfiguration.load(preferredBaseURL: baseURLString)
        client = EngineClient(configuration: configuration)
        credentialDescription = configuration.credential.description
        connection = .connecting
        Task { await refresh() }
    }

    func openInspector(at section: InspectorSection) {
        requestedInspectorSection = section
        inspectorRequestID &+= 1
    }

    func dismissError() {
        operationError = nil
    }

    private func performAction(_ operation: () async throws -> Void) async {
        guard !isPerformingAction else { return }
        isPerformingAction = true
        operationError = nil
        defer { isPerformingAction = false }

        do {
            try await operation()
        } catch {
            operationError = error.localizedDescription
        }
    }
}
