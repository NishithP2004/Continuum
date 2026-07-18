import SwiftUI

struct PrivacyView: View {
    let store: AppStore

    private var privacy: PrivacySummary { store.snapshot.privacy }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                ConnectionBanner(status: store.connection)

                HStack(spacing: 12) {
                    MetricTile(
                        title: "Accepted metadata",
                        value: "\(privacy.accepted)",
                        systemImage: "checkmark.shield.fill",
                        tint: .green
                    )
                    MetricTile(
                        title: "Secrets rejected",
                        value: "\(privacy.droppedSecrets)",
                        systemImage: "xmark.shield.fill",
                        tint: .red
                    )
                    MetricTile(
                        title: "Kept local",
                        value: "\(privacy.keptLocal)",
                        systemImage: "lock.fill",
                        tint: .blue
                    )
                    MetricTile(
                        title: "Events expired",
                        value: "\(privacy.expired)",
                        systemImage: "clock.badge.xmark",
                        tint: .secondary
                    )
                }

                InspectorCard("Privacy Boundary", systemImage: "hand.raised.fill") {
                    VStack(alignment: .leading, spacing: 10) {
                        PrivacyPromiseRow(
                            icon: "camera.fill",
                            title: "No screenshots",
                            detail: "Continuum observes allowlisted semantic events, not pixels."
                        )
                        PrivacyPromiseRow(
                            icon: "terminal.fill",
                            title: "No terminal output or keystrokes",
                            detail: "Only sanitized command shape, duration, cwd, and exit code are eligible."
                        )
                        PrivacyPromiseRow(
                            icon: "doc.text.fill",
                            title: "No document bodies",
                            detail: "File contents, browser DOM, cookies, clipboard, and query strings are excluded."
                        )
                        PrivacyPromiseRow(
                            icon: "externaldrive.fill.badge.checkmark",
                            title: "Secret and confidential data stay local",
                            detail: "Secret events are rejected; confidential metadata is excluded from cloud requests."
                        )
                    }
                }

                if !privacy.rules.isEmpty {
                    InspectorCard("Filter Audit", systemImage: "list.bullet.clipboard.fill") {
                        Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 8) {
                            ForEach(privacy.rules) { rule in
                                GridRow {
                                    Text(rule.rule)
                                    Text("\(rule.count)")
                                        .font(.body.monospacedDigit())
                                        .foregroundStyle(.secondary)
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

private struct PrivacyPromiseRow: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(.secondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .fontWeight(.medium)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
