import Foundation
import ObolCore

/// Typed client for the D016 sync surface
/// (`/api/sync/{handshake,pull,push,seed,import}`).
///
/// The routes all require a D009 session and are origin-bound through the
/// shared ``BFFClient``; the Bearer token is only ever transported in the
/// Authorization header. Nothing here decides pairing policy: it transports
/// and decodes the wire contract, and validation of the data itself stays in
/// the store (``ObolDatabase``).
public struct SyncAPI: Sendable {
    public let client: BFFClient

    public init(client: BFFClient) {
        self.client = client
    }

    // MARK: - Handshake

    public struct HandshakeRequest: Encodable, Equatable, Sendable {
        public let protocolVersion: Int
        public let stationId: String
        public let platform: String
        public let deviceLabel: String
        public let clientCursor: Int64?
        public let clientCursorHash: String?
        public let dataEpoch: Int?
        public let serverInstanceId: String?

        public init(
            protocolVersion: Int,
            stationId: String,
            platform: String,
            deviceLabel: String,
            clientCursor: Int64?,
            clientCursorHash: String?,
            dataEpoch: Int?,
            serverInstanceId: String?
        ) {
            self.protocolVersion = protocolVersion
            self.stationId = stationId
            self.platform = platform
            self.deviceLabel = deviceLabel
            self.clientCursor = clientCursor
            self.clientCursorHash = clientCursorHash
            self.dataEpoch = dataEpoch
            self.serverInstanceId = serverInstanceId
        }
    }

    public struct HandshakeResponse: Decodable, Equatable, Sendable {
        public let serverInstanceId: String
        public let ownerFingerprint: String
        public let protocolVersion: Int
        public let protocolMin: Int
        public let protocolMax: Int
        public let dataEpoch: Int
        public let cursor: Int64
        public let cursorHash: String
        public let headHash: String
        public let hasFinancialData: Bool
        public let serverName: String
    }

    /// Performs the periodic handshake. A first pairing omits the identity
    /// fields; a resume sends the stored cursor, instance id and epoch so the
    /// server can detect endpoint drift and rollback.
    public func handshake(_ body: HandshakeRequest, token: String) async throws -> SyncHandshake {
        let response: HandshakeResponse = try await client.post(
            "/api/sync/handshake",
            body: body,
            bearerToken: token
        )
        return SyncHandshake(
            serverInstanceId: response.serverInstanceId,
            ownerFingerprint: response.ownerFingerprint,
            protocolVersion: response.protocolVersion,
            protocolMin: response.protocolMin,
            protocolMax: response.protocolMax,
            dataEpoch: response.dataEpoch,
            cursor: response.cursor,
            cursorHash: response.cursorHash,
            headHash: response.headHash,
            hasFinancialData: response.hasFinancialData,
            serverName: response.serverName
        )
    }

    // MARK: - Pull

    public enum SyncPullLimits {
        public static let minimum = 1
        public static let targetMaximum = 500
    }

    public func pull(cursor: Int64, limit: Int, token: String) async throws -> PullPage {
        let targetLimit = min(max(limit, SyncPullLimits.minimum), SyncPullLimits.targetMaximum)
        return try await client.get(
            "/api/sync/pull",
            queryItems: [
                URLQueryItem(name: "cursor", value: String(cursor)),
                URLQueryItem(name: "limit", value: String(targetLimit))
            ],
            bearerToken: token
        )
    }

    // MARK: - Push

    public struct PushRequest: Encodable, Equatable, Sendable {
        public let protocolVersion: Int
        public let stationId: String
        public let serverInstanceId: String
        public let dataEpoch: Int
        public let ops: [JSONValue]
    }

    public struct PushResponse: Decodable, Equatable, Sendable {
        public let serverInstanceId: String
        public let dataEpoch: Int
        public let cursor: Int64
        public let results: [PushAcknowledgement]
    }

    /// Pushes one caller-assembled batch. Batching belongs to the store and
    /// the sync engine: they freeze no more than 100 operations, 64 KiB each
    /// and 1 MiB per request. This method still rejects an over-count request
    /// before any network call.
    public func push(_ request: PushRequest, token: String) async throws -> PushResponse {
        guard request.ops.count <= SyncProtocol.maximumPushOperations else {
            throw APIError.invalidRequest(
                "a push batch may contain at most \(SyncProtocol.maximumPushOperations) operations, got \(request.ops.count)"
            )
        }
        let response: PushResponse = try await client.post(
            "/api/sync/push",
            body: request,
            bearerToken: token
        )
        return response
    }

    // MARK: - Seed

    public struct SeedRequest: Encodable, Equatable, Sendable {
        public let protocolVersion: Int
        public let stationId: String
        public let serverInstanceId: String
        public let dataEpoch: Int
        public let snapshot: FinancialSnapshot
    }

    public struct SeedResponse: Decodable, Equatable, Sendable {
        public let serverInstanceId: String
        public let dataEpoch: Int
        public let cursor: Int64
        public let counts: [String: Int]
    }

    /// One-time migration call of a legacy, log-free local profile into an
    /// empty server. The server enforces the empty-state, byte and row
    /// bounds; a refused seed commits nothing and the caller must surface the
    /// server state instead of retrying blindly.
    public func seed(_ request: SeedRequest, token: String) async throws -> SeedResponse {
        try await client.post("/api/sync/seed", body: request, bearerToken: token)
    }

    // MARK: - Snapshot import

    public struct ImportResponse: Decodable, Equatable, Sendable {
        public let serverInstanceId: String
        public let dataEpoch: Int
        public let cursor: Int64
        public let counts: [String: Int]
        public let importId: String
    }

    /// Sends the frozen D7 import body verbatim.
    ///
    /// The body is the canonical six-field request built when the checkpoint
    /// was persisted, so a lost response, restart or re-authentication retries
    /// byte-identical content and the server replays its stored result instead
    /// of importing twice. The caller owns retry policy.
    public func importSnapshot(body: Data, token: String) async throws -> ImportResponse {
        guard body.count <= SyncProtocol.maximumImportBytes else {
            throw APIError.invalidRequest(
                "a snapshot import body may contain at most \(SyncProtocol.maximumImportBytes) bytes, got \(body.count)"
            )
        }
        return try await client.perform(
            BFFClient.Request(
                method: .post,
                path: "/api/sync/import",
                body: body,
                bearerToken: token
            )
        )
    }
}
