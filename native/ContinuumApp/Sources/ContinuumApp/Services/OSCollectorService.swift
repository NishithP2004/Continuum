import AppKit
import ApplicationServices
import CoreServices
import Foundation

enum NativePrivacyPolicyGate {
    private enum NativeSource: Equatable {
        case apps
        case windows
        case approvedFolders
    }

    static func apply(
        _ event: NativeCollectedEvent,
        policy: PrivacyPolicyV1?
    ) -> NativeCollectedEvent? {
        guard let policy,
              event.version == "2",
              event.source == "os",
              let source = source(for: event.eventType),
              sourceIsEnabled(source, policy: policy),
              classificationIsEnabled(event.privacy.classification, source: source, policy: policy),
              immutableSecretScanAllows(event) else {
            return nil
        }

        var prepared = event
        prepared.title = sanitizePotentiallySensitiveMetadata(event.title, maximumLength: 256) ?? "Native activity"
        prepared.dedupeKey = sanitizePotentiallySensitiveMetadata(event.dedupeKey, maximumLength: 512)
            ?? "os:\(event.eventType):\(event.id)"
        prepared.attributes = allowedAttributes(for: source, from: event.attributes)

        switch source {
        case .apps:
            break
        case .windows:
            guard prepared.attributes["windowTitle"] != nil else { return nil }
        case .approvedFolders:
            guard let rootID = prepared.attributes["approvedRootId"],
                  let folder = policy.approvedFolders.first(where: { $0.id == rootID }),
                  prepared.projectId == folder.projectID else {
                return nil
            }
            if let relativePath = prepared.attributes["relativePath"] {
                let normalized = relativePath.replacingOccurrences(of: "\\", with: "/")
                guard isSafeRelativePath(normalized),
                      !policy.ignoredPaths.contains(where: { matchesGlob(normalized, pattern: $0) }) else {
                    return nil
                }
                prepared.attributes["relativePath"] = normalized
            }
            if !policy.includeRelativePaths {
                prepared.attributes.removeValue(forKey: "relativePath")
                prepared.title = "Approved folder activity"
                let change = prepared.attributes["changeKind"] ?? "changed"
                let bucket = Int((ISO8601DateFormatter().date(from: prepared.occurredAt)?.timeIntervalSince1970 ?? 0) / 10)
                prepared.dedupeKey = "os:folder:\(rootID):\(change):\(bucket)"
            }
        }

        prepared.policyVersion = policy.version
        prepared.privacy.rules = Array(Set(prepared.privacy.rules + [
            "native_allowlist",
            "native_policy_v1",
            "native_secret_guard_v1",
            "policy_v\(policy.version)"
        ])).sorted()
        prepared.syncEligibility = source == .windows
            || prepared.privacy.classification != "public"
                && !(prepared.privacy.classification == "personal" && policy.cloudSharingEnabled)
            ? "local_only"
            : "cloud_eligible"
        return prepared
    }

    static func compliantQueue(
        _ events: [NativeCollectedEvent],
        policy: PrivacyPolicyV1?
    ) -> [NativeCollectedEvent] {
        events.compactMap { apply($0, policy: policy) }
    }

    private static func source(for eventType: String) -> NativeSource? {
        switch eventType {
        case "app_activated", "app_launched", "app_terminated":
            .apps
        case "window_focused":
            .windows
        case "folder_changed":
            .approvedFolders
        default:
            nil
        }
    }

    private static func sourceIsEnabled(_ source: NativeSource, policy: PrivacyPolicyV1) -> Bool {
        switch source {
        case .apps:
            policy.sourceEnabled["os_app"] == true
        case .windows:
            policy.captureWindowTitles && policy.sourceEnabled["os_window"] == true
        case .approvedFolders:
            policy.sourceEnabled["os_folder"] == true
        }
    }

