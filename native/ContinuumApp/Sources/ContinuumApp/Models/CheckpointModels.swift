import Foundation

struct EvidenceItem: Decodable, Equatable, Sendable, Identifiable {
    var text: String
    var evidenceEventIDs: [String]

    var id: String { "\(text):\(evidenceEventIDs.joined(separator: ","))" }

    init(text: String, evidenceEventIDs: [String] = []) {
        self.text = text
        self.evidenceEventIDs = evidenceEventIDs
    }

    private enum CodingKeys: String, CodingKey {
        case text
        case summary
        case value
        case evidenceEventIDs = "evidenceEventIds"
        case evidenceIds
        case eventIds
    }

    init(from decoder: Decoder) throws {
        if let scalar = try? decoder.singleValueContainer(),
           let text = try? scalar.decode(String.self) {
            self.init(text: text)
            return
        }

        let values = try decoder.container(keyedBy: CodingKeys.self)
        let text = try values.decodeIfPresent(String.self, forKey: .text)
            ?? values.decodeIfPresent(String.self, forKey: .summary)
            ?? values.decodeIfPresent(String.self, forKey: .value)
            ?? "Untitled evidence"
        let evidenceEventIDs = try values.decodeIfPresent([String].self, forKey: .evidenceEventIDs)
            ?? values.decodeIfPresent([String].self, forKey: .evidenceIds)
            ?? values.decodeIfPresent([String].self, forKey: .eventIds)
            ?? []
        self.init(text: text, evidenceEventIDs: evidenceEventIDs)
    }
}

struct BlockerItem: Codable, Equatable, Sendable, Identifiable {
    var text: String
    var status: String
    var evidenceEventIDs: [String]

    var id: String { "\(status):\(text)" }

    init(text: String, status: String = "open", evidenceEventIDs: [String] = []) {
        self.text = text
        self.status = status
        self.evidenceEventIDs = evidenceEventIDs
    }

    private enum CodingKeys: String, CodingKey {
        case text
        case status
        case evidenceEventIDs = "evidenceEventIds"
        case evidenceIds
        case eventIds
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        text = try values.decodeIfPresent(String.self, forKey: .text) ?? "Untitled blocker"
        status = try values.decodeIfPresent(String.self, forKey: .status) ?? "open"
        evidenceEventIDs = try values.decodeIfPresent([String].self, forKey: .evidenceEventIDs)
            ?? values.decodeIfPresent([String].self, forKey: .evidenceIds)
            ?? values.decodeIfPresent([String].self, forKey: .eventIds)
            ?? []
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(text, forKey: .text)
        try values.encode(status, forKey: .status)
        try values.encode(evidenceEventIDs, forKey: .eventIds)
    }
}

struct HypothesisItem: Codable, Equatable, Sendable, Identifiable {
    var text: String
    var state: String
    var evidenceEventIDs: [String]

    var id: String { "\(state):\(text)" }

    init(text: String, state: String = "active", evidenceEventIDs: [String] = []) {
        self.text = text
        self.state = state
        self.evidenceEventIDs = evidenceEventIDs
    }

    private enum CodingKeys: String, CodingKey {
        case text
        case state
        case status
        case evidenceEventIDs = "evidenceEventIds"
        case evidenceIds
        case eventIds
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        text = try values.decodeIfPresent(String.self, forKey: .text) ?? "Untitled hypothesis"
        state = try values.decodeIfPresent(String.self, forKey: .state)
            ?? values.decodeIfPresent(String.self, forKey: .status)
            ?? "active"
        evidenceEventIDs = try values.decodeIfPresent([String].self, forKey: .evidenceEventIDs)
            ?? values.decodeIfPresent([String].self, forKey: .evidenceIds)
            ?? values.decodeIfPresent([String].self, forKey: .eventIds)
            ?? []
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(text, forKey: .text)
        try values.encode(state, forKey: .status)
        try values.encode(evidenceEventIDs, forKey: .eventIds)
    }
}

struct EntityItem: Decodable, Equatable, Sendable, Identifiable {
    var name: String
    var type: String
    var key: String?

    var id: String { "\(type):\(name)" }

    init(name: String, type: String = "concept", key: String? = nil) {
        self.name = name
        self.type = type
        self.key = key
    }

    private enum CodingKeys: String, CodingKey {
        case name
        case type
        case key
        case label
        case kind
    }

