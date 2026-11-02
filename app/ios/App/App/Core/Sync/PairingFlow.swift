import Foundation
import ObolCore

/// The D016 D7/D8 pairing matrix machinery.
///
/// Preview and confirmation are distinct: the scan is a live login and
/// handshake that registers the station on the server, while the confirmed
/// choice alone binds, replaces, imports or seeds local state. Every
/// destructive branch demands its typed confirmation and a completed export
/// offer, and no merge is ever automatic.
///
/// `importLocalData` transfers the COMPLETE settled materialized snapshot of a
/// never-paired profile as fresh identifiers through the frozen `/api/sync/import`
/// body. It never replays a partial outbox and never merges existing server
/// identifiers.
public enum PairingFlow {
    // MARK: - Choices and outcomes

    /// Core mirror of the wizard action. AppState translates its own
    /// ``PairingAction``; the cases are identical by contract.
    public enum PairingChoice: String, Equatable, Sendable {
        case resume
        case useServerData
        case importLocalData
        case seedEmptyServer
        case stayLocal
    }

    public enum ConfirmOutcome: Equatable, Sendable {
        case resumed
        case baselineAdopted
        case importedSnapshot(counts: EntityCounts)
        case serverSeeded(counts: [String: Int], cursor: Int64)
        case stayedLocal
    }

    // MARK: - Errors

    public enum FlowError: Error, Equatable, Sendable, LocalizedError {
        case confirmationRequired
        case exportRequired
        case unsupportedChoice(message: String)
        case overwriteNotAllowed(message: String)
        case seedTooLarge(rows: Int, bytes: Int)
        case serverNotForSeed(message: String)

        public var errorDescription: String? {
            switch self {
            case .confirmationRequired:
                return "Type REPLACE to confirm discarding the local financial data."
            case .exportRequired:
                return "Offer and complete the local export before discarding."
            case .unsupportedChoice(let message),
                 .overwriteNotAllowed(let message):
                return message
            case .seedTooLarge(let rows, let bytes):
                return "The local legacy database is \(rows) rows / \(bytes) bytes and exceeds the 10,000-row, 10 MiB seed bound; it stays standalone and can be exported."
            case .serverNotForSeed(let message):
                return "The server refuses the seed: \(message). Its state was not changed and the local data was kept."
            }
        }
    }

    // MARK: - Scan

    public struct ScanReport: Equatable, Sendable {
        public let origin: ServerOrigin
        /// The live server identity and journal head, as returned by a real
        /// authenticated handshake with the registered station id.
        public let handshake: SyncHandshake

        public init(origin: ServerOrigin, handshake: SyncHandshake) {
            self.origin = origin
            self.handshake = handshake
        }
    }

    /// Logs in to the entered server address without persisting credentials
    /// and registers the station via the D016 handshake. The returned report
    /// and the ephemeral session are the pairing wizard input; nothing in
    /// the local store changes.
    public static func previewScan(
        serverAddress: String,
        stationId: String,
        email: String,
        password: String,
        deviceLabel: String
    ) async throws -> (report: ScanReport, session: RemoteSession) {
        let origin = try SyncEngine.origin(fromServerURL: serverAddress)
        let client = try SyncEngine.makeClient(origin: origin)
        let auth = AuthAPI(client: client)
        let session = try await auth.login(
            email: email,
            password: password,
            deviceLabel: deviceLabel
        )
        let syncAPI = SyncAPI(client: client)
        let handshake = try await syncAPI.handshake(
            SyncAPI.HandshakeRequest(
                protocolVersion: SyncProtocol.version,
                stationId: stationId,
                platform: "ios",
                deviceLabel: deviceLabel,
                clientCursor: nil,
                clientCursorHash: nil,
                dataEpoch: nil,
                serverInstanceId: nil
            ),
            token: session.token
        )
        return (ScanReport(origin: origin, handshake: handshake), session)
    }

    // MARK: - Confirm

