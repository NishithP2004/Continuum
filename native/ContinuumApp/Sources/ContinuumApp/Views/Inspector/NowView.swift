import SwiftUI

struct NowView: View {
    let store: AppStore

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                ConnectionBanner(status: store.connection)

                if store.snapshot.activeProject == nil, store.currentCheckpoint == nil {
                    LiveOnboardingCard(store: store)
                }

                InspectorCard("System Health", systemImage: "heart.text.square") {
                    Grid(alignment: .leading, horizontalSpacing: 28, verticalSpacing: 10) {
                        ForEach(store.health.overview.items) { item in
                            HealthGridRow(item: item)
                        }
                    }
                }

                HStack(spacing: 12) {
                    MetricTile(
                        title: "Pending events",
                        value: "\(store.snapshot.pendingEvents)",
                        systemImage: "tray.full.fill"
                    )
                    MetricTile(
                        title: "Checkpoints",
                        value: "\(store.checkpoints.count)",
                        systemImage: "bookmark.fill",
                        tint: .purple
                    )
                    MetricTile(
                        title: "Capture",
                        value: store.capturePaused ? "Paused" : "Live",
                        systemImage: store.capturePaused ? "pause.circle.fill" : "record.circle.fill",
                        tint: store.capturePaused ? .orange : .green
                    )
                }

                if let project = store.snapshot.activeProject {
                    InspectorCard("Active Project", systemImage: "hammer.fill") {
                        Text(project.name)
                            .font(.title3.weight(.semibold))
                        if let path = project.path {
                            Text(path)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                    }
                }

                if let checkpoint = store.currentCheckpoint {
                    InspectorCard("Current State", systemImage: "scope") {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(checkpoint.focus)
                                .font(.title3.weight(.medium))
                            Text(checkpoint.summary)
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                            HStack(spacing: 16) {
                                Label(
                                    "\(DisplayFormatting.percentage(checkpoint.confidence)) confidence",
                                    systemImage: "gauge.with.dots.needle.50percent"
                                )
                                Label(
                                    DisplayFormatting.relativeTimestamp(checkpoint.createdAt),
                                    systemImage: "clock"
                                )
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                    }

                    let openBlockers = checkpoint.blockers.filter { $0.status == "open" }
                    if !openBlockers.isEmpty {
                        InspectorCard("Open Blockers", systemImage: "exclamationmark.octagon.fill") {
                            VStack(alignment: .leading, spacing: 10) {
                                ForEach(openBlockers) { blocker in
                                    Label(blocker.text, systemImage: "circle.fill")
                                        .labelStyle(.titleAndIcon)
                                }
                            }
                            .foregroundStyle(.orange)
                        }
                    }

                    if !checkpoint.questions.isEmpty {
                        InspectorCard("Open Questions", systemImage: "questionmark.bubble.fill") {
                            EvidenceRows(items: checkpoint.questions)
                        }
                    }
                } else if store.snapshot.activeProject != nil {
                    EmptySectionView(
                        title: "No checkpoint yet",
                        message: "Capture a few relevant events, then choose Checkpoint Now.",
                        systemImage: "bookmark.slash"
                    )
                }
            }
            .padding(20)
        }
    }
}

private struct HealthGridRow: View {
    let item: NativeHealthItem

    var body: some View {
        GridRow {
            Label(item.subsystem.title, systemImage: systemImage)
                .foregroundStyle(tint)
            Text(item.status.capitalized)
                .font(.callout.weight(.medium))
            Text(item.detail ?? "")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .help(item.detail ?? "")
        }
    }

    private var systemImage: String {
        switch item.severity {
        case .ready: "checkmark.circle.fill"
        case .neutral: "circle.dotted"
        case .warning: "exclamationmark.triangle.fill"
        case .error: "xmark.octagon.fill"
        }
    }

    private var tint: Color {
        switch item.severity {
        case .ready: .green
        case .neutral: .secondary
        case .warning: .orange
        case .error: .red
        }
    }
}
