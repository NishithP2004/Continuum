import SwiftUI

struct InspectorRootView: View {
    @SceneStorage("continuum.inspector.section") private var selectedSectionRaw = InspectorSection.now.rawValue
    let store: AppStore

    private var selection: Binding<InspectorSection?> {
        Binding(
            get: { InspectorSection(rawValue: selectedSectionRaw) ?? .now },
            set: { selectedSectionRaw = ($0 ?? .now).rawValue }
        )
    }

    var body: some View {
        NavigationSplitView {
            InspectorSidebar(selection: selection)
                .navigationSplitViewColumnWidth(min: 180, ideal: 210, max: 260)
        } detail: {
            InspectorDetailView(
                section: InspectorSection(rawValue: selectedSectionRaw) ?? .now,
                store: store
            )
            .navigationTitle((InspectorSection(rawValue: selectedSectionRaw) ?? .now).title)
            .toolbar {
                ToolbarItemGroup {
                    Button {
                        Task { await store.refresh() }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .disabled(store.isRefreshing)

                    Button {
                        Task { await store.flushCheckpoint() }
                    } label: {
                        Label("Checkpoint", systemImage: "bookmark.fill")
                    }
                    .disabled(store.isPerformingAction)

                    Button {
                        Task { await store.acknowledgeCurrentCheckpoint() }
                    } label: {
                        Label("Mark Caught Up", systemImage: "checkmark.seal.fill")
                    }
                    .disabled(store.currentCheckpoint == nil || store.isPerformingAction)
                }
            }
        }
        .onChange(of: store.inspectorRequestID) {
            selectedSectionRaw = store.requestedInspectorSection.rawValue
        }
        .alert(
            "Continuum couldn’t complete that action",
            isPresented: Binding(
                get: { store.operationError != nil },
                set: { if !$0 { store.dismissError() } }
            )
        ) {
            Button("OK") { store.dismissError() }
        } message: {
            Text(store.operationError ?? "Unknown error")
        }
    }
}

private struct InspectorSidebar: View {
    @Binding var selection: InspectorSection?

    var body: some View {
        List(InspectorSection.allCases, selection: $selection) { section in
            Label(section.title, systemImage: section.systemImage)
                .tag(section)
        }
        .listStyle(.sidebar)
        .navigationTitle("Continuum")
    }
}

private struct InspectorDetailView: View {
    let section: InspectorSection
    let store: AppStore

    @ViewBuilder
    var body: some View {
        switch section {
        case .now:
            NowView(store: store)
        case .activity:
            ActivityView(store: store)
        case .timeline:
            TimelineView(store: store)
        case .contextDiff:
            ContextDiffView(store: store)
        case .privacy:
            PrivacyView(store: store)
        case .providerHealth:
            ProviderHealthView(store: store)
        }
    }
}
