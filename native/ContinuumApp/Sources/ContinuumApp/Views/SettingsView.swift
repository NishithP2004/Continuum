import SwiftUI

struct SettingsView: View {
    @AppStorage("continuum.daemonURL") private var daemonURL = "http://127.0.0.1:43117"
    @State private var remoteDraft: RemoteAuthenticationDraft
    @State private var showAdvancedRemoteConfiguration = false
    let store: AppStore

    init(store: AppStore) {
        self.store = store
        _remoteDraft = State(initialValue: RemoteAuthenticationDraft.load())
    }

    var body: some View {
        TabView {
            Form {
                Section("Engine") {
                    TextField("Daemon URL", text: $daemonURL)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { reconnectDaemon() }
                    HStack {
                        Text("Credential")
                        Spacer()
                        Text(store.credentialDescription)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .help(store.credentialDescription)
                    }
                    HStack {
                        Button("Reconnect") {
                            reconnectDaemon()
                        }
                        .disabled(!daemonURLIsValid)
                        Spacer()
                        Label(store.connection.label, systemImage: store.connection.systemImage)
                            .foregroundStyle(connectionColor)
                    }
                    if !daemonURLIsValid {
                        Text("Use Continuum's fixed local origin: http://127.0.0.1:43117.")
                            .font(.caption)
                            .foregroundStyle(.red)
                    }
                }

                Section("Capture") {
                    Toggle(
                        "Pause semantic event capture",
                        isOn: Binding(
                            get: { store.capturePaused },
                            set: { _ in Task { await store.toggleCapture() } }
                        )
                    )
                    Text("Continuum collects allowlisted metadata only—never screenshots, file bodies, terminal output, or browser DOM.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)
            .padding()
            .tabItem {
                Label("General", systemImage: "gearshape")
            }

            ScrollView {
                PrivacyControlsView(store: store)
                    .padding()
            }
            .tabItem {
                Label("Privacy", systemImage: "hand.raised.fill")
            }

            Form {
                Section("Checkpoint generation") {
                    ModelControlsView(store: store)
                }
            }
            .formStyle(.grouped)
            .padding()
            .tabItem {
                Label("Models", systemImage: "cpu")
            }

            Form {
                Section("Remote companion") {
                    LabeledContent {
                        Label(store.remoteAuthentication.phase.title, systemImage: remoteAuthenticationIcon)
                            .foregroundStyle(remoteAuthenticationColor)
                    } label: {
                        Text("Auth0 session")
                    }
                    Text(store.remoteAuthentication.message)
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    TextField("Continuum service URL", text: $remoteDraft.serviceURL)
                        .textFieldStyle(.roundedBorder)
                        .disabled(remoteConfigurationLocked)
                    TextField("Auth0 issuer URL", text: $remoteDraft.issuer)
                        .textFieldStyle(.roundedBorder)
                        .disabled(remoteConfigurationLocked)
                    TextField("Native application client ID", text: $remoteDraft.clientID)
                        .textFieldStyle(.roundedBorder)
                        .disabled(remoteConfigurationLocked)
                    TextField("API audience", text: $remoteDraft.audience)
                        .textFieldStyle(.roundedBorder)
                        .disabled(remoteConfigurationLocked)

                    DisclosureGroup("Advanced OAuth settings", isExpanded: $showAdvancedRemoteConfiguration) {
                        TextField("Scopes", text: $remoteDraft.scopes)
                            .textFieldStyle(.roundedBorder)
                            .disabled(remoteConfigurationLocked)
                        LabeledContent("Callback URL") {
                            Text("\(RemoteAuthenticationConfiguration.applicationCallbackScheme)://auth/callback")
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                        }
                    }

                    HStack {
                        if store.remoteAuthentication.isAuthenticated {
                            Button("Sign Out and Revoke") {
                                Task { await store.signOutRemote() }
                            }
                        } else {
                            Button("Sign In with Auth0") {
                                Task { await store.signInRemote(using: remoteDraft) }
                            }
                            .buttonStyle(.borderedProminent)
                        }
                        Spacer()
                        if let expiresAt = store.remoteAuthentication.accessTokenExpiresAt,
                           store.remoteAuthentication.isAuthenticated {
                            Text("Access token expires \(expiresAt, style: .relative)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .disabled(store.remoteAuthentication.phase.isBusy)
                    if store.remoteAuthentication.isAuthenticated {
                        Text("Sign out before changing the service or Auth0 application configuration.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Synchronization") {
                    LabeledContent("Status", value: store.syncStatus.state.capitalized)
                    if let message = store.syncStatus.message {
                        Text(message)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if let endpoint = store.syncStatus.endpoint {
                        LabeledContent("Endpoint") {
                            Text(endpoint)
                                .font(.caption.monospaced())
                                .lineLimit(1)
                                .help(endpoint)
                        }
                    }
                    Button("Reconnect Sync") {
                        Task { await store.reconnectSync() }
                    }
                    .disabled(store.isPerformingAction || !store.remoteAuthentication.isAuthenticated)
                }

                Section("Security") {
                    Text("Continuum uses Authorization Code with PKCE. The Auth0 refresh credential is stored as a non-synchronizable, device-only Keychain item. Access tokens stay in memory and are passed only to the loopback daemon. Client secrets are never requested or stored.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)
            .padding()
            .tabItem {
                Label("Sync", systemImage: "arrow.triangle.2.circlepath.icloud")
            }
        }
        .frame(width: 720, height: 580)
        .task {
            store.startPolling()
        }
    }

    private var connectionColor: Color {
        switch store.connection {
        case .connecting: .secondary
        case .connected: .green
        case .degraded: .orange
        case .disconnected: .red
        }
    }

    private var remoteAuthenticationColor: Color {
        switch store.remoteAuthentication.phase {
        case .signedIn: .green
        case .failed: .red
        case .signingIn, .refreshing, .signingOut: .blue
        case .notConfigured, .signedOut: .secondary
        }
    }

    private var remoteAuthenticationIcon: String {
        switch store.remoteAuthentication.phase {
        case .signedIn: "checkmark.shield.fill"
        case .failed: "exclamationmark.shield.fill"
        case .signingIn, .refreshing, .signingOut: "arrow.triangle.2.circlepath"
        case .notConfigured: "gear.badge.questionmark"
        case .signedOut: "person.crop.circle.badge.xmark"
        }
    }

    private var remoteConfigurationLocked: Bool {
        store.remoteAuthentication.phase.isBusy || store.remoteAuthentication.isAuthenticated
    }

    private var daemonURLIsValid: Bool {
        EngineConfiguration.validatedLoopbackURL(daemonURL) != nil
    }

    private func reconnectDaemon() {
        guard daemonURLIsValid else { return }
        store.reconfigure(baseURLString: daemonURL)
    }
}
