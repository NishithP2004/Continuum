import SwiftUI

struct ContextDiffView: View {
    let store: AppStore

    private var diff: ContextDiffSummary { store.contextDiff }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                ConnectionBanner(status: store.connection)

                InspectorCard("Comparison", systemImage: "arrow.left.arrow.right") {
                    Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
                        GridRow {
                            Text("Baseline").foregroundStyle(.secondary)
                            Text(diff.baselineCheckpointID ?? "Not acknowledged yet")
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                        }
                        GridRow {
                            Text("Current").foregroundStyle(.secondary)
                            Text(diff.currentCheckpointID ?? "No current checkpoint")
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                        }
                    }
                    HStack {
                        Button {
                            Task { await store.loadSyntheticCatchUp() }
                        } label: {
                            Label("Load Synthetic Catch-Up", systemImage: "play.circle")
                        }
                        .disabled(store.isPerformingAction)
                        .help("Loads the Monday phase of the bundled deterministic replay for a reproducible demo.")
                        Spacer()
                        Button {
                            Task { await store.generateBriefing() }
                        } label: {
                            Label("Generate GPT Briefing", systemImage: "sparkles")
                        }
                        .disabled(store.isPerformingAction || store.modelSettings.provider != .openai)
                        .help("Uses the selected OpenAI model with store:false and only the structured Context Diff.")
                    }
                    if store.modelSettings.provider != .openai {
                        Text("Select Cloud · OpenAI in Settings to consent to an eligible GPT briefing.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                if let briefing = diff.briefing, !briefing.isEmpty {
                    InspectorCard("Catch-up Briefing", systemImage: "sparkles") {
                        Text(briefing)
                            .textSelection(.enabled)
                    }
                }

                HStack(spacing: 12) {
                    MetricTile(
                        title: "Added blockers",
                        value: "\(diff.addedBlockers.count)",
                        systemImage: "plus.circle.fill",
                        tint: .orange
                    )
                    MetricTile(
                        title: "Resolved blockers",
                        value: "\(diff.resolvedBlockers.count)",
                        systemImage: "checkmark.circle.fill",
                        tint: .green
                    )
                    MetricTile(
                        title: "Hypotheses changed",
                        value: "\(diff.changedHypotheses.count)",
                        systemImage: "flask.fill",
                        tint: .purple
                    )
                }

                if !diff.addedBlockers.isEmpty {
                    InspectorCard("New Blockers", systemImage: "exclamationmark.octagon.fill") {
                        ForEach(diff.addedBlockers) { blocker in
                            DiffEvidenceRow(text: blocker.text, evidenceIDs: blocker.evidenceEventIDs)
                        }
                    }
                }

                if !diff.resolvedBlockers.isEmpty {
                    InspectorCard("Resolved Blockers", systemImage: "checkmark.seal.fill") {
                        ForEach(diff.resolvedBlockers) { blocker in
                            DiffEvidenceRow(text: blocker.text, evidenceIDs: blocker.evidenceEventIDs)
                        }
                    }
                }

                if !diff.changedHypotheses.isEmpty {
                    InspectorCard("Changed Hypotheses", systemImage: "flask.fill") {
                        ForEach(diff.changedHypotheses) { hypothesis in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(hypothesis.text)
                                Text("\(hypothesis.from) → \(hypothesis.to)")
                                    .font(.caption.weight(.medium))
                                    .foregroundStyle(.purple)
                                if !hypothesis.evidenceEventIDs.isEmpty {
                                    Text("Evidence · \(hypothesis.evidenceEventIDs.joined(separator: ", "))")
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }

                if !diff.newDecisions.isEmpty {
                    InspectorCard("New Decisions", systemImage: "checkmark.diamond.fill") {
                        EvidenceRows(items: diff.newDecisions)
                    }
                }

                if !diff.newFiles.isEmpty || !diff.newCommits.isEmpty || !diff.newEntities.isEmpty {
                    InspectorCard("New Graph Evidence", systemImage: "point.3.filled.connected.trianglepath.dotted") {
                        DiffGraphEvidence(diff: diff)
                    }
                }

                if isEmpty {
                    EmptySectionView(
                        title: "Nothing changed yet",
                        message: "Acknowledge a checkpoint, then Continuum will compare later state against it.",
                        systemImage: "equal.circle"
                    )
                }
            }
            .padding(20)
        }
    }

    private var isEmpty: Bool {
        diff.addedBlockers.isEmpty
            && diff.resolvedBlockers.isEmpty
            && diff.changedHypotheses.isEmpty
            && diff.newDecisions.isEmpty
            && diff.newFiles.isEmpty
            && diff.newCommits.isEmpty
            && diff.newEntities.isEmpty
            && (diff.briefing?.isEmpty ?? true)
    }
}

private struct DiffEvidenceRow: View {
    let text: String
    let evidenceIDs: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(text)
            if !evidenceIDs.isEmpty {
                Text("Evidence · \(evidenceIDs.joined(separator: ", "))")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
    }
}

private struct DiffGraphEvidence: View {
    let diff: ContextDiffSummary

    var body: some View {
        Grid(alignment: .topLeading, horizontalSpacing: 24, verticalSpacing: 8) {
            if !diff.newFiles.isEmpty {
                GridRow {
                    Label("Files", systemImage: "doc.text")
                    ValuesColumn(values: diff.newFiles)
                }
            }
            if !diff.newCommits.isEmpty {
                GridRow {
                    Label("Commits", systemImage: "point.3.connected.trianglepath.dotted")
                    ValuesColumn(values: diff.newCommits)
                }
            }
            if !diff.newEntities.isEmpty {
                GridRow {
                    Label("Entities", systemImage: "circle.hexagongrid")
                    ValuesColumn(values: diff.newEntities.map { "\($0.name) · \($0.type)" })
                }
            }
        }
    }
}

private struct ValuesColumn: View {
    let values: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(values, id: \.self) { value in
                Text(value)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
            }
        }
    }
}
