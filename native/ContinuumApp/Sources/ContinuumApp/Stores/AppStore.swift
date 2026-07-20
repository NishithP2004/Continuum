import Foundation
import Observation

@MainActor
@Observable
final class AppStore {
    private(set) var snapshot = EngineSnapshot()
    private(set) var checkpoints: [CheckpointSummary] = []
    private(set) var contextDiff = ContextDiffSummary()
    private(set) var modelSettings = ModelSettings()
    private(set) var privacyPolicy: PrivacyPolicyV1
    private(set) var privacyAudit: [PrivacyAuditEntry] = []
    private(set) var chromePairings: [CollectorPairing] = []
    private(set) var projectIdentityConflicts: [ProjectIdentityConflict] = []
    private(set) var graph = GraphSnapshot()
    private(set) var remoteAuthentication = RemoteAuthenticationState()
    private(set) var devices: [DeviceSummary] = []
    private(set) var chatSession: ChatSession?
    private(set) var chatMessages: [ChatMessage] = []
    private(set) var pendingChatActions: [ContextAction] = []
    private(set) var isChatResponding = false
    private(set) var activeChatRunID: String?
    private(set) var lastUpdated: Date?
    private(set) var isRefreshing = false
    private(set) var isPerformingAction = false
    private(set) var operationError: String?
    private(set) var credentialDescription: String

    let health: AppHealthState
    let navigation: InspectorNavigationState

    @ObservationIgnored private var client: EngineClient
    @ObservationIgnored private let clientSession: URLSession
    @ObservationIgnored private let osCollector: OSCollectorService
    @ObservationIgnored private let remoteAuthenticationService: Auth0AuthenticationService
    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var chatTask: Task<Void, Never>?
    @ObservationIgnored private var remoteAuthenticationTask: Task<Void, Never>?
    @ObservationIgnored private var remoteAuthenticationConfiguration: RemoteAuthenticationConfiguration?
    @ObservationIgnored private var validatedPrivacyPolicy: PrivacyPolicyV1?
    @ObservationIgnored private var engineSessionGeneration = EngineSessionGeneration()

    init(
        configuration: EngineConfiguration = .load(),
        session: URLSession = .shared,
        remoteAuthenticationService: Auth0AuthenticationService? = nil
    ) {
        let cachedPolicy = PrivacyPolicyCache.load()
        clientSession = session
        client = EngineClient(configuration: configuration, session: session)
        osCollector = OSCollectorService(configuration: configuration, initialPolicy: cachedPolicy)
        self.remoteAuthenticationService = remoteAuthenticationService ?? Auth0AuthenticationService()
        health = AppHealthState()
        navigation = InspectorNavigationState()
        credentialDescription = configuration.credential.description
        privacyPolicy = cachedPolicy
            ?? .failClosed(approvedFolders: PrivacyPolicyCache.loadApprovedFolders())
        validatedPrivacyPolicy = cachedPolicy
    }

    var connection: EngineConnectionStatus { health.connection }
    var collectorHealth: ServiceHealth { health.collector }
    var projectionHealth: ServiceHealth { health.projection }
    var syncStatus: SyncStatus { health.sync }

    var activeProjectID: String? {
        snapshot.activeProject?.id ?? snapshot.currentCheckpoint?.projectID ?? checkpoints.last?.projectID
    }

    var currentCheckpoint: CheckpointSummary? {
        snapshot.currentCheckpoint ?? checkpoints.last
    }

    var capturePaused: Bool { snapshot.capturePaused }

    var chatClassification: String { "personal" }

    var chatSyncEligibility: String {
        Self.resolvedChatSyncEligibility(
            provider: modelSettings.chatProvider,
            cloudSharingEnabled: privacyPolicy.cloudSharingEnabled
        )
    }

    nonisolated static func resolvedChatSyncEligibility(
        provider: ProviderKind,
        cloudSharingEnabled: Bool
    ) -> String {
        provider == .openai && cloudSharingEnabled
            ? "cloud_eligible"
            : "local_only"
    }

    nonisolated static func canReuseChatSession(
        _ session: ChatSession,
        projectID: String?,
        classification: String,
        syncEligibility: String
    ) -> Bool {
        session.projectID == projectID
            && session.classification == classification
            && session.syncEligibility == syncEligibility
    }

