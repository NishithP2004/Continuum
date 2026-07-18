import SwiftUI

struct NowView: View {
    let store: AppStore

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                ConnectionBanner(status: store.connection)

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
                } else {
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
