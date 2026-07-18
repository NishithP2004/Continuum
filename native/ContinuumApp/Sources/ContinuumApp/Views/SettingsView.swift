import SwiftUI

struct SettingsView: View {
    @AppStorage("continuum.daemonURL") private var daemonURL = "http://127.0.0.1:43117"
    let store: AppStore

    var body: some View {
        TabView {
            Form {
                Section("Engine") {
                    TextField("Daemon URL", text: $daemonURL)
                        .textFieldStyle(.roundedBorder)
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
                            store.reconfigure(baseURLString: daemonURL)
                        }
                        Spacer()
                        Label(store.connection.label, systemImage: store.connection.systemImage)
                            .foregroundStyle(connectionColor)
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
        }
        .frame(width: 560, height: 360)
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
}
