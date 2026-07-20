import Foundation

enum InspectorSection: String, CaseIterable, Identifiable, Sendable {
    case now
    case activity
    case timeline
    case contextDiff
    case chat
    case graph
    case privacy
    case devices
    case providerHealth

    var id: String { rawValue }

    var title: String {
        switch self {
        case .now: "Now"
        case .activity: "Activity"
        case .timeline: "Timeline"
        case .contextDiff: "Context Diff"
        case .chat: "Chat"
        case .graph: "Graph"
        case .privacy: "Privacy"
        case .devices: "Devices"
        case .providerHealth: "Provider Health"
        }
    }

    var systemImage: String {
        switch self {
        case .now: "scope"
        case .activity: "waveform.path.ecg"
        case .timeline: "clock.arrow.circlepath"
        case .contextDiff: "arrow.left.arrow.right"
        case .chat: "bubble.left.and.bubble.right.fill"
        case .graph: "point.3.filled.connected.trianglepath.dotted"
        case .privacy: "hand.raised.fill"
        case .devices: "laptopcomputer.and.iphone"
        case .providerHealth: "bolt.heart.fill"
        }
    }
}
