import SwiftUI

struct TimelineView: View {
    let store: AppStore

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                ConnectionBanner(status: store.connection)

                if store.checkpoints.isEmpty {
                    EmptySectionView(
                        title: "Timeline is empty",
                        message: "Evidence-backed checkpoints will form the project timeline.",
                        systemImage: "clock.badge.questionmark"
                    )
                } else {
                    ForEach(store.checkpoints) { checkpoint in
                        InspectorCard(checkpoint.focus, systemImage: "bookmark.fill") {
                            Text(checkpoint.summary)
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)

                            HStack(spacing: 14) {
                                Label(
                                    DisplayFormatting.relativeTimestamp(checkpoint.createdAt),
                                    systemImage: "clock"
                                )
                                Label(checkpoint.provider, systemImage: "cpu")
                                Text(checkpoint.id)
                                    .font(.caption2.monospaced())
                                    .lineLimit(1)
                            }
                            .font(.caption)
                            .foregroundStyle(.secondary)

                            if !checkpoint.files.isEmpty || !checkpoint.commits.isEmpty {
                                Divider()
                                HStack(alignment: .top, spacing: 24) {
                                    if !checkpoint.files.isEmpty {
                                        TimelineStringList(
                                            title: "Files",
                                            systemImage: "doc.text",
                                            values: checkpoint.files
                                        )
                                    }
                                    if !checkpoint.commits.isEmpty {
                                        TimelineStringList(
                                            title: "Commits",
                                            systemImage: "point.3.connected.trianglepath.dotted",
                                            values: checkpoint.commits
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
            .padding(20)
        }
    }
}

private struct TimelineStringList: View {
    let title: String
    let systemImage: String
    let values: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Label(title, systemImage: systemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            ForEach(values.prefix(5), id: \.self) { value in
                Text(value)
                    .font(.caption.monospaced())
                    .lineLimit(1)
                    .textSelection(.enabled)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
