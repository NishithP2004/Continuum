import SwiftUI

struct ActivityView: View {
    let store: AppStore

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                ConnectionBanner(status: store.connection)

                if !store.snapshot.collectorNames.isEmpty {
                    InspectorCard("Live Collectors", systemImage: "antenna.radiowaves.left.and.right") {
                        HStack(spacing: 8) {
                            ForEach(store.snapshot.collectorNames, id: \.self) { collector in
                                Text(collector)
                                    .font(.caption.weight(.medium))
                                    .padding(.horizontal, 9)
                                    .padding(.vertical, 5)
                                    .background(.quaternary, in: Capsule())
                            }
                        }
                    }
                }

                if store.snapshot.recentActivity.isEmpty {
                    EmptySectionView(
                        title: "No recent activity",
                        message: "Sanitized editor, terminal, Git, and browser metadata will appear here.",
                        systemImage: "waveform.path.ecg"
                    )
                } else {
                    ForEach(store.snapshot.recentActivity) { activity in
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: icon(for: activity.source))
                                .foregroundStyle(.secondary)
                                .frame(width: 22)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(activity.title)
                                    .font(.headline)
                                HStack(spacing: 8) {
                                    Text(activity.source.uppercased())
                                    Text(activity.eventType)
                                    Text(DisplayFormatting.relativeTimestamp(activity.timestamp))
                                }
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if let relevance = activity.relevance {
                                Text(relevance)
                                    .font(.caption2.weight(.medium))
                                    .padding(.horizontal, 7)
                                    .padding(.vertical, 3)
                                    .background(.quaternary, in: Capsule())
                            }
                        }
                        .padding(14)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
                    }
                }
            }
            .padding(20)
        }
    }

    private func icon(for source: String) -> String {
        switch source.lowercased() {
        case "vscode": "chevron.left.forwardslash.chevron.right"
        case "terminal", "zsh": "terminal.fill"
        case "git": "point.3.connected.trianglepath.dotted"
        case "chrome", "browser": "globe"
        case "os": "macwindow"
        default: "circle.grid.cross"
        }
    }
}
