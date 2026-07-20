import Foundation
import Observation

struct ChatDraftRequest: Equatable, Sendable, Identifiable {
    let id: Int
    let text: String
}

@MainActor
@Observable
final class InspectorNavigationState {
    private(set) var requestedSection: InspectorSection = .now
    private(set) var requestID = 0
    private(set) var chatDraftRequest: ChatDraftRequest?

    func open(_ section: InspectorSection) {
        requestedSection = section
        requestID &+= 1
    }

    @discardableResult
    func openChat(for node: GraphNode) -> ChatDraftRequest? {
        guard let text = Self.chatDraft(for: node) else { return nil }
        let request = ChatDraftRequest(
            id: (chatDraftRequest?.id ?? 0) &+ 1,
            text: text
        )
        chatDraftRequest = request
        open(.chat)
        return request
    }

    nonisolated static func chatDraft(for node: GraphNode) -> String? {
        let kind = bounded(node.kind, maximumLength: 40) ?? "item"
        let label = bounded(node.label, maximumLength: 120)
        let identifier = bounded(node.id, maximumLength: 160)
        guard label != nil || identifier != nil else { return nil }

        var subject = "the selected \(kind)"
        if let label { subject += " “\(label)”" }
        if let identifier { subject += " (graph node \(identifier))" }
        return "Explain how \(subject) relates to my current work. Cite the supporting checkpoints and distinguish evidence from hypotheses."
    }

    private nonisolated static func bounded(_ value: String, maximumLength: Int) -> String? {
        let normalized = value
            .replacingOccurrences(of: "[\\p{C}]", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty,
              !ChatSecretGuard.containsSecret(normalized) else {
            return nil
        }
        return String(normalized.prefix(maximumLength))
    }
}

enum ChatSecretGuard {
    static func containsSecret(_ text: String) -> Bool {
        let patterns = [
            #"(?i)(api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd)\s*[:=]"#,
            #"(?i)bearer\s+[a-z0-9._~+/=-]{12,}"#,
            #"(?i)-----BEGIN [A-Z ]*PRIVATE KEY-----"#,
            #"\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b"#
        ]
        return patterns.contains { text.range(of: $0, options: .regularExpression) != nil }
    }
}
