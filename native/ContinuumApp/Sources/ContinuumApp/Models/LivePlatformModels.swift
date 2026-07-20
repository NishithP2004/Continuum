import Foundation

struct ApprovedFolder: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var path: String
    var projectID: String
    var projectName: String

    init(
        id: String = UUID().uuidString,
        path: String,
        projectID: String,
        projectName: String
    ) {
        self.id = id
        self.path = path
        self.projectID = projectID
        self.projectName = projectName
    }

    private enum CodingKeys: String, CodingKey {
        case id, path, projectName
        case projectID = "projectId"
    }
}

struct PrivacyPolicyV1: Codable, Equatable, Sendable {
    var version: Int
    var updatedAt: String
    var sourceEnabled: [String: Bool]
    var captureWindowTitles: Bool
    var includeRelativePaths: Bool
    var includeURLHosts: Bool
    var includeURLPaths: Bool
    var includeCommandNames: Bool
    var includeCommandFlagNames: Bool
    var personalMetadataEnabled: Bool
    var confidentialLocalCollectionEnabled: Bool
    var cloudSharingEnabled: Bool
    var retentionHours: Int
    var allowedDomains: [String]
    var ignoredDomains: [String]
    var ignoredPaths: [String]
    var approvedFolders: [ApprovedFolder]

    init(
        version: Int = 1,
        updatedAt: String = ISO8601DateFormatter().string(from: Date()),
        sourceEnabled: [String: Bool] = [
            "vscode": true,
            "terminal": true,
            "git": true,
            "chrome": true,
            "os_app": true,
            "os_window": false,
            "os_folder": true
        ],
        captureWindowTitles: Bool = false,
        includeRelativePaths: Bool = true,
        includeURLHosts: Bool = true,
        includeURLPaths: Bool = false,
        includeCommandNames: Bool = true,
        includeCommandFlagNames: Bool = false,
        personalMetadataEnabled: Bool = true,
        confidentialLocalCollectionEnabled: Bool = true,
        cloudSharingEnabled: Bool = false,
        retentionHours: Int = 24,
        allowedDomains: [String] = [],
        ignoredDomains: [String] = [],
        ignoredPaths: [String] = ["**/.env*", "**/.git/objects/**", "**/node_modules/**"],
        approvedFolders: [ApprovedFolder] = []
    ) {
        self.version = version
        self.updatedAt = updatedAt
        self.sourceEnabled = sourceEnabled
        self.captureWindowTitles = captureWindowTitles
        self.includeRelativePaths = includeRelativePaths
        self.includeURLHosts = includeURLHosts
        self.includeURLPaths = includeURLPaths
        self.includeCommandNames = includeCommandNames
        self.includeCommandFlagNames = includeCommandFlagNames
        self.personalMetadataEnabled = personalMetadataEnabled
        self.confidentialLocalCollectionEnabled = confidentialLocalCollectionEnabled
        self.cloudSharingEnabled = cloudSharingEnabled
        self.retentionHours = retentionHours
        self.allowedDomains = allowedDomains
        self.ignoredDomains = ignoredDomains
        self.ignoredPaths = ignoredPaths
        self.approvedFolders = approvedFolders
    }

    static func failClosed(approvedFolders: [ApprovedFolder] = []) -> PrivacyPolicyV1 {
        PrivacyPolicyV1(
            version: 1,
            updatedAt: "1970-01-01T00:00:00Z",
            sourceEnabled: [
                "vscode": false,
                "terminal": false,
                "git": false,
                "chrome": false,
                "os_app": false,
                "os_window": false,
                "os_folder": false
            ],
            captureWindowTitles: false,
            includeRelativePaths: false,
            includeURLHosts: false,
            includeURLPaths: false,
            includeCommandNames: false,
            includeCommandFlagNames: false,
            personalMetadataEnabled: false,
            confidentialLocalCollectionEnabled: false,
            cloudSharingEnabled: false,
            retentionHours: 1,
            approvedFolders: approvedFolders
        )
    }

    private enum CodingKeys: String, CodingKey {
        case version, revision, updatedAt, sources, metadata, retentionHours
        case allowedDomains, ignoredDomains, ignoredPathPatterns, immutableProtections
    }

