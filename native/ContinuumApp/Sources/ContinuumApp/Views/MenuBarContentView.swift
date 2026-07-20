import AppKit
import SwiftUI

struct StatusItemLabel: View {
    let store: AppStore

    var body: some View {
        Image(systemName: store.capturePaused ? "pause.circle.fill" : store.connection.systemImage)
            .symbolRenderingMode(.hierarchical)
            .accessibilityLabel("Continuum: \(store.connection.label)")
    }
}

struct MenuBarContentView: View {
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings
    let store: AppStore

    var body: some View {
        Section {
            Label(store.connection.label, systemImage: store.connection.systemImage)
            if let project = store.snapshot.activeProject {
                Text(project.name.truncatedForMenu())
            }
            Text(
                "\(store.modelSettings.provider.title) · \(store.modelSettings.model)"
                    .truncatedForMenu()
            )
            Text("\(store.snapshot.pendingEvents) events pending")
        }

        Divider()

        Button(store.capturePaused ? "Resume Capture" : "Pause Capture") {
            Task { await store.toggleCapture() }
        }
        .keyboardShortcut("p", modifiers: [.command, .shift])

        Button("Checkpoint Now") {
            Task { await store.flushCheckpoint() }
        }
        .keyboardShortcut("k", modifiers: [.command, .shift])
        .disabled(store.isPerformingAction)

        Button("Catch Up") {
            presentInspector(section: .contextDiff)
        }

        Divider()

        Button("Open Inspector") {
            presentInspector(section: .now)
        }
        .keyboardShortcut("i", modifiers: [.command, .shift])

        Button("Settings…") {
            AppPresentation.openSettings(openSettings)
        }

        Divider()

        Button("Quit Continuum") {
            NSApplication.shared.terminate(nil)
        }
        .keyboardShortcut("q")
    }

    private func presentInspector(section: InspectorSection) {
        store.openInspector(at: section)
        if AppPresentation.hasMainWindow {
            AppPresentation.activate()
        } else {
            openWindow(id: AppScene.mainWindowID)
            NSApp.activate(ignoringOtherApps: true)
            DispatchQueue.main.async {
                AppPresentation.activate()
            }
        }
    }
}
