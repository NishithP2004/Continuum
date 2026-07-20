import CryptoKit
import Foundation
import Security

protocol RefreshCredentialStore: Sendable {
    func read(account: String) throws -> String?
    func write(_ credential: String, account: String) throws
    func delete(account: String) throws
}

struct KeychainRefreshCredentialStore: RefreshCredentialStore {
    private let service = "dev.continuum.app.auth0.refresh-token"

    func read(account: String) throws -> String? {
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8),
              !value.isEmpty else {
            throw RemoteAuthenticationError.keychainFailure(status)
        }
        return value
    }

    func write(_ credential: String, account: String) throws {
        guard let data = credential.data(using: .utf8), !data.isEmpty else {
            throw RemoteAuthenticationError.keychainFailure(errSecParam)
        }
        let query = baseQuery(account: account)
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else {
            throw RemoteAuthenticationError.keychainFailure(status)
        }

        var addition = query
        addition[kSecValueData as String] = data
        addition[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        addition[kSecAttrSynchronizable as String] = kCFBooleanFalse
        let addStatus = SecItemAdd(addition as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw RemoteAuthenticationError.keychainFailure(addStatus)
        }
    }

    func delete(account: String) throws {
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw RemoteAuthenticationError.keychainFailure(status)
        }
    }

    private func baseQuery(account: String) -> [String: Any] {
        let digest = SHA256.hash(data: Data(account.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: digest,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any
        ]
    }
}
