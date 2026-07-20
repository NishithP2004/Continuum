import SwiftUI

struct DevicesView: View {
    let store: AppStore
    @State private var devicePendingRevocation: DeviceSummary?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: syncIcon)
                        .foregroundStyle(syncColor)
                        .font(.title2)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(syncTitle)
                            .font(.headline)
                        if let message = store.syncStatus.message {
                            Text(message)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if let lastSync = store.syncStatus.lastSyncedAt {
                            Text("Last sync \(DisplayFormatting.relativeTimestamp(lastSync))")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Button("Reconnect", systemImage: "arrow.triangle.2.circlepath") {
                        Task { await store.reconnectSync() }
                    }
                    .disabled(store.isPerformingAction)
                }
                .padding(16)
                .background(syncColor.opacity(0.09), in: RoundedRectangle(cornerRadius: 12))

                HStack(spacing: 12) {
                    MetricTile(
                        title: "Known devices",
                        value: "\(store.devices.count)",
                        systemImage: "laptopcomputer.and.iphone"
                    )
                    MetricTile(
                        title: "Pending operations",
                        value: "\(store.syncStatus.pendingOperations)",
                        systemImage: "arrow.up.arrow.down.circle",
                        tint: store.syncStatus.pendingOperations > 0 ? .orange : .green
                    )
                    MetricTile(
                        title: "Graph projection",
                        value: store.projectionHealth.status.capitalized,
                        systemImage: "server.rack",
                        tint: store.projectionHealth.isReady ? .green : .orange
                    )
                }

                if store.devices.isEmpty {
                    EmptySectionView(
                        title: "No synchronized devices",
                        message: "Configure the self-hosted sync service in Settings, then sign in to connect this Mac and the Continuum PWA.",
                        systemImage: "laptopcomputer.trianglebadge.exclamationmark"
                    )
                } else {
                    InspectorCard("Devices", systemImage: "laptopcomputer.and.iphone") {
                        ForEach(store.devices) { device in
                            HStack(spacing: 12) {
                                Image(systemName: deviceIcon(device.platform))
                                    .frame(width: 24)
                                    .foregroundStyle(device.status.lowercased() == "online" ? .green : .secondary)
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack(spacing: 6) {
                                        Text(device.name)
                                            .fontWeight(.medium)
                                        if device.isCurrent {
                                            Text("This Mac")
                                                .font(.caption2.weight(.semibold))
                                                .padding(.horizontal, 6)
                                                .padding(.vertical, 2)
                                                .background(.quaternary, in: Capsule())
                                        }
                                    }
                                    Text(
                                        device.lastSeenAt.map {
                                            "\(device.platform) · seen \(DisplayFormatting.relativeTimestamp($0))"
                                        } ?? device.platform
                                    )
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(device.status.capitalized)
                                    .font(.caption.weight(.medium))
                                    .foregroundStyle(.secondary)
                                if !device.isCurrent, device.status.lowercased() != "revoked" {
                                    Button("Revoke", systemImage: "xmark.circle", role: .destructive) {
                                        devicePendingRevocation = device
                                    }
                                    .labelStyle(.iconOnly)
                                    .help("Revoke \(device.name)")
                                }
                            }
                            if device.id != store.devices.last?.id { Divider() }
                        }
                    }
                }

                InspectorCard("Synced Context", systemImage: "lock.shield") {
                    Text("Only policy-eligible sanitized metadata, checkpoints, graph changes, baselines, settings, and eligible chats are synchronized. Confidential context remains local, and raw event metadata expires after 24 hours.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(20)
        }
        .alert(
            "Revoke \(devicePendingRevocation?.name ?? "device")?",
            isPresented: Binding(
                get: { devicePendingRevocation != nil },
                set: { if !$0 { devicePendingRevocation = nil } }
            ),
            presenting: devicePendingRevocation
        ) { device in
            Button("Revoke Device", role: .destructive) {
                Task { await store.revokeDevice(device) }
                devicePendingRevocation = nil
            }
            Button("Cancel", role: .cancel) {
                devicePendingRevocation = nil
            }
        } message: { device in
            Text("\(device.name) will no longer be allowed to synchronize this Continuum account.")
        }
    }

    private var syncTitle: String {
        switch store.syncStatus.state.lowercased() {
        case "ready", "connected", "synced": "Sync connected"
        case "syncing": "Synchronizing context"
        case "notconfigured": "Sync not configured"
        default: "Sync unavailable"
        }
    }

    private var syncIcon: String {
        switch store.syncStatus.state.lowercased() {
        case "ready", "connected", "synced": "checkmark.icloud.fill"
        case "syncing": "arrow.triangle.2.circlepath.icloud"
        default: "exclamationmark.icloud.fill"
        }
    }

    private var syncColor: Color {
        switch store.syncStatus.state.lowercased() {
        case "ready", "connected", "synced": .green
        case "syncing": .blue
        default: .orange
        }
    }

    private func deviceIcon(_ platform: String) -> String {
        switch platform.lowercased() {
        case "macos", "mac": "desktopcomputer"
        case "ios", "iphone": "iphone"
        case "android": "smartphone"
        default: "globe"
        }
    }
}