    /// Executes an already validated wizard decision. Callers (AppState)
    /// validate the matrix from the scan and local facts before calling; this
    /// function still re-verifies every qualification mechanically.
    public static func confirm(
        choice: PairingChoice,
        scan: ScanReport,
        session: RemoteSession,
        stationId: String,
        database: ObolDatabase,
        deviceLabel: String,
        replaceConfirmation: String?,
        exportCompleted: Bool,
        progress: (@Sendable (SyncEngine.CycleProgress) -> Void)? = nil
    ) async throws -> ConfirmOutcome {
        switch choice {
        case .stayLocal:
            // Nothing is stored: the ephemeral preview session stays in
            // memory only and no credential is written for this origin.
            return .stayedLocal

        case .resume:
            return try await resume(
                scan: scan,
                session: session,
                database: database,
                deviceLabel: deviceLabel,
                progress: progress
            )

        case .useServerData:
            return try await adoptServerData(
                scan: scan,
                session: session,
                database: database,
                deviceLabel: deviceLabel,
                replaceConfirmation: replaceConfirmation,
                exportCompleted: exportCompleted,
                progress: progress
            )

        case .importLocalData:
            return try await importLocalData(
                scan: scan,
                session: session,
                database: database,
                deviceLabel: deviceLabel,
                progress: progress
            )

        case .seedEmptyServer:
            return try await seedEmptyServer(
                scan: scan,
                session: session,
                stationId: stationId,
                database: database,
                deviceLabel: deviceLabel,
                progress: progress
            )
        }
    }

    // MARK: - Single branches

    /// Resume an existing binding: validates that the live response matches
    /// the stored instance identity and owner fingerprint, then binds at the
    /// scanned origin (a same-instance URL move is exactly this path) and
    /// runs the normal cycle. A pending frozen import is resumed by that cycle
    /// with its original body. A distinct instance, owner or epoch throws
    /// before any queued operation is sent.
    static func resume(
        scan: ScanReport,
        session: RemoteSession,
        database: ObolDatabase,
        deviceLabel: String,
        progress: (@Sendable (SyncEngine.CycleProgress) -> Void)? = nil
    ) async throws -> ConfirmOutcome {
        let binding = try await database.binding()
        guard binding.isPaired,
              let storedInstance = binding.serverInstanceId,
              !storedInstance.isEmpty else {
            throw FlowError.unsupportedChoice(
                message: "Resume requires a previously paired store. Pair first from the connection wizard."
            )
        }
        guard storedInstance == scan.handshake.serverInstanceId else {
            throw FlowError.unsupportedChoice(
                message: "The scanned server instance differs from the stored binding; a previously paired device never replays its queue into another deployment."
            )
        }
        guard binding.ownerFingerprint == scan.handshake.ownerFingerprint else {
            throw FlowError.unsupportedChoice(
                message: "The scanned server owner differs from the stored binding; the queue was not sent."
            )
        }
        guard binding.dataEpoch == scan.handshake.dataEpoch else {
            throw FlowError.unsupportedChoice(
                message: "The server data epoch changed; the stored journal history cannot be compared against it."
            )
        }
        if let pending = try await database.pendingSnapshotImport() {
            guard pending.stationId == binding.stationId,
                  pending.serverInstanceId == storedInstance,
                  pending.dataEpoch == binding.dataEpoch else {
                throw FlowError.unsupportedChoice(
                    message: "A frozen import targets a different server identity or epoch. Explicitly replace the local data only after a completed export."
                )
            }
        }

        try persistCredential(session, origin: scan.origin)
        _ = try await SyncEngine.foregroundCycle(
            database: database,
            deviceLabel: deviceLabel,
            progress: progress
        )
        return .resumed
    }