    private struct WireSources: Codable {
        var osApps: Bool
        var osWindows: Bool
        var approvedFolders: Bool
        var vscode: Bool
        var terminal: Bool
        var git: Bool
        var chrome: Bool
    }

    private struct WireMetadata: Codable {
        var relativeFilePaths: Bool
        var urlHosts: Bool
        var urlPaths: Bool
        var commandNames: Bool
        var commandFlagNames: Bool
        var personalMetadata: Bool
        var confidentialLocalCollection: Bool
        var personalCloudEligibility: Bool
    }

    private struct ImmutableProtections: Codable {
        var secretDetection = true
        var attributeAllowlist = true
        var prohibitedContentExclusion = true
        var confidentialCloudBlock = true
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let wireVersion = try values.decode(String.self, forKey: .version)
        guard wireVersion == "1" else {
            throw DecodingError.dataCorruptedError(
                forKey: .version,
                in: values,
                debugDescription: "Unsupported privacy policy version."
            )
        }
        version = try values.decode(Int.self, forKey: .revision)
        guard version >= 1 else {
            throw DecodingError.dataCorruptedError(
                forKey: .revision,
                in: values,
                debugDescription: "Privacy policy revision must be positive."
            )
        }
        updatedAt = try values.decode(String.self, forKey: .updatedAt)
        let fractionalTimestamp = ISO8601DateFormatter()
        fractionalTimestamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard ISO8601DateFormatter().date(from: updatedAt) != nil
                || fractionalTimestamp.date(from: updatedAt) != nil else {
            throw DecodingError.dataCorruptedError(
                forKey: .updatedAt,
                in: values,
                debugDescription: "Privacy policy timestamp is invalid."
            )
        }

        let sources = try values.decode(WireSources.self, forKey: .sources)
        sourceEnabled = [
            "vscode": sources.vscode,
            "terminal": sources.terminal,
            "git": sources.git,
            "chrome": sources.chrome,
            "os_app": sources.osApps,
            "os_window": sources.osWindows,
            "os_folder": sources.approvedFolders
        ]
        captureWindowTitles = sources.osWindows

        let metadata = try values.decode(WireMetadata.self, forKey: .metadata)
        includeRelativePaths = metadata.relativeFilePaths
        includeURLHosts = metadata.urlHosts
        includeURLPaths = metadata.urlPaths
        includeCommandNames = metadata.commandNames
        includeCommandFlagNames = metadata.commandFlagNames
        personalMetadataEnabled = metadata.personalMetadata
        confidentialLocalCollectionEnabled = metadata.confidentialLocalCollection
        cloudSharingEnabled = metadata.personalCloudEligibility
        retentionHours = min(max(try values.decode(Int.self, forKey: .retentionHours), 1), 24)
        allowedDomains = try values.decode([String].self, forKey: .allowedDomains)
        ignoredDomains = try values.decode([String].self, forKey: .ignoredDomains)
        ignoredPaths = try values.decode([String].self, forKey: .ignoredPathPatterns)
        let immutable = try values.decode(ImmutableProtections.self, forKey: .immutableProtections)
        guard immutable.secretDetection,
              immutable.attributeAllowlist,
              immutable.prohibitedContentExclusion,
              immutable.confidentialCloudBlock else {
            throw DecodingError.dataCorruptedError(
                forKey: .immutableProtections,
                in: values,
                debugDescription: "Immutable privacy protections cannot be disabled."
            )
        }
        approvedFolders = []
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode("1", forKey: .version)
        try values.encode(version, forKey: .revision)
        try values.encode(updatedAt, forKey: .updatedAt)
        try values.encode(
            WireSources(
                osApps: sourceEnabled["os_app"] ?? true,
                osWindows: captureWindowTitles && (sourceEnabled["os_window"] ?? false),
                approvedFolders: sourceEnabled["os_folder"] ?? true,
                vscode: sourceEnabled["vscode"] ?? true,
                terminal: sourceEnabled["terminal"] ?? true,
                git: sourceEnabled["git"] ?? true,
                chrome: sourceEnabled["chrome"] ?? true
            ),
            forKey: .sources
        )
        try values.encode(
            WireMetadata(
                relativeFilePaths: includeRelativePaths,
                urlHosts: includeURLHosts,
                urlPaths: includeURLPaths,
                commandNames: includeCommandNames,
                commandFlagNames: includeCommandFlagNames,
                personalMetadata: personalMetadataEnabled,
                confidentialLocalCollection: confidentialLocalCollectionEnabled,
                personalCloudEligibility: cloudSharingEnabled
            ),
            forKey: .metadata
        )
        try values.encode(retentionHours, forKey: .retentionHours)
        try values.encode(allowedDomains, forKey: .allowedDomains)
        try values.encode(ignoredDomains, forKey: .ignoredDomains)
        try values.encode(ignoredPaths, forKey: .ignoredPathPatterns)
        try values.encode(ImmutableProtections(), forKey: .immutableProtections)
    }
}

