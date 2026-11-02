import Foundation
import ObolCore

/// Discovery, transport policy and the bounded foreground synchronization
/// cycle for a paired store (D016, canon §12).
///
/// Everything here is pure Core: no SwiftUI import and no feature reference.
/// The app layer drives it and publishes typed state; failures surface as
/// ``SyncEngine/EngineError`` with the wire cause intact.
///
/// The cycle is: resume one frozen snapshot import if present → handshake →
/// pull complete commit groups → push bounded batches → pull again. Each phase
/// is bounded by page and batch budgets, ordinary pushes are paused while an
/// import checkpoint exists, and the store's own transactional validation is
/// the only writer of local state.
public enum SyncEngine {
    // MARK: - Errors

    public enum EngineError: Error, Equatable, Sendable, LocalizedError {
        case notPaired
        case syncStopped(reason: SyncStopReason, message: String?)
        case missingServerURL
        case missingStoredCredential(origin: String)
        case sessionExpired
        case offline(message: String)
        case pullBudgetExhausted(pages: Int)
        case pushBudgetExhausted(batches: Int)
        case transport(message: String)

        public var errorDescription: String? {
            switch self {
            case .notPaired:
                return "The store is not paired with a server."
            case .syncStopped(let reason, let message):
                return "Synchronization is stopped (\(reason.rawValue)): \(message ?? "no detail")"
            case .missingServerURL:
                return "The paired store has no server URL."
            case .missingStoredCredential(let origin):
                return "No stored credential exists for \(origin)."
            case .sessionExpired:
                return "The session expired and could not be renewed."
            case .offline(let message):
                return "The synchronization is offline: \(message)"
            case .pullBudgetExhausted(let pages):
                return "The foreground pull stopped after the \(pages)-page budget; run synchronize again to continue downloading."
            case .pushBudgetExhausted(let batches):
                return "The foreground push stopped after the \(batches)-batch budget; run synchronize again to continue uploading."
            case .transport(let message):
                return "The server request failed: \(message)"
            }
        }
    }

    // MARK: - Cycle report

    public struct SyncCycleReport: Equatable, Sendable {
        public let serverOrigin: ServerOrigin
        public let handshake: SyncHandshake
        /// The import acknowledged in this cycle, if one was pending.
        public let acknowledgedImportID: String?
        public let pulledPages: Int
        public let pulledEvents: Int
        public let pushedOperations: Int
        public let pushBatches: Int
        public let serverHeadAhead: Bool
        public let finishedAt: Date

        public init(
            serverOrigin: ServerOrigin,
            handshake: SyncHandshake,
            acknowledgedImportID: String?,
            pulledPages: Int,
            pulledEvents: Int,
            pushedOperations: Int,
            pushBatches: Int,
            serverHeadAhead: Bool,
            finishedAt: Date
        ) {
            self.serverOrigin = serverOrigin
            self.handshake = handshake
            self.acknowledgedImportID = acknowledgedImportID
            self.pulledPages = pulledPages
            self.pulledEvents = pulledEvents
            self.pushedOperations = pushedOperations
            self.pushBatches = pushBatches
            self.serverHeadAhead = serverHeadAhead
            self.finishedAt = finishedAt
        }
    }

    // MARK: - Typed progress

    public struct CycleProgress: Equatable, Sendable {
        public var phase: Phase
        public var detail: String

        public enum Phase: Equatable, Sendable {
            case handshake
            case pulling
            case pushing
            case done
        }

        public init(phase: Phase, detail: String) {
            self.phase = phase
            self.detail = detail
        }
    }

    // MARK: - Transport

