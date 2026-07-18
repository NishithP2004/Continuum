import Foundation

struct ProjectSummary: Codable, Equatable, Sendable, Identifiable {
    let id: String
    var name: String
    var path: String?

    init(id: String, name: String, path: String? = nil) {
        self.id = id
        self.name = name
        self.path = path
    }
}

struct ActivityItem: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var timestamp: String
    var source: String
    var eventType: String
    var title: String
    var relevance: String?

    init(
        id: String = UUID().uuidString,
        timestamp: String,
        source: String,
        eventType: String,
        title: String,
        relevance: String? = nil
    ) {
        self.id = id
        self.timestamp = timestamp
        self.source = source
        self.eventType = eventType
        self.title = title
        self.relevance = relevance
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case timestamp
        case time
        case source
        case eventType
        case type
        case title
        case relevance
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        timestamp = try values.decodeIfPresent(String.self, forKey: .timestamp)
            ?? values.decodeIfPresent(String.self, forKey: .time)
            ?? ""
        source = try values.decodeIfPresent(String.self, forKey: .source) ?? "unknown"
        eventType = try values.decodeIfPresent(String.self, forKey: .eventType)
            ?? values.decodeIfPresent(String.self, forKey: .type)
            ?? "activity"
        title = try values.decodeIfPresent(String.self, forKey: .title) ?? eventType
        relevance = try values.decodeIfPresent(String.self, forKey: .relevance)
        id = try values.decodeIfPresent(String.self, forKey: .id)
            ?? "\(source):\(timestamp):\(title)"
    }
}

struct PrivacyRuleStat: Codable, Equatable, Sendable, Identifiable {
    var rule: String
    var count: Int

    var id: String { rule }
}

struct PrivacySummary: Decodable, Equatable, Sendable {
    var accepted: Int
    var droppedSecrets: Int
    var keptLocal: Int
    var expired: Int
    var rules: [PrivacyRuleStat]

    init(
        accepted: Int = 0,
        droppedSecrets: Int = 0,
        keptLocal: Int = 0,
        expired: Int = 0,
        rules: [PrivacyRuleStat] = []
    ) {
        self.accepted = accepted
        self.droppedSecrets = droppedSecrets
        self.keptLocal = keptLocal
        self.expired = expired
        self.rules = rules
    }

    private enum CodingKeys: String, CodingKey {
        case accepted
        case droppedSecrets
        case secretRejected
        case keptLocal
        case confidentialLocal
        case expired
        case rules
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        accepted = try values.decodeIfPresent(Int.self, forKey: .accepted) ?? 0
        droppedSecrets = try values.decodeIfPresent(Int.self, forKey: .droppedSecrets)
            ?? values.decodeIfPresent(Int.self, forKey: .secretRejected)
            ?? 0
        keptLocal = try values.decodeIfPresent(Int.self, forKey: .keptLocal)
            ?? values.decodeIfPresent(Int.self, forKey: .confidentialLocal)
            ?? 0
        expired = try values.decodeIfPresent(Int.self, forKey: .expired) ?? 0
        rules = try values.decodeIfPresent([PrivacyRuleStat].self, forKey: .rules) ?? []
    }
}

struct ProviderHealth: Codable, Equatable, Sendable {
    var provider: String
    var model: String
    var status: String
    var message: String?
    var cloudActive: Bool

    init(
        provider: String = "local",
        model: String = "gemma3n:e2b",
        status: String = "unknown",
        message: String? = nil,
        cloudActive: Bool = false
    ) {
        self.provider = provider
        self.model = model
        self.status = status
        self.message = message
        self.cloudActive = cloudActive
    }
}

struct RetrievalHealth: Codable, Equatable, Sendable {
    var mode: String
    var degraded: Bool
    var message: String?
    var checkpointCount: Int
    var graphNodeCount: Int
    var graphEdgeCount: Int

    init(
        mode: String = "fts+graph",
        degraded: Bool = true,
        message: String? = "Vector retrieval has not reported ready.",
        checkpointCount: Int = 0,
        graphNodeCount: Int = 0,
        graphEdgeCount: Int = 0
    ) {
        self.mode = mode
        self.degraded = degraded
        self.message = message
        self.checkpointCount = checkpointCount
        self.graphNodeCount = graphNodeCount
        self.graphEdgeCount = graphEdgeCount
    }
}

struct EngineSnapshot: Decodable, Equatable, Sendable {
    var status: String
    var capturePaused: Bool
    var activeProject: ProjectSummary?
    var currentCheckpoint: CheckpointSummary?
    var recentActivity: [ActivityItem]
    var privacy: PrivacySummary
    var provider: ProviderHealth
    var retrieval: RetrievalHealth
    var pendingEvents: Int
    var collectorNames: [String]

    init(
        status: String = "ok",
        capturePaused: Bool = false,
        activeProject: ProjectSummary? = nil,
        currentCheckpoint: CheckpointSummary? = nil,
        recentActivity: [ActivityItem] = [],
        privacy: PrivacySummary = PrivacySummary(),
        provider: ProviderHealth = ProviderHealth(),
        retrieval: RetrievalHealth = RetrievalHealth(),
        pendingEvents: Int = 0,
        collectorNames: [String] = []
    ) {
        self.status = status
        self.capturePaused = capturePaused
        self.activeProject = activeProject
        self.currentCheckpoint = currentCheckpoint
        self.recentActivity = recentActivity
        self.privacy = privacy
        self.provider = provider
        self.retrieval = retrieval
        self.pendingEvents = pendingEvents
        self.collectorNames = collectorNames
    }