    private static func classificationIsEnabled(
        _ classification: String,
        source: NativeSource,
        policy: PrivacyPolicyV1
    ) -> Bool {
        switch source {
        case .apps, .approvedFolders:
            guard classification == "personal" else { return false }
            return policy.personalMetadataEnabled
        case .windows:
            guard classification == "confidential" else { return false }
            return policy.confidentialLocalCollectionEnabled
        }
    }

    private static func allowedAttributes(
        for source: NativeSource,
        from attributes: [String: String]
    ) -> [String: String] {
        let allowed: Set<String> = switch source {
        case .apps:
            ["bundleId", "appName", "action"]
        case .windows:
            ["bundleId", "appName", "windowTitle"]
        case .approvedFolders:
            ["changeKind", "approvedRootId", "relativePath"]
        }
        return attributes.reduce(into: [:]) { result, entry in
            guard allowed.contains(entry.key),
                  let value = sanitizePotentiallySensitiveMetadata(entry.value, maximumLength: 240) else {
                return
            }
            result[entry.key] = value
        }
    }

    private static func immutableSecretScanAllows(_ event: NativeCollectedEvent) -> Bool {
        let values = [
            event.id,
            event.deviceId,
            event.occurredAt,
            event.hlc,
            event.eventType,
            event.projectId ?? "",
            event.title,
            event.dedupeKey,
            event.privacy.classification,
            event.relevance.decision,
            event.relevance.reason,
            event.syncEligibility
        ] + event.privacy.rules + Array(event.attributes.keys) + Array(event.attributes.values)
        return values.allSatisfy { value in
            value.isEmpty || sanitizePotentiallySensitiveMetadata(value, maximumLength: max(value.count, 1)) != nil
        }
    }

    private static func isSafeRelativePath(_ value: String) -> Bool {
        guard !value.hasPrefix("/"),
              !value.hasPrefix("~/"),
              value.range(of: #"^[A-Za-z]:/"#, options: .regularExpression) == nil else {
            return false
        }
        return !value.split(separator: "/").contains("..")
    }
}

actor NativeEventSubmitter {
    private var client: EngineClient
    private let queueStore: NativeEventQueueStore
    private var queued: [NativeCollectedEvent]
    private var policy: PrivacyPolicyV1?
    private var policyGeneration = 0
    private var isFlushing = false

    init(
        configuration: EngineConfiguration,
        policy initialPolicy: PrivacyPolicyV1? = nil,
        policyGeneration initialPolicyGeneration: Int = 0,
        queueStore providedQueueStore: NativeEventQueueStore? = nil
    ) {
        client = EngineClient(configuration: configuration)
        let store = providedQueueStore ?? NativeEventQueueStore.defaultStore()
        queueStore = store
        policy = initialPolicy
        policyGeneration = initialPolicyGeneration
        let loaded = store.load()
        let policyRetained = Self.eventsWithinPolicyRetention(loaded, policy: initialPolicy)
        queued = NativePrivacyPolicyGate.compliantQueue(policyRetained, policy: initialPolicy)
        if queued != loaded { store.save(queued) }
    }

    func reconfigure(_ configuration: EngineConfiguration) {
        client = EngineClient(configuration: configuration)
    }

    func updatePolicy(_ policy: PrivacyPolicyV1?, generation: Int) {
        guard generation >= policyGeneration else { return }
        policyGeneration = generation
        self.policy = policy
        queued = NativePrivacyPolicyGate.compliantQueue(
            Self.eventsWithinPolicyRetention(queued, policy: policy),
            policy: policy
        )
        queueStore.save(queued)
    }

    func enqueue(
        _ event: NativeCollectedEvent,
        policy proposedPolicy: PrivacyPolicyV1,
        generation proposedGeneration: Int
    ) async -> ServiceHealth {
        guard let policy,
              policyGeneration == proposedGeneration,
              policy == proposedPolicy,
              let event = NativePrivacyPolicyGate.apply(event, policy: policy) else {
            return ServiceHealth(
                status: "ready",
                message: "Native metadata was excluded by the current privacy policy.",
                updatedAt: ISO8601DateFormatter().string(from: Date())
            )
        }
        queued = Self.eventsWithinPolicyRetention(queued, policy: policy)
        queued.append(event)
        if queued.count > 500 {
            queued.removeFirst(queued.count - 500)
        }
        queueStore.save(queued)

        guard !isFlushing else {
            return ServiceHealth(
                status: "ready",
                message: "Native metadata is queued for the active delivery pass.",
                updatedAt: ISO8601DateFormatter().string(from: Date())
            )
        }
        isFlushing = true
        defer { isFlushing = false }
        do {
            // The daemon contract accepts at most 100 events. Drain in bounded
            // batches and remove only acknowledged IDs so actor re-entrancy
            // cannot discard events appended during an in-flight request.
            while !queued.isEmpty {
                let batch = Array(queued.prefix(100))
                try await client.submit(events: batch)
                let acknowledged = Set(batch.map(\.id))
                queued.removeAll { acknowledged.contains($0.id) }
                queueStore.save(queued)
            }
            return ServiceHealth(
                status: "ready",
                message: "Native metadata collection is active.",
                updatedAt: ISO8601DateFormatter().string(from: Date())
            )
        } catch {
            return ServiceHealth(
                status: "degraded",
                message: "\(queued.count) native events queued while the engine reconnects.",
                updatedAt: ISO8601DateFormatter().string(from: Date())
            )
        }
    }

    private static func eventsWithinPolicyRetention(
        _ events: [NativeCollectedEvent],
        policy: PrivacyPolicyV1?
    ) -> [NativeCollectedEvent] {
        guard let policy else { return [] }
        return NativeEventQueueStore.liveEvents(
            events,
            maximumAge: TimeInterval(min(max(policy.retentionHours, 1), 24) * 60 * 60)
        )
    }
}