struct PrivacyAuditEntry: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var rule: String
    var decision: String
    var count: Int
    var source: String
    var timestamp: String

    init(
        id: String = UUID().uuidString,
        rule: String,
        decision: String,
        count: Int,
        source: String,
        timestamp: String
    ) {
        self.id = id
        self.rule = rule
        self.decision = decision
        self.count = count
        self.source = source
        self.timestamp = timestamp
    }

    private enum CodingKeys: String, CodingKey {
        case id, rule, decision, action, count, source, timestamp, time, occurredAt
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        rule = try values.decodeIfPresent(String.self, forKey: .rule) ?? "unknown_rule"
        decision = try values.decodeIfPresent(String.self, forKey: .decision)
            ?? values.decodeIfPresent(String.self, forKey: .action)
            ?? "unknown"
        count = try values.decodeIfPresent(Int.self, forKey: .count) ?? 0
        source = try values.decodeIfPresent(String.self, forKey: .source) ?? "unknown"
        timestamp = try values.decodeIfPresent(String.self, forKey: .timestamp)
            ?? values.decodeIfPresent(String.self, forKey: .time)
            ?? values.decodeIfPresent(String.self, forKey: .occurredAt)
            ?? ""
        id = try values.decodeIfPresent(String.self, forKey: .id)
            ?? "\(rule):\(decision):\(source):\(timestamp)"
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(rule, forKey: .rule)
        try values.encode(decision, forKey: .decision)
        try values.encode(count, forKey: .count)
        try values.encode(source, forKey: .source)
        try values.encode(timestamp, forKey: .timestamp)
    }
}

struct CollectorPairing: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var kind: String
    var clientID: String
    var status: String
    var createdAt: String
    var expiresAt: String
    var approvedAt: String?
    var revokedAt: String?
    var resolvedProject: ProjectSummary?

    private enum CodingKeys: String, CodingKey {
        case id, kind, status, createdAt, expiresAt, approvedAt, revokedAt
        case resolvedProject, project, projectName
        case clientID = "clientId"
        case projectID = "projectId"
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        kind = try values.decodeIfPresent(String.self, forKey: .kind) ?? "chrome"
        clientID = try values.decode(String.self, forKey: .clientID)
        status = try values.decode(String.self, forKey: .status)
        createdAt = try values.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        expiresAt = try values.decodeIfPresent(String.self, forKey: .expiresAt) ?? ""
        approvedAt = try values.decodeIfPresent(String.self, forKey: .approvedAt)
        revokedAt = try values.decodeIfPresent(String.self, forKey: .revokedAt)
        resolvedProject = (try? values.decode(ProjectSummary.self, forKey: .resolvedProject))
            ?? (try? values.decode(ProjectSummary.self, forKey: .project))
        if resolvedProject == nil,
           let projectID = try values.decodeIfPresent(String.self, forKey: .projectID) {
            resolvedProject = ProjectSummary(
                id: projectID,
                name: try values.decodeIfPresent(String.self, forKey: .projectName) ?? projectID
            )
        }
    }

    var isExpired: Bool {
        guard ["pending", "approved"].contains(status.lowercased()),
              let expiryDate else {
            return false
        }
        return expiryDate <= Date()
    }

    var effectiveStatus: String {
        isExpired ? "expired" : status.lowercased()
    }

    var isPending: Bool { effectiveStatus == "pending" }
    var isConnected: Bool { effectiveStatus == "paired" }

    var expiryDate: Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: expiresAt) ?? ISO8601DateFormatter().date(from: expiresAt)
    }
}