    private enum CodingKeys: String, CodingKey {
        case status
        case connected
        case capturePaused
        case paused
        case activeProject
        case projectID = "projectId"
        case currentCheckpoint
        case current
        case recentActivity
        case activity
        case privacy
        case droppedSecretCount
        case provider
        case providerHealth
        case settings
        case retrieval
        case retrievalMode
        case pendingEvents
        case eventCount
        case checkpointCount
        case collectorNames
        case collectors
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        if let explicitStatus = try values.decodeIfPresent(String.self, forKey: .status) {
            status = explicitStatus
        } else if let connected = try values.decodeIfPresent(Bool.self, forKey: .connected) {
            status = connected ? "ok" : "disconnected"
        } else {
            status = "ok"
        }
        capturePaused = try values.decodeIfPresent(Bool.self, forKey: .capturePaused)
            ?? values.decodeIfPresent(Bool.self, forKey: .paused)
            ?? false
        if let project = try? values.decode(ProjectSummary.self, forKey: .activeProject) {
            activeProject = project
        } else if let projectID = try values.decodeIfPresent(String.self, forKey: .projectID) {
            activeProject = ProjectSummary(id: projectID, name: projectID)
        } else {
            activeProject = nil
        }
        currentCheckpoint = (try? values.decode(CheckpointSummary.self, forKey: .currentCheckpoint))
            ?? (try? values.decode(CheckpointSummary.self, forKey: .current))
        recentActivity = (try? values.decode([ActivityItem].self, forKey: .recentActivity))
            ?? (try? values.decode([ActivityItem].self, forKey: .activity))
            ?? []

        if let detailedPrivacy = try? values.decode(PrivacySummary.self, forKey: .privacy) {
            privacy = detailedPrivacy
        } else {
            privacy = PrivacySummary(
                accepted: try values.decodeIfPresent(Int.self, forKey: .eventCount) ?? 0,
                droppedSecrets: try values.decodeIfPresent(Int.self, forKey: .droppedSecretCount) ?? 0
            )
        }

        let settings = try? values.decode(ModelSettings.self, forKey: .settings)
        if let detailedProvider = try? values.decode(ProviderHealth.self, forKey: .provider) {
            provider = detailedProvider
        } else {
            let availability = try? values.decode(ProviderAvailability.self, forKey: .providerHealth)
            let selectedProvider = settings?.provider ?? .local
            let availabilityValue = selectedProvider == .local
                ? availability?.ollama
                : availability?.openai
            provider = ProviderHealth(
                provider: selectedProvider == .local ? "ollama" : "openai",
                model: settings?.model ?? (selectedProvider == .local ? "gemma3n:e2b" : "gpt-5.6-terra"),
                status: availabilityValue == "available" ? "ready" : (availabilityValue ?? "unknown"),
                message: availabilityValue == "unavailable" ? "The selected checkpoint provider is unavailable." : nil,
                cloudActive: selectedProvider == .openai
            )
        }

        if let detailedRetrieval = try? values.decode(RetrievalHealth.self, forKey: .retrieval) {
            retrieval = detailedRetrieval
        } else {
            let mode = try values.decodeIfPresent(String.self, forKey: .retrievalMode) ?? "fts_graph"
            retrieval = RetrievalHealth(
                mode: mode == "fts_graph" ? "FTS + graph" : "Hybrid",
                degraded: mode == "fts_graph",
                message: mode == "fts_graph" ? "Vector search unavailable; using FTS plus graph retrieval." : nil,
                checkpointCount: try values.decodeIfPresent(Int.self, forKey: .checkpointCount) ?? 0
            )
        }

        pendingEvents = try values.decodeIfPresent(Int.self, forKey: .pendingEvents)
            ?? values.decodeIfPresent(Int.self, forKey: .eventCount)
            ?? 0
        collectorNames = try values.decodeIfPresent([String].self, forKey: .collectorNames)
            ?? values.decodeIfPresent([String].self, forKey: .collectors)
            ?? []
    }
}

private struct ProviderAvailability: Decodable {
    let ollama: String
    let openai: String
}

enum ProviderKind: String, CaseIterable, Codable, Sendable {
    case local
    case openai

    var title: String {
        switch self {
        case .local: "Local · Ollama"
        case .openai: "Cloud · OpenAI"
        }
    }
}

struct ModelSettings: Decodable, Equatable, Sendable {
    var provider: ProviderKind
    var model: String
    var localModel: String
    var cloudModel: String

    init(
        provider: ProviderKind = .local,
        model: String = "gemma3n:e2b",
        localModel: String = "gemma3n:e2b",
        cloudModel: String = "gpt-5.6-terra"
    ) {
        self.provider = provider
        self.model = model
        self.localModel = localModel
        self.cloudModel = cloudModel
    }

    private enum CodingKeys: String, CodingKey {
        case provider
        case model
        case localModel
        case cloudModel
        case activeCheckpointProvider
        case ollamaModel
        case openaiModel
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let activeProvider = try values.decodeIfPresent(String.self, forKey: .activeCheckpointProvider)
        if let providerValue = try values.decodeIfPresent(ProviderKind.self, forKey: .provider) {
            provider = providerValue
        } else {
            provider = activeProvider == "openai" ? .openai : .local
        }
        localModel = try values.decodeIfPresent(String.self, forKey: .localModel)
            ?? values.decodeIfPresent(String.self, forKey: .ollamaModel)
            ?? "gemma3n:e2b"
        cloudModel = try values.decodeIfPresent(String.self, forKey: .cloudModel)
            ?? values.decodeIfPresent(String.self, forKey: .openaiModel)
            ?? "gpt-5.6-terra"
        model = try values.decodeIfPresent(String.self, forKey: .model)
            ?? (provider == .local ? localModel : cloudModel)
        if provider == .local {
            localModel = model
        } else {
            cloudModel = model
        }
    }
}
