import Foundation

enum PrivacyPolicyCache {
    private static let key = "continuum.privacyPolicy.v1"
    private static let foldersKey = "continuum.approvedFolders.v1"

    static func load(defaults: UserDefaults = .standard) -> PrivacyPolicyV1? {
        guard let data = defaults.data(forKey: key),
              var policy = try? JSONDecoder().decode(PrivacyPolicyV1.self, from: data) else {
            return nil
        }
        policy.approvedFolders = loadApprovedFolders(defaults: defaults)
        return policy
    }

    static func loadApprovedFolders(defaults: UserDefaults = .standard) -> [ApprovedFolder] {
        guard let folderData = defaults.data(forKey: foldersKey),
              let folders = try? JSONDecoder().decode([ApprovedFolder].self, from: folderData) else {
            return []
        }
        return folders
    }

    static func save(_ policy: PrivacyPolicyV1, defaults: UserDefaults = .standard) {
        if let data = try? JSONEncoder().encode(policy) {
            defaults.set(data, forKey: key)
        }
        saveApprovedFolders(policy.approvedFolders, defaults: defaults)
    }

    static func saveApprovedFolders(
        _ approvedFolders: [ApprovedFolder],
        defaults: UserDefaults = .standard
    ) {
        if let folders = try? JSONEncoder().encode(approvedFolders) {
            defaults.set(folders, forKey: foldersKey)
        }
    }

    static func clearPolicy(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: key)
    }
}
