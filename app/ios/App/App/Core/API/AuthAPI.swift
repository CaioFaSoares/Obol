import Foundation

// D009 D3 wire models. Field names and shapes match
// `server/src/infrastructure/plugins/remoteAuth.ts` exactly.

public struct SetupStatusResponse: Decodable, Equatable, Sendable {
    public let setupRequired: Bool
    public let serverName: String
    public let smtpConfigured: Bool

    public init(setupRequired: Bool, serverName: String, smtpConfigured: Bool) {
        self.setupRequired = setupRequired
        self.serverName = serverName
        self.smtpConfigured = smtpConfigured
    }
}

public struct SetupInitRequest: Encodable, Equatable, Sendable {
    public let setupToken: String?
    public let email: String
    public let password: String

    public init(setupToken: String?, email: String, password: String) {
        self.setupToken = setupToken
        self.email = email
        self.password = password
    }
}

public struct SetupInitResponse: Decodable, Equatable, Sendable {
    public let serverName: String

    public init(serverName: String) {
        self.serverName = serverName
    }
}

public struct LoginRequest: Encodable, Equatable, Sendable {
    public enum Transport: String, Encodable, Equatable, Sendable {
        case cookie
        case bearer
    }

    public let email: String
    public let password: String
    public let deviceLabel: String?
    public let transport: Transport?

    public init(
        email: String,
        password: String,
        deviceLabel: String? = nil,
        transport: Transport? = nil
    ) {
        self.email = email
        self.password = password
        self.deviceLabel = deviceLabel
        self.transport = transport
    }
}

public struct LoginResponse: Decodable, Equatable, Sendable {
    /// Present only for the bearer transport.
    public let token: String?
    public let expiresAt: String
    public let serverName: String

    public init(token: String?, expiresAt: String, serverName: String) {
        self.token = token
        self.expiresAt = expiresAt
        self.serverName = serverName
    }
}

public struct SessionRenewResponse: Decodable, Equatable, Sendable {
    /// Present only for the bearer transport.
    public let token: String?
    public let expiresAt: String

    public init(token: String?, expiresAt: String) {
        self.token = token
        self.expiresAt = expiresAt
    }
}

public struct AuthSessionEntry: Decodable, Equatable, Sendable, Identifiable {
    public let id: String
    /// PocketBase date string as returned by the BFF.
    public let created: String
    public let deviceLabel: String

    public init(id: String, created: String, deviceLabel: String) {
        self.id = id
        self.created = created
        self.deviceLabel = deviceLabel
    }

    /// Parsed creation date, or `nil` when the server value is not a date.
    public var createdAt: Date? {
        BFFDateParser.parse(created)
    }
}

public struct SessionListResponse: Decodable, Equatable, Sendable {
    public let sessions: [AuthSessionEntry]

    public init(sessions: [AuthSessionEntry]) {
        self.sessions = sessions
    }
}

public struct SessionRevokedResponse: Decodable, Equatable, Sendable {
    public let success: Bool

    public init(success: Bool) {
        self.success = success
    }
}

public struct PasswordResetRequest: Encodable, Equatable, Sendable {
    public let email: String

    public init(email: String) {
        self.email = email
    }
}

public struct PasswordResetResponse: Decodable, Equatable, Sendable {
    public let message: String

    public init(message: String) {
        self.message = message
    }
}

public struct PasswordResetConfirmRequest: Encodable, Equatable, Sendable {
    public let token: String
    public let password: String

    public init(token: String, password: String) {
        self.token = token
        self.password = password
    }
}

/// A live remote session, safe to pass across app layers.
///
/// The value is intentionally not `Codable`: persistence belongs to
/// ``KeychainStore``, so a token can never be written to a plist, JSON file, or
/// database by accident. Its textual descriptions omit the token.
public struct RemoteSession: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    public let origin: ServerOrigin
    public let token: String
    public let expiresAt: Date
    public let serverName: String
    public let deviceLabel: String?

    public init(
        origin: ServerOrigin,
        token: String,
        expiresAt: Date,
        serverName: String,
        deviceLabel: String? = nil
    ) {
        self.origin = origin
        self.token = token
        self.expiresAt = expiresAt
        self.serverName = serverName
        self.deviceLabel = deviceLabel
    }

    /// `true` while the token is still inside its server-issued window.
    public func isValid(at date: Date = Date()) -> Bool {
        expiresAt > date
    }

    public func isExpired(at date: Date = Date()) -> Bool {
        !isValid(at: date)
    }

    public var description: String {
        "RemoteSession(origin: \(origin.storageKey), expiresAt: \(expiresAt.timeIntervalSince1970), serverName: \(serverName))"
    }

    public var debugDescription: String {
        description
    }
}