    /// `useServerData`: after a typed REPLACE plus completed export whenever
    /// the local side has any data, discards the complete local store
    /// (including any frozen import checkpoint) and adopts the server baseline
    /// as a fresh station.
    static func adoptServerData(
        scan: ScanReport,
        session: RemoteSession,
        database: ObolDatabase,
        deviceLabel: String,
        replaceConfirmation: String?,
        exportCompleted: Bool,
        progress: (@Sendable (SyncEngine.CycleProgress) -> Void)? = nil
    ) async throws -> ConfirmOutcome {
        let facts = try await database.legacyProfileFacts()
        let pendingImport = try await database.pendingSnapshotImport()
        let hasLocalData = facts.entityCount > 0
            || facts.pendingCount > 0
            || pendingImport != nil
        if hasLocalData {
            let typed = replaceConfirmation?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard typed == "REPLACE" else {
                throw FlowError.confirmationRequired
            }
            guard exportCompleted else { throw FlowError.exportRequired }
        }
        // Local finance rows, working data, pending intents, the frozen
        // import checkpoint, receipts and the old binding are all removed
        // together. The station identity survives through the Keychain.
        try await database.resetToStandaloneAfterDiscard()
        _ = try await database.applyHandshake(
            scan.handshake,
            serverURL: scan.origin.url.absoluteString
        )
        try persistCredential(session, origin: scan.origin)
        _ = try await SyncEngine.foregroundCycle(
            database: database,
            deviceLabel: deviceLabel,
            progress: progress
        )
        return .baselineAdopted
    }

    /// `importLocalData`: transfers the complete settled materialized snapshot
    /// of a never-paired profile as new identifiers.
    ///
    /// The checkpoint (fresh identifiers, rewritten references, immutable
    /// import id/hash/body, covered operation ids and server binding) is
    /// persisted before the request. The exact frozen body is retried after a
    /// lost response, restart or re-authentication; ordinary pushes stay
    /// paused until the server accepts it. A previously paired device never
    /// takes this path.
    static func importLocalData(
        scan: ScanReport,
        session: RemoteSession,
        database: ObolDatabase,
        deviceLabel: String,
        progress: (@Sendable (SyncEngine.CycleProgress) -> Void)? = nil
    ) async throws -> ConfirmOutcome {
        guard session.origin == scan.origin else {
            throw FlowError.unsupportedChoice(
                message: "The preview session belongs to a different origin than the pairing decision."
            )
        }
        let client = try SyncEngine.makeClient(origin: scan.origin)
        let binding = try await database.binding()

        if let pending = try await database.pendingSnapshotImport() {
            guard binding.isPaired,
                  pending.stationId == binding.stationId,
                  pending.serverInstanceId == scan.handshake.serverInstanceId,
                  pending.dataEpoch == scan.handshake.dataEpoch else {
                throw FlowError.unsupportedChoice(
                    message: "A frozen snapshot import for another server identity or data epoch is pending. Resume that exact target, or explicitly replace the local data after a completed export."
                )
            }
            let outcome = try await SyncEngine.submitFrozenImport(
                database: database,
                checkpoint: pending,
                session: session,
                client: client
            )
            try persistCredential(session, origin: scan.origin)
            _ = try await SyncEngine.foregroundCycle(
                database: database,
                deviceLabel: deviceLabel,
                progress: progress
            )
            return .importedSnapshot(counts: outcome.counts)
        }

        if let instance = binding.serverInstanceId, !instance.isEmpty {
            throw FlowError.unsupportedChoice(
                message: "A previously paired device never replays a partial outbox to another endpoint. Resume the existing station, or explicitly replace the local data after a completed export."
            )
        }
        let facts = try await database.legacyProfileFacts()
        guard facts.entityCount > 0 || facts.pendingCount > 0 else {
            throw FlowError.unsupportedChoice(
                message: "There is no local data to import; pair by adopting the server baseline instead."
            )
        }

        let checkpoint = try await database.prepareSnapshotImport(
            handshake: scan.handshake,
            serverURL: scan.origin.url.absoluteString
        )
        let outcome = try await SyncEngine.submitFrozenImport(
            database: database,
            checkpoint: checkpoint,
            session: session,
            client: client
        )
        try persistCredential(session, origin: scan.origin)
        _ = try await SyncEngine.foregroundCycle(
            database: database,
            deviceLabel: deviceLabel,
            progress: progress
        )
        return .importedSnapshot(counts: outcome.counts)
    }