/// Persists only events that have already passed the native collector's
/// allowlist and secret reduction. Raw window titles or paths that fail the
/// sanitizer never reach this store.
struct NativeEventQueueStore: Sendable {
    let fileURL: URL
    let maximumAge: TimeInterval
    let maximumCount: Int

    init(fileURL: URL, maximumAge: TimeInterval = 24 * 60 * 60, maximumCount: Int = 500) {
        self.fileURL = fileURL
        self.maximumAge = maximumAge
        self.maximumCount = maximumCount
    }

    static func defaultStore() -> NativeEventQueueStore {
        let environment = ProcessInfo.processInfo.environment
        let baseURL: URL
        if let override = environment["CONTINUUM_DATA_DIR"], !override.isEmpty {
            baseURL = URL(fileURLWithPath: override, isDirectory: true)
        } else {
            baseURL = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Application Support/Continuum", isDirectory: true)
        }
        return NativeEventQueueStore(fileURL: baseURL.appendingPathComponent("native-events.queue.json"))
    }

    static func liveEvents(
        _ events: [NativeCollectedEvent],
        now: Date = Date(),
        maximumAge: TimeInterval = 24 * 60 * 60,
        maximumCount: Int = 500
    ) -> [NativeCollectedEvent] {
        let formatter = ISO8601DateFormatter()
        let cutoff = now.addingTimeInterval(-maximumAge)
        return Array(events.filter { event in
            guard let occurredAt = formatter.date(from: event.occurredAt) else { return false }
            return occurredAt >= cutoff && occurredAt <= now.addingTimeInterval(5 * 60)
        }.suffix(maximumCount))
    }

    func load(now: Date = Date()) -> [NativeCollectedEvent] {
        guard let data = try? Data(contentsOf: fileURL),
              let decoded = try? JSONDecoder().decode([NativeCollectedEvent].self, from: data) else {
            return []
        }
        let live = Self.liveEvents(decoded, now: now, maximumAge: maximumAge, maximumCount: maximumCount)
        if live != decoded { save(live) }
        return live
    }