/// Result of an explicit logout.
///
/// `remoteRevoked` is `true` when the BFF confirmed deletion (or answered that
/// the session is already unauthenticated). `localCredentialRemoved` reports
/// whether a Keychain item was actually deleted.
public struct LogoutResult: Equatable, Sendable {
    public let remoteRevoked: Bool
    public let localCredentialRemoved: Bool

    public init(remoteRevoked: Bool, localCredentialRemoved: Bool) {
        self.remoteRevoked = remoteRevoked
        self.localCredentialRemoved = localCredentialRemoved
    }
}

/// Local session-lifecycle failures that are not server or keychain errors.
public enum AuthSessionError: Error, Equatable, Sendable {
    /// The server answered a bearer login or renewal without a token.
    case missingBearerToken
    /// `expiresAt` was not a parseable timestamp.
    case invalidExpiration
    /// No credential is stored for the client's origin.
    case missingStoredCredential(origin: String)
    /// The stored Keychain payload is not a valid credential record.
    case corruptedStoredCredential
    /// The credential record could not be serialized before storing.
    case credentialEncodingFailed
    /// The session belongs to a different deployment than this client.
    case originMismatch
}

extension AuthSessionError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .missingBearerToken:
            return "The server did not return a session token."
        case .invalidExpiration:
            return "The server returned an invalid session expiry."
        case .missingStoredCredential(let origin):
            return "No stored session exists for \(origin)."
        case .corruptedStoredCredential:
            return "The stored session credential is corrupted."
        case .credentialEncodingFailed:
            return "The session credential could not be encoded for storage."
        case .originMismatch:
            return "The session belongs to a different server deployment."
        }
    }
}

/// Authentication and session lifecycle client for one Obol deployment
/// (D009 D3, D9, D14).
///
/// Every method uses ``BFFClient``; the bearer token travels only in the
/// `Authorization` header. The network methods are stateless. The persisted
/// methods additionally store the session payload in ``KeychainStore`` scoped
/// to this deployment and never store a password.
public struct AuthAPI: Sendable {
    public let client: BFFClient
    public let keychain: KeychainStore

    public init(client: BFFClient, keychain: KeychainStore = KeychainStore()) {
        self.client = client
        self.keychain = keychain
    }

    // MARK: - Setup (public)

    /// `GET /api/setup/status`
    public func setupStatus() async throws -> SetupStatusResponse {
        try await client.get("/api/setup/status")
    }

    /// `POST /api/setup/init`
    ///
    /// The setup token comes from the deployment operator. A missing or expired
    /// token surfaces as `INVALID_SETUP_TOKEN`; an already-initialized server
    /// surfaces as `FORBIDDEN`.
    public func initializeOwner(
        setupToken: String?,
        email: String,
        password: String
    ) async throws -> SetupInitResponse {
        let request = SetupInitRequest(setupToken: setupToken, email: email, password: password)
        return try await client.post("/api/setup/init", body: request)
    }

    // MARK: - Login

    /// Bearer login. Returns a session value or throws ``APIError``.
    public func login(
        email: String,
        password: String,
        deviceLabel: String? = nil
    ) async throws -> RemoteSession {
        let request = LoginRequest(
            email: email,
            password: password,
            deviceLabel: deviceLabel,
            transport: .bearer
        )
        let response: LoginResponse = try await client.post("/api/auth/login", body: request)
        guard let token = response.token, !token.isEmpty else {
            throw AuthSessionError.missingBearerToken
        }
        guard let expiresAt = BFFDateParser.parse(response.expiresAt) else {
            throw AuthSessionError.invalidExpiration
        }
        return RemoteSession(
            origin: client.origin,
            token: token,
            expiresAt: expiresAt,
            serverName: response.serverName,
            deviceLabel: deviceLabel
        )
    }

    /// Bearer login followed by a Keychain write scoped to this deployment.
    ///
    /// If the keychain write fails, the error is returned; the freshly minted
    /// server session is left to expire because it was never persisted.
    public func loginPersisted(
        email: String,
        password: String,
        deviceLabel: String? = nil
    ) async throws -> RemoteSession {
        // The installation identifier is durable and independent of any server
        // or account. Create it before the session so a successful pairing
        // always has one; it is never derived from the email.
        _ = try keychain.stationIdentifier()
        let session = try await login(email: email, password: password, deviceLabel: deviceLabel)
        try store(session)
        return session
    }

