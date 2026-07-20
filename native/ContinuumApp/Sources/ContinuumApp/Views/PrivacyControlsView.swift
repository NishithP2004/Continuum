import AppKit
import SwiftUI

struct PrivacyControlsView: View {
    let store: AppStore
    @State private var domain = ""
    @State private var ignoredDomain = ""
    @State private var ignoredPath = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            GroupBox("Live sources") {
                Grid(alignment: .leading, horizontalSpacing: 28, verticalSpacing: 10) {
                    sourceToggle("VS Code", source: "vscode")
                    sourceToggle("Terminal command metadata", source: "terminal")
                    sourceToggle("Git metadata", source: "git")
                    sourceToggle("Chrome foreground tab", source: "chrome")
                    sourceToggle("Application lifecycle", source: "os_app")
                    sourceToggle("Approved folders", source: "os_folder")
                    GridRow {
                        Toggle("Focused-window titles", isOn: windowTitleBinding)
                        Text("Off by default · Accessibility permission · local only")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(8)

                if store.collectorHealth.status == "permissionRequired" {
                    HStack(spacing: 10) {
                        Label("Focused-window capture is waiting for Accessibility access.", systemImage: "hand.raised.fill")
                            .font(.caption)
                            .foregroundStyle(.orange)
                        Spacer()
                        Button("Open Accessibility Settings") {
                            openAccessibilitySettings()
                        }
                        Button("Check Again") {
                            store.recheckCollectorPermissions()
                        }
                    }
                    .padding(8)
                }
            }

            ChromePairingControlsView(store: store)

            GroupBox("Eligible metadata") {
                VStack(alignment: .leading, spacing: 10) {
                    Toggle("Workspace-relative file paths", isOn: policyBinding(\.includeRelativePaths))
                    Toggle("URL hosts from allowed domains", isOn: policyBinding(\.includeURLHosts))
                    Toggle("Allowlisted URL paths", isOn: policyBinding(\.includeURLPaths))
                    Toggle("Safe command names", isOn: policyBinding(\.includeCommandNames))
                    Toggle("Safe command flag names", isOn: policyBinding(\.includeCommandFlagNames))
                    Divider()
                    Toggle("Collect sanitized personal metadata", isOn: policyBinding(\.personalMetadataEnabled))
                    Toggle(
                        "Collect confidential metadata locally only",
                        isOn: policyBinding(\.confidentialLocalCollectionEnabled)
                    )
                    Text("Confidential metadata remains local-only and is never eligible for cloud providers or synchronization.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Toggle("Allow eligible sanitized metadata for cloud providers and sync", isOn: policyBinding(\.cloudSharingEnabled))
                    Text("Selecting a cloud model remains explicit consent. Confidential context is never eligible.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(8)
            }

            GroupBox("Retention and rules") {
                VStack(alignment: .leading, spacing: 12) {
                    Stepper(
                        "Raw sanitized event retention: \(store.privacyPolicy.retentionHours) hours",
                        value: retentionBinding,
                        in: 1...24
                    )

                    HStack {
                        TextField("Allow browser domain", text: $domain)
                            .textFieldStyle(.roundedBorder)
                        Button("Add") { addDomain() }
                            .disabled(normalizedDomain == nil)
                    }
                    tagList(store.privacyPolicy.allowedDomains) { value in
                        Task {
                            await store.updatePrivacyPolicy { $0.allowedDomains.removeAll { $0 == value } }
                        }
                    }

                    HStack {
                        TextField("Ignore browser domain", text: $ignoredDomain)
                            .textFieldStyle(.roundedBorder)
                        Button("Add") { addIgnoredDomain() }
                            .disabled(normalizedIgnoredDomain == nil)
                    }
                    tagList(store.privacyPolicy.ignoredDomains) { value in
                        Task {
                            await store.updatePrivacyPolicy { $0.ignoredDomains.removeAll { $0 == value } }
                        }
                    }

                    HStack {
                        TextField("Ignore path glob (for example **/dist/**)", text: $ignoredPath)
                            .textFieldStyle(.roundedBorder)
                        Button("Add") { addIgnoredPath() }
                            .disabled(normalizedIgnoredPath == nil)
                    }
                    tagList(store.privacyPolicy.ignoredPaths) { value in
                        Task {
                            await store.updatePrivacyPolicy { $0.ignoredPaths.removeAll { $0 == value } }
                        }
                    }
                }
                .padding(8)
            }

            GroupBox("Approved folders") {
                VStack(alignment: .leading, spacing: 10) {
                    if store.privacyPolicy.approvedFolders.isEmpty {
                        Text("No folders approved. Continuum never watches your home directory implicitly.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(store.privacyPolicy.approvedFolders) { folder in
                            HStack(spacing: 10) {
                                Image(systemName: "folder.fill")
                                    .foregroundStyle(.secondary)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(URL(fileURLWithPath: folder.path).lastPathComponent)
                                    Text("\(folder.projectName) · \(folder.path)")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                        .help(folder.path)
                                }
                                Spacer()
                                Button("Remove", systemImage: "minus.circle") {
                                    Task { await store.removeApprovedFolder(id: folder.id) }
                                }
                                .labelStyle(.iconOnly)
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    Button("Approve Folder…", systemImage: "folder.badge.plus") {
                        chooseFolder()
                    }
                    .disabled(store.snapshot.activeProject == nil)
                    if store.snapshot.activeProject == nil {
                        Text("Focus a live VS Code workspace or terminal repository first so the folder can be mapped to a project.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(8)
            }

            ProjectIdentityConflictsView(store: store)

            GroupBox("Always enforced") {
                VStack(alignment: .leading, spacing: 8) {
                    immutableRow("Credentials and detected secrets are rejected")
                    immutableRow("No screenshots, document bodies, terminal output, keystrokes, clipboard, DOM, cookies, or URL queries")
                    immutableRow("Git patches, blobs, remotes, and credential-bearing attributes are prohibited")
                    immutableRow("Confidential metadata never enters cloud requests or synchronization")
                }
                .padding(8)
            }
        }
    }

    private func sourceToggle(_ title: String, source: String) -> some View {
        GridRow {
            Toggle(title, isOn: sourceBinding(source))
            Text(store.privacyPolicy.sourceEnabled[source] == false ? "Disabled" : "Collecting allowlisted metadata")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func policyBinding(_ keyPath: WritableKeyPath<PrivacyPolicyV1, Bool>) -> Binding<Bool> {
        Binding(
            get: { store.privacyPolicy[keyPath: keyPath] },
            set: { value in
                Task { await store.updatePrivacyPolicy { $0[keyPath: keyPath] = value } }
            }
        )
    }

    private func sourceBinding(_ source: String) -> Binding<Bool> {
        Binding(
            get: { store.privacyPolicy.sourceEnabled[source] ?? false },
            set: { value in
                Task {
                    await store.updatePrivacyPolicy { policy in
                        policy.sourceEnabled[source] = value
                        if source == "os_window" { policy.captureWindowTitles = value }
                    }
                }
            }
        )
    }

    private var windowTitleBinding: Binding<Bool> {
        Binding(
            get: {
                store.privacyPolicy.captureWindowTitles
                    && (store.privacyPolicy.sourceEnabled["os_window"] ?? false)
            },
            set: { value in
                Task {
                    await store.updatePrivacyPolicy { policy in
                        policy.captureWindowTitles = value
                        policy.sourceEnabled["os_window"] = value
                    }
                }
            }
        )
    }

    private var retentionBinding: Binding<Int> {
        Binding(
            get: { store.privacyPolicy.retentionHours },
            set: { value in Task { await store.updatePrivacyPolicy { $0.retentionHours = value } } }
        )
    }

    @ViewBuilder
    private func tagList(_ values: [String], remove: @escaping (String) -> Void) -> some View {
        if !values.isEmpty {
            FlowTags(values: values, remove: remove)
        }
    }

    private func immutableRow(_ text: String) -> some View {
        Label(text, systemImage: "lock.shield.fill")
            .font(.callout)
            .foregroundStyle(.secondary)
    }

    private var normalizedDomain: String? {
        PrivacyRuleInput.normalizedDomain(domain)
    }

    private var normalizedIgnoredDomain: String? {
        PrivacyRuleInput.normalizedDomain(ignoredDomain)
    }

    private var normalizedIgnoredPath: String? {
        PrivacyRuleInput.normalizedRelativeGlob(ignoredPath)
    }

    private func addDomain() {
        guard let value = normalizedDomain else { return }
        domain = ""
        Task {
            await store.updatePrivacyPolicy { policy in
                policy.ignoredDomains.removeAll { $0 == value }
                if !policy.allowedDomains.contains(value) { policy.allowedDomains.append(value) }
            }
        }
    }

    private func addIgnoredDomain() {
        guard let value = normalizedIgnoredDomain else { return }
        ignoredDomain = ""
        Task {
            await store.updatePrivacyPolicy { policy in
                policy.allowedDomains.removeAll { $0 == value }
                if !policy.ignoredDomains.contains(value) { policy.ignoredDomains.append(value) }
            }
        }
    }

    private func addIgnoredPath() {
        guard let value = normalizedIgnoredPath else { return }
        ignoredPath = ""
        Task {
            await store.updatePrivacyPolicy { policy in
                if !policy.ignoredPaths.contains(value) { policy.ignoredPaths.append(value) }
            }
        }
    }

    private func chooseFolder() {
        guard let project = store.snapshot.activeProject else { return }
        let panel = NSOpenPanel()
        panel.title = "Approve a folder for \(project.name)"
        panel.message = "Continuum records only coalesced relative path and change metadata. It never reads file contents."
        panel.prompt = "Approve Folder"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task { await store.addApprovedFolder(path: url.path, project: project) }
    }

    private func openAccessibilitySettings() {
        guard let url = URL(
            string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        ) else { return }
        NSWorkspace.shared.open(url)
    }
}

private struct FlowTags: View {
    let values: [String]
    let remove: (String) -> Void

    var body: some View {
        HStack(spacing: 6) {
            ForEach(values.prefix(8), id: \.self) { value in
                HStack(spacing: 4) {
                    Text(value)
                    Button {
                        remove(value)
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove \(value)")
                }
                .font(.caption)
                .padding(.horizontal, 7)
                .padding(.vertical, 4)
                .background(.quaternary, in: Capsule())
            }
        }
    }
}