struct ProjectIdentityCandidate: Decodable, Equatable, Sendable, Identifiable {
    var projectID: String
    var label: String

    var id: String { projectID }

    private enum CodingKeys: String, CodingKey {
        case label
        case projectID = "projectId"
    }
}

struct ProjectIdentityConflict: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var deviceID: String?
    var localAlias: String?
    var normalizedName: String
    var repositoryFingerprint: String?
    var assignedProjectID: String
    var candidates: [ProjectIdentityCandidate]
    var status: String
    var createdAt: String
    var updatedAt: String?
    var resolvedAt: String?
    var confirmedProjectID: String?

    private enum CodingKeys: String, CodingKey {
        case id, localAlias, normalizedName, repositoryFingerprint, candidates, status, createdAt, updatedAt, resolvedAt
        case deviceID = "deviceId"
        case assignedProjectID = "assignedProjectId"
        case confirmedProjectID = "confirmedProjectId"
    }
}

struct ServiceHealth: Codable, Equatable, Sendable {
    var status: String
    var message: String?
    var updatedAt: String?

    init(status: String = "unknown", message: String? = nil, updatedAt: String? = nil) {
        self.status = status
        self.message = message
        self.updatedAt = updatedAt
    }

    var isReady: Bool {
        ["ready", "connected", "healthy", "ok"].contains(status.lowercased())
    }

    private enum CodingKeys: String, CodingKey { case status, message, updatedAt }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        status = try values.decodeIfPresent(String.self, forKey: .status) ?? "unknown"
        message = try values.decodeIfPresent(String.self, forKey: .message)
        updatedAt = try values.decodeIfPresent(String.self, forKey: .updatedAt)
    }
}

struct SyncStatus: Decodable, Equatable, Sendable {
    var state: String
    var message: String?
    var lastSyncedAt: String?
    var pendingOperations: Int
    var currentDeviceID: String?
    var authenticated: Bool
    var endpoint: String?

    init(
        state: String = "notConfigured",
        message: String? = "Remote sync is not configured.",
        lastSyncedAt: String? = nil,
        pendingOperations: Int = 0,
        currentDeviceID: String? = nil,
        authenticated: Bool = false,
        endpoint: String? = nil
    ) {
        self.state = state
        self.message = message
        self.lastSyncedAt = lastSyncedAt
        self.pendingOperations = pendingOperations
        self.currentDeviceID = currentDeviceID
        self.authenticated = authenticated
        self.endpoint = endpoint
    }

    private enum CodingKeys: String, CodingKey {
        case state, status, message, lastSyncedAt, pendingOperations
        case configured, authenticated, connected, syncing, lastPushAt, lastPullAt, lastError, deviceId, endpoint
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let configured = try values.decodeIfPresent(Bool.self, forKey: .configured)
        let decodedAuthenticated = try values.decodeIfPresent(Bool.self, forKey: .authenticated)
        let connected = try values.decodeIfPresent(Bool.self, forKey: .connected)
        let syncing = try values.decodeIfPresent(Bool.self, forKey: .syncing)
        let lastError = try values.decodeIfPresent(String.self, forKey: .lastError)
        if let explicit = try values.decodeIfPresent(String.self, forKey: .state)
            ?? values.decodeIfPresent(String.self, forKey: .status) {
            state = explicit
        } else if syncing == true {
            state = "syncing"
        } else if connected == true {
            state = "connected"
        } else if configured == false {
            state = "notConfigured"
        } else if decodedAuthenticated == false {
            state = "signedOut"
        } else if lastError != nil {
            state = "degraded"
        } else if configured == true, decodedAuthenticated == true {
            state = "ready"
        } else {
            state = "unavailable"
        }
        message = try values.decodeIfPresent(String.self, forKey: .message)
            ?? lastError
        let lastPush = try values.decodeIfPresent(String.self, forKey: .lastPushAt)
        let lastPull = try values.decodeIfPresent(String.self, forKey: .lastPullAt)
        lastSyncedAt = try values.decodeIfPresent(String.self, forKey: .lastSyncedAt)
            ?? [lastPush, lastPull].compactMap { $0 }.max()
        pendingOperations = try values.decodeIfPresent(Int.self, forKey: .pendingOperations) ?? 0
        currentDeviceID = try values.decodeIfPresent(String.self, forKey: .deviceId)
        authenticated = decodedAuthenticated ?? false
        endpoint = try values.decodeIfPresent(String.self, forKey: .endpoint)
    }
}