    // MARK: - Session lifecycle (authenticated)

    /// `POST /api/auth/session/renew`
    ///
    /// Returns the rotated token and expiry. The same session record is
    /// extended server-side; the old token remains valid until its own expiry.
    public func renew(_ session: RemoteSession) async throws -> RemoteSession {
        guard session.origin == client.origin else {
            throw AuthSessionError.originMismatch
        }
        let request = BFFClient.Request(
            method: .post,
            path: "/api/auth/session/renew",
            bearerToken: session.token
        )
        let response: SessionRenewResponse = try await client.perform(request)
        guard let token = response.token, !token.isEmpty else {
            throw AuthSessionError.missingBearerToken
        }
        guard let expiresAt = BFFDateParser.parse(response.expiresAt) else {
            throw AuthSessionError.invalidExpiration
        }
        return RemoteSession(
            origin: session.origin,
            token: token,
            expiresAt: expiresAt,
            serverName: session.serverName,
            deviceLabel: session.deviceLabel
        )
    }

    /// Renews the stored session and replaces the Keychain payload in place.
    public func renewPersisted() async throws -> RemoteSession {
        guard let stored = try restoreStoredSession() else {
            throw AuthSessionError.missingStoredCredential(origin: client.origin.storageKey)
        }
        let renewed = try await renew(stored)
        try store(renewed)
        return renewed
    }

    /// `GET /api/auth/session`
    public func listSessions(token: String) async throws -> [AuthSessionEntry] {
        let response: SessionListResponse = try await client.get(
            "/api/auth/session",
            bearerToken: token
        )
        return response.sessions
    }

    /// Lists sessions for a known deployment session.
    public func listSessions(_ session: RemoteSession) async throws -> [AuthSessionEntry] {
        guard session.origin == client.origin else {
            throw AuthSessionError.originMismatch
        }
        return try await listSessions(token: session.token)
    }

    /// `DELETE /api/auth/session` — revokes the calling session.
    @discardableResult
    public func revokeCurrentSession(token: String) async throws -> Bool {
        let response: SessionRevokedResponse = try await client.delete(
            "/api/auth/session",
            bearerToken: token
        )
        return response.success
    }

    @discardableResult
    public func revokeCurrentSession(_ session: RemoteSession) async throws -> Bool {
        guard session.origin == client.origin else {
            throw AuthSessionError.originMismatch
        }
        return try await revokeCurrentSession(token: session.token)
    }

    /// `DELETE /api/auth/session/{id}` — revokes any session of the owner.
    ///
    /// The identifier is validated before interpolation so it cannot alter the
    /// request path.
    @discardableResult
    public func revokeSession(id: String, token: String) async throws -> Bool {
        guard Self.isValidSessionIdentifier(id) else {
            throw APIError.invalidRequest("the session identifier is not valid")
        }
        let response: SessionRevokedResponse = try await client.delete(
            "/api/auth/session/\(id)",
            bearerToken: token
        )
        return response.success
    }

    /// Revokes a session by identifier using a known deployment session.
    @discardableResult
    public func revokeSession(id: String, using session: RemoteSession) async throws -> Bool {
        guard session.origin == client.origin else {
            throw AuthSessionError.originMismatch
        }
        return try await revokeSession(id: id, token: session.token)
    }

    // MARK: - Persistence

    /// Reads the stored session for this deployment, or `nil` when absent.
    ///
    /// An expired session is still returned; callers decide whether to renew,
    /// continue offline (`D15`), or show authentication. A corrupt payload
    /// throws instead of being treated as absent.
    public func restoreStoredSession() throws -> RemoteSession? {
        guard let data = try keychain.readSessionSecret(for: client.origin) else {
            return nil
        }
        let record: StoredSessionCredential
        do {
            record = try JSONDecoder().decode(StoredSessionCredential.self, from: data)
        } catch {
            throw AuthSessionError.corruptedStoredCredential
        }
        guard !record.token.isEmpty,
              let expiresAt = BFFDateParser.parse(record.expiresAt) else {
            throw AuthSessionError.corruptedStoredCredential
        }
        return RemoteSession(
            origin: client.origin,
            token: record.token,
            expiresAt: expiresAt,
            serverName: record.serverName,
            deviceLabel: record.deviceLabel
        )
    }