    func save(_ events: [NativeCollectedEvent]) {
        let retained = Self.liveEvents(events, maximumAge: maximumAge, maximumCount: maximumCount)
        guard let data = try? JSONEncoder().encode(retained) else { return }
        do {
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(),
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            try data.write(to: fileURL, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
        } catch {
            // Collection remains operational in memory. Health is reported by
            // the submitter when the daemon cannot accept the queued events.
        }
    }
}

@MainActor
final class OSCollectorService {
    typealias HealthHandler = @MainActor (ServiceHealth) -> Void
    typealias AccessibilityPermissionProvider = @MainActor (_ shouldPrompt: Bool) -> Bool

    private let workspace = NSWorkspace.shared
    private let deviceID: String
    private let accessibilityPermissionProvider: AccessibilityPermissionProvider
    private var submitter: NativeEventSubmitter
    private var policy: PrivacyPolicyV1?
    private var policyGeneration = 0
    private var healthHandler: HealthHandler?
    private var workspaceObservers: [NSObjectProtocol] = []
    private var windowTimer: Timer?
    private var accessibilityMonitorTimer: Timer?
    private var folderStream: FSEventStreamRef?
    private var lastWindowDedupeKey: String?
    private var windowAuthorizationState: WindowCaptureAuthorizationState = .disabled
    private var accessibilityPromptRequested = false
    private var deliveryHealth = ServiceHealth(status: "ready")
    private var folderFailureMessage: String?
    private var isRunning = false

    private static func sharedDeviceID() -> String {
        let environment = ProcessInfo.processInfo.environment
        if let override = environment["CONTINUUM_DEVICE_ID"], (8...128).contains(override.count) {
            return override
        }
        let path = environment["CONTINUUM_DEVICE_ID_FILE"]
            ?? FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".continuum/device-id").path
        let url = URL(fileURLWithPath: path)
        if let value = try? String(contentsOf: url, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
           (8...128).contains(value.count) {
            return value
        }
        let generated = UUID().uuidString.lowercased()
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
            try Data("\(generated)\n".utf8).write(to: url, options: .atomic)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        } catch {
            // The engine reports collector identity health if the shared file
            // cannot be created; collection can still remain local meanwhile.
        }
        return generated
    }

    init(
        configuration: EngineConfiguration = .load(),
        initialPolicy: PrivacyPolicyV1? = nil,
        accessibilityPermissionProvider: @escaping AccessibilityPermissionProvider = OSCollectorService.systemAccessibilityPermission
    ) {
        deviceID = Self.sharedDeviceID()
        self.accessibilityPermissionProvider = accessibilityPermissionProvider
        policy = initialPolicy
        policyGeneration = initialPolicy == nil ? 0 : 1
        submitter = NativeEventSubmitter(
            configuration: configuration,
            policy: initialPolicy,
            policyGeneration: policyGeneration
        )
    }

    deinit {
        windowTimer?.invalidate()
        accessibilityMonitorTimer?.invalidate()
        if let stream = folderStream {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
        }
    }

    func start(policy: PrivacyPolicyV1?, healthHandler: @escaping HealthHandler) {
        self.healthHandler = healthHandler
        install(policy: policy)
        guard policy != nil else {
            stopCollectionSources()
            healthHandler(
                ServiceHealth(
                    status: "degraded",
                    message: "Native collection is disabled until a validated privacy policy is available."
                )
            )
            return
        }
        if !isRunning { isRunning = true }
        configureWorkspaceObservers()
        configureWindowTimer()
        configureFolderStream()
        publishCollectorHealth()
    }

    func stop() {
        guard isRunning else { return }
        stopCollectionSources()
        healthHandler?(ServiceHealth(status: "paused", message: "Native collection is paused."))
    }

