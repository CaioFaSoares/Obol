import Foundation
import Security

/// Failures returned by ``KeychainStore``.
///
/// `errSecItemNotFound` is never represented here: absence is reported as a
/// `nil` read or a `false` removal. Everything else is surfaced so callers
/// never mistake a locked, corrupted, or unauthorized keychain for a missing
/// credential.
public enum KeychainError: Error, Equatable, Sendable {
    /// Any other OSStatus, preserved verbatim for diagnosis.
    case unexpectedStatus(OSStatus)
    /// The keychain is locked or requires user interaction that is not
    /// available (for example before first unlock after a reboot).
    case interactionNotAllowed
    /// No keychain is available on this device right now.
    case unavailable
    /// The process lacks the entitlement or access control to touch the item.
    case accessDenied
    /// The item exists but cannot be decoded as the expected value.
    case corruptedItem
    /// A key or value could not be encoded as UTF-8.
    case invalidEncoding
    /// The account key is empty and would address no item.
    case invalidAccount
}

extension KeychainError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .unexpectedStatus(let status):
            return "The keychain operation failed (OSStatus \(status))."
        case .interactionNotAllowed:
            return "The keychain is locked; unlock the device and try again."
        case .unavailable:
            return "The keychain is not available on this device."
        case .accessDenied:
            return "The keychain refused access to the stored credential."
        case .corruptedItem:
            return "The stored credential is corrupted."
        case .invalidEncoding:
            return "The credential could not be encoded."
        case .invalidAccount:
            return "The keychain account key is empty."
        }
    }
}

/// Keychain-backed storage for the remote session credential and the durable
/// installation identifier (D009 D9, D016 D14).
///
/// Scope rules:
/// - The session payload is addressed by ``ServerOrigin/storageKey``. A token
///   stored for one deployment is never returned for another origin.
/// - The station identifier is installation-wide and is stored under a
///   separate account. Logout never removes it, and no sync persistence is
///   duplicated here.
/// - The service name is injectable so tests can use an isolated keychain
///   namespace.
///
/// Accessibility: iOS (and other data-protection platforms) use
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. macOS has no
/// per-item data-protection accessibility on the login keychain, so the item
/// relies on the login keychain's own protection; the same service/account
/// isolation still applies.
public struct KeychainStore: Sendable {
    public static let defaultService = "copland.obol.session"
    public static let stationAccount = "station.v1"

    public let service: String

    public init(service: String = KeychainStore.defaultService) {
        self.service = service
    }

    /// Keychain account for the session payload of one deployment.
    public static func sessionAccount(for origin: ServerOrigin) -> String {
        "session.v1.\(origin.storageKey)"
    }

    // MARK: - Session payload scoped to a deployment

    /// Reads the opaque session payload for `origin`, or `nil` when absent.
    public func readSessionSecret(for origin: ServerOrigin) throws -> Data? {
        try readData(account: Self.sessionAccount(for: origin))
    }

    /// Inserts or replaces the session payload for `origin`.
    public func writeSessionSecret(_ data: Data, for origin: ServerOrigin) throws {
        try writeData(data, account: Self.sessionAccount(for: origin))
    }

    /// Removes only the session payload for `origin`. Returns `true` when an
    /// item was deleted and `false` when none existed.
    public func removeSessionSecret(for origin: ServerOrigin) throws -> Bool {
        try remove(account: Self.sessionAccount(for: origin))
    }

    // MARK: - Durable installation station identifier

    /// Returns the existing station identifier, or `nil` when none is stored.
    ///
    /// A stored value that is not a UUID is corrupt, not absent: it throws
    /// ``KeychainError/corruptedItem`` so callers never replace it with a new
    /// identity.
    public func stationIdentifierIfPresent() throws -> String? {
        guard let value = try readString(account: Self.stationAccount) else {
            return nil
        }
        guard !value.isEmpty, UUID(uuidString: value) != nil else {
            throw KeychainError.corruptedItem
        }
        return value
    }

    /// Returns the durable station identifier, creating a lowercase UUID on
    /// first use. Creation is a single create-only `SecItemAdd`: a concurrent
    /// first writer's persisted value wins, and any missing or corrupt winner
    /// is an explicit error rather than a second generated identity. The
    /// identifier is never derived from a session, token, email, or device
    /// name, and it survives logout and reinstall-free token rotation.
    public func stationIdentifier(createIfMissing: Bool = true) throws -> String? {
        if let existing = try stationIdentifierIfPresent() {
            return existing
        }
        guard createIfMissing else {
            return nil
        }
        return try createStationIdentifier(UUID().uuidString.lowercased())
    }

