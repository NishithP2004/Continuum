import Foundation

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

struct EngineSessionGeneration: Equatable, Sendable {
    private(set) var value: UInt = 0

    var token: UInt { value }

    mutating func invalidate() {
        value &+= 1
    }

    func isCurrent(_ token: UInt) -> Bool {
        token == value
    }
}

enum NativeHealthSubsystem: String, CaseIterable, Sendable {
    case engine
    case collectors
    case provider
    case retrieval
    case sync
    case projection

    var title: String {
        switch self {
        case .engine: "Local engine"
        case .collectors: "Native collectors"
        case .provider: "Agent provider"
        case .retrieval: "Vector retrieval"
        case .sync: "Device sync"
        case .projection: "Graph projection"
        }
    }
}

enum NativeHealthSeverity: Equatable, Sendable {
    case ready
    case neutral
    case warning
    case error
}

struct NativeHealthItem: Identifiable, Equatable, Sendable {
    let subsystem: NativeHealthSubsystem
    let status: String
    let detail: String?
    let severity: NativeHealthSeverity

    var id: NativeHealthSubsystem { subsystem }
    var isReady: Bool { severity == .ready }
}

struct NativeHealthOverview: Equatable, Sendable {
    let items: [NativeHealthItem]

    init(
        connection: EngineConnectionStatus,
        collector: ServiceHealth,
        provider: ProviderHealth,
        retrieval: RetrievalHealth,
        sync: SyncStatus,
        projection: ServiceHealth
    ) {
        items = [
            Self.engineItem(connection),
            Self.serviceItem(.collectors, health: collector),
            Self.providerItem(provider),
            Self.retrievalItem(retrieval),
            Self.syncItem(sync),
            Self.serviceItem(.projection, health: projection)
        ]
    }

    subscript(_ subsystem: NativeHealthSubsystem) -> NativeHealthItem? {
        items.first { $0.subsystem == subsystem }
    }

    private static func engineItem(_ connection: EngineConnectionStatus) -> NativeHealthItem {
        let severity: NativeHealthSeverity = switch connection {
        case .connected: .ready
        case .connecting: .neutral
        case .degraded: .warning
        case .disconnected: .error
        }
        return NativeHealthItem(
            subsystem: .engine,
            status: connection.label,
            detail: connection.detail,
            severity: severity
        )
    }

    private static func providerItem(_ provider: ProviderHealth) -> NativeHealthItem {
        NativeHealthItem(
            subsystem: .provider,
            status: provider.status,
            detail: provider.message,
            severity: severity(for: provider.status)
        )
    }

    private static func retrievalItem(_ retrieval: RetrievalHealth) -> NativeHealthItem {
        NativeHealthItem(
            subsystem: .retrieval,
            status: retrieval.degraded ? "degraded" : "ready",
            detail: retrieval.message ?? retrieval.mode,
            severity: retrieval.degraded ? .warning : .ready
        )
    }

    private static func syncItem(_ sync: SyncStatus) -> NativeHealthItem {
        NativeHealthItem(
            subsystem: .sync,
            status: sync.state,
            detail: sync.message,
            severity: severity(for: sync.state)
        )
    }

    private static func serviceItem(
        _ subsystem: NativeHealthSubsystem,
        health: ServiceHealth
    ) -> NativeHealthItem {
        NativeHealthItem(
            subsystem: subsystem,
            status: health.status,
            detail: health.message,
            severity: severity(for: health.status)
        )
    }

    private static func severity(for status: String) -> NativeHealthSeverity {
        switch status.lowercased() {
        case "ready", "connected", "healthy", "ok", "synced": .ready
        case "starting", "connecting", "unknown", "paused", "notconfigured", "signedout": .neutral
        case "failed", "error", "disconnected", "unavailable": .error
        default: .warning
        }
    }
}

enum WindowCaptureAuthorizationState: Equatable, Sendable {
    case disabled
    case permissionRequired
    case ready

    static func resolve(policy: PrivacyPolicyV1?, isTrusted: Bool) -> Self {
        guard let policy,
              policy.captureWindowTitles,
              policy.sourceEnabled["os_window"] == true,
              policy.confidentialLocalCollectionEnabled else {
            return .disabled
        }
        return isTrusted ? .ready : .permissionRequired
    }
}

enum NativeCollectorHealthResolver {
    static func resolve(
        isRunning: Bool,
        hasValidatedPolicy: Bool,
        windowAuthorization: WindowCaptureAuthorizationState,
        delivery: ServiceHealth,
        folderFailureMessage: String?,
        updatedAt: String? = nil
    ) -> ServiceHealth {
        guard isRunning else {
            return ServiceHealth(status: "paused", message: "Native collection is paused.", updatedAt: updatedAt)
        }
        guard hasValidatedPolicy else {
            return ServiceHealth(
                status: "degraded",
                message: "Native collection is disabled until a validated privacy policy is available.",
                updatedAt: updatedAt
            )
        }

        var messages: [String] = []
        if windowAuthorization == .permissionRequired {
            messages.append("Accessibility permission is required for optional focused-window titles.")
        }
        if let folderFailureMessage {
            messages.append(folderFailureMessage)
        }
        if !delivery.isReady, let deliveryMessage = delivery.message {
            messages.append(deliveryMessage)
        }

        let status: String
        if windowAuthorization == .permissionRequired {
            status = "permissionRequired"
        } else if folderFailureMessage != nil || !delivery.isReady {
            status = "degraded"
        } else {
            status = "ready"
            let windowMessage = windowAuthorization == .ready
                ? " Focused-window titles are enabled locally."
                : ""
            messages.append("Native allowlisted metadata collection is active.\(windowMessage)")
        }
        return ServiceHealth(
            status: status,
            message: messages.joined(separator: " "),
            updatedAt: updatedAt
        )
    }
}

enum PrivacyRuleInput {
    static func normalizedDomain(_ rawValue: String) -> String? {
        let input = rawValue.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
        let value: String
        if let url = URL(string: input.contains("://") ? input : "https://\(input)"),
           let host = url.host {
            value = host
        } else {
            return nil
        }
        let domainPattern = #"^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$"#
        let ipv4Pattern = #"^(?:\d{1,3}\.){3}\d{1,3}$"#
        guard value == "localhost"
                || value.range(of: domainPattern, options: .regularExpression) != nil
                || value.range(of: ipv4Pattern, options: .regularExpression) != nil else {
            return nil
        }
        return value
    }

    static func normalizedRelativeGlob(_ rawValue: String) -> String? {
        let value = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty,
              value.count <= 256,
              !value.hasPrefix("/"),
              !value.split(separator: "/").contains("..") else {
            return nil
        }
        return value
    }
}