    private func stopCollectionSources() {
        isRunning = false
        for observer in workspaceObservers {
            workspace.notificationCenter.removeObserver(observer)
        }
        workspaceObservers.removeAll()
        windowTimer?.invalidate()
        windowTimer = nil
        accessibilityMonitorTimer?.invalidate()
        accessibilityMonitorTimer = nil
        windowAuthorizationState = .disabled
        stopFolderStream()
    }

    func reconfigure(policy: PrivacyPolicyV1?) {
        install(policy: policy)
        guard policy != nil else {
            stopCollectionSources()
            healthHandler?(
                ServiceHealth(
                    status: "degraded",
                    message: "Native collection is disabled until a validated privacy policy is available."
                )
            )
            return
        }
        if !isRunning { isRunning = true }
        configureWorkspaceObservers()
        configureWindowTimer()
        configureFolderStream()
        publishCollectorHealth()
    }

    func reconfigureEngine(_ configuration: EngineConfiguration) {
        Task { await submitter.reconfigure(configuration) }
    }

    func recheckPermissions() {
        refreshAccessibilityPermission()
    }

    private static func systemAccessibilityPermission(shouldPrompt: Bool) -> Bool {
        guard shouldPrompt else { return AXIsProcessTrusted() }
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return AXIsProcessTrustedWithOptions(options)
    }

    private func install(policy: PrivacyPolicyV1?) {
        self.policy = policy
        policyGeneration += 1
        let generation = policyGeneration
        Task { await submitter.updatePolicy(policy, generation: generation) }
    }