struct DeviceSummary: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var name: String
    var platform: String
    var status: String
    var lastSeenAt: String?
    var isCurrent: Bool

    init(
        id: String,
        name: String,
        platform: String,
        status: String,
        lastSeenAt: String? = nil,
        isCurrent: Bool = false
    ) {
        self.id = id
        self.name = name
        self.platform = platform
        self.status = status
        self.lastSeenAt = lastSeenAt
        self.isCurrent = isCurrent
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, platform, status, lastSeenAt, isCurrent, revokedAt
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        name = try values.decodeIfPresent(String.self, forKey: .name) ?? "Unnamed device"
        platform = try values.decodeIfPresent(String.self, forKey: .platform) ?? "unknown"
        lastSeenAt = try values.decodeIfPresent(String.self, forKey: .lastSeenAt)
        let revokedAt = try values.decodeIfPresent(String.self, forKey: .revokedAt)
        if let explicitStatus = try values.decodeIfPresent(String.self, forKey: .status) {
            status = explicitStatus
        } else if revokedAt != nil {
            status = "revoked"
        } else if let lastSeenAt,
                  let lastSeen = ISO8601DateFormatter().date(from: lastSeenAt),
                  Date().timeIntervalSince(lastSeen) < 120 {
            status = "online"
        } else {
            status = "offline"
        }
        isCurrent = try values.decodeIfPresent(Bool.self, forKey: .isCurrent) ?? false
    }
}

struct GraphProvenance: Decodable, Equatable, Sendable, Identifiable {
    var checkpointID: String?
    var eventID: String?
    var label: String?

    var id: String { "\(checkpointID ?? ""):\(eventID ?? ""):\(label ?? "")" }

    init(checkpointID: String? = nil, eventID: String? = nil, label: String? = nil) {
        self.checkpointID = checkpointID
        self.eventID = eventID
        self.label = label
    }

    private enum CodingKeys: String, CodingKey {
        case checkpointID = "checkpointId"
        case eventID = "eventId"
        case label
    }
}

struct GraphNode: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var label: String
    var kind: String
    var status: String?
    var importance: Double?
    var provenance: [GraphProvenance]

    init(
        id: String,
        label: String,
        kind: String,
        status: String? = nil,
        importance: Double? = nil,
        provenance: [GraphProvenance] = []
    ) {
        self.id = id
        self.label = label
        self.kind = kind
        self.status = status
        self.importance = importance
        self.provenance = provenance
    }

    private enum CodingKeys: String, CodingKey {
        case id, label, name, kind, type, status, importance, provenance
        case checkpointIDs = "checkpointIds"
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        label = try values.decodeIfPresent(String.self, forKey: .label)
            ?? values.decodeIfPresent(String.self, forKey: .name)
            ?? id
        kind = try values.decodeIfPresent(String.self, forKey: .kind)
            ?? values.decodeIfPresent(String.self, forKey: .type)
            ?? "concept"
        status = try values.decodeIfPresent(String.self, forKey: .status)
        importance = try values.decodeIfPresent(Double.self, forKey: .importance)
        if let detailed = try values.decodeIfPresent([GraphProvenance].self, forKey: .provenance) {
            provenance = detailed
        } else {
            provenance = try values.decodeIfPresent([String].self, forKey: .checkpointIDs)?.map {
                GraphProvenance(checkpointID: $0, label: "Checkpoint")
            } ?? []
        }
    }
}

