import SwiftUI

struct ChatView: View {
    let store: AppStore
    @State private var draft = ""
    @State private var appliedChatDraftRequestID = 0

    var body: some View {
        VStack(spacing: 0) {
            chatHeader
            Divider()
            messageList
            if !store.pendingChatActions.isEmpty {
                actionTray
                Divider()
            }
            composer
        }
        .background(.background)
        .onAppear {
            applyPendingGraphContext()
        }
        .onChange(of: store.navigation.chatDraftRequest?.id) {
            applyPendingGraphContext()
        }
    }

    private var chatHeader: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Grounded Continuum Agent")
                    .font(.headline)
                Text(
                    store.snapshot.activeProject.map { "Using \($0.name) checkpoints and graph" }
                        ?? "Waiting for an active project"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
            Label(store.modelSettings.chatProvider.title, systemImage: providerIcon)
                .font(.caption.weight(.medium))
                .foregroundStyle(store.modelSettings.chatProvider == .openai ? .blue : .secondary)
            eligibilityIndicator
            if store.isChatResponding {
                Button("Stop", systemImage: "stop.circle") {
                    Task { await store.cancelChat() }
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 18) {
                    if store.chatMessages.isEmpty {
                        ContentUnavailableView {
                            Label("Ask about your work", systemImage: "bubble.left.and.text.bubble.right")
                        } description: {
                            Text("Answers are grounded in Continuum checkpoints and cite their evidence. The agent cannot read files or run commands.")
                        } actions: {
                            Button("What should I do next?") {
                                draft = "What should I do next? Cite the checkpoint, relevant files, and blockers."
                            }
                        }
                        .frame(maxWidth: .infinity, minHeight: 360)
                    } else {
                        ForEach(store.chatMessages) { message in
                            ChatMessageRow(message: message)
                                .id(message.id)
                        }
                    }
                }
                .padding(24)
            }
            .onChange(of: store.chatMessages.count) {
                if let id = store.chatMessages.last?.id {
                    withAnimation(.easeOut(duration: 0.18)) {
                        proxy.scrollTo(id, anchor: .bottom)
                    }
                }
            }
        }
    }

    private var actionTray: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 10) {
                ForEach(store.pendingChatActions) { action in
                    VStack(alignment: .leading, spacing: 6) {
                        Label(action.title, systemImage: actionIcon(action.kind))
                            .font(.callout.weight(.semibold))
                        if let summary = action.summary {
                            Text(summary)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        if action.requiresConfirmation && ["pending", "proposed"].contains(action.status.lowercased()) {
                            Button("Confirm") {
                                Task { await store.confirmChatAction(action) }
                            }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                        } else {
                            Text(action.status.capitalized)
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .frame(width: 230, alignment: .leading)
                    .padding(12)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 10)
        }
    }

    private var composer: some View {
        VStack(spacing: 8) {
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Ask Continuum about your current work…", text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...6)
                    .padding(10)
                    .background(.quaternary.opacity(0.65), in: RoundedRectangle(cornerRadius: 10))
                    .onSubmit { submit() }

                Button(action: submit) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                }
                .buttonStyle(.plain)
                .disabled(
                    draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || store.isChatResponding
                        || store.activeProjectID == nil
                        || store.chatRequiresCloudConsent
                )
                .accessibilityLabel("Send message")
            }
            Text(composerPrivacyMessage)
                .font(.caption2)
                .foregroundStyle(store.chatRequiresCloudConsent ? .orange : .secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(16)
    }

    private var providerIcon: String {
        switch store.modelSettings.chatProvider {
        case .local: "server.rack"
        case .apple: "apple.logo"
        case .openai: "cloud.fill"
        }
    }

    @ViewBuilder
    private var eligibilityIndicator: some View {
        if store.chatRequiresCloudConsent {
            Button {
                store.openInspector(at: .privacy)
            } label: {
                Label("Cloud consent required", systemImage: "exclamationmark.lock.fill")
            }
            .buttonStyle(.plain)
            .font(.caption.weight(.medium))
            .foregroundStyle(.orange)
            .help("OpenAI chat remains blocked until eligible sanitized personal metadata is allowed in Privacy.")
        } else if store.chatSyncEligibility == "cloud_eligible" {
            Label("Cloud eligible", systemImage: "cloud.fill")
                .font(.caption.weight(.medium))
                .foregroundStyle(.blue)
                .help("This personal conversation may use OpenAI and synchronize because cloud sharing is enabled in Privacy.")
        } else {
            Label("Local only", systemImage: "lock.fill")
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .help("This conversation stays local and is not eligible for cloud providers or synchronization.")
        }
    }

    private var composerPrivacyMessage: String {
        if store.chatRequiresCloudConsent {
            return "OpenAI is selected, but cloud sharing is off. Review Privacy or choose a local provider before sending."
        }
        return "Secrets are rejected before storage. Hypotheses are labeled unverified until supported by cited evidence."
    }

    private func submit() {
        let message = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return }
        draft = ""
        store.startChatMessage(message)
    }

    private func applyPendingGraphContext() {
        guard let request = store.navigation.chatDraftRequest,
              request.id != appliedChatDraftRequestID else {
            return
        }
        let existing = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        draft = existing.isEmpty ? request.text : "\(existing)\n\n\(request.text)"
        appliedChatDraftRequestID = request.id
    }

    private func actionIcon(_ kind: String) -> String {
        switch kind {
        case "ack_baseline": "checkmark.seal"
        case "create_checkpoint": "bookmark"
        case "select_project": "folder"
        case "get_diff": "arrow.left.arrow.right"
        default: "magnifyingglass"
        }
    }
}