    private func configureWorkspaceObservers() {
        let center = workspace.notificationCenter
        for observer in workspaceObservers {
            center.removeObserver(observer)
        }
        workspaceObservers.removeAll()
        guard isRunning,
              let policy,
              policy.sourceEnabled["os_app"] == true,
              policy.personalMetadataEnabled else {
            return
        }
        let registrations: [(Notification.Name, String)] = [
            (NSWorkspace.didActivateApplicationNotification, "app_activated"),
            (NSWorkspace.didLaunchApplicationNotification, "app_launched"),
            (NSWorkspace.didTerminateApplicationNotification, "app_terminated")
        ]

        for (name, eventType) in registrations {
            let observer = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                Task { @MainActor in
                    self?.handleWorkspaceNotification(note, eventType: eventType)
                }
            }
            workspaceObservers.append(observer)
        }
    }

    private func handleWorkspaceNotification(_ notification: Notification, eventType: String) {
        guard isRunning,
              let policy,
              policy.sourceEnabled["os_app"] == true,
              policy.personalMetadataEnabled,
              let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
              application.bundleIdentifier != "dev.continuum.app" else {
            return
        }

        let name = sanitizeMetadata(application.localizedName ?? "Application", maximumLength: 80)
            ?? "Application"
        var attributes: [String: String] = [:]
        if let bundleID = sanitizeIdentifier(application.bundleIdentifier) {
            attributes["bundleId"] = bundleID
        }
        attributes["appName"] = name
        attributes["action"] = eventType
        let bucket = Int(Date().timeIntervalSince1970 / 10)
        emit(
            NativeCollectedEvent(
                deviceID: deviceID,
                eventType: eventType,
                title: "\(name) \(eventType.replacingOccurrences(of: "_", with: " "))",
                attributes: attributes,
                privacyClassification: "personal",
                relevance: eventType == "app_activated" ? "uncertain" : "keep",
                confidence: 0.7,
                dedupeKey: "os:\(eventType):\(application.bundleIdentifier ?? name):\(bucket)",
                policyVersion: policy.version
            )
        )
    }

    private func configureWindowTimer() {
        windowTimer?.invalidate()
        windowTimer = nil
        accessibilityMonitorTimer?.invalidate()
        accessibilityMonitorTimer = nil
        lastWindowDedupeKey = nil
        guard isRunning,
              let policy,
              policy.captureWindowTitles,
              policy.sourceEnabled["os_window"] == true,
              policy.confidentialLocalCollectionEnabled else {
            windowAuthorizationState = .disabled
            accessibilityPromptRequested = false
            return
        }

        let shouldPrompt = !accessibilityPromptRequested
        if shouldPrompt { accessibilityPromptRequested = true }
        windowAuthorizationState = .resolve(
            policy: policy,
            isTrusted: accessibilityPermissionProvider(shouldPrompt)
        )
        if windowAuthorizationState == .ready {
            startWindowCaptureTimer()
        }
        startAccessibilityMonitorTimer()
    }

    private func startWindowCaptureTimer() {
        guard windowTimer == nil else { return }
        let timer = Timer(timeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.captureFocusedWindow() }
        }
        windowTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func startAccessibilityMonitorTimer() {
        guard accessibilityMonitorTimer == nil else { return }
        let timer = Timer(timeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshAccessibilityPermission() }
        }
        accessibilityMonitorTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func refreshAccessibilityPermission() {
        guard isRunning else { return }
        let next = WindowCaptureAuthorizationState.resolve(
            policy: policy,
            isTrusted: accessibilityPermissionProvider(false)
        )
        guard next != windowAuthorizationState else { return }
        windowAuthorizationState = next
        switch next {
        case .ready:
            startWindowCaptureTimer()
        case .disabled, .permissionRequired:
            windowTimer?.invalidate()
            windowTimer = nil
            lastWindowDedupeKey = nil
        }
        publishCollectorHealth()
    }

    private func captureFocusedWindow() {
        guard isRunning,
              let policy,
              policy.captureWindowTitles,
              policy.sourceEnabled["os_window"] == true,
              policy.confidentialLocalCollectionEnabled,
              let application = workspace.frontmostApplication,
              application.bundleIdentifier != "dev.continuum.app" else {
            return
        }

        let axApplication = AXUIElementCreateApplication(application.processIdentifier)
        var windowValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            axApplication,
            kAXFocusedWindowAttribute as CFString,
            &windowValue
        ) == .success,
        let windowValue else {
            return
        }

        let window = unsafeBitCast(windowValue, to: AXUIElement.self)
        var titleValue: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            window,
            kAXTitleAttribute as CFString,
            &titleValue
        ) == .success,
        let rawTitle = titleValue as? String,
        !rawTitle.isEmpty else {
            return
        }

        guard let title = sanitizePotentiallySensitiveMetadata(rawTitle, maximumLength: 160) else {
            emitRejectedMetadataAggregate(kind: "window_title")
            return
        }

        let bundleID = sanitizeIdentifier(application.bundleIdentifier) ?? "unknown"
        let dedupeKey = "os:window:\(bundleID):\(title.lowercased())"
        guard dedupeKey != lastWindowDedupeKey else { return }
        lastWindowDedupeKey = dedupeKey

        emit(
            NativeCollectedEvent(
                deviceID: deviceID,
                eventType: "window_focused",
                title: title,
                attributes: [
                    "bundleId": bundleID,
                    "appName": sanitizeMetadata(application.localizedName ?? "Application", maximumLength: 80) ?? "Application",
                    "windowTitle": title
                ],
                privacyClassification: "confidential",
                relevance: "uncertain",
                confidence: 0.65,
                dedupeKey: dedupeKey,
                policyVersion: policy.version,
                syncEligibility: "local_only"
            )
        )
    }

    private func configureFolderStream() {
        stopFolderStream()
        folderFailureMessage = nil
        guard isRunning,
              let policy,
              policy.sourceEnabled["os_folder"] == true,
              policy.personalMetadataEnabled,
              !policy.approvedFolders.isEmpty else {
            return
        }

        let paths = policy.approvedFolders.map(\.path) as CFArray
        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil,
            release: nil,
            copyDescription: nil
        )
        let flags = FSEventStreamCreateFlags(
            kFSEventStreamCreateFlagUseCFTypes
                | kFSEventStreamCreateFlagFileEvents
                | kFSEventStreamCreateFlagNoDefer
        )
        guard let stream = FSEventStreamCreate(
            nil,
            continuumFolderEventCallback,
            &context,
            paths,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            1.0,
            flags
        ) else {
            folderFailureMessage = "Approved-folder monitoring could not start."
            return
        }

        folderStream = stream
        FSEventStreamSetDispatchQueue(stream, DispatchQueue.global(qos: .utility))
        if !FSEventStreamStart(stream) {
            stopFolderStream()
            folderFailureMessage = "Approved-folder monitoring could not start."
        }
    }

    private func stopFolderStream() {
        guard let stream = folderStream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
        folderStream = nil
    }

    fileprivate func handleFolderEvents(paths: [String], flags: [FSEventStreamEventFlags]) {
        guard isRunning,
              let policy,
              policy.sourceEnabled["os_folder"] == true,
              policy.personalMetadataEnabled else {
            return
        }
        for (index, changedPath) in paths.enumerated() {
            guard let folder = policy.approvedFolders
                .filter({ changedPath == $0.path || changedPath.hasPrefix($0.path + "/") })
                .max(by: { $0.path.count < $1.path.count }) else {
                continue
            }

            let rawRelative = changedPath == folder.path
                ? "."
                : String(changedPath.dropFirst(folder.path.count + 1))
            guard !policy.ignoredPaths.contains(where: { matchesGlob(rawRelative, pattern: $0) }) else {
                continue
            }

            let relative = sanitizePotentiallySensitiveMetadata(rawRelative, maximumLength: 240)
            guard relative != nil || !policy.includeRelativePaths else {
                emitRejectedMetadataAggregate(kind: "folder_path")
                continue
            }

            let flag = index < flags.count ? flags[index] : 0
            let change = folderChangeName(flag)
            var attributes = ["changeKind": change, "approvedRootId": folder.id]
            if policy.includeRelativePaths, let relative {
                attributes["relativePath"] = relative
            }
            let title = policy.includeRelativePaths && relative != nil
                ? "\(change.capitalized): \(relative!)"
                : "\(change.capitalized) in \(folder.projectName)"
            let bucket = Int(Date().timeIntervalSince1970 / 10)
            emit(
                NativeCollectedEvent(
                    deviceID: deviceID,
                    eventType: "folder_changed",
                    projectID: folder.projectID,
                    title: title,
                    attributes: attributes,
                    privacyClassification: "personal",
                    relevance: "keep",
                    confidence: 0.82,
                    dedupeKey: "os:folder:\(folder.id):\(relative ?? change):\(bucket)",
                    policyVersion: policy.version
                )
            )
        }
    }

    private func emitRejectedMetadataAggregate(kind: String) {
        guard let policy else { return }
        let bucket = Int(Date().timeIntervalSince1970 / 60)
        emit(
            NativeCollectedEvent(
                deviceID: deviceID,
                eventType: "privacy_rejection",
                title: "Sensitive \(kind.replacingOccurrences(of: "_", with: " ")) metadata rejected",
                attributes: ["rule": "native_secret_guard", "kind": kind],
                privacyClassification: "secret",
                relevance: "keep",
                confidence: 1,
                dedupeKey: "os:privacy:\(kind):\(bucket)",
                policyVersion: policy.version,
                syncEligibility: "local_only"
            )
        )
    }

    private func emit(_ event: NativeCollectedEvent) {
        guard let policy,
              let event = NativePrivacyPolicyGate.apply(event, policy: policy) else {
            return
        }
        let generation = policyGeneration
        Task {
            let health = await submitter.enqueue(event, policy: policy, generation: generation)
            await MainActor.run {
                deliveryHealth = health
                publishCollectorHealth()
            }
        }
    }

    private func publishCollectorHealth() {
        guard let healthHandler else { return }
        healthHandler(
            NativeCollectorHealthResolver.resolve(
                isRunning: isRunning,
                hasValidatedPolicy: policy != nil,
                windowAuthorization: windowAuthorizationState,
                delivery: deliveryHealth,
                folderFailureMessage: folderFailureMessage,
                updatedAt: ISO8601DateFormatter().string(from: Date())
            )
        )
    }

    private func folderChangeName(_ flags: FSEventStreamEventFlags) -> String {
        if flags & FSEventStreamEventFlags(kFSEventStreamEventFlagItemCreated) != 0 { return "created" }
        if flags & FSEventStreamEventFlags(kFSEventStreamEventFlagItemRemoved) != 0 { return "removed" }
        if flags & FSEventStreamEventFlags(kFSEventStreamEventFlagItemRenamed) != 0 { return "renamed" }
        if flags & FSEventStreamEventFlags(kFSEventStreamEventFlagItemModified) != 0 { return "modified" }
        return "changed"
    }
}

