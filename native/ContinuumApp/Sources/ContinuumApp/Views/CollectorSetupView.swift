import SwiftUI

struct ChromePairingControlsView: View {
    let store: AppStore
    @State private var confirmation: ChromePairingConfirmation?

    var body: some View {
        GroupBox("Chrome pairing") {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Approve the Continuum extension before it can send sanitized foreground-tab metadata.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Refresh", systemImage: "arrow.clockwise") {
                        Task { await store.refresh() }
                    }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.plain)
                    .disabled(store.isRefreshing)
                }

                if let project = store.snapshot.activeProject {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "hammer.fill")
                            .foregroundStyle(.secondary)
                            .frame(width: 20)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Resolved live project")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(project.name)
                                .fontWeight(.medium)
                            Text(project.id)
                                .font(.caption2.monospaced())
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                        Spacer()
                        Text("Read-only")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(.quaternary, in: Capsule())
                    }
                    Text("Chrome follows the current project lease resolved from live VS Code or terminal activity; it cannot choose or override a project.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if store.chromePairings.isEmpty {
                    Label(
                        "No pairing requests. In the Chrome extension, choose Pair with Continuum to create a five-minute approval request.",
                        systemImage: "puzzlepiece.extension"
                    )
                    .font(.callout)
                    .foregroundStyle(.secondary)
                } else {
                    ForEach(store.chromePairings) { pairing in
                        ChromePairingRow(
                            pairing: pairing,
                            approve: {
                                confirmation = ChromePairingConfirmation(pairing: pairing, action: .approve)
                            },
                            revoke: {
                                confirmation = ChromePairingConfirmation(pairing: pairing, action: .revoke)
                            }
                        )
                    }
                }
            }
            .padding(8)
        }
        .alert(
            confirmation?.title ?? "Chrome pairing",
            isPresented: Binding(
                get: { confirmation != nil },
                set: { if !$0 { confirmation = nil } }
            ),
            presenting: confirmation
        ) { request in
            Button("Cancel", role: .cancel) {}
            switch request.action {
            case .approve:
                Button("Approve Collector") {
                    confirmation = nil
                    Task { await store.approveChromePairing(request.pairing) }
                }
            case .revoke:
                Button(request.revokeButtonTitle, role: .destructive) {
                    confirmation = nil
                    Task { await store.revokeChromePairing(request.pairing) }
                }
            }
        } message: { request in
            Text(request.message)
        }
    }
}

struct ProjectIdentityConflictsView: View {
    let store: AppStore
    @State private var confirmation: ProjectIdentityConfirmation?

    var body: some View {
        GroupBox("Project identity") {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline) {
                    Text("When live collectors match more than one synchronized project, only you can choose the canonical identity.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button("Refresh", systemImage: "arrow.clockwise") {
                        Task { await store.refresh() }
                    }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.plain)
                    .disabled(store.isRefreshing)
                }

                if store.projectIdentityConflicts.isEmpty {
                    Label("No project matches need confirmation.", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                } else {
                    ForEach(store.projectIdentityConflicts) { conflict in
                        VStack(alignment: .leading, spacing: 10) {
                            Label("Confirm \(conflict.normalizedName)", systemImage: "point.3.connected.trianglepath.dotted")
                                .font(.headline)
                            Text("Continuum found \(conflict.candidates.count) existing projects with matching live identity signals. Select the project this local workspace belongs to.")
                                .font(.caption)
                                .foregroundStyle(.secondary)

                            LabeledContent("Provisional project") {
                                Text(conflict.assignedProjectID)
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                            }

                            ForEach(conflict.candidates) { candidate in
                                HStack(spacing: 10) {
                                    Image(systemName: "folder.badge.questionmark")
                                        .foregroundStyle(.secondary)
                                        .frame(width: 20)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(candidate.label)
                                            .fontWeight(.medium)
                                        Text(candidate.projectID)
                                            .font(.caption2.monospaced())
                                            .foregroundStyle(.secondary)
                                            .textSelection(.enabled)
                                    }
                                    Spacer()
                                    Button("Use This Project…") {
                                        confirmation = ProjectIdentityConfirmation(
                                            conflict: conflict,
                                            candidate: candidate
                                        )
                                    }
                                    .disabled(store.isPerformingAction)
                                }
                                .padding(10)
                                .background(.background.opacity(0.45), in: RoundedRectangle(cornerRadius: 8))
                            }
                        }
                        .padding(12)
                        .background(.quaternary.opacity(0.55), in: RoundedRectangle(cornerRadius: 10))
                    }
                }
            }
            .padding(8)
        }
        .alert(
            confirmation.map { "Use \($0.candidate.label) for \($0.conflict.normalizedName)?" }
                ?? "Confirm project identity",
            isPresented: Binding(
                get: { confirmation != nil },
                set: { if !$0 { confirmation = nil } }
            ),
            presenting: confirmation
        ) { request in
            Button("Cancel", role: .cancel) {}
            Button("Confirm Project") {
                confirmation = nil
                Task {
                    await store.confirmProjectIdentity(request.conflict, target: request.candidate)
                }
            }
        } message: { request in
            Text("Future activity for this local workspace will resolve to \(request.candidate.label) (\(request.candidate.projectID)). This confirmation does not broaden collector permissions.")
        }
    }
}