    /// `seedEmptyServer`: one-time migration of a legacy, log-free local
    /// profile into an empty server, preserving the original identifiers. A
    /// failed or lost seed response stops the flow with the server state
    /// visible; the local store is unbound again and never blindly retried or
    /// overwritten. A frozen import must be resolved first.
    static func seedEmptyServer(
        scan: ScanReport,
        session: RemoteSession,
        stationId: String,
        database: ObolDatabase,
        deviceLabel: String,
        progress: (@Sendable (SyncEngine.CycleProgress) -> Void)? = nil
    ) async throws -> ConfirmOutcome {
        if let pending = try await database.pendingSnapshotImport() {
            throw FlowError.unsupportedChoice(
                message: "A frozen snapshot import (\(pending.importId)) is pending; resume it instead of seeding."
            )
        }
        let facts = try await database.legacyProfileFacts()
        guard facts.legacyRows else {
            throw FlowError.unsupportedChoice(
                message: "Seeding is only for a legacy database with rows and no operation log."
            )
        }
        guard !scan.handshake.hasFinancialData else {
            throw FlowError.unsupportedChoice(
                message: "The server already has financial data and cannot accept a seed."
            )
        }

        let snapshot = try await database.loadFinancialSnapshot()
        let totalRows = snapshot.accounts.count + snapshot.cards.count
            + snapshot.categories.count + snapshot.invoices.count
            + snapshot.projects.count + snapshot.recurrences.count
            + snapshot.transactions.count
        let seedRequest = SyncAPI.SeedRequest(
            protocolVersion: SyncProtocol.version,
            stationId: stationId,
            serverInstanceId: scan.handshake.serverInstanceId,
            dataEpoch: scan.handshake.dataEpoch,
            snapshot: snapshot
        )
        let encodedBody: Data
        do {
            encodedBody = try JSONEncoder().encode(seedRequest)
        } catch {
            throw FlowError.overwriteNotAllowed(
                message: "The local snapshot could not be encoded: \(String(describing: error))"
            )
        }
        if totalRows > SyncProtocol.maximumImportRows
            || encodedBody.count > SyncProtocol.maximumImportBytes {
            throw FlowError.seedTooLarge(rows: totalRows, bytes: encodedBody.count)
        }

        // The seed request needs the registered station identity, so the
        // handshake binds first. A failed seed below unbinds again and
        // surfaces the server state; nothing overwrites local rows.
        _ = try await database.applyHandshake(
            scan.handshake,
            serverURL: scan.origin.url.absoluteString
        )
        try persistCredential(session, origin: scan.origin)

        let client = try SyncEngine.makeClient(origin: scan.origin)
        let seedResponse: SyncAPI.SeedResponse
        do {
            seedResponse = try await SyncAPI(client: client).seed(
                seedRequest,
                token: session.token
            )
        } catch let error as APIError where error.serverBody?.code == "SERVER_NOT_EMPTY" {
            // Server refused with its state intact: unbind so the user can
            // choose use-server-data or stay local with full information.
            try await database.disconnectPairingImmediately()
            throw FlowError.serverNotForSeed(
                message: error.serverMessage ?? "SERVER_NOT_EMPTY"
            )
        }

        _ = try await SyncEngine.foregroundCycle(
            database: database,
            deviceLabel: deviceLabel,
            progress: progress
        )
        return .serverSeeded(
            counts: seedResponse.counts,
            cursor: seedResponse.cursor
        )
    }

    /// Writes the credential for the target origin only after the binding was
    /// accepted. A previously unheard-of origin therefore never holds a
    /// token before its identity was verified.
    static func persistCredential(_ session: RemoteSession, origin: ServerOrigin) throws {
        guard session.origin == origin else {
            throw FlowError.unsupportedChoice(
                message: "The preview session belongs to a different origin than the pairing decision."
            )
        }
        let client = try SyncEngine.makeClient(origin: origin)
        try AuthAPI(client: client).store(session)
    }
}