private let continuumFolderEventCallback: FSEventStreamCallback = {
    _, callbackInfo, eventCount, eventPaths, eventFlags, _ in
    guard let callbackInfo else { return }
    let collector = Unmanaged<OSCollectorService>.fromOpaque(callbackInfo).takeUnretainedValue()
    let pathArray = unsafeBitCast(eventPaths, to: NSArray.self) as? [String] ?? []
    let flags = Array(UnsafeBufferPointer(start: eventFlags, count: eventCount))
    Task { @MainActor in
        collector.handleFolderEvents(paths: pathArray, flags: flags)
    }
}

private func sanitizeMetadata(_ value: String, maximumLength: Int) -> String? {
    let normalized = value
        .replacingOccurrences(of: "[\\p{C}]", with: " ", options: .regularExpression)
        .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else { return nil }
    return String(normalized.prefix(maximumLength))
}

private func sanitizePotentiallySensitiveMetadata(_ value: String, maximumLength: Int) -> String? {
    guard let sanitized = sanitizeMetadata(value, maximumLength: maximumLength) else { return nil }
    let secretPatterns = [
        #"(?i)(api[_-]?key|access[_-]?token|client[_-]?secret|password|passwd)\s*[:=]"#,
        #"(?i)bearer\s+[a-z0-9._~+/=-]{12,}"#,
        #"(?i)-----BEGIN [A-Z ]*PRIVATE KEY-----"#,
        #"\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b"#,
        #"(?i)(?:^|\s)/(?:Users|home|private|etc|var|tmp|opt|Applications|System|Library|Volumes)/\S+"#,
        #"(?i)(?:^|\s)[A-Z]:\\\S+"#,
        #"(?i)https?://[^\s?#]+[?#]\S*"#
    ]
    guard !secretPatterns.contains(where: { sanitized.range(of: $0, options: .regularExpression) != nil }) else {
        return nil
    }
    return sanitized
}

private func sanitizeIdentifier(_ value: String?) -> String? {
    guard let value,
          value.range(of: #"^[A-Za-z0-9.-]{1,160}$"#, options: .regularExpression) != nil else {
        return nil
    }
    return value
}

private func matchesGlob(_ value: String, pattern: String) -> Bool {
    var index = pattern.startIndex
    var expression = "^"
    if pattern.hasPrefix("**/") {
        expression += "(?:.*/)?"
        index = pattern.index(index, offsetBy: 3)
    }
    while index < pattern.endIndex {
        let character = pattern[index]
        if character == "*" {
            let next = pattern.index(after: index)
            if next < pattern.endIndex, pattern[next] == "*" {
                expression += ".*"
                index = pattern.index(after: next)
            } else {
                expression += "[^/]*"
                index = next
            }
        } else if character == "?" {
            expression += "[^/]"
            index = pattern.index(after: index)
        } else {
            expression += NSRegularExpression.escapedPattern(for: String(character))
            index = pattern.index(after: index)
        }
    }
    expression += "$"
    return value.range(of: expression, options: .regularExpression) != nil
}