    init(from decoder: Decoder) throws {
        if let scalar = try? decoder.singleValueContainer(),
           let name = try? scalar.decode(String.self) {
            self.init(name: name)
            return
        }
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let key = try values.decodeIfPresent(String.self, forKey: .key)
        let name = try values.decodeIfPresent(String.self, forKey: .name)
            ?? values.decodeIfPresent(String.self, forKey: .label)
            ?? key
            ?? "Unknown"
        let type = try values.decodeIfPresent(String.self, forKey: .type)
            ?? values.decodeIfPresent(String.self, forKey: .kind)
            ?? "concept"
        self.init(name: name, type: type, key: key)
    }
}

struct CheckpointSummary: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var projectID: String
    var goal: String
    var focus: String
    var summary: String
    var progress: [EvidenceItem]
    var blockers: [BlockerItem]
    var hypotheses: [HypothesisItem]
    var decisions: [EvidenceItem]
    var questions: [EvidenceItem]
    var files: [String]
    var commits: [String]
    var entities: [EntityItem]
    var importance: Double
    var confidence: Double
    var provider: String
    var model: String
    var createdAt: String

    init(
        id: String,
        projectID: String,
        goal: String,
        focus: String,
        summary: String,
        progress: [EvidenceItem] = [],
        blockers: [BlockerItem] = [],
        hypotheses: [HypothesisItem] = [],
        decisions: [EvidenceItem] = [],
        questions: [EvidenceItem] = [],
        files: [String] = [],
        commits: [String] = [],
        entities: [EntityItem] = [],
        importance: Double = 0.5,
        confidence: Double = 0.5,
        provider: String = "unknown",
        model: String = "unknown",
        createdAt: String
    ) {
        self.id = id
        self.projectID = projectID
        self.goal = goal
        self.focus = focus
        self.summary = summary
        self.progress = progress
        self.blockers = blockers
        self.hypotheses = hypotheses
        self.decisions = decisions
        self.questions = questions
        self.files = files
        self.commits = commits
        self.entities = entities
        self.importance = importance
        self.confidence = confidence
        self.provider = provider
        self.model = model
        self.createdAt = createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case checkpointID = "checkpointId"
        case projectID = "projectId"
        case goal
        case focus
        case summary
        case progress
        case blockers
        case hypotheses
        case decisions
        case questions
        case files
        case commits
        case entities
        case importance
        case confidence
        case provider
        case model
        case createdAt
        case timestamp
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decodeIfPresent(String.self, forKey: .id)
            ?? values.decodeIfPresent(String.self, forKey: .checkpointID)
            ?? UUID().uuidString
        projectID = try values.decodeIfPresent(String.self, forKey: .projectID) ?? "default"
        goal = try values.decodeIfPresent(String.self, forKey: .goal) ?? "Resume the active task"
        focus = try values.decodeIfPresent(String.self, forKey: .focus) ?? "No focus reported"
        summary = try values.decodeIfPresent(String.self, forKey: .summary) ?? focus
        progress = try values.decodeIfPresent([EvidenceItem].self, forKey: .progress) ?? []
        blockers = try values.decodeIfPresent([BlockerItem].self, forKey: .blockers) ?? []
        hypotheses = try values.decodeIfPresent([HypothesisItem].self, forKey: .hypotheses) ?? []
        decisions = try values.decodeIfPresent([EvidenceItem].self, forKey: .decisions) ?? []
        questions = try values.decodeIfPresent([EvidenceItem].self, forKey: .questions) ?? []
        entities = try values.decodeIfPresent([EntityItem].self, forKey: .entities) ?? []
        files = try values.decodeIfPresent([String].self, forKey: .files)
            ?? entities.filter { $0.type == "file" }.map { $0.key ?? $0.name }
        commits = try values.decodeIfPresent([String].self, forKey: .commits)
            ?? entities.filter { $0.type == "commit" }.map { $0.key ?? $0.name }
        importance = try values.decodeIfPresent(Double.self, forKey: .importance) ?? 0.5
        confidence = try values.decodeIfPresent(Double.self, forKey: .confidence) ?? 0.5
        provider = try values.decodeIfPresent(String.self, forKey: .provider) ?? "unknown"
        model = try values.decodeIfPresent(String.self, forKey: .model) ?? "unknown"
        createdAt = try values.decodeIfPresent(String.self, forKey: .createdAt)
            ?? values.decodeIfPresent(String.self, forKey: .timestamp)
            ?? ""
    }
}

struct HypothesisChange: Decodable, Equatable, Sendable, Identifiable {
    var text: String
    var from: String
    var to: String
    var evidenceEventIDs: [String]

    var id: String { "\(from):\(to):\(text)" }