struct GraphEdge: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var source: String
    var target: String
    var relation: String
    var provenance: [GraphProvenance]

    init(
        id: String,
        source: String,
        target: String,
        relation: String,
        provenance: [GraphProvenance] = []
    ) {
        self.id = id
        self.source = source
        self.target = target
        self.relation = relation
        self.provenance = provenance
    }

    private enum CodingKeys: String, CodingKey {
        case id, source, sourceId, target, targetId, relation, type, kind, provenance
        case checkpointIDs = "checkpointIds"
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        source = try values.decodeIfPresent(String.self, forKey: .source)
            ?? values.decode(String.self, forKey: .sourceId)
        target = try values.decodeIfPresent(String.self, forKey: .target)
            ?? values.decode(String.self, forKey: .targetId)
        relation = try values.decodeIfPresent(String.self, forKey: .relation)
            ?? values.decodeIfPresent(String.self, forKey: .type)
            ?? values.decodeIfPresent(String.self, forKey: .kind)
            ?? "related_to"
        id = try values.decodeIfPresent(String.self, forKey: .id)
            ?? "\(source):\(relation):\(target)"
        if let detailed = try values.decodeIfPresent([GraphProvenance].self, forKey: .provenance) {
            provenance = detailed
        } else {
            provenance = try values.decodeIfPresent([String].self, forKey: .checkpointIDs)?.map {
                GraphProvenance(checkpointID: $0, label: "Checkpoint")
            } ?? []
        }
    }
}

struct GraphSnapshot: Decodable, Equatable, Sendable {
    var nodes: [GraphNode]
    var edges: [GraphEdge]
    var cursor: String?
    var truncated: Bool
    var generatedAt: String
    var projection: ServiceHealth?

    init(
        nodes: [GraphNode] = [],
        edges: [GraphEdge] = [],
        cursor: String? = nil,
        truncated: Bool = false,
        generatedAt: String = "",
        projection: ServiceHealth? = nil
    ) {
        self.nodes = nodes
        self.edges = edges
        self.cursor = cursor
        self.truncated = truncated
        self.generatedAt = generatedAt
        self.projection = projection
    }

    private enum CodingKeys: String, CodingKey {
        case nodes, edges, cursor, nextCursor, truncated, generatedAt, projection, degraded
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        nodes = try values.decodeIfPresent([GraphNode].self, forKey: .nodes) ?? []
        edges = try values.decodeIfPresent([GraphEdge].self, forKey: .edges) ?? []
        cursor = try values.decodeIfPresent(String.self, forKey: .cursor)
            ?? values.decodeIfPresent(String.self, forKey: .nextCursor)
        truncated = try values.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
        generatedAt = try values.decodeIfPresent(String.self, forKey: .generatedAt) ?? ""
        if let detailed = try values.decodeIfPresent(ServiceHealth.self, forKey: .projection) {
            projection = detailed
        } else if try values.decodeIfPresent(Bool.self, forKey: .degraded) == true {
            projection = ServiceHealth(status: "degraded", message: "Graph is using degraded local retrieval.")
        } else {
            projection = ServiceHealth(status: "ready")
        }
    }
}

struct GraphQuery: Codable, Equatable, Sendable {
    var projectId: String?
    var query: String?
    var nodeKinds: [String]
    var relations: [String]
    var aroundNodeId: String?
    var hops: Int
    var cursor: String?
    var limit: Int

    private enum CodingKeys: String, CodingKey {
        case projectId, query, aroundNodeId, hops, cursor, limit
        case nodeKinds = "kinds"
        case relations = "edgeKinds"
    }

    init(
        projectID: String? = nil,
        query: String? = nil,
        nodeKinds: [String] = [],
        relations: [String] = [],
        aroundNodeID: String? = nil,
        hops: Int = 1,
        cursor: String? = nil,
        limit: Int = 250
    ) {
        projectId = projectID
        self.query = query
        self.nodeKinds = nodeKinds
        self.relations = relations
        aroundNodeId = aroundNodeID
        self.hops = min(max(hops, 0), 2)
        self.cursor = cursor
        self.limit = min(max(limit, 1), 500)
    }
}

