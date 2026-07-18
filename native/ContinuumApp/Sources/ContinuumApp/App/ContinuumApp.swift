import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        // Continuum intentionally lives in the menu bar and does not claim Dock space.
        NSApp.setActivationPolicy(.accessory)
    }
}

@main
struct ContinuumApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var store = AppStore()

    var body: some Scene {
        MenuBarExtra {
            MenuBarContentView(store: store)
        } label: {
            StatusItemLabel(store: store)
                .task {
                    store.startPolling()
                }
        }
        .menuBarExtraStyle(.menu)

        Window("Continuum Inspector", id: "inspector") {
            InspectorRootView(store: store)
                .frame(minWidth: 820, minHeight: 560)
                .task {
                    store.startPolling()
                    await store.refresh()
                }
        }
        .defaultSize(width: 1040, height: 700)
        .windowResizability(.contentMinSize)

        Settings {
            SettingsView(store: store)
        }
    }
}