    /// Stores a session value for this deployment, replacing any previous
    /// payload for the same origin.
    public func store(_ session: RemoteSession) throws {
        guard session.origin == client.origin else {
            throw AuthSessionError.originMismatch
        }
        let record = StoredSessionCredential(
            token: session.token,
            expiresAt: BFFDateParser.string(from: session.expiresAt),
            serverName: session.serverName,
            deviceLabel: session.deviceLabel
        )
        let data: Data
        do {
            data = try JSONEncoder().encode(record)
        } catch {
            throw AuthSessionError.credentialEncodingFailed
        }
        try keychain.writeSessionSecret(data, for: client.origin)
    }

    // MARK: - Logout

    /// Revokes the session on the server, then removes the local credential.
    ///
    /// `401`/`SESSION_EXPIRED` is treated as already revoked. Any other failure
    /// propagates and leaves the local credential intact so the caller can
    /// retry. The station identifier and local financial data are never
    /// touched.
    @discardableResult
    public func logout(_ session: RemoteSession) async throws -> LogoutResult {
        guard session.origin == client.origin else {
            throw AuthSessionError.originMismatch
        }
        var remoteRevoked = false
        do {
            remoteRevoked = try await revokeCurrentSession(token: session.token)
        } catch let error as APIError where error.isAuthenticationFailure {
            remoteRevoked = true
        }
        let removed = try keychain.removeSessionSecret(for: client.origin)
        return LogoutResult(remoteRevoked: remoteRevoked, localCredentialRemoved: removed)
    }

    /// Logs out the stored session when one exists; otherwise only clears any
    /// residual local credential.
    @discardableResult
    public func logoutPersisted() async throws -> LogoutResult {
        if let session = try restoreStoredSession() {
            return try await logout(session)
        }
        let removed = try keychain.removeSessionSecret(for: client.origin)
        return LogoutResult(remoteRevoked: false, localCredentialRemoved: removed)
    }

    /// Removes only the local credential for this deployment.
    ///
    /// The server-side session is not contacted and may remain valid until its
    /// expiry. Local data and the station identifier are untouched.
    @discardableResult
    public func logoutLocallyOnly() throws -> Bool {
        try keychain.removeSessionSecret(for: client.origin)
    }

    // MARK: - Password lifecycle (public)

    /// `POST /api/auth/request-password-reset`
    ///
    /// The server always returns the same success body, whether or not the
    /// address exists.
    public func requestPasswordReset(email: String) async throws -> PasswordResetResponse {
        let request = PasswordResetRequest(email: email)
        return try await client.post("/api/auth/request-password-reset", body: request)
    }

    /// `POST /api/auth/confirm-password-reset`
    ///
    /// A successful reset revokes every session server-side. The local
    /// credential for this deployment is removed as well; local data and the
    /// station identifier are untouched.
    @discardableResult
    public func confirmPasswordReset(token: String, password: String) async throws -> Bool {
        let request = PasswordResetConfirmRequest(token: token, password: password)
        let response: SessionRevokedResponse = try await client.post(
            "/api/auth/confirm-password-reset",
            body: request
        )
        if response.success {
            _ = try keychain.removeSessionSecret(for: client.origin)
        }
        return response.success
    }

    // MARK: - Helpers

    private static func isValidSessionIdentifier(_ id: String) -> Bool {
        guard !id.isEmpty, id.count <= 64 else {
            return false
        }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
        return id.unicodeScalars.allSatisfy { allowed.contains($0) }
    }
}

/// Keychain payload for one deployment. Contains the bearer token and the
/// expiry needed to restore the session without a network call. It never
/// contains a password.
private struct StoredSessionCredential: Codable {
    let token: String
    let expiresAt: String
    let serverName: String
    let deviceLabel: String?
}

/// Parses BFF RFC3339 timestamps and PocketBase date strings, and serializes
/// expiries for Keychain storage.
enum BFFDateParser {
    static func parse(_ raw: String) -> Date? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else {
            return nil
        }
        if let date = try? Date(value, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) {
            return date
        }
        if let date = try? Date(value, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: false)) {
            return date
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        for format in Self.fallbackFormats {
            formatter.dateFormat = format
            if let date = formatter.date(from: value) {
                return date
            }
        }
        return nil
    }

    static func string(from date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private static let fallbackFormats = [
        "yyyy-MM-dd'T'HH:mm:ss.SSSXXXXX",
        "yyyy-MM-dd'T'HH:mm:ssXXXXX",
        "yyyy-MM-dd HH:mm:ss.SSSXXXXX",
        "yyyy-MM-dd HH:mm:ssXXXXX",
    ]
}