private struct ChatMessageRow: View {
    let message: ChatMessage

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            if message.role == .user { Spacer(minLength: 80) }
            if message.role == .assistant {
                Image(systemName: "circle.hexagongrid.fill")
                    .foregroundStyle(.tint)
                    .frame(width: 24)
            }

            VStack(alignment: .leading, spacing: 10) {
                MarkdownMessageView(source: message.text.isEmpty && message.isStreaming ? "Thinking…" : message.text)
                    .foregroundStyle(message.text.isEmpty ? .secondary : .primary)

                if !message.citations.isEmpty {
                    FlowLayout(spacing: 6) {
                        ForEach(message.citations) { citation in
                            Label(citation.label, systemImage: citationIcon(citation))
                                .font(.caption2.monospaced())
                                .lineLimit(1)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 4)
                                .background(.quaternary, in: Capsule())
                                .help(citationHelp(citation))
                        }
                    }
                }
            }
            .padding(12)
            .background(
                message.role == .user ? AnyShapeStyle(Color.accentColor.opacity(0.13)) : AnyShapeStyle(.regularMaterial),
                in: RoundedRectangle(cornerRadius: 12)
            )

            if message.role != .user { Spacer(minLength: 80) }
        }
    }

    private func citationIcon(_ citation: ChatCitation) -> String {
        switch citation.kind {
        case "file": "doc.text"
        case "commit": "point.3.connected.trianglepath.dotted"
        case "blocker": "exclamationmark.octagon"
        case "decision": "checkmark.diamond"
        case "entity": "circle.hexagongrid"
        default: "bookmark"
        }
    }

    private func citationHelp(_ citation: ChatCitation) -> String {
        (citation.checkpointIDs + [citation.checkpointID, citation.eventID, citation.file, citation.commit].compactMap { $0 })
            .joined(separator: " · ")
    }
}

private struct FlowLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        let result = positions(proposal: proposal, subviews: subviews)
        return result.size
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        let result = positions(
            proposal: ProposedViewSize(width: bounds.width, height: proposal.height),
            subviews: subviews
        )
        for (index, point) in result.points.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y), proposal: .unspecified)
        }
    }

    private func positions(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, points: [CGPoint]) {
        let width = proposal.width ?? 500
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        var points: [CGPoint] = []
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += lineHeight + spacing
                lineHeight = 0
            }
            points.append(CGPoint(x: x, y: y))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
        return (CGSize(width: width, height: y + lineHeight), points)
    }
}