    var chatRequiresCloudConsent: Bool {
        modelSettings.chatProvider == .openai && !privacyPolicy.cloudSharingEnabled
    }

    func startPolling() {
        guard pollTask == nil, streamTask == nil else { return }
        startRemoteAuthenticationIfNeeded()
        startNativeCollectorIfNeeded()
        let sessionToken = engineSessionGeneration.token
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self,
                      self.engineSessionGeneration.isCurrent(sessionToken) else { return }
                await self.refresh()
                try? await Task.sleep(for: .seconds(15))
            }
        }
        streamTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self,
                      self.engineSessionGeneration.isCurrent(sessionToken) else { return }
                let stream = await self.client.revisionEvents()
                do {
                    for try await _ in stream {
                        guard !Task.isCancelled,
                              self.engineSessionGeneration.isCurrent(sessionToken) else { return }
                        await self.refresh()
                    }
                } catch {
                    guard self.engineSessionGeneration.isCurrent(sessionToken) else { return }
                    if self.lastUpdated == nil {
                        self.health.connection = .disconnected("Live updates unavailable: \(error.localizedDescription)")
                    } else {
                        self.health.connection = .degraded("Live updates reconnecting; periodic refresh remains active.")
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
        osCollector.stop()
    }

    func refresh() async {
        guard !isRefreshing else { return }
        let sessionToken = engineSessionGeneration.token
        isRefreshing = true
        defer {
            if engineSessionGeneration.isCurrent(sessionToken) {
                isRefreshing = false
            }
        }

        let activeClient = client
        do {
            let newSnapshot = try await activeClient.fetchState()
            guard engineSessionGeneration.isCurrent(sessionToken) else { return }
            snapshot = newSnapshot
            health.update(from: newSnapshot)
            lastUpdated = Date()
            operationError = nil
            let projectID = activeProjectID

            do {
                let fetched = try await activeClient.fetchCheckpoints(projectID: projectID)
                guard engineSessionGeneration.isCurrent(sessionToken) else { return }
                checkpoints = fetched
            } catch {
                guard engineSessionGeneration.isCurrent(sessionToken) else { return }
            }

            do {
                let fetched = try await activeClient.fetchModelSettings()
                guard engineSessionGeneration.isCurrent(sessionToken) else { return }
                modelSettings = fetched
            } catch {
                guard engineSessionGeneration.isCurrent(sessionToken) else { return }
            }

            do {
                let fetched = try await activeClient.fetchDiff(projectID: projectID)
                guard engineSessionGeneration.isCurrent(sessionToken) else { return }
                contextDiff = fetched
            } catch {
                guard engineSessionGeneration.isCurrent(sessionToken) else { return }
            }

            do {
                let fetched = try await activeClient.fetchPrivacy()
                guard engineSessionGeneration.isCurrent(sessionToken) else { return }
                snapshot.privacy = fetched
            } catch {
                guard engineSessionGeneration.isCurrent(sessionToken) else { return }
            }

            do {
                var fetchedPolicy = try await activeClient.fetchPrivacyPolicy()
                guard engineSessionGeneration.isCurrent(sessionToken) else { return }
                fetchedPolicy.approvedFolders = privacyPolicy.approvedFolders
                let policyChanged = fetchedPolicy != privacyPolicy
                let policyWasUnavailable = validatedPrivacyPolicy == nil
                privacyPolicy = fetchedPolicy
                validatedPrivacyPolicy = fetchedPolicy
                PrivacyPolicyCache.save(fetchedPolicy)
                if policyChanged || policyWasUnavailable { startNativeCollectorIfNeeded() }
            } catch {
                guard engineSessionGeneration.isCurrent(sessionToken) else { return }
                if validatedPrivacyPolicy == nil {
                    health.collector = ServiceHealth(
                        status: "degraded",
                        message: "Native collection is disabled until a validated privacy policy is available."
                    )
                }
            }

            do {
                let fetched = try await activeClient.fetchPrivacyAudit()
                guard engineSessionGeneration.isCurrent(sessionToken) else { return }
                privacyAudit = fetched
            } catch {
                guard engineSessionGeneration.isCurrent(sessionToken) else { return }
                privacyAudit = []
            }

            do {
                let fetched = try await activeClient.fetchChromePairings()
                guard engineSessionGeneration.isCurrent(sessionToken) else { return }
                chromePairings = fetched
            } catch {
                guard engineSessionGeneration.isCurrent(sessionToken) else { return }
            }

            do {
                let fetched = try await activeClient.fetchProjectIdentityConflicts()
                guard engineSessionGeneration.isCurrent(sessionToken) else { return }
                projectIdentityConflicts = fetched
            } catch {
                guard engineSessionGeneration.isCurrent(sessionToken) else { return }
            }

            do {
                let fetched = try await activeClient.fetchSyncStatus()
                guard engineSessionGeneration.isCurrent(sessionToken) else { return }
                health.sync = fetched
            } catch {
                guard engineSessionGeneration.isCurrent(sessionToken) else { return }
                health.sync = SyncStatus(
                    state: "unavailable",
                    message: "Sync service unavailable: \(error.localizedDescription)"
                )
            }
            do {
                let fetched = try await activeClient.fetchGraph(
                    GraphQuery(projectID: projectID, limit: 1)
                )
                guard engineSessionGeneration.isCurrent(sessionToken) else { return }
                health.projection = fetched.projection ?? ServiceHealth(status: "ready")
            } catch {
                guard engineSessionGeneration.isCurrent(sessionToken) else { return }
                health.projection = ServiceHealth(
                    status: "degraded",
                    message: "Graph projection health unavailable: \(error.localizedDescription)"
                )
            }
            do {
                let fetched = try await activeClient.fetchDevices().map { device in
                    var resolved = device
                    resolved.isCurrent = device.id == syncStatus.currentDeviceID
                    return resolved
                }
                guard engineSessionGeneration.isCurrent(sessionToken) else { return }
                devices = fetched
            } catch {
                guard engineSessionGeneration.isCurrent(sessionToken) else { return }
                devices = []
            }

            health.connection = .connected
        } catch {
            guard engineSessionGeneration.isCurrent(sessionToken) else { return }
            health.connection = .disconnected(error.localizedDescription)
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
            startNativeCollectorIfNeeded()
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

    func updateModel(provider: ProviderKind, model: String) async {
        guard let selected = modelSettings.selecting(provider: provider, model: model) else {
            operationError = "Choose a non-empty model identifier of at most 200 characters."
            return
        }
        await performAction {
            let settings = try await self.client.updateModel(
                provider: provider,
                model: selected.model,
                preserving: self.modelSettings
            )
            self.modelSettings = settings
        }
        if operationError == nil {
            await refresh()
        }
    }

    func reconfigure(baseURLString: String) {
        guard let configuration = EngineConfiguration.validated(preferredBaseURL: baseURLString) else {
            operationError = "The daemon URL must be an HTTP loopback URL using 127.0.0.1 or localhost."
            return
        }
        UserDefaults.standard.set(configuration.baseURL.absoluteString, forKey: "continuum.daemonURL")
        stopPolling()
        engineSessionGeneration.invalidate()
        isRefreshing = false
        client = EngineClient(configuration: configuration, session: clientSession)
        osCollector.reconfigureEngine(configuration)
        credentialDescription = configuration.credential.description
        validatedPrivacyPolicy = nil
        privacyPolicy = .failClosed(approvedFolders: privacyPolicy.approvedFolders)
        PrivacyPolicyCache.clearPolicy()
        health.connection = .connecting
        health.provider = ProviderHealth(
            provider: modelSettings.provider.engineValue,
            model: modelSettings.model,
            status: "unknown",
            message: "Waiting for provider health from the reconfigured daemon.",
            cloudActive: modelSettings.provider == .openai
        )
        health.retrieval = RetrievalHealth(
            mode: snapshot.retrieval.mode,
            degraded: true,
            message: "Waiting for retrieval health from the reconfigured daemon."
        )
        health.sync = SyncStatus(
            state: "unavailable",
            message: "Waiting for synchronization health from the reconfigured daemon."
        )
        health.projection = ServiceHealth(
            status: "unknown",
            message: "Waiting for graph projection health from the reconfigured daemon."
        )
        startPolling()
        Task {
            await refresh()
            await refreshRemoteAuthentication(force: true)
        }
    }

    func updatePrivacyPolicy(_ update: (inout PrivacyPolicyV1) -> Void) async {
        var next = privacyPolicy
        update(&next)
        next.version = max(privacyPolicy.version + 1, next.version)
        next.retentionHours = min(max(next.retentionHours, 1), 24)
        privacyPolicy = next
        PrivacyPolicyCache.saveApprovedFolders(next.approvedFolders)
        if var validatedPrivacyPolicy {
            validatedPrivacyPolicy.approvedFolders = next.approvedFolders
            self.validatedPrivacyPolicy = validatedPrivacyPolicy
            PrivacyPolicyCache.save(validatedPrivacyPolicy)
        }
        startNativeCollectorIfNeeded()

        await performAction {
            var persisted = try await self.client.updatePrivacyPolicy(next)
            persisted.approvedFolders = next.approvedFolders
            self.privacyPolicy = persisted
            self.validatedPrivacyPolicy = persisted
            PrivacyPolicyCache.save(self.privacyPolicy)
            self.startNativeCollectorIfNeeded()
        }
    }

    func addApprovedFolder(path: String, project: ProjectSummary) async {
        let standardized = URL(fileURLWithPath: path).standardizedFileURL.path
        await updatePrivacyPolicy { policy in
            guard !policy.approvedFolders.contains(where: { $0.path == standardized }) else { return }
            policy.approvedFolders.append(
                ApprovedFolder(
                    path: standardized,
                    projectID: project.id,
                    projectName: project.name
                )
            )
        }
    }

    func removeApprovedFolder(id: String) async {
        await updatePrivacyPolicy { policy in
            policy.approvedFolders.removeAll { $0.id == id }
        }
    }

    func approveChromePairing(_ pairing: CollectorPairing) async {
        guard pairing.isPending else {
            operationError = pairing.isExpired
                ? "This Chrome pairing request expired. Create a new request from the extension."
                : "Only pending Chrome pairing requests can be approved."
            return
        }
        await performAction {
            try await self.client.approveChromePairing(id: pairing.id)
            self.chromePairings = try await self.client.fetchChromePairings()
        }
    }

    func revokeChromePairing(_ pairing: CollectorPairing) async {
        guard pairing.effectiveStatus != "revoked" else { return }
        await performAction {
            try await self.client.revokeChromePairing(id: pairing.id)
            self.chromePairings = try await self.client.fetchChromePairings()
        }
    }

    func confirmProjectIdentity(
        _ conflict: ProjectIdentityConflict,
        target: ProjectIdentityCandidate
    ) async {
        guard conflict.status == "pending",
              conflict.candidates.contains(where: { $0.projectID == target.projectID }) else {
            operationError = "That project is no longer a candidate for this identity conflict."
            return
        }
        await performAction {
            _ = try await self.client.confirmProjectIdentityConflict(
                id: conflict.id,
                targetProjectID: target.projectID
            )
            self.projectIdentityConflicts = try await self.client.fetchProjectIdentityConflicts()
        }
        if operationError == nil {
            await refresh()
        }
    }

    func loadGraph(
        query: String? = nil,
        nodeKinds: [String] = [],
        relations: [String] = [],
        aroundNodeID: String? = nil,
        hops: Int = 1
    ) async {
        let sessionToken = engineSessionGeneration.token
        let activeClient = client
        do {
            let fetched = try await activeClient.fetchGraph(
                GraphQuery(
                    projectID: activeProjectID,
                    query: query,
                    nodeKinds: nodeKinds,
                    relations: relations,
                    aroundNodeID: aroundNodeID,
                    hops: hops
                )
            )
            guard engineSessionGeneration.isCurrent(sessionToken) else { return }
            graph = fetched
            health.projection = graph.projection ?? ServiceHealth(status: "ready")
        } catch {
            guard engineSessionGeneration.isCurrent(sessionToken) else { return }
            health.projection = ServiceHealth(status: "degraded", message: error.localizedDescription)
            operationError = error.localizedDescription
        }
    }

    func reconnectSync() async {
        await performAction {
            if self.remoteAuthentication.isAuthenticated {
                let access = try await self.remoteAuthenticationService.validAccessSession()
                guard let configuration = self.remoteAuthenticationConfiguration else {
                    throw RemoteAuthenticationError.invalidConfiguration("Remote authentication is not configured.")
                }
                self.health.sync = try await self.client.configureRemoteSync(
                    endpoint: configuration.serviceURL,
                    accessToken: access.accessToken
                )
                self.remoteAuthentication.accessTokenExpiresAt = access.expiresAt
            }
            try await self.client.reconnectSync()
            self.health.sync = try await self.client.fetchSyncStatus()
            self.devices = ((try? await self.client.fetchDevices()) ?? []).map { device in
                var resolved = device
                resolved.isCurrent = device.id == self.syncStatus.currentDeviceID
                return resolved
            }
        }
    }

    func signInRemote(using draft: RemoteAuthenticationDraft) async {
        guard !remoteAuthentication.phase.isBusy else { return }
        do {
            let configuration = try draft.configuration()
            remoteAuthentication = RemoteAuthenticationState(
                phase: .signingIn,
                message: "Complete sign-in in your browser. Continuum verifies the callback with PKCE and request state."
            )
            let access = try await remoteAuthenticationService.signIn(configuration: configuration)
            draft.save()
            remoteAuthenticationConfiguration = configuration
            remoteAuthentication = RemoteAuthenticationState(
                phase: .signedIn,
                message: "Authenticated with Auth0. The refresh credential is stored only in this Mac’s Keychain.",
                accessTokenExpiresAt: access.expiresAt
            )
            do {
                try await installRemoteAccess(access, configuration: configuration)
            } catch {
                remoteAuthentication.message = "Signed in securely, but the local engine could not accept the synchronization session: \(error.localizedDescription)"
                operationError = error.localizedDescription
                return
            }
            await reconnectSync()
        } catch let error as RemoteAuthenticationError where error == .browserCancelled {
            remoteAuthentication = RemoteAuthenticationState(
                phase: .signedOut,
                message: error.localizedDescription
            )
        } catch {
            remoteAuthentication = RemoteAuthenticationState(
                phase: .failed,
                message: error.localizedDescription
            )
            operationError = error.localizedDescription
        }
    }

    func signOutRemote() async {
        guard !remoteAuthentication.phase.isBusy else { return }
        remoteAuthentication = RemoteAuthenticationState(
            phase: .signingOut,
            message: "Removing the local session and revoking its Auth0 refresh credential."
        )
        var revocationWarning: String?
        do {
            try await remoteAuthenticationService.signOut()
        } catch {
            revocationWarning = error.localizedDescription
        }
        do {
            health.sync = try await client.disconnectRemoteSync()
        } catch {
            operationError = error.localizedDescription
        }
        remoteAuthentication = RemoteAuthenticationState(
            phase: .signedOut,
            message: revocationWarning
                ?? "Signed out. The local Keychain refresh credential and in-memory access token were removed."
        )
    }

    func revokeDevice(_ device: DeviceSummary) async {
        guard !device.isCurrent else {
            operationError = "This Mac cannot revoke itself from the native app."
            return
        }
        await performAction {
            try await self.client.revokeDevice(id: device.id)
            self.devices.removeAll { $0.id == device.id }
        }
    }

    func sendChatMessage(_ rawText: String) async {
        let text = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isChatResponding else { return }
        guard !ChatSecretGuard.containsSecret(text) else {
            operationError = "That message looks like it contains a credential or secret. It was not stored or sent."
            return
        }

        let runID = UUID().uuidString.lowercased()
        isChatResponding = true
        activeChatRunID = runID
        operationError = nil
        defer {
            isChatResponding = false
            if activeChatRunID == runID {
                activeChatRunID = nil
            }
        }

        do {
            let desiredClassification = chatClassification
            let desiredEligibility = chatSyncEligibility
            let session: ChatSession
            if let existing = chatSession,
               Self.canReuseChatSession(
                   existing,
                   projectID: activeProjectID,
                   classification: desiredClassification,
                   syncEligibility: desiredEligibility
               ) {
                session = existing
            } else {
                session = try await client.createChatSession(
                    projectID: activeProjectID,
                    classification: desiredClassification,
                    syncEligibility: desiredEligibility
                )
                chatSession = session
                chatMessages = session.messages
                pendingChatActions = []
            }

            chatMessages.append(ChatMessage(sessionID: session.id, role: .user, text: text))
            let assistantID = UUID().uuidString
            chatMessages.append(
                ChatMessage(
                    id: assistantID,
                    sessionID: session.id,
                    role: .assistant,
                    text: "",
                    isStreaming: true
                )
            )

            let stream = await client.chatEvents(
                sessionID: session.id,
                text: text,
                projectID: activeProjectID,
                runID: runID
            )
            for try await event in stream {
                if let eventRunID = event.runID,
                   eventRunID != runID {
                    throw EngineClientError.invalidPayload("The daemon returned an unexpected chat run ID.")
                }
                if event.type == "cancelled" {
                    throw CancellationError()
                }
                if let delta = event.delta,
                   let index = chatMessages.firstIndex(where: { $0.id == assistantID }) {
                    chatMessages[index].text += delta
                }
                if let message = event.message,
                   let index = chatMessages.firstIndex(where: { $0.id == assistantID }) {
                    chatMessages[index] = message
                }
                if let citations = event.citations,
                   let index = chatMessages.firstIndex(where: { $0.id == assistantID }) {
                    for citation in citations where !chatMessages[index].citations.contains(where: { $0.id == citation.id }) {
                        chatMessages[index].citations.append(citation)
                    }
                }
                if let action = event.action {
                    pendingChatActions.removeAll { $0.id == action.id }
                    pendingChatActions.append(action)
                }
                if let error = event.error {
                    throw EngineClientError.invalidPayload(error)
                }
            }
            if let index = chatMessages.firstIndex(where: { $0.id == assistantID }) {
                chatMessages[index].isStreaming = false
                if chatMessages[index].text.isEmpty {
                    chatMessages[index].text = "The agent completed without returning text."
                }
            }
        } catch is CancellationError {
            if let index = chatMessages.lastIndex(where: { $0.role == .assistant && $0.isStreaming }) {
                chatMessages[index].isStreaming = false
                if chatMessages[index].text.isEmpty {
                    chatMessages[index].text = "Response stopped."
                }
            }
        } catch {
            if let index = chatMessages.lastIndex(where: { $0.role == .assistant && $0.isStreaming }) {
                chatMessages[index].isStreaming = false
                chatMessages[index].text = "Couldn’t complete this response: \(error.localizedDescription)"
            }
            operationError = error.localizedDescription
        }
    }

    func startChatMessage(_ text: String) {
        chatTask?.cancel()
        chatTask = Task { [weak self] in
            await self?.sendChatMessage(text)
        }
    }

    func confirmChatAction(_ action: ContextAction) async {
        guard let sessionID = chatSession?.id else { return }
        await performAction {
            let updated = try await self.client.confirmAction(sessionID: sessionID, actionID: action.id)
            self.pendingChatActions.removeAll { $0.id == action.id }
            self.pendingChatActions.append(updated)
            if ["confirmed", "completed"].contains(updated.status.lowercased()) {
                await self.refresh()
            }
        }
    }

    func cancelChat() async {
        let runID = activeChatRunID
        if let runID {
            do {
                try await client.cancelChatRun(id: runID)
            } catch {
                operationError = "The response stopped locally, but the engine cancellation request failed: \(error.localizedDescription)"
            }
        }
        chatTask?.cancel()
        chatTask = nil
        isChatResponding = false
        activeChatRunID = nil
        if let index = chatMessages.lastIndex(where: { $0.role == .assistant && $0.isStreaming }) {
            chatMessages[index].isStreaming = false
            if chatMessages[index].text.isEmpty {
                chatMessages[index].text = "Response stopped."
            }
        }
    }

    func openInspector(at section: InspectorSection) {
        navigation.open(section)
    }

    func recheckCollectorPermissions() {
        osCollector.recheckPermissions()
    }

    @discardableResult
    func openChat(for node: GraphNode) -> ChatDraftRequest? {
        navigation.openChat(for: node)
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

    private func startNativeCollectorIfNeeded() {
        if snapshot.capturePaused {
            osCollector.stop()
            return
        }
        osCollector.start(policy: validatedPrivacyPolicy) { [weak self] health in
            self?.health.collector = health
        }
    }

    private func startRemoteAuthenticationIfNeeded() {
        guard remoteAuthenticationTask == nil else { return }
        remoteAuthenticationTask = Task { [weak self] in
            guard let self else { return }
            await self.restoreRemoteAuthentication()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(300))
                guard !Task.isCancelled else { return }
                await self.refreshRemoteAuthentication()
            }
        }
    }

    private func restoreRemoteAuthentication() async {
        let draft = RemoteAuthenticationDraft.load()
        let configuration: RemoteAuthenticationConfiguration
        do {
            configuration = try draft.configuration()
        } catch {
            let hasPartialConfiguration = !draft.serviceURL.isEmpty
                || !draft.issuer.isEmpty
                || !draft.clientID.isEmpty
                || !draft.audience.isEmpty
            remoteAuthentication = RemoteAuthenticationState(
                phase: hasPartialConfiguration ? .failed : .notConfigured,
                message: hasPartialConfiguration
                    ? error.localizedDescription
                    : "Configure the self-hosted service and Auth0 native application to enable synchronization."
            )
            return
        }

        remoteAuthentication = RemoteAuthenticationState(
            phase: .refreshing,
            message: "Checking the device-only Keychain for a saved Auth0 session."
        )
        do {
            let access = try await remoteAuthenticationService.restore(configuration: configuration)
            remoteAuthenticationConfiguration = configuration
            remoteAuthentication = RemoteAuthenticationState(
                phase: .signedIn,
                message: "Authenticated with Auth0. Synchronization credentials are active only in memory.",
                accessTokenExpiresAt: access.expiresAt
            )
            do {
                try await installRemoteAccess(access, configuration: configuration)
            } catch {
                remoteAuthentication.message = "The Auth0 session is valid, but the local engine could not accept it: \(error.localizedDescription)"
                return
            }
            _ = try? await client.reconnectSync()
        } catch let error as RemoteAuthenticationError where error == .noRefreshCredential {
            remoteAuthentication = RemoteAuthenticationState(
                phase: .signedOut,
                message: "Remote synchronization is configured. Sign in to connect this Mac."
            )
        } catch {
            remoteAuthentication = RemoteAuthenticationState(
                phase: .failed,
                message: error.localizedDescription
            )
        }
    }

    private func refreshRemoteAuthentication(force: Bool = false) async {
        guard remoteAuthentication.isAuthenticated else { return }
        if !force,
           let expiry = remoteAuthentication.accessTokenExpiresAt,
           expiry.timeIntervalSinceNow > 10 * 60 {
            return
        }
        do {
            let access = try await remoteAuthenticationService.validAccessSession()
            guard let configuration = remoteAuthenticationConfiguration else {
                throw RemoteAuthenticationError.invalidConfiguration("Remote authentication is not configured.")
            }
            remoteAuthentication = RemoteAuthenticationState(
                phase: .signedIn,
                message: "Authenticated with Auth0. Synchronization credentials are active only in memory.",
                accessTokenExpiresAt: access.expiresAt
            )
            do {
                try await installRemoteAccess(access, configuration: configuration)
            } catch {
                remoteAuthentication.message = "The Auth0 session is valid, but the local engine could not accept it: \(error.localizedDescription)"
            }
        } catch {
            remoteAuthentication = RemoteAuthenticationState(
                phase: .failed,
                message: error.localizedDescription
            )
            _ = try? await client.disconnectRemoteSync()
        }
    }

    private func installRemoteAccess(
        _ access: RemoteAccessSession,
        configuration: RemoteAuthenticationConfiguration
    ) async throws {
        health.sync = try await client.configureRemoteSync(
            endpoint: configuration.serviceURL,
            accessToken: access.accessToken
        )
    }
}
