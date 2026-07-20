import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        DispatchQueue.main.async {
            AppPresentation.activate()
        }
    }

    func applicationShouldHandleReopen(
        _ sender: NSApplication,
        hasVisibleWindows flag: Bool
    ) -> Bool {
        AppPresentation.activate()
        return true
    }
}

enum AppScene {
    static let mainWindowID = "main"
}

@main
struct ContinuumApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var store = AppStore()

    var body: some Scene {
        WindowGroup("Continuum", id: AppScene.mainWindowID) {
            InspectorRootView(store: store)
                .frame(minWidth: 920, minHeight: 620)
                .onAppear {
                    AppPresentation.activate()
                }
                .task {
                    store.startPolling()
                    await store.refresh()
                }
        }
        .defaultSize(width: 1180, height: 780)
        .windowResizability(.contentMinSize)
        .commands {
            ContinuumCommands()
        }

        MenuBarExtra {
            MenuBarContentView(store: store)
        } label: {
            StatusItemLabel(store: store)
                .task {
                    store.startPolling()
                }
        }
        .menuBarExtraStyle(.menu)

        Settings {
            SettingsView(store: store)
        }
    }
}

struct ContinuumCommands: Commands {
    @Environment(\.openSettings) private var openSettings

    var body: some Commands {
        CommandGroup(replacing: .newItem) {}

        CommandGroup(replacing: .appSettings) {
            Button("Settings…") {
                AppPresentation.openSettings(openSettings)
            }
            .keyboardShortcut(",", modifiers: .command)
        }

        CommandMenu("Continuum") {
            Button("Show Continuum") {
                AppPresentation.activate()
            }
            .keyboardShortcut("0", modifiers: .command)
        }
    }
}

enum AppPresentation {
    static func activate() {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.async {
            guard let window = mainWindow else { return }
            if window.isMiniaturized { window.deminiaturize(nil) }
            window.makeKeyAndOrderFront(nil)
        }
    }

    static var hasMainWindow: Bool { mainWindow != nil }

    private static var mainWindow: NSWindow? {
        NSApp.windows.first(where: {
            $0.canBecomeMain
                && ($0.title == "Continuum" || $0.frame.width >= 900)
        })
    }

    static func openSettings(_ action: OpenSettingsAction) {
        action()
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.async {
            NSApp.activate(ignoringOtherApps: true)
            NSApp.windows.first(where: { $0.title.localizedCaseInsensitiveContains("settings") })?
                .makeKeyAndOrderFront(nil)
        }
    }
}
