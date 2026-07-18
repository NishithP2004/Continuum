import Foundation

enum InspectorSection: String, CaseIterable, Identifiable, Sendable {
    case now
    case activity
    case timeline
    case contextDiff
    case privacy
    case providerHealth

    var id: String { rawValue }

    var title: String {
        switch self {
        case .now: "Now"
        case .activity: "Activity"
        case .timeline: "Timeline"
        case .contextDiff: "Context Diff"
        case .privacy: "Privacy"
        case .providerHealth: "Provider Health"
        }
    }

    var systemImage: String {
        switch self {
        case .now: "scope"
        case .activity: "waveform.path.ecg"
        case .timeline: "clock.arrow.circlepath"
        case .contextDiff: "arrow.left.arrow.right"
        case .privacy: "hand.raised.fill"
        case .providerHealth: "bolt.heart.fill"
        }
    }
}
