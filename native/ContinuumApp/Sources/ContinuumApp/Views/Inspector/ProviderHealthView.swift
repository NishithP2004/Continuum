import SwiftUI

struct ProviderHealthView: View {
    let store: AppStore

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                ConnectionBanner(status: store.connection)

                if store.health.provider.cloudActive || store.modelSettings.provider == .openai {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "cloud.fill")
                            .foregroundStyle(.blue)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Cloud provider active")
                                .font(.headline)
                            Text("Sanitized public/personal metadata may be sent to OpenAI. Secret and confidential data remain ineligible.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(12)
                    .background(.blue.opacity(0.09), in: RoundedRectangle(cornerRadius: 10))
                }

                InspectorCard("Checkpoint Provider", systemImage: "cpu.fill") {
                    ModelControlsView(store: store)
                }

                HStack(spacing: 12) {
                    MetricTile(
                        title: "Provider",
                        value: store.health.provider.provider.capitalized,
                        systemImage: "server.rack"
                    )
                    MetricTile(
                        title: "Provider status",
                        value: store.health.provider.status.capitalized,
                        systemImage: providerStatusIcon,
                        tint: providerStatusTint
                    )
                    MetricTile(
                        title: "Retrieval mode",
                        value: store.health.retrieval.mode,
                        systemImage: "magnifyingglass.circle.fill",
                        tint: store.health.retrieval.degraded ? .orange : .green
                    )
                }

                InspectorCard("Retrieval Index", systemImage: "point.3.filled.connected.trianglepath.dotted") {
                    Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 10) {
                        GridRow {
                            Text("Checkpoints").foregroundStyle(.secondary)
                            Text("\(store.health.retrieval.checkpointCount)").monospacedDigit()
                        }
                        GridRow {
                            Text("Graph nodes").foregroundStyle(.secondary)
                            Text("\(store.health.retrieval.graphNodeCount)").monospacedDigit()
                        }
                        GridRow {
                            Text("Graph edges").foregroundStyle(.secondary)
                            Text("\(store.health.retrieval.graphEdgeCount)").monospacedDigit()
                        }
                    }
                    if let message = store.health.retrieval.message {
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(store.health.retrieval.degraded ? .orange : .secondary)
                    }
                }
            }
            .padding(20)
        }
    }

    private var providerStatusIcon: String {
        store.health.provider.status.lowercased() == "ready"
            ? "checkmark.circle.fill"
            : "exclamationmark.triangle.fill"
    }

    private var providerStatusTint: Color {
        store.health.provider.status.lowercased() == "ready" ? .green : .orange
    }
}

struct ModelControlsView: View {
    let store: AppStore
    @State private var customModel = ""

    private let localModels = ["gemma3n:e2b", "gemma3:1b"]
    private let appleModels = ["apple-system-default"]
    private let cloudModels = ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("Provider", selection: providerBinding) {
                ForEach(ProviderKind.allCases, id: \.self) { provider in
                    Text(provider.title).tag(provider)
                }
            }
            .pickerStyle(.segmented)

            Picker("Model", selection: modelBinding) {
                ForEach(availableModels, id: \.self) { model in
                    Text(model).tag(model)
                }
                if !availableModels.contains(store.modelSettings.model) {
                    Text(store.modelSettings.model).tag(store.modelSettings.model)
                }
            }

            HStack {
                TextField("Advanced custom model ID", text: $customModel)
                    .textFieldStyle(.roundedBorder)
                Button("Use Model") {
                    let model = customModel.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !model.isEmpty else { return }
                    Task {
                        await store.updateModel(provider: store.modelSettings.provider, model: model)
                    }
                }
                .disabled(customModel.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            Text(providerDescription)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .disabled(store.isPerformingAction)
    }

    private var availableModels: [String] {
        switch store.modelSettings.provider {
        case .local: localModels
        case .apple: appleModels
        case .openai: cloudModels
        }
    }

    private var providerBinding: Binding<ProviderKind> {
        Binding(
            get: { store.modelSettings.provider },
            set: { provider in
                let model = store.modelSettings.model(for: provider)
                Task { await store.updateModel(provider: provider, model: model) }
            }
        )
    }

    private var modelBinding: Binding<String> {
        Binding(
            get: { store.modelSettings.model },
            set: { model in
                Task {
                    await store.updateModel(provider: store.modelSettings.provider, model: model)
                }
            }
        )
    }

    private var providerDescription: String {
        switch store.modelSettings.provider {
        case .local:
            "Ollama runs checkpoint generation on this Mac. Continuum never silently falls back to cloud."
        case .apple:
            "Apple Foundation Models runs on-device on eligible macOS 26+ Macs with Apple Intelligence enabled. Unavailability is surfaced; Continuum does not silently switch providers."
        case .openai:
            "OpenAI Responses uses store:false. Provider selection is cloud consent, not a Zero Data Retention claim."
        }
    }
}