struct ChatCitation: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var kind: String
    var checkpointIDs: [String]
    var checkpointID: String?
    var eventID: String?
    var file: String?
    var commit: String?
    var label: String

    init(
        id: String = UUID().uuidString,
        kind: String = "checkpoint",
        checkpointIDs: [String] = [],
        checkpointID: String? = nil,
        eventID: String? = nil,
        file: String? = nil,
        commit: String? = nil,
        label: String
    ) {
        self.id = id
        self.kind = kind
        self.checkpointIDs = checkpointIDs
        self.checkpointID = checkpointID
        self.eventID = eventID
        self.file = file
        self.commit = commit
        self.label = label
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, file, commit, label
        case checkpointIDs = "checkpointIds"
        case checkpointID = "checkpointId"
        case eventID = "eventId"
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        kind = try values.decodeIfPresent(String.self, forKey: .kind) ?? "checkpoint"
        checkpointIDs = try values.decodeIfPresent([String].self, forKey: .checkpointIDs) ?? []
        checkpointID = try values.decodeIfPresent(String.self, forKey: .checkpointID) ?? checkpointIDs.first
        eventID = try values.decodeIfPresent(String.self, forKey: .eventID)
        let resourceID = try values.decodeIfPresent(String.self, forKey: .id)
        file = try values.decodeIfPresent(String.self, forKey: .file)
            ?? (kind == "file" ? resourceID : nil)
        commit = try values.decodeIfPresent(String.self, forKey: .commit)
            ?? (kind == "commit" ? resourceID : nil)
        label = try values.decodeIfPresent(String.self, forKey: .label)
            ?? file ?? commit ?? checkpointID ?? eventID ?? "Evidence"
        id = resourceID
            ?? "\(checkpointID ?? ""):\(eventID ?? ""):\(label)"
    }
}

enum ChatRole: String, Codable, Sendable {
    case user
    case assistant
    case system
}

struct ChatMessage: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var sessionID: String
    var role: ChatRole
    var text: String
    var citations: [ChatCitation]
    var createdAt: String
    var isStreaming: Bool

    init(
        id: String = UUID().uuidString,
        sessionID: String,
        role: ChatRole,
        text: String,
        citations: [ChatCitation] = [],
        createdAt: String = ISO8601DateFormatter().string(from: Date()),
        isStreaming: Bool = false
    ) {
        self.id = id
        self.sessionID = sessionID
        self.role = role
        self.text = text
        self.citations = citations
        self.createdAt = createdAt
        self.isStreaming = isStreaming
    }

    private enum CodingKeys: String, CodingKey {
        case id, role, text, content, citations, createdAt, isStreaming
        case sessionID = "sessionId"
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        sessionID = try values.decodeIfPresent(String.self, forKey: .sessionID) ?? ""
        role = try values.decodeIfPresent(ChatRole.self, forKey: .role) ?? .assistant
        text = try values.decodeIfPresent(String.self, forKey: .text)
            ?? values.decodeIfPresent(String.self, forKey: .content)
            ?? ""
        citations = try values.decodeIfPresent([ChatCitation].self, forKey: .citations) ?? []
        createdAt = try values.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        isStreaming = try values.decodeIfPresent(Bool.self, forKey: .isStreaming) ?? false
    }
}

struct ChatSession: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var projectID: String?
    var title: String?
    var classification: String
    var syncEligibility: String
    var messages: [ChatMessage]
    var createdAt: String
    var updatedAt: String

    init(
        id: String,
        projectID: String?,
        title: String? = nil,
        classification: String = "personal",
        syncEligibility: String = "local_only",
        messages: [ChatMessage] = [],
        createdAt: String = ISO8601DateFormatter().string(from: Date()),
        updatedAt: String? = nil
    ) {
        self.id = id
        self.projectID = projectID
        self.title = title
        self.classification = classification
        self.syncEligibility = syncEligibility
        self.messages = messages
        self.createdAt = createdAt
        self.updatedAt = updatedAt ?? createdAt
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, classification, syncEligibility, messages, createdAt, updatedAt
        case projectID = "projectId"
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        projectID = try values.decodeIfPresent(String.self, forKey: .projectID)
        title = try values.decodeIfPresent(String.self, forKey: .title)
        classification = try values.decodeIfPresent(String.self, forKey: .classification) ?? "personal"
        syncEligibility = try values.decodeIfPresent(String.self, forKey: .syncEligibility) ?? "local_only"
        messages = try values.decodeIfPresent([ChatMessage].self, forKey: .messages) ?? []
        createdAt = try values.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        updatedAt = try values.decodeIfPresent(String.self, forKey: .updatedAt) ?? createdAt
    }
}

struct ContextAction: Decodable, Equatable, Sendable, Identifiable {
    var id: String
    var kind: String
    var title: String
    var summary: String?
    var requiresConfirmation: Bool
    var status: String