    private enum CodingKeys: String, CodingKey {
        case text
        case from
        case to
        case state
        case status
        case evidenceEventIDs = "evidenceEventIds"
        case evidenceIds
        case eventIds
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        text = try values.decodeIfPresent(String.self, forKey: .text) ?? "Untitled hypothesis"
        from = try values.decodeIfPresent(String.self, forKey: .from) ?? "active"
        to = try values.decodeIfPresent(String.self, forKey: .to)
            ?? values.decodeIfPresent(String.self, forKey: .state)
            ?? values.decodeIfPresent(String.self, forKey: .status)
            ?? "changed"
        evidenceEventIDs = try values.decodeIfPresent([String].self, forKey: .evidenceEventIDs)
            ?? values.decodeIfPresent([String].self, forKey: .evidenceIds)
            ?? values.decodeIfPresent([String].self, forKey: .eventIds)
            ?? []
    }
}

struct ContextDiffSummary: Decodable, Equatable, Sendable {
    var baselineCheckpointID: String?
    var currentCheckpointID: String?
    var addedBlockers: [BlockerItem]
    var resolvedBlockers: [BlockerItem]
    var changedHypotheses: [HypothesisChange]
    var newDecisions: [EvidenceItem]
    var newFiles: [String]
    var newCommits: [String]
    var newEntities: [EntityItem]
    var briefing: String?

    init(
        baselineCheckpointID: String? = nil,
        currentCheckpointID: String? = nil,
        addedBlockers: [BlockerItem] = [],
        resolvedBlockers: [BlockerItem] = [],
        changedHypotheses: [HypothesisChange] = [],
        newDecisions: [EvidenceItem] = [],
        newFiles: [String] = [],
        newCommits: [String] = [],
        newEntities: [EntityItem] = [],
        briefing: String? = nil
    ) {
        self.baselineCheckpointID = baselineCheckpointID
        self.currentCheckpointID = currentCheckpointID
        self.addedBlockers = addedBlockers
        self.resolvedBlockers = resolvedBlockers
        self.changedHypotheses = changedHypotheses
        self.newDecisions = newDecisions
        self.newFiles = newFiles
        self.newCommits = newCommits
        self.newEntities = newEntities
        self.briefing = briefing
    }

    private enum CodingKeys: String, CodingKey {
        case baselineCheckpointID = "baselineCheckpointId"
        case currentCheckpointID = "currentCheckpointId"
        case addedBlockers
        case resolvedBlockers
        case changedHypotheses
        case newDecisions
        case newFiles
        case newCommits
        case newEntities
        case briefing
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        baselineCheckpointID = try values.decodeIfPresent(String.self, forKey: .baselineCheckpointID)
        currentCheckpointID = try values.decodeIfPresent(String.self, forKey: .currentCheckpointID)
        addedBlockers = try values.decodeIfPresent([BlockerItem].self, forKey: .addedBlockers) ?? []
        resolvedBlockers = try values.decodeIfPresent([BlockerItem].self, forKey: .resolvedBlockers) ?? []
        changedHypotheses = try values.decodeIfPresent([HypothesisChange].self, forKey: .changedHypotheses) ?? []
        newDecisions = try values.decodeIfPresent([EvidenceItem].self, forKey: .newDecisions) ?? []

        let fileEntities = try? values.decode([EntityItem].self, forKey: .newFiles)
        if let fileEntities {
            newFiles = fileEntities.map { $0.key ?? $0.name }
        } else {
            newFiles = try values.decodeIfPresent([String].self, forKey: .newFiles) ?? []
        }

        let commitEntities = try? values.decode([EntityItem].self, forKey: .newCommits)
        if let commitEntities {
            newCommits = commitEntities.map { $0.key ?? $0.name }
        } else {
            newCommits = try values.decodeIfPresent([String].self, forKey: .newCommits) ?? []
        }

        newEntities = try values.decodeIfPresent([EntityItem].self, forKey: .newEntities) ?? []

        if let text = try? values.decode(String.self, forKey: .briefing) {
            briefing = text
        } else if let structured = try? values.decode(StructuredBriefing.self, forKey: .briefing) {
            briefing = structured.formatted
        } else {
            briefing = nil
        }
    }
}

private struct StructuredBriefing: Decodable {
    let headline: String
    let summary: String
    let nextActions: [String]

    var formatted: String {
        let actions = nextActions.map { "• \($0)" }.joined(separator: "\n")
        return actions.isEmpty
            ? "\(headline)\n\n\(summary)"
            : "\(headline)\n\n\(summary)\n\nNext actions\n\(actions)"
    }
}