    /// Creates the station item with `SecItemAdd` create-only semantics: the
    /// item is inserted only when absent, and on `errSecDuplicateItem` the
    /// already persisted value wins. The candidate is never written over a
    /// live item, and a winner that cannot be read fails explicitly.
    private func createStationIdentifier(_ candidate: String) throws -> String {
        guard let data = candidate.data(using: .utf8) else {
            throw KeychainError.invalidEncoding
        }
        var newItem = baseQuery(account: Self.stationAccount)
        newItem[kSecValueData as String] = data
        newItem[kSecAttrSynchronizable as String] = kCFBooleanFalse as Any
        #if !os(macOS)
        newItem[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        #endif
        let addStatus = SecItemAdd(newItem as CFDictionary, nil)
        if addStatus == errSecSuccess {
            return candidate
        }
        guard addStatus == errSecDuplicateItem else {
            throw Self.from(status: addStatus)
        }
        // Another process created the item first; its identifier is the
        // durable one. If it cannot be read, fail instead of overwriting it.
        guard let existing = try stationIdentifierIfPresent() else {
            throw KeychainError.unexpectedStatus(errSecDuplicateItem)
        }
        return existing
    }

    /// Removes the station identifier. This is a maintenance operation; logout
    /// must not call it.
    public func removeStationIdentifier() throws -> Bool {
        try remove(account: Self.stationAccount)
    }

    // MARK: - Generic item primitives

    /// Reads raw data for `account`, or `nil` when absent.
    public func readData(account: String) throws -> Data? {
        guard !account.isEmpty else {
            throw KeychainError.invalidAccount
        }
        var query = baseQuery(account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess {
            guard let data = result as? Data else {
                throw KeychainError.corruptedItem
            }
            return data
        }
        if status == errSecItemNotFound {
            return nil
        }
        throw Self.from(status: status)
    }

    /// Inserts or updates raw data for `account`. The item is created with the
    /// platform accessibility attribute; updates keep the existing attributes.
    public func writeData(_ data: Data, account: String) throws {
        guard !account.isEmpty else {
            throw KeychainError.invalidAccount
        }
        let query = baseQuery(account: account)
        let attributes: [String: Any] = [kSecValueData as String: data]
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess {
            return
        }
        guard updateStatus == errSecItemNotFound else {
            throw Self.from(status: updateStatus)
        }

        var newItem = query
        newItem[kSecValueData as String] = data
        newItem[kSecAttrSynchronizable as String] = kCFBooleanFalse as Any
        #if !os(macOS)
        newItem[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        #endif
        let addStatus = SecItemAdd(newItem as CFDictionary, nil)
        if addStatus == errSecSuccess {
            return
        }
        if addStatus == errSecDuplicateItem {
            // A concurrent writer created the item between update and add.
            let retryStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
            guard retryStatus == errSecSuccess else {
                throw Self.from(status: retryStatus)
            }
            return
        }
        throw Self.from(status: addStatus)
    }

    /// Removes the item for `account`. Returns `true` only when an item was
    /// actually deleted; absence returns `false` and never throws.
    public func remove(account: String) throws -> Bool {
        guard !account.isEmpty else {
            throw KeychainError.invalidAccount
        }
        let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
        if status == errSecSuccess {
            return true
        }
        if status == errSecItemNotFound {
            return false
        }
        throw Self.from(status: status)
    }

    /// Reads a UTF-8 string for `account`, or `nil` when absent.
    public func readString(account: String) throws -> String? {
        guard let data = try readData(account: account) else {
            return nil
        }
        guard let value = String(data: data, encoding: .utf8) else {
            throw KeychainError.corruptedItem
        }
        return value
    }

    /// Writes a UTF-8 string for `account`.
    public func writeString(_ value: String, account: String) throws {
        guard let data = value.data(using: .utf8) else {
            throw KeychainError.invalidEncoding
        }
        try writeData(data, account: account)
    }

    // MARK: - Internals

    private func baseQuery(account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    static func from(status: OSStatus) -> KeychainError {
        if status == errSecInteractionNotAllowed {
            return .interactionNotAllowed
        }
        if status == errSecNotAvailable {
            return .unavailable
        }
        if status == errSecMissingEntitlement {
            return .accessDenied
        }
        if status == errSecAuthFailed || status == errSecDecode {
            return .corruptedItem
        }
        return .unexpectedStatus(status)
    }
}