    private enum CodingKeys: String, CodingKey {
        case id, kind, type, name, title, summary, requiresConfirmation, mutating, status
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        kind = try values.decodeIfPresent(String.self, forKey: .kind)
            ?? values.decodeIfPresent(String.self, forKey: .type)
            ?? values.decodeIfPresent(String.self, forKey: .name)
            ?? "search_context"
        title = try values.decodeIfPresent(String.self, forKey: .title) ?? kind.replacingOccurrences(of: "_", with: " ").capitalized
        summary = try values.decodeIfPresent(String.self, forKey: .summary)
        requiresConfirmation = try values.decodeIfPresent(Bool.self, forKey: .requiresConfirmation)
            ?? values.decodeIfPresent(Bool.self, forKey: .mutating)
            ?? false
        status = try values.decodeIfPresent(String.self, forKey: .status) ?? "proposed"
    }
}

struct ChatRunEvent: Decodable, Equatable, Sendable {
    var type: String
    var runID: String?
    var delta: String?
    var message: ChatMessage?
    var citations: [ChatCitation]?
    var action: ContextAction?
    var error: String?

    init(
        type: String,
        runID: String? = nil,
        delta: String? = nil,
        message: ChatMessage? = nil,
        citations: [ChatCitation]? = nil,
        action: ContextAction? = nil,
        error: String? = nil
    ) {
        self.type = type
        self.runID = runID
        self.delta = delta
        self.message = message
        self.citations = citations
        self.action = action
        self.error = error
    }

    private enum CodingKeys: String, CodingKey {
        case type, text, delta, message, citation, citations, action, error, code
        case runID = "runId"
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        type = try values.decodeIfPresent(String.self, forKey: .type) ?? "message"
        runID = try values.decodeIfPresent(String.self, forKey: .runID)
        delta = try values.decodeIfPresent(String.self, forKey: .delta)
            ?? (type == "delta" ? values.decodeIfPresent(String.self, forKey: .text) : nil)
        message = try values.decodeIfPresent(ChatMessage.self, forKey: .message)
        if let citation = try values.decodeIfPresent(ChatCitation.self, forKey: .citation) {
            citations = [citation]
        } else {
            citations = try values.decodeIfPresent([ChatCitation].self, forKey: .citations)
        }
        action = try values.decodeIfPresent(ContextAction.self, forKey: .action)
        error = try values.decodeIfPresent(String.self, forKey: .error)
            ?? (type == "error" ? values.decodeIfPresent(String.self, forKey: .message) : nil)
    }
}

struct NativeCollectedEvent: Codable, Equatable, Sendable {
    struct Privacy: Codable, Equatable, Sendable {
        var classification: String
        var rules: [String]
    }

    struct Relevance: Codable, Equatable, Sendable {
        var decision: String
        var reason: String
    }

    var version = "2"
    var id: String
    var deviceId: String
    var occurredAt: String
    var hlc: String
    var source = "os"
    var eventType: String
    var projectId: String?
    var title: String
    var attributes: [String: String]
    var privacy: Privacy
    var relevance: Relevance
    var confidence: Double
    var dedupeKey: String
    var policyVersion: Int
    var syncEligibility: String

    init(
        id: String = UUID().uuidString,
        deviceID: String,
        time: String = ISO8601DateFormatter().string(from: Date()),
        eventType: String,
        projectID: String? = nil,
        title: String,
        attributes: [String: String] = [:],
        privacyClassification: String = "personal",
        relevance: String = "keep",
        confidence: Double = 0.8,
        dedupeKey: String,
        policyVersion: Int,
        syncEligibility: String = "cloud_eligible"
    ) {
        self.id = id
        deviceId = deviceID
        occurredAt = time
        let milliseconds = Int64((ISO8601DateFormatter().date(from: time) ?? Date()).timeIntervalSince1970 * 1_000)
        hlc = "\(milliseconds):0:\(deviceID)"
        self.eventType = eventType
        projectId = projectID
        self.title = title
        self.attributes = attributes
        privacy = Privacy(
            classification: privacyClassification,
            rules: ["native_allowlist", "policy_v\(policyVersion)"]
        )
        self.relevance = Relevance(decision: relevance, reason: "native_os_metadata")
        self.confidence = confidence
        self.dedupeKey = dedupeKey
        self.policyVersion = policyVersion
        self.syncEligibility = syncEligibility
    }
}
