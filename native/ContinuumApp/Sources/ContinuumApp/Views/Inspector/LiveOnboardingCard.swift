import SwiftUI

struct LiveOnboardingCard: View {
    let store: AppStore

    var body: some View {
        InspectorCard("Set up live context", systemImage: "sparkles") {
            Text("Continuum is connected and waiting for its first live project. Choose how checkpoints run, then enable only the collectors and folders you want.")
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 14) {
                onboardingHeader(
                    number: 1,
                    title: "Choose a checkpoint provider",
                    status: store.modelSettings.provider.title,
                    ready: store.health.provider.status.lowercased() == "ready"
                )
                ModelControlsView(store: store)

                Divider()

                onboardingHeader(
                    number: 2,
                    title: "Review collector permissions",
                    status: store.collectorHealth.status.capitalized,
                    ready: store.collectorHealth.isReady
                )
                VStack(alignment: .leading, spacing: 6) {
                    permissionRow(
                        title: "Application activity",
                        detail: sourceEnabled("os_app")
                            ? "Enabled · no extra macOS permission"
                            : "Disabled in Privacy"
                    )
                    permissionRow(
                        title: "Focused-window titles",
                        detail: focusedWindowDetail
                    )
                    Text("Window titles remain off by default and local-only. Continuum asks for Accessibility access only if you explicitly enable them.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Divider()

                onboardingHeader(
                    number: 3,
                    title: "Resolve a project, then approve folders",
                    status: approvedFolderStatus,
                    ready: !store.privacyPolicy.approvedFolders.isEmpty
                )
                Text("Open a repository in VS Code or a Continuum-enabled terminal first. Once its live project identity is resolved, you can approve individual folders for that read-only project mapping—your home directory is never watched implicitly.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Divider()

                onboardingHeader(
                    number: 4,
                    title: "Pair Chrome if you want browser context",
                    status: chromeStatus,
                    ready: pairedChromeCount > 0
                )
                Text("Create a pairing request from the Chrome extension, then approve it in Privacy within five minutes. Chrome can send only allowlisted, sanitized foreground-tab metadata.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack {
                Button("Open Privacy & Collectors", systemImage: "hand.raised.fill") {
                    store.openInspector(at: .privacy)
                }
                .buttonStyle(.borderedProminent)

                Button("Refresh Live State", systemImage: "arrow.clockwise") {
                    Task { await store.refresh() }
                }
                .disabled(store.isRefreshing)
            }
        }
    }

    private func onboardingHeader(
        number: Int,
        title: String,
        status: String,
        ready: Bool
    ) -> some View {
        HStack(spacing: 10) {
            Text("\(number)")
                .font(.caption.monospacedDigit().weight(.bold))
                .frame(width: 24, height: 24)
                .foregroundStyle(.white)
                .background(ready ? Color.green : Color.accentColor, in: Circle())
            Text(title)
                .font(.headline)
            Spacer()
            Label(status, systemImage: ready ? "checkmark.circle.fill" : "circle.dotted")
                .font(.caption.weight(.medium))
                .foregroundStyle(ready ? .green : .secondary)
        }
    }

    private func permissionRow(title: String, detail: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Label(title, systemImage: "checkmark.shield")
            Spacer()
            Text(detail)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func sourceEnabled(_ source: String) -> Bool {
        store.privacyPolicy.sourceEnabled[source] ?? false
    }

    private var focusedWindowDetail: String {
        guard store.privacyPolicy.captureWindowTitles,
              sourceEnabled("os_window") else {
            return "Off · no permission requested"
        }
        return store.collectorHealth.status == "permissionRequired"
            ? "Accessibility permission required"
            : "Enabled · local only"
    }

    private var approvedFolderStatus: String {
        let count = store.privacyPolicy.approvedFolders.count
        return count == 0 ? "None approved" : "\(count) approved"
    }

    private var pairedChromeCount: Int {
        store.chromePairings.filter(\.isConnected).count
    }

    private var pendingChromeCount: Int {
        store.chromePairings.filter(\.isPending).count
    }

    private var chromeStatus: String {
        if pairedChromeCount > 0 {
            return pairedChromeCount == 1 ? "Paired" : "\(pairedChromeCount) paired"
        }
        if pendingChromeCount > 0 {
            return pendingChromeCount == 1 ? "Approval pending" : "\(pendingChromeCount) pending"
        }
        return "Optional"
    }
}