private struct ChromePairingRow: View {
    let pairing: CollectorPairing
    let approve: () -> Void
    let revoke: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: statusIcon)
                .foregroundStyle(statusColor)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 8) {
                    Text("Chrome collector")
                        .fontWeight(.medium)
                    Text(statusTitle)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(statusColor)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(statusColor.opacity(0.10), in: Capsule())
                }
                Text(pairing.clientID)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .help(pairing.clientID)

                if !pairing.expiresAt.isEmpty {
                    Label(expiryLabel, systemImage: "clock")
                        .font(.caption)
                        .foregroundStyle(pairing.effectiveStatus == "expired" ? .orange : .secondary)
                        .help("Approval deadline: \(pairing.expiresAt)")
                }
                if let project = pairing.resolvedProject {
                    Label("Resolved project: \(project.name) (read-only)", systemImage: "hammer")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if pairing.isPending {
                Button("Approve", action: approve)
                    .buttonStyle(.borderedProminent)
            }
            if !["revoked", "expired"].contains(pairing.effectiveStatus) {
                Button(pairing.isPending ? "Decline" : "Revoke", action: revoke)
            }
        }
        .padding(10)
        .background(.quaternary.opacity(0.55), in: RoundedRectangle(cornerRadius: 9))
    }

    private var statusTitle: String {
        switch pairing.effectiveStatus {
        case "pending": "Pending approval"
        case "approved": "Approved · waiting for Chrome"
        case "paired": "Paired"
        case "expired": "Expired"
        case "revoked": "Revoked"
        default: pairing.effectiveStatus.capitalized
        }
    }

    private var statusIcon: String {
        switch pairing.effectiveStatus {
        case "pending": "person.badge.clock"
        case "approved": "checkmark.circle"
        case "paired": "link.circle.fill"
        case "expired": "clock.badge.xmark"
        case "revoked": "xmark.circle.fill"
        default: "questionmark.circle"
        }
    }

    private var statusColor: Color {
        switch pairing.effectiveStatus {
        case "paired": .green
        case "pending", "approved": .blue
        case "expired": .orange
        case "revoked": .red
        default: .secondary
        }
    }

    private var expiryLabel: String {
        let relative = DisplayFormatting.relativeTimestamp(pairing.expiresAt)
        return switch pairing.effectiveStatus {
        case "pending", "approved": "Expires \(relative)"
        case "expired": "Expired \(relative)"
        default: "Approval deadline \(relative)"
        }
    }
}

private struct ChromePairingConfirmation: Identifiable {
    enum Action {
        case approve
        case revoke
    }

    let pairing: CollectorPairing
    let action: Action

    var id: String { "\(pairing.id):\(String(describing: action))" }

    var title: String {
        switch action {
        case .approve: "Approve this Chrome collector?"
        case .revoke: pairing.isPending ? "Decline this Chrome pairing request?" : "Revoke this Chrome pairing?"
        }
    }

    var message: String {
        switch action {
        case .approve:
            "Approve \(pairing.clientID) to submit Chrome metadata allowed by your Privacy settings. The extension cannot change its resolved project."
        case .revoke:
            "\(pairing.clientID) will immediately lose access to the local collector API. It must create a new pairing request to reconnect."
        }
    }

    var revokeButtonTitle: String {
        pairing.isPending ? "Decline Request" : "Revoke Pairing"
    }
}

private struct ProjectIdentityConfirmation: Identifiable {
    let conflict: ProjectIdentityConflict
    let candidate: ProjectIdentityCandidate

    var id: String { "\(conflict.id):\(candidate.projectID)" }
}