    /// Parses a normalized origin from a stored or user-typed server URL.
    /// HTTPS always uses the secure policy. A cleartext HTTP origin is only
    /// usable in a `DEBUG` build, where the user explicitly typed that scheme;
    /// a release build parses it with the secure policy and refuses it. ATS is
    /// never disabled globally; the per-session configuration stays
    /// origin-bound either way.
    public static func origin(fromServerURL raw: String?) throws -> ServerOrigin {
        guard let raw, !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw EngineError.missingServerURL
        }
        let scanner = TLSGuard(policy: transportPolicy)
        return try scanner.origin(from: raw)
    }

    /// Cleartext is a `DEBUG`-only convenience for a loopback development
    /// server. Release builds carry no cleartext opt-in at all, so a stored
    /// `http://` address fails closed at origin validation.
    private static var transportPolicy: TransportSecurityPolicy {
        #if DEBUG
        return .development
        #else
        return .secure
        #endif
    }

    public static func policy(for origin: ServerOrigin) -> TransportSecurityPolicy {
        origin.isSecure ? .secure : transportPolicy
    }

    public static func makeClient(origin: ServerOrigin) throws -> BFFClient {
        try BFFClient(
            origin: origin,
            policy: policy(for: origin),
            configuration: BFFClient.Configuration(
                requestTimeout: 60,
                resourceTimeout: 120,
                maximumRequestBytes: SyncEngineLimits.maximumImportBodyBytes,
                maximumResponseBytes: SyncEngineLimits.maximumPullPageBytes,
                userAgent: "Obol/0.4 (iOS)"
            )
        )
    }

    public static func makeClient(serverURL: String?) throws -> BFFClient {
        try makeClient(origin: try origin(fromServerURL: serverURL))
    }

    /// Restores the origin-scoped credential and renews it before expiry so
    /// long pull sequences keep a valid token. Renewal never changes the
    /// station identity; a rotation that fails with an authentication
    /// rejection marks the session expired instead of retrying blindly.
    public static func ensureSession(
        client: BFFClient,
        expiryMargin: TimeInterval = 90
    ) async throws -> RemoteSession {
        let auth = AuthAPI(client: client)
        guard let session = try auth.restoreStoredSession() else {
            throw EngineError.missingStoredCredential(origin: client.origin.storageKey)
        }
        if session.expiresAt.timeIntervalSinceNow < expiryMargin {
            do {
                return try await auth.renewPersisted()
            } catch let error as APIError where error.isAuthenticationFailure {
                throw EngineError.sessionExpired
            }
        }
        return session
    }

    // MARK: - Snapshot import

    /// Sends the frozen import body verbatim and adopts the server result.
    ///
    /// The body was persisted before the first attempt; a lost response,
    /// restart or re-authentication therefore retries byte-identical content
    /// and the server replays its stored result. A 409 (`IMPORT_ID_REUSED`,
    /// `IMPORT_ENTITY_ID_TAKEN`, identity or epoch drift) leaves the checkpoint
    /// and every local fact untouched.
    public static func submitFrozenImport(
        database: ObolDatabase,
        checkpoint: SnapshotImportCheckpoint,
        session: RemoteSession,
        client: BFFClient
    ) async throws -> SnapshotImportOutcome {
        guard session.origin == client.origin else {
            throw StoreError.invalidImport(
                "The session belongs to a different origin than the frozen import target."
            )
        }
        // A 409 (IMPORT_ID_REUSED, IMPORT_ENTITY_ID_TAKEN, identity or epoch
        // drift) propagates as the typed APIError so its server code and
        // message stay visible; the checkpoint and local facts are untouched.
        let response = try await SyncAPI(client: client)
            .importSnapshot(body: checkpoint.body, token: session.token)
        guard response.importId == checkpoint.importId,
              response.serverInstanceId == checkpoint.serverInstanceId,
              response.dataEpoch == checkpoint.dataEpoch else {
            throw StoreError.invalidImport(
                "The import response named import \(response.importId) on server \(response.serverInstanceId) epoch \(response.dataEpoch), which does not match the frozen target."
            )
        }
        return try await database.applySnapshotImportResult(
            serverInstanceId: response.serverInstanceId,
            dataEpoch: response.dataEpoch,
            importId: response.importId,
            counts: response.counts
        )
    }

    // MARK: - Bounded foreground cycle

    /// One bounded foreground synchronization cycle for the bound store.
    /// Writes go through ``ObolDatabase`` transactions only. The cycle never
    /// deletes or rewrites local data on its own; protocol, epoch, rollback and
    /// cursor stop states surface as store errors, outbox conflicts as records.
    ///
    /// A pending snapshot import is resumed first with its frozen body. Normal
    /// pushes stay paused until the server accepts it, so covered operations
    /// are never replayed into the target deployment.
    public static func foregroundCycle(
        database: ObolDatabase,
        deviceLabel: String,
        maximumPullPages: Int = 200,
        maximumPushBatches: Int = 20,
        progress: (@Sendable (CycleProgress) -> Void)? = nil
    ) async throws -> SyncCycleReport {
        let status = try await database.storeStatus()
        let binding = status.binding
        guard binding.isPaired else { throw EngineError.notPaired }
        guard binding.stopReason == .none else {
            throw EngineError.syncStopped(reason: binding.stopReason, message: binding.stopDetail)
        }

        let pendingImport = try await database.pendingSnapshotImport()
        let targetURL = pendingImport?.serverURL ?? binding.serverURL
        let origin = try origin(fromServerURL: targetURL)
        let client = try makeClient(origin: origin)
        let session = try await ensureSession(client: client)
        let syncAPI = SyncAPI(client: client)

        var acknowledgedImportID: String?
        if let checkpoint = pendingImport {
            progress?(CycleProgress(
                phase: .handshake,
                detail: "Resuming frozen snapshot import \(checkpoint.importId)"
            ))
            let outcome = try await submitFrozenImport(
                database: database,
                checkpoint: checkpoint,
                session: session,
                client: client
            )
            acknowledgedImportID = outcome.importId
        }

        // Resume interrupted sends only after the import decision. Covered
        // operations are gone at this point; later local intents stay queued.
        _ = try await database.recoverInterruptedOperations()

        progress?(CycleProgress(phase: .handshake, detail: "Handshaking with the server"))

        let currentBinding = try await database.binding()
        let handshakeRequest = SyncAPI.HandshakeRequest(
            protocolVersion: SyncProtocol.version,
            stationId: currentBinding.stationId,
            platform: "ios",
            deviceLabel: deviceLabel,
            clientCursor: currentBinding.cursor,
            clientCursorHash: currentBinding.lastChainHash,
            dataEpoch: currentBinding.dataEpoch,
            serverInstanceId: currentBinding.serverInstanceId
        )
        let handshakeResponse = try await syncAPI.handshake(
            handshakeRequest,
            token: session.token
        )
        _ = try await database.applyHandshake(
            handshakeResponse,
            serverURL: targetURL
        )

        var cursor = currentBinding.cursor
        var pulledPages = 0
        var pulledEvents = 0

        // Runs complete commit groups only: the store rejects a page whose
        // groups are partial, and the cursor always lands on a boundary.
        func pullBounded(budget: Int) async throws -> (pages: Int, events: Int) {
            var localPages = 0
            var localEvents = 0
            while localPages < budget {
                progress?(CycleProgress(
                    phase: .pulling,
                    detail: "Pulling server events from cursor \(cursor)"
                ))
                let page = try await syncAPI.pull(
                    cursor: cursor,
                    limit: SyncProtocol.targetPullLimit,
                    token: session.token
                )
                let summary = try await database.applyPullPage(page)
                localPages += 1
                localEvents += summary.appliedEvents + summary.ignoredEvents
                guard summary.newCursor != cursor else { break }
                cursor = summary.newCursor
                if !page.hasMore { break }
            }
            return (localPages, localEvents)
        }

        let firstPull = try await pullBounded(budget: maximumPullPages)
        pulledPages += firstPull.pages
        pulledEvents += firstPull.events

        progress?(CycleProgress(phase: .pushing, detail: "Uploading queued operations"))

        var pushBatches = 0
        var pushedOperations = 0
        var batchLimit = SyncProtocol.maximumPushOperations
        while pushBatches < maximumPushBatches {
            let batch = try await database.nextSendableBatch(
                maximumOperations: batchLimit,
                maximumWireBytes: SyncProtocol.maximumPushBodyBytes
            )
            guard !batch.isEmpty else { break }

            let currentBinding = try await database.binding()
            guard let serverInstanceId = currentBinding.serverInstanceId,
                  !serverInstanceId.isEmpty else {
                throw EngineError.syncStopped(
                    reason: .endpointMismatch,
                    message: "The bound store has no server instance id."
                )
            }
            let request = SyncAPI.PushRequest(
                protocolVersion: SyncProtocol.version,
                stationId: currentBinding.stationId,
                serverInstanceId: serverInstanceId,
                dataEpoch: currentBinding.dataEpoch,
                ops: batch.map { $0.envelope.wireObject() }
            )
            let response: SyncAPI.PushResponse
            do {
                response = try await syncAPI.push(request, token: session.token)
            } catch let error as APIError where error.httpStatus == 413 {
                // The store already respects the documented bounds; if a
                // deployment applies a stricter body size, shrink the batch
                // instead of retrying the same request forever. A single
                // operation that still cannot be sent is rejected honestly.
                if batch.count > 1 {
                    for operation in batch {
                        try await database.markOperationRetry(
                            opId: operation.opId,
                            error: "the server refused the batch size (HTTP 413); retrying in a smaller batch"
                        )
                    }
                    batchLimit = max(1, batch.count / 2)
                } else if let operation = batch.first {
                    try await database.rejectOperationLocally(
                        opId: operation.opId,
                        reason: "the server refused this operation with HTTP 413"
                    )
                }
                pushBatches += 1
                continue
            }
            _ = try await database.applyPushResults(response.results)
            pushBatches += 1
            pushedOperations += batch.count
        }

        let unsentOperations = try await database.pendingOperations()
            .filter { $0.status == .queued && $0.blockedBy == nil }
        if !unsentOperations.isEmpty {
            throw EngineError.pushBudgetExhausted(batches: pushBatches)
        }

        // Final pull so locally accepted pushes and any concurrent server
        // activity land in the same foreground window.
        let finalPull = try await pullBounded(budget: maximumPullPages)
        pulledPages += finalPull.pages
        pulledEvents += finalPull.events

        let cursorBinding = try await database.binding()
        let serverHeadAhead = cursorBinding.cursor < handshakeResponse.cursor
        progress?(CycleProgress(phase: .done, detail: "Synchronization finished"))

        return SyncCycleReport(
            serverOrigin: origin,
            handshake: handshakeResponse,
            acknowledgedImportID: acknowledgedImportID,
            pulledPages: pulledPages,
            pulledEvents: pulledEvents,
            pushedOperations: pushedOperations,
            pushBatches: pushBatches,
            serverHeadAhead: serverHeadAhead,
            finishedAt: Date()
        )
    }
}

// MARK: - Wire limits

public enum SyncEngineLimits {
    /// Pull page transport allowance (32 MiB); one commit may exceed the 500
    /// event target but never this bound.
    public static let maximumPullPageBytes = 33_554_432
    /// Request allowance: the snapshot import is the largest body (10 MiB).
    public static let maximumImportBodyBytes = SyncProtocol.maximumImportBytes
    /// Push request transport allowance (1 MiB per D016).
    public static let maximumPushBodyBytes = SyncProtocol.maximumPushBodyBytes
}
