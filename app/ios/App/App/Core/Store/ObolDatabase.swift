import Foundation
import ObolCore
import SQLite3

private enum HandshakeOutcome {
    case success(SyncBinding)
    case stopped(SyncStopReason, String)
}

private struct ConflictCandidate {
    let opId: String
    let kind: ConflictKind
    let entityType: EntityType
    let entityId: String
    let baseRevision: Int?
    let currentRevision: Int
    let currentRecord: JSONValue?
    let message: String
}

/// The native app's single durable SQLite store.
///
/// One actor owns one connection. Finance rows, optimistic working rows,
/// per-entity revisions, the immutable outbox, conflicts, binding/cursor state,
/// and applied operation receipts commit in this database. A local mutation and
/// its outbox intent commit in the same transaction; a pull page and its cursor
/// commit in the same transaction. Nothing here performs network I/O, and no
/// token or password is stored.
public actor ObolDatabase {
    public static let currentSchemaVersion = SQLiteSchema.currentVersion
    public static let databaseFileName = "obol.sqlite3"

    public let directoryURL: URL
    public let databaseURL: URL

    private let fileManager: FileManager
    private var connection: SQLiteConnection?

    /// Opens the store for one durable station identity.
    ///
    /// `stationId` is the installation identifier owned by `KeychainStore`; it
    /// is never generated here. On a fresh database the exact supplied value is
    /// written to `sync_state`. On an existing database a different stored
    /// identity throws ``StoreError/stationIdentityMismatch(stored:installation:)``
    /// and leaves every finance row, outbox operation, and cursor untouched.
    public init(stationId: String, directoryURL: URL? = nil, fileManager: FileManager = .default) throws {
        guard UUID(uuidString: stationId) != nil else {
            throw StoreError.invalidArgument("station identifier '\(stationId)' is not a UUID.")
        }
        let directory = try Self.resolveDirectory(directoryURL, fileManager: fileManager)
        try Self.prepareDirectory(directory, fileManager: fileManager)
        let databaseURL = directory.appendingPathComponent(Self.databaseFileName, isDirectory: false)

        self.directoryURL = directory
        self.databaseURL = databaseURL
        self.fileManager = fileManager

        let connection = try SQLiteConnection(path: databaseURL.path)
        do {
            try SQLiteSchema.migrate(connection)
            try Self.applyDataProtection(
                directory: directory,
                databaseURL: databaseURL,
                fileManager: fileManager
            )
            try Self.ensureSyncState(
                connection: connection,
                stationId: stationId,
                databasePath: databaseURL.path,
                now: Date()
            )
        } catch let failure {
            do {
                try connection.close()
            } catch {
                // Preserve the original failure.
            }
            throw failure
        }
        self.connection = connection
    }

    public func close() throws {
        guard let connection else { return }
        try connection.close()
        self.connection = nil
    }
}

// MARK: - Reads

public extension ObolDatabase {
    /// Complete working view: base records plus every optimistic local edit.
    /// Pending, conflicted, and rejected intents stay visible until resolved.
    func loadFinancialSnapshot() throws -> FinancialSnapshot {
        let connection = try requireConnection()
        return try loadSnapshot(connection)
    }

    func storeStatus() throws -> StoreStatus {
        let connection = try requireConnection()
        let binding = try loadBinding(connection)
        let snapshot = try loadSnapshot(connection)
        let baseRows = try connection.scalarInt("SELECT COUNT(*) FROM base_entities")
        let workingRows = try connection.scalarInt(
            "SELECT COUNT(*) FROM working_entities WHERE deleted = 0"
        )
        let pending = try connection.scalarInt("SELECT COUNT(*) FROM sync_outbox")
        let conflicted = try connection.scalarInt(
            "SELECT COUNT(*) FROM sync_outbox WHERE status = 'conflict'"
        )
        let conflictCount = try connection.scalarInt("SELECT COUNT(*) FROM sync_conflicts")
        let receipts = try connection.scalarInt("SELECT COUNT(*) FROM sync_applied_ops")
        return StoreStatus(
            schemaVersion: try connection.userVersion(),
            databasePath: databaseURL.path,
            journalMode: (try connection.scalarText("PRAGMA journal_mode")) ?? "unknown",
            foreignKeysEnabled: (try connection.scalarInt("PRAGMA foreign_keys")) == 1,
            binding: binding,
            counts: EntityCounts(snapshot: snapshot),
            baseEntityCount: baseRows,
            workingEntityCount: workingRows,
            pendingOperationCount: pending,
            conflictedOperationCount: conflicted,
            conflictCount: conflictCount,
            appliedOperationCount: receipts
        )
    }

    func binding() throws -> SyncBinding {
        try loadBinding(requireConnection())
    }

    /// Every unresolved outbox row, in durable insertion order.
    func pendingOperations() throws -> [OutboxOperation] {
        try readOutbox(requireConnection(), opId: nil)
    }

    func conflicts() throws -> [ConflictRecord] {
        try readConflicts(requireConnection())
    }

    func outboxOperation(opId: String) throws -> OutboxOperation? {
        try readOutbox(requireConnection(), opId: opId).first
    }
}

// MARK: - Local mutations

public extension ObolDatabase {
    /// Applies one financial command with the user's business time and records
    /// every corresponding server operation in the same SQLite transaction.
    ///
    /// `effectiveAt` dates the financial effect. The engine receives it as its
    /// clock, so an offline realization or payment never adopts the reconnect
    /// date. Unknown or unsupported commands are rejected before any write.
    func apply(_ command: FinancialCommand, effectiveAt: Date) throws -> LocalMutationResult {
        let connection = try requireConnection()

        if case .processMonthlyRecurrences = command {
            let currentBinding = try loadBinding(connection)
            guard !currentBinding.isPaired else {
                throw StoreError.pairedAutomaticRecurrenceDisabled
            }
        }
        guard OperationBuilder.supports(command) else {
            throw StoreError.unsupportedCommand(OperationBuilder.name(of: command))
        }

        let before = try loadSnapshot(connection)
        let after = try FinanceEngine().apply(command, to: before, now: effectiveAt)
        if after == before {
            return LocalMutationResult(snapshot: after, operations: [], changedEntities: [])
        }

        return try connection.transaction {
            let context = try planningContext(
                connection,
                effectiveAt: effectiveAt,
                clientCreatedAt: Date()
            )
            let planned = try OperationBuilder.plan(
                command: command,
                before: before,
                after: after,
                context: context
            )
            let changed = try OperationBuilder.changedEntities(before: before, after: after)
            guard !changed.isEmpty else {
                return LocalMutationResult(snapshot: after, operations: [], changedEntities: [])
            }
            guard !planned.isEmpty else {
                throw StoreError.noOperationMapping(OperationBuilder.name(of: command))
            }

            try writeWorkingChanges(connection, after: after, changed: changed, now: effectiveAt)
            try insertOperations(connection, planned: planned, context: context)
            try refreshBlockedState(connection, now: effectiveAt)
            let operations = try planned.map { plannedOperation -> OutboxOperation in
                guard let stored = try readOutbox(connection, opId: plannedOperation.opId).first else {
                    throw StoreError.operationNotFound(plannedOperation.opId)
                }
                return stored
            }
            return LocalMutationResult(
                snapshot: after,
                operations: operations,
                changedEntities: changed
            )
        }
    }

    /// Returns every operation left `in_flight` by a previous process to
    /// `queued`. Nothing is replayed automatically.
    @discardableResult
    func recoverInterruptedOperations() throws -> Int {
        let connection = try requireConnection()
        return try connection.transaction {
            let now = Date()
            try connection.withStatement(
                "UPDATE sync_outbox SET status = 'queued', updated_at = ? WHERE status = 'in_flight'"
            ) { statement in
                try statement.bind(1, text: Self.iso(now))
                try statement.step()
            }
            let recovered = try connection.changes()
            try refreshBlockedState(connection, now: now)
            return recovered
        }
    }
}

// MARK: - Outbox dispatch

public extension ObolDatabase {
    /// Returns the first operation that can be sent. Kept as the single-step
    /// form of ``nextSendableBatch`` for callers that inspect one intent.
    /// `nil` means dependencies, blocks, or an empty queue prevent a send.
    func nextSendableOperation() throws -> OutboxOperation? {
        try nextSendableBatch(maximumOperations: 1).first
    }

    /// Selects, freezes and marks `in_flight` one bounded push batch.
    ///
    /// The D016 bounds are enforced before an envelope is frozen: at most 100
    /// operations, at most 64 KiB per serialized operation, and a conservative
    /// 1 MiB complete-request budget. Independent eligible operations are split
    /// across calls instead of stranding a valid batch on HTTP 413. An
    /// operation that alone exceeds 64 KiB cannot ever be transported, so it is
    /// marked rejected with an honest reason and its dependents are blocked
    /// rather than looping forever. Ordinary dispatch is paused while a frozen
    /// snapshot import is pending.
    func nextSendableBatch(
        maximumOperations: Int = SyncProtocol.maximumPushOperations,
        maximumWireBytes: Int = SyncProtocol.maximumPushBodyBytes
    ) throws -> [OutboxOperation] {
        let connection = try requireConnection()
        let operationLimit = max(
            1,
            min(maximumOperations, SyncProtocol.maximumPushOperations)
        )
        return try connection.transaction {
            if let pending = try readPendingSnapshotImport(connection) {
                throw StoreError.snapshotImportPending(
                    "import \(pending.importId) must be accepted before ordinary operations are sent."
                )
            }
            let bodyBudget = max(
                SyncProtocol.maximumOperationBytes,
                maximumWireBytes - Self.pushRequestOverheadBytes
            )
            var batch: [OutboxOperation] = []
            var usedBytes = 0
            let now = Date()

            for opId in try outboxQueuedIdentifiers(connection) {
                if batch.count >= operationLimit { break }
                guard let operation = try readOutbox(connection, opId: opId).first else {
                    continue
                }
                if operation.blockedBy != nil { continue }
                guard try dependenciesSatisfied(connection, operation.dependsOn) else {
                    continue
                }

                let projectedEnvelope = try projectedEnvelopeForSend(
                    connection,
                    operation: operation
                )
                // Same JSONEncoder the transport uses, so the measured bytes
                // are the bytes the server will receive for this operation.
                let wireBytes = try ObolRecordCodec.encoder.encode(
                    projectedEnvelope.wireObject()
                ).count
                if wireBytes > SyncProtocol.maximumOperationBytes {
                    try markLocalRejection(
                        connection,
                        operation: operation,
                        reason: "operation serializes to \(wireBytes) bytes; the per-operation bound is \(SyncProtocol.maximumOperationBytes)",
                        now: now
                    )
                    continue
                }
                let projectedBytes = usedBytes + wireBytes + 1
                if projectedBytes > bodyBudget {
                    if batch.isEmpty {
                        throw StoreError.invalidArgument(
                            "operation \(operation.opId) does not fit the push body bound"
                        )
                    }
                    break
                }

                batch.append(
                    try finalizeForSend(connection, operation: operation, now: now)
                )
                usedBytes = projectedBytes
            }
            return batch
        }
    }

    /// Rejects one frozen operation locally when the transport proved it cannot
    /// ever be accepted, so a queue cannot loop on the same invalid request.
    /// Finance rows are untouched and dependents are blocked honestly.
    func rejectOperationLocally(opId: String, reason: String) throws {
        let connection = try requireConnection()
        try connection.transaction {
            guard let operation = try readOutbox(connection, opId: opId).first else {
                throw StoreError.operationNotFound(opId)
            }
            try markLocalRejection(
                connection,
                operation: operation,
                reason: reason,
                now: Date()
            )
            try refreshBlockedState(connection, now: Date())
        }
    }

    /// Marks a failed send for retry. The envelope is already frozen and is not
    /// changed; only `last_error` and the queued status move.
    func markOperationRetry(opId: String, error: String) throws {
        let connection = try requireConnection()
        try connection.transaction {
            let now = Date()
            try connection.withStatement(
                """
                UPDATE sync_outbox
                SET status = 'queued', last_error = ?, updated_at = ?
                WHERE op_id = ? AND status IN ('in_flight', 'queued')
                """
            ) { statement in
                try statement.bind(1, text: error)
                try statement.bind(2, text: Self.iso(now))
                try statement.bind(3, text: opId)
                try statement.step()
            }
            guard try connection.changes() == 1 else {
                if try readOutbox(connection, opId: opId).first != nil {
                    throw StoreError.invalidArgument(
                        "operation \(opId) is not in a retryable state"
                    )
                }
                throw StoreError.operationNotFound(opId)
            }
            try refreshBlockedState(connection, now: now)
        }
    }

    /// Applies one push response. Successful results replace optimistic rows
    /// with server entities, remap server-created ids, and remove the operation
    /// atomically. Conflicts and rejections keep the local intent and snapshots.
    /// Repeating the same acknowledgement is idempotent.
    func applyPushResults(_ results: [PushAcknowledgement]) throws -> PushApplySummary {
        let connection = try requireConnection()
        return try connection.transaction {
            try requireNoPendingSnapshotImport(connection)
            var applied: [String] = []
            var duplicates: [String] = []
            var conflicted: [String] = []
            var rejected: [String] = []
            var blocked: [String] = []
            var remaps: [ClientEntityRemap] = []

            for result in results {
                let now = Date()
                guard let operation = try readOutbox(connection, opId: result.opId).first else {
                    if let receipt = try readReceipt(connection, opId: result.opId) {
                        if receiptMatches(stored: receipt.status, incoming: result.status) {
                            continue
                        }
                        throw StoreError.conflictingAcknowledgement(
                            opId: result.opId,
                            stored: receipt.status,
                            incoming: result.status.rawValue
                        )
                    }
                    throw StoreError.operationNotFound(result.opId)
                }

                switch result.status {
                case .applied, .duplicate:
                    let remapped = try remapCreatedEntities(
                        connection,
                        operation: operation,
                        result: result,
                        now: now
                    )
                    remaps.append(contentsOf: remapped)

                    try detectPushConflicts(
                        connection,
                        entities: result.entities,
                        acceptedOpId: operation.opId,
                        now: now
                    )

                    let pendingKeys = try pendingEntityKeys(
                        connection,
                        excludingOpId: operation.opId
                    )
                    for entity in result.entities {
                        _ = try applyServerEntity(
                            connection,
                            entity: entity,
                            now: now,
                            pendingKeys: pendingKeys
                        )
                    }

                    try removeOutbox(connection, opId: operation.opId)
                    try insertReceipt(
                        connection,
                        opId: operation.opId,
                        status: result.status.rawValue,
                        result: try encodeAcknowledgement(result),
                        now: now
                    )
                    try deleteConflicts(connection, opId: operation.opId)
                    try refreshBlockedState(connection, now: now)
                    if result.status == .applied {
                        applied.append(result.opId)
                    } else {
                        duplicates.append(result.opId)
                    }

                case .conflict:
                    _ = try markPushConflict(
                        connection,
                        operation: operation,
                        conflicts: result.conflicts,
                        code: result.code,
                        message: result.message,
                        now: now
                    )
                    conflicted.append(result.opId)

                case .rejected:
                    try markPushRejected(
                        connection,
                        operation: operation,
                        code: result.code,
                        message: result.message,
                        now: now
                    )
                    rejected.append(result.opId)

                case .blocked:
                    try markPushBlocked(
                        connection,
                        operation: operation,
                        code: result.code,
                        message: result.message,
                        now: now
                    )
                    blocked.append(result.opId)
                }
            }

            return PushApplySummary(
                appliedOperationIDs: applied,
                duplicateOperationIDs: duplicates,
                conflictedOperationIDs: conflicted,
                rejectedOperationIDs: rejected,
                blockedOperationIDs: blocked,
                remappedEntities: remaps
            )
        }
    }

    /// Applies already accepted server entities without an operation result.
    /// Pending intents are preserved; stale base revisions become conflicts.
    @discardableResult
    func applyAcceptedServerEntities(_ entities: [ServerEntity]) throws -> Int {
        let connection = try requireConnection()
        return try connection.transaction {
            try requireNoPendingSnapshotImport(connection)
            let now = Date()
            let pendingKeys = try pendingEntityKeys(connection, excludingOpId: nil)
            var applied = 0
            for entity in entities {
                try detectPushConflicts(
                    connection,
                    entities: [entity],
                    acceptedOpId: nil,
                    now: now
                )
                if try applyServerEntity(
                    connection,
                    entity: entity,
                    now: now,
                    pendingKeys: pendingKeys
                ) {
                    applied += 1
                }
            }
            return applied
        }
    }
}

// MARK: - Handshake, pull, and stop state

public extension ObolDatabase {
    /// Validates and stores a handshake. Cursor, epoch, instance, fingerprint,
    /// and protocol mismatches stop sync without touching finance, outbox, or
    /// conflict rows. The local cursor is never advanced here.
    func applyHandshake(_ handshake: SyncHandshake, serverURL: String?) throws -> SyncBinding {
        let connection = try requireConnection()
        let sanitizedServerURL = Self.sanitizedServerURL(serverURL)
        let outcome = try connection.transaction { () -> HandshakeOutcome in
            let now = Date()
            let binding = try loadBinding(connection)
            if let pending = try readPendingSnapshotImport(connection) {
                guard handshake.serverInstanceId == pending.serverInstanceId,
                      handshake.dataEpoch == pending.dataEpoch else {
                    throw StoreError.snapshotImportPending(
                        "import \(pending.importId) targets server \(pending.serverInstanceId) epoch \(pending.dataEpoch); this handshake names another identity."
                    )
                }
            }

            if binding.cursor > 0 {
                guard let index = binding.cursorCommitIndex,
                      let size = binding.cursorCommitSize,
                      index + 1 == size else {
                    let message = "Stored cursor \(binding.cursor) is inside a commit group."
                    try updateStopReason(
                        connection,
                        reason: .cursorNotOnCommitBoundary,
                        detail: message,
                        now: now
                    )
                    return .stopped(.cursorNotOnCommitBoundary, message)
                }
            }

            guard handshake.protocolMin <= handshake.protocolMax,
                  handshake.protocolVersion >= handshake.protocolMin,
                  handshake.protocolVersion <= handshake.protocolMax,
                  SyncProtocol.version >= handshake.protocolMin,
                  SyncProtocol.version <= handshake.protocolMax else {
                let message = "Server supports protocol \(handshake.protocolMin)...\(handshake.protocolMax); client speaks \(SyncProtocol.version)."
                try updateStopReason(
                    connection,
                    reason: .protocolUnsupported,
                    detail: message,
                    now: now
                )
                return .stopped(.protocolUnsupported, message)
            }

            if let instance = binding.serverInstanceId,
               !instance.isEmpty,
               instance != handshake.serverInstanceId {
                let message = "Server instance changed from \(instance) to \(handshake.serverInstanceId)."
                try updateStopReason(connection, reason: .endpointMismatch, detail: message, now: now)
                return .stopped(.endpointMismatch, message)
            }

            if let fingerprint = binding.ownerFingerprint,
               !fingerprint.isEmpty,
               fingerprint != handshake.ownerFingerprint {
                let message = "Server owner fingerprint changed."
                try updateStopReason(connection, reason: .endpointMismatch, detail: message, now: now)
                return .stopped(.endpointMismatch, message)
            }

            let previouslyPaired = binding.serverInstanceId != nil
            if previouslyPaired, handshake.dataEpoch != binding.dataEpoch {
                let message = "Server data epoch changed from \(binding.dataEpoch) to \(handshake.dataEpoch)."
                try updateStopReason(connection, reason: .dataEpochChanged, detail: message, now: now)
                return .stopped(.dataEpochChanged, message)
            }

            if binding.cursor > handshake.cursor {
                let message = "Local cursor \(binding.cursor) is ahead of server cursor \(handshake.cursor)."
                try updateStopReason(connection, reason: .serverRollbackDetected, detail: message, now: now)
                return .stopped(.serverRollbackDetected, message)
            }

            try connection.withStatement(
                """
                UPDATE sync_state
                SET mode = 'paired',
                    server_url = COALESCE(?, server_url),
                    server_instance_id = ?,
                    owner_fingerprint = ?,
                    protocol_version = ?,
                    protocol_min = ?,
                    protocol_max = ?,
                    data_epoch = ?,
                    server_head_cursor = ?,
                    server_head_hash = ?,
                    has_financial_data = ?,
                    stop_reason = 'none',
                    stop_detail = NULL,
                    updated_at = ?
                WHERE id = 1
                """
            ) { statement in
                try statement.bind(1, text: sanitizedServerURL)
                try statement.bind(2, text: handshake.serverInstanceId)
                try statement.bind(3, text: handshake.ownerFingerprint)
                try statement.bind(4, int: SyncProtocol.version)
                try statement.bind(5, int: handshake.protocolMin)
                try statement.bind(6, int: handshake.protocolMax)
                try statement.bind(7, int: handshake.dataEpoch)
                try statement.bind(8, int64: handshake.cursor)
                try statement.bind(9, text: handshake.headHash)
                try statement.bind(10, int: handshake.hasFinancialData ? 1 : 0)
                try statement.bind(11, text: Self.iso(now))
                try statement.step()
            }
            return .success(try loadBinding(connection))
        }

        switch outcome {
        case .success(let binding):
            return binding
        case .stopped(let reason, let message):
            throw StoreError.syncStopped(reason: reason, message: message)
        }
    }

    /// Applies one complete pull page in one transaction. The page is rejected
    /// before any write unless every commit group is complete and the hash chain
    /// continues from the stored cursor.
    func applyPullPage(_ page: PullPage) throws -> PullApplySummary {
        let connection = try requireConnection()
        try requireNoPendingSnapshotImport(connection)
        let binding = try loadBinding(connection)

        guard let instance = binding.serverInstanceId else {
            try failPull(
                connection,
                reason: .endpointMismatch,
                message: "A handshake must succeed before the first pull."
            )
        }
        if page.serverInstanceId != instance {
            try failPull(
                connection,
                reason: .endpointMismatch,
                message: "Pull server instance \(page.serverInstanceId) does not match bound instance \(instance)."
            )
        }
        if page.dataEpoch != binding.dataEpoch {
            try failPull(
                connection,
                reason: .dataEpochChanged,
                message: "Pull data epoch \(page.dataEpoch) does not match bound epoch \(binding.dataEpoch)."
            )
        }
        if binding.cursor > 0 {
            guard let index = binding.cursorCommitIndex,
                  let size = binding.cursorCommitSize,
                  index + 1 == size else {
                try failPull(
                    connection,
                    reason: .cursorNotOnCommitBoundary,
                    message: "Stored cursor \(binding.cursor) is inside a commit group."
                )
            }
        }

        try validatePullPage(page, binding: binding, connection: connection)

        if page.events.isEmpty {
            return PullApplySummary(
                appliedEvents: 0,
                ignoredEvents: 0,
                conflictsCreated: 0,
                conflictsUpdated: 0,
                newCursor: page.nextCursor
            )
        }

        return try connection.transaction {
            let now = Date()
            let pendingKeys = try pendingEntityKeys(connection, excludingOpId: nil)
            let pendingOperations = try loadPendingOperations(connection)
            var applied = 0
            var ignored = 0
            var createdConflicts = 0
            var updatedConflicts = 0

            for event in page.events {
                let key = EntityKey(entityType: event.entityType, entityId: event.entityId)
                let currentRevision = try serverRevision(connection, key: key) ?? 0
                if event.revision <= currentRevision {
                    ignored += 1
                    continue
                }

                let candidates = conflictCandidates(
                    event: event,
                    operations: pendingOperations
                )
                let counts = try markConflictCandidates(
                    connection,
                    candidates: candidates,
                    now: now
                )
                createdConflicts += counts.created
                updatedConflicts += counts.updated

                let entity = ServerEntity(
                    entityType: event.entityType,
                    entityId: event.entityId,
                    revision: event.revision,
                    record: event.record
                )
                if try applyServerEntity(
                    connection,
                    entity: entity,
                    now: now,
                    pendingKeys: pendingKeys
                ) {
                    applied += 1
                }
            }

            guard let last = page.events.last else {
                throw StoreError.invalidArgument("Pull page has no terminal event")
            }
            try connection.withStatement(
                """
                UPDATE sync_state
                SET cursor = ?, cursor_commit_index = ?, cursor_commit_size = ?,
                    last_chain_hash = ?, stop_reason = 'none', stop_detail = NULL,
                    updated_at = ?
                WHERE id = 1
                """
            ) { statement in
                try statement.bind(1, int64: page.nextCursor)
                try statement.bind(2, int: last.commitIndex)
                try statement.bind(3, int: last.commitSize)
                try statement.bind(4, text: last.chainHash)
                try statement.bind(5, text: Self.iso(now))
                try statement.step()
            }

            return PullApplySummary(
                appliedEvents: applied,
                ignoredEvents: ignored,
                conflictsCreated: createdConflicts,
                conflictsUpdated: updatedConflicts,
                newCursor: page.nextCursor
            )
        }
    }

    /// Records a non-destructive sync stop. Clients call this for a 401; the
    /// store never deletes finance, outbox, conflicts, or binding metadata.
    func setSyncStopReason(_ reason: SyncStopReason, detail: String? = nil) throws {
        let connection = try requireConnection()
        try connection.transaction {
            try updateStopReason(connection, reason: reason, detail: detail, now: Date())
        }
    }
}

// MARK: - Rejection and conflict resolution

public extension ObolDatabase {
    /// Acknowledges a rejected operation. The caller must have asked for this;
    /// nothing is restored automatically. Before-snapshots are restored only
    /// where no other unaccepted intent still claims the entity.
    func acknowledgeRejectedOperation(
        opId: String,
        dependentStrategy: DependentStrategy
    ) throws -> ConflictResolutionResult {
        let connection = try requireConnection()
        return try connection.transaction {
            try requireNoPendingSnapshotImport(connection)
            let now = Date()
            guard let operation = try readOutbox(connection, opId: opId).first else {
                throw StoreError.operationNotFound(opId)
            }
            guard operation.status == .rejected else {
                throw StoreError.invalidArgument("operation \(opId) is not rejected")
            }

            let restoration = try restoreBeforeSnapshots(
                connection,
                operation: operation,
                now: now
            )
            try removeOutbox(connection, opId: opId)
            try deleteConflicts(connection, opId: opId)
            try insertReceipt(
                connection,
                opId: opId,
                status: "rejected",
                result: "{\"acknowledged\":true}",
                now: now
            )
            let newIDs = try applyDependentStrategy(
                connection,
                resolvedOpId: opId,
                strategy: dependentStrategy,
                now: now
            )
            try refreshBlockedState(connection, now: now)
            return ConflictResolutionResult(
                opId: opId,
                newOperationIDs: newIDs,
                restoredEntities: restoration.restored,
                skippedEntities: restoration.skipped
            )
        }
    }

    /// Resolves one conflicted operation explicitly. This is the only path that
    /// adopts a server version, rebases, or discards a conflicting intent.
    func resolveConflict(
        opId: String,
        resolution: ConflictResolution,
        dependentStrategy: DependentStrategy
    ) throws -> ConflictResolutionResult {
        let connection = try requireConnection()
        return try connection.transaction {
            try requireNoPendingSnapshotImport(connection)
            let now = Date()
            guard let operation = try readOutbox(connection, opId: opId).first else {
                throw StoreError.operationNotFound(opId)
            }
            guard operation.status == .conflict else {
                throw StoreError.invalidArgument("operation \(opId) is not conflicted")
            }

            switch resolution {
            case .retryWithCurrentServerRevision:
                let conflictRows = try readConflicts(connection, opId: opId)
                guard !conflictRows.isEmpty else {
                    throw StoreError.invalidArgument("operation \(opId) has no conflict rows")
                }
                guard !conflictRows.contains(where: { $0.kind == .entityIdTaken }) else {
                    throw StoreError.invalidArgument(
                        "entity-id collision conflicts cannot be retried with the same id"
                    )
                }

                var baseRevisions = operation.baseRevisions
                for conflict in conflictRows {
                    let key = "\(conflict.entityType.rawValue):\(conflict.entityId)"
                    baseRevisions[key] = conflict.currentRevision
                }
                let dependenciesSettled = try dependenciesSatisfied(
                    connection,
                    operation.dependsOn
                )
                let rebased = try rebaseOperations(
                    connection,
                    initialOpIds: [operation.opId],
                    now: now
                ) { candidate in
                    guard candidate.opId == operation.opId else {
                        return RebasedOperation(identity: candidate)
                    }
                    return RebasedOperation(
                        identity: candidate,
                        baseRevisions: baseRevisions,
                        freezeEnvelope: dependenciesSettled
                    )
                }
                try insertReceipt(
                    connection,
                    opId: operation.opId,
                    status: "retried",
                    result: "{\"retried\":true}",
                    now: now
                )
                try setConflictResolution(connection, opId: opId, resolution: .retry, now: now)
                let newIDs = try applyDependentStrategy(
                    connection,
                    resolvedOpId: operation.opId,
                    strategy: dependentStrategy,
                    now: now,
                    alreadyRebased: Set(rebased.values)
                )
                try refreshBlockedState(connection, now: now)
                return ConflictResolutionResult(
                    opId: opId,
                    newOperationIDs: Array(rebased.values).sorted() + newIDs,
                    restoredEntities: [],
                    skippedEntities: []
                )

            case .useServer, .discard:
                let restoration = try restoreBeforeSnapshots(
                    connection,
                    operation: operation,
                    now: now
                )
                if resolution == .useServer {
                    for conflict in try readConflicts(connection, opId: opId) {
                        let key = EntityKey(
                            entityType: conflict.entityType,
                            entityId: conflict.entityId
                        )
                        if !restoration.skipped.contains(key) {
                            try restoreWorkingFromBase(connection, key: key, now: now)
                        }
                    }
                }
                try removeOutbox(connection, opId: opId)
                try setConflictResolution(
                    connection,
                    opId: opId,
                    resolution: resolution == .useServer ? .server : .discarded,
                    now: now
                )
                try insertReceipt(
                    connection,
                    opId: opId,
                    status: "discarded",
                    result: "{\"discarded\":true}",
                    now: now
                )
                let newIDs = try applyDependentStrategy(
                    connection,
                    resolvedOpId: opId,
                    strategy: dependentStrategy,
                    now: now
                )
                try refreshBlockedState(connection, now: now)
                return ConflictResolutionResult(
                    opId: opId,
                    newOperationIDs: newIDs,
                    restoredEntities: restoration.restored,
                    skippedEntities: restoration.skipped
                )
            }
        }
    }
}

// MARK: - Export and import

public extension ObolDatabase {
    /// Token-free local export. It contains the working snapshot, counts,
    /// non-secret binding metadata, unresolved operations, and conflicts.
    func exportJSON() throws -> Data {
        let connection = try requireConnection()
        let snapshot = try loadSnapshot(connection)
        let binding = try loadBinding(connection)
        let outbox = try readOutbox(connection, opId: nil)
        let conflictRows = try readConflicts(connection)
        let counts = ExportCounts(
            entities: EntityCounts(snapshot: snapshot),
            baseRows: try connection.scalarInt("SELECT COUNT(*) FROM base_entities"),
            workingRows: try connection.scalarInt(
                "SELECT COUNT(*) FROM working_entities WHERE deleted = 0"
            ),
            outboxRows: outbox.count,
            conflicts: conflictRows.count,
            appliedOperations: try connection.scalarInt(
                "SELECT COUNT(*) FROM sync_applied_ops"
            )
        )
        let envelope = ExportEnvelope(
            format: "obol.local.snapshot",
            schemaVersion: Self.currentSchemaVersion,
            exportedAt: Date(),
            counts: counts,
            snapshot: snapshot,
            binding: binding,
            outbox: outbox,
            conflicts: conflictRows
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(ObolDate.string(date))
        }
        return try encoder.encode(envelope)
    }

    /// Explicitly replaces local financial data from a previously exported
    /// snapshot. Pending operations are never discarded unless the caller says
    /// so. The snapshot is validated before a single row is changed.
    func importJSON(_ data: Data, mode: ImportMode) throws -> ImportResult {
        let connection = try requireConnection()
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let string = try container.decode(String.self)
            guard let date = ObolDate.parse(string) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Invalid ISO-8601 date: \(string)"
                )
            }
            return date
        }

        let envelope: ExportEnvelope
        do {
            envelope = try decoder.decode(ExportEnvelope.self, from: data)
        } catch {
            throw StoreError.invalidImport(String(describing: error))
        }
        guard envelope.format == "obol.local.snapshot" else {
            throw StoreError.invalidImport("unknown format '\(envelope.format)'")
        }
        guard envelope.schemaVersion <= Self.currentSchemaVersion else {
            throw StoreError.invalidImport(
                "schema version \(envelope.schemaVersion) is newer than this app supports"
            )
        }
        try Self.validateSnapshot(envelope.snapshot)

        let discard: Bool
        switch mode {
        case .replaceFinancialData(let flag):
            discard = flag
        }
        let pendingCount = try connection.scalarInt("SELECT COUNT(*) FROM sync_outbox")
        if pendingCount > 0 && !discard {
            throw StoreError.pendingOperationsPresent(pendingCount)
        }

        let records = try OperationBuilder.snapshotMap(envelope.snapshot)
        try connection.transaction {
            try connection.execute("DELETE FROM base_entities;")
            try connection.execute("DELETE FROM working_entities;")
            try connection.execute("DELETE FROM entity_versions;")
            try connection.execute("DELETE FROM sync_outbox;")
            try connection.execute("DELETE FROM sync_conflicts;")
            try connection.execute("DELETE FROM sync_applied_ops;")
            try connection.execute("DELETE FROM sync_pending_import;")

            let now = Self.iso(Date())
            for (key, value) in records.sorted(by: { $0.key.description < $1.key.description }) {
                let record = CanonicalJSON.string(value)
                try connection.withStatement(
                    """
                    INSERT INTO base_entities
                        (entity_type, entity_id, revision, deleted, record, updated_at)
                    VALUES (?, ?, 0, 0, ?, ?)
                    """
                ) { statement in
                    try statement.bind(1, text: key.entityType.rawValue)
                    try statement.bind(2, text: key.entityId)
                    try statement.bind(3, text: record)
                    try statement.bind(4, text: now)
                    try statement.step()
                }
                try connection.withStatement(
                    """
                    INSERT INTO working_entities
                        (entity_type, entity_id, record, deleted, updated_at)
                    VALUES (?, ?, ?, 0, ?)
                    """
                ) { statement in
                    try statement.bind(1, text: key.entityType.rawValue)
                    try statement.bind(2, text: key.entityId)
                    try statement.bind(3, text: record)
                    try statement.bind(4, text: now)
                    try statement.step()
                }
                try connection.withStatement(
                    """
                    INSERT INTO entity_versions
                        (entity_type, entity_id, server_revision, local_revision, deleted, updated_at)
                    VALUES (?, ?, 0, 1, 0, ?)
                    """
                ) { statement in
                    try statement.bind(1, text: key.entityType.rawValue)
                    try statement.bind(2, text: key.entityId)
                    try statement.bind(3, text: now)
                    try statement.step()
                }
            }

            try connection.withStatement(
                """
                UPDATE sync_state
                SET cursor = 0,
                    cursor_commit_index = NULL,
                    cursor_commit_size = NULL,
                    last_chain_hash = '',
                    server_head_cursor = NULL,
                    server_head_hash = NULL,
                    stop_reason = 'none',
                    stop_detail = NULL,
                    updated_at = ?
                WHERE id = 1
                """
            ) { statement in
                try statement.bind(1, text: now)
                try statement.step()
            }
        }

        return ImportResult(
            counts: EntityCounts(snapshot: envelope.snapshot),
            discardedPendingOperations: discard
        )
    }
}

// MARK: - Pairing transitions

public extension ObolDatabase {
    /// A typed recovery decision is required for one recorded sync stop.
    /// Nothing here silently resets or repairs a binding.
    enum StoppedSyncReason: Equatable, Sendable {
        /// A handshake observed a different `serverInstanceId` or owner
        /// fingerprint under a URL drift resolution.
        case endpointMismatch
        /// The server created a new data epoch; local history cannot be
        /// compared against it any more.
        case dataEpochChanged
        /// The server journal rolled back behind the locally stored cursor.
        case serverRollbackDetected
        /// The stored cursor sits inside a commit group and pull cannot
        /// continue from it.
        case cursorNotOnCommitBoundary

        init(from reason: SyncStopReason) {
            switch reason {
            case .endpointMismatch:
                self = .endpointMismatch
            case .dataEpochChanged:
                self = .dataEpochChanged
            case .serverRollbackDetected:
                self = .serverRollbackDetected
            case .cursorNotOnCommitBoundary:
                self = .cursorNotOnCommitBoundary
            case .none, .authRequired, .protocolUnsupported, .pageInvalid:
                fatalError("Unsupported stopped reason in PairingDecision")
            }
        }
    }

    /// Unpairs from the server while explicitly preserving the finance ledger,
    /// every queued or resolved outbox intent, stored conflicts, pull cursor
    /// and the station identity. Credentials and pending operations are never
    /// sent anywhere by this call. Re-pairing to the same instance later is a
    /// normal resume; pairing to a different origin is validated as a matrix
    /// decision again.
    func disconnectPairingImmediately() throws {
        let connection = try requireConnection()
        try connection.transaction {
            try connection.withStatement(
                """
                UPDATE sync_state
                SET mode = 'standalone',
                    server_url = NULL,
                    server_instance_id = NULL,
                    owner_fingerprint = NULL,
                    server_head_cursor = NULL,
                    server_head_hash = NULL,
                    has_financial_data = NULL,
                    stop_reason = 'none',
                    stop_detail = NULL,
                    updated_at = ?
                WHERE id = 1
                """
            ) { statement in
                try statement.bind(1, text: Self.iso(Date()))
                try statement.step()
            }
        }
    }

    /// Adopts a recorded sync stop so the store can present a fresh pairing
    /// preview again. The binding is cleared to a fresh unpaired state
    /// (epoch 1, cursor 0, genesis hash) so the next handshake registers from
    /// the beginning, while the finance ledger, outbox, conflicts and settled
    /// history stay exactly as they are. Discarding or replacing that data
    /// remains a separate, explicitly confirmed decision.
    func adoptStoppedSync(reason stopped: StoppedSyncReason) throws {
        let connection = try requireConnection()
        try connection.transaction {
            try connection.withStatement(
                """
                UPDATE sync_state
                SET mode = 'standalone',
                    server_url = NULL,
                    server_instance_id = NULL,
                    owner_fingerprint = NULL,
                    data_epoch = 1,
                    cursor = 0,
                    cursor_commit_index = NULL,
                    cursor_commit_size = NULL,
                    last_chain_hash = '',
                    server_head_cursor = NULL,
                    server_head_hash = NULL,
                    has_financial_data = NULL,
                    stop_reason = 'none',
                    stop_detail = NULL,
                    updated_at = ?
                WHERE id = 1
                """
            ) { statement in
                try statement.bind(1, text: Self.iso(Date()))
                try statement.step()
            }
        }
    }

    /// Destructive re-pair primitive: drops the complete local finance data,
    /// outbox, conflicts, receipts and binding in one transaction, returning
    /// the store to the fresh standalone state with the same station
    /// identity. Called only after the pairing wizard validated a typed
    /// REPLACE confirmation and the export offer answer.
    func resetToStandaloneAfterDiscard() throws {
        let connection = try requireConnection()
        try connection.transaction {
            try connection.execute("DELETE FROM base_entities;")
            try connection.execute("DELETE FROM working_entities;")
            try connection.execute("DELETE FROM entity_versions;")
            try connection.execute("DELETE FROM sync_outbox;")
            try connection.execute("DELETE FROM sync_conflicts;")
            try connection.execute("DELETE FROM sync_applied_ops;")
            try connection.execute("DELETE FROM sync_pending_import;")
            let now = Self.iso(Date())
            try connection.withStatement(
                """
                UPDATE sync_state
                SET mode = 'standalone',
                    server_url = NULL,
                    server_instance_id = NULL,
                    owner_fingerprint = NULL,
                    data_epoch = 1,
                    cursor = 0,
                    cursor_commit_index = NULL,
                    cursor_commit_size = NULL,
                    last_chain_hash = '',
                    server_head_cursor = NULL,
                    server_head_hash = NULL,
                    has_financial_data = NULL,
                    stop_reason = 'none',
                    stop_detail = NULL,
                    updated_at = ?
                WHERE id = 1
                """
            ) { statement in
                try statement.bind(1, text: now)
                try statement.step()
            }
        }
    }

    /// Classification facts for the pairing wizard: a store with rows but no
    /// operation history (no pending operation was ever stored and no
    /// operation was ever applied) holds legacy rows that may seed an empty
    /// server; anything else follows the pairing matrix.
    func legacyProfileFacts() throws -> (legacyRows: Bool, entityCount: Int, pendingCount: Int, receiptCount: Int) {
        let connection = try requireConnection()
        let entityCount = try connection.scalarInt(
            "SELECT COUNT(*) FROM working_entities WHERE deleted = 0"
        )
        let pendingCount = try connection.scalarInt("SELECT COUNT(*) FROM sync_outbox")
        let receiptCount = try connection.scalarInt("SELECT COUNT(*) FROM sync_applied_ops")
        let legacyRows = entityCount > 0 && pendingCount == 0 && receiptCount == 0
        return (legacyRows, entityCount, pendingCount, receiptCount)
    }

    // MARK: - Snapshot import (D7 import-as-new)

    /// Freezes one complete materialized snapshot for first pairing without an
    /// existing-ID merge.
    ///
    /// In ONE transaction this mints a fresh 15-character identifier for every
    /// local entity in the seven collections, rewrites every stored record and
    /// relation (including `invoice_id` and `source_invoice_id`), rewrites the
    /// per-entity revisions and stored conflicts, builds and validates the
    /// complete seven-collection snapshot, and persists the immutable import
    /// checkpoint together with the server binding. Covered outbox operation
    /// ids are recorded so that only they are retired once the server accepts.
    ///
    /// The store must never have been paired: a previously paired device never
    /// replays a partial outbox and has no materialized snapshot to transfer.
    /// No network call happens here.
    func prepareSnapshotImport(
        handshake: SyncHandshake,
        serverURL: String?,
        now: Date = Date()
    ) throws -> SnapshotImportCheckpoint {
        let connection = try requireConnection()
        return try connection.transaction {
            let binding = try loadBinding(connection)
            guard binding.serverInstanceId == nil || binding.serverInstanceId?.isEmpty == true
            else {
                throw StoreError.invalidImport(
                    "Snapshot import is only for a never-paired profile; a previously paired device never replays a partial outbox to another endpoint."
                )
            }
            guard binding.cursor == 0, binding.lastChainHash.isEmpty else {
                throw StoreError.invalidImport(
                    "Snapshot import requires an empty local cursor; the journal already advanced."
                )
            }
            guard try connection.scalarInt("SELECT COUNT(*) FROM sync_applied_ops") == 0 else {
                throw StoreError.invalidImport(
                    "Snapshot import requires a profile that never received an accepted operation."
                )
            }
            if let pending = try readPendingSnapshotImport(connection) {
                throw StoreError.snapshotImportPending(
                    "import \(pending.importId) is already frozen; resume it instead of creating another."
                )
            }
            guard handshake.dataEpoch >= 1,
                  handshake.protocolMin <= handshake.protocolMax,
                  handshake.protocolVersion >= handshake.protocolMin,
                  handshake.protocolVersion <= handshake.protocolMax,
                  SyncProtocol.version >= handshake.protocolMin,
                  SyncProtocol.version <= handshake.protocolMax else {
                throw StoreError.invalidImport(
                    "The target server does not accept protocol \(SyncProtocol.version)."
                )
            }
            guard let sanitizedURL = Self.sanitizedServerURL(serverURL),
                  !sanitizedURL.isEmpty else {
                throw StoreError.invalidImport("The target server address is missing.")
            }

            let mapping = try remapLocalNamespace(connection, now: now)
            guard !mapping.isEmpty else {
                throw StoreError.invalidImport(
                    "There is no local financial data to import; adopt the server baseline instead."
                )
            }

            let snapshot = try loadSnapshot(connection)
            try Self.validateSnapshot(snapshot)
            let snapshotValue = try ObolRecordCodec.jsonValue(snapshot)
            let request = try SnapshotImportRequest.make(
                protocolVersion: SyncProtocol.version,
                stationId: binding.stationId,
                serverInstanceId: handshake.serverInstanceId,
                dataEpoch: handshake.dataEpoch,
                importId: SyncIdentifier.uuidv7(at: now),
                snapshot: snapshotValue
            )
            let body = try request.bodyData()
            let rowCount = snapshot.accounts.count + snapshot.cards.count
                + snapshot.categories.count + snapshot.invoices.count
                + snapshot.projects.count + snapshot.recurrences.count
                + snapshot.transactions.count
            guard rowCount <= SyncProtocol.maximumImportRows else {
                throw StoreError.invalidImport(
                    "The snapshot carries \(rowCount) rows; the import bound is \(SyncProtocol.maximumImportRows)."
                )
            }
            guard body.count <= SyncProtocol.maximumImportBytes else {
                throw StoreError.invalidImport(
                    "The snapshot import request is \(body.count) bytes; the bound is \(SyncProtocol.maximumImportBytes)."
                )
            }

            let covered = try outboxIdentifiers(connection)
            try insertPendingSnapshotImport(
                connection,
                request: request,
                snapshotText: CanonicalJSON.string(snapshotValue),
                serverURL: sanitizedURL,
                coveredOperationIDs: covered,
                now: now
            )

            try connection.withStatement(
                """
                UPDATE sync_state
                SET mode = 'paired',
                    server_url = ?,
                    server_instance_id = ?,
                    owner_fingerprint = ?,
                    protocol_version = ?,
                    protocol_min = ?,
                    protocol_max = ?,
                    data_epoch = ?,
                    cursor = 0,
                    cursor_commit_index = NULL,
                    cursor_commit_size = NULL,
                    last_chain_hash = '',
                    server_head_cursor = ?,
                    server_head_hash = ?,
                    has_financial_data = ?,
                    stop_reason = 'none',
                    stop_detail = NULL,
                    updated_at = ?
                WHERE id = 1
                """
            ) { statement in
                try statement.bind(1, text: sanitizedURL)
                try statement.bind(2, text: handshake.serverInstanceId)
                try statement.bind(3, text: handshake.ownerFingerprint)
                try statement.bind(4, int: SyncProtocol.version)
                try statement.bind(5, int: handshake.protocolMin)
                try statement.bind(6, int: handshake.protocolMax)
                try statement.bind(7, int: handshake.dataEpoch)
                try statement.bind(8, int64: handshake.cursor)
                try statement.bind(9, text: handshake.headHash)
                try statement.bind(10, int: handshake.hasFinancialData ? 1 : 0)
                try statement.bind(11, text: Self.iso(now))
                try statement.step()
            }

            return SnapshotImportCheckpoint(
                importId: request.importId,
                stationId: request.stationId,
                serverInstanceId: request.serverInstanceId,
                serverURL: sanitizedURL,
                dataEpoch: request.dataEpoch,
                protocolVersion: request.protocolVersion,
                payloadHash: request.payloadHash,
                body: body,
                coveredOperationIDs: covered,
                counts: EntityCounts(snapshot: snapshot)
            )
        }
    }

    /// The frozen checkpoint, if one exists. Rebuilds the exact request body
    /// from stored fields and re-proves its hash.
    func pendingSnapshotImport() throws -> SnapshotImportCheckpoint? {
        try readPendingSnapshotImport(requireConnection())
    }

    /// Atomically adopts one server-accepted import.
    ///
    /// Imported records become the server baseline at revision 1. Only the
    /// operations covered by the frozen snapshot are retired; operations
    /// created after the checkpoint stay durable, lose dependencies on retired
    /// operations, and advance their causal base revision for imported
    /// entities. Working rows that a later local operation still claims are
    /// never overwritten. The pull cursor is untouched: only a pull advances
    /// it. Any mismatch leaves the checkpoint and every local row intact.
    func applySnapshotImportResult(
        serverInstanceId: String,
        dataEpoch: Int,
        importId: String,
        counts: [String: Int]
    ) throws -> SnapshotImportOutcome {
        let connection = try requireConnection()
        return try connection.transaction {
            guard let checkpoint = try readPendingSnapshotImport(connection) else {
                throw StoreError.invalidArgument("no snapshot import is pending")
            }
            guard checkpoint.importId == importId else {
                throw StoreError.invalidImport(
                    "The server acknowledged import \(importId) while the frozen checkpoint is \(checkpoint.importId)."
                )
            }
            guard checkpoint.serverInstanceId == serverInstanceId,
                  checkpoint.dataEpoch == dataEpoch else {
                throw StoreError.invalidImport(
                    "The import response identity does not match the frozen target."
                )
            }
            let request = try SnapshotImportRequest.decodeBody(checkpoint.body)
            let records = try request.entityRecords()
            let expected = try request.counts()
            guard expected == checkpoint.counts else {
                throw StoreError.invalidImport("The frozen snapshot counts changed.")
            }
            try Self.validateServerCounts(counts, expected: expected)

            var imported = Set<String>()
            for type in EntityType.allCases {
                for record in records[type] ?? [] {
                    guard let object = record.objectValue,
                          let identifier = object["id"]?.stringValue else {
                        throw StoreError.invalidImport(
                            "The frozen \(type.rawValue) record has no identifier."
                        )
                    }
                    imported.insert(EntityKey(entityType: type, entityId: identifier).description)
                }
            }

            let covered = Set(checkpoint.coveredOperationIDs)
            let retained = try loadPendingOperations(connection).filter {
                !covered.contains($0.opId)
            }
            var pendingKeys = Set<EntityKey>()
            for operation in retained {
                pendingKeys.formUnion(operation.writeSet)
                pendingKeys.insert(
                    EntityKey(entityType: operation.entityType, entityId: operation.entityId)
                )
                pendingKeys.formUnion(operation.beforeSnapshots.map(\.key))
            }

            let timestamp = Self.iso(Date())
            for type in EntityType.allCases {
                for record in records[type] ?? [] {
                    guard let object = record.objectValue,
                          let identifier = object["id"]?.stringValue else { continue }
                    let key = EntityKey(entityType: type, entityId: identifier)
                    let recordText = CanonicalJSON.string(record)
                    try upsertBase(
                        connection,
                        key: key,
                        revision: 1,
                        deleted: 0,
                        record: recordText,
                        now: timestamp
                    )
                    let existingLocal = try versionRow(connection, key: key)?.local ?? 0
                    if !pendingKeys.contains(key) {
                        try upsertWorking(
                            connection,
                            key: key,
                            record: recordText,
                            deleted: 0,
                            now: timestamp
                        )
                    }
                    try upsertServerRevision(
                        connection,
                        key: key,
                        revision: 1,
                        deleted: 0,
                        now: timestamp
                    )
                    try setLocalRevision(
                        connection,
                        key: key,
                        localRevision: max(existingLocal, 1),
                        deleted: 0,
                        now: timestamp
                    )
                }
            }

            for opId in checkpoint.coveredOperationIDs {
                try connection.withStatement(
                    "DELETE FROM sync_outbox WHERE op_id = ?"
                ) { statement in
                    try statement.bind(1, text: opId)
                    try statement.step()
                }
                try deleteConflicts(connection, opId: opId)
            }

            var advanced = 0
            for operation in retained {
                var baseRevisions = operation.baseRevisions
                let originalBaseRevisions = baseRevisions
                let dependencies = operation.dependsOn.filter { !covered.contains($0) }
                var causalKeys = Set(operation.writeSet)
                causalKeys.insert(
                    EntityKey(
                        entityType: operation.entityType,
                        entityId: operation.entityId
                    )
                )
                for key in causalKeys where imported.contains(key.description) {
                    let current = baseRevisions[key.description] ?? 0
                    if current < 1 {
                        baseRevisions[key.description] = 1
                        advanced += 1
                    }
                }
                guard baseRevisions != originalBaseRevisions
                        || dependencies != operation.dependsOn else {
                    continue
                }
                guard operation.status == .queued, !operation.isEnvelopeLocked else {
                    throw StoreError.immutableOperationConflict(opId: operation.opId)
                }
                let envelope = SyncOperationEnvelope(
                    protocolVersion: operation.protocolVersion,
                    stationId: operation.stationId,
                    opId: operation.opId,
                    type: operation.type,
                    entityType: operation.entityType,
                    entityId: operation.entityId,
                    payload: operation.payload,
                    baseRevisions: baseRevisions,
                    dependsOn: dependencies,
                    clientCreatedAt: operation.clientCreatedAt,
                    effectiveAt: operation.effectiveAt,
                    payloadHash: ""
                )
                let hash = try SyncHashing.hashEnvelope(envelope)
                try connection.withStatement(
                    """
                    UPDATE sync_outbox
                    SET base_revisions = ?, depends_on = ?, payload_hash = ?,
                        blocked_by = NULL, updated_at = ?
                    WHERE op_id = ?
                    """
                ) { statement in
                    try statement.bind(
                        1,
                        text: try Self.baseRevisionsJSON(baseRevisions)
                    )
                    try statement.bind(
                        2,
                        text: try Self.stringArrayJSON(dependencies)
                    )
                    try statement.bind(3, text: hash)
                    try statement.bind(4, text: timestamp)
                    try statement.bind(5, text: operation.opId)
                    try statement.step()
                }
            }

            try connection.withStatement(
                "DELETE FROM sync_pending_import WHERE id = 1"
            ) { statement in
                try statement.step()
            }
            try refreshBlockedState(connection, now: Date())

            return SnapshotImportOutcome(
                importId: importId,
                counts: expected,
                retiredOperationIDs: checkpoint.coveredOperationIDs,
                retainedOperationIDs: retained.map(\.opId).sorted(),
                advancedBaseRevisions: advanced
            )
        }
    }
}

// MARK: - Snapshot import helpers

private extension ObolDatabase {
    /// Identity fields of a push request besides the operations array. Used as
    /// a conservative byte budget for the D016 body bound.
    static let pushRequestOverheadBytes = 512

    /// Marks a locally impossible send as rejected without touching finance
    /// rows. Dependents are blocked so one oversized intent cannot stall the
    /// whole queue.
    func markLocalRejection(
        _ connection: SQLiteConnection,
        operation: OutboxOperation,
        reason: String,
        now: Date
    ) throws {
        let timestamp = Self.iso(now)
        try connection.withStatement(
            """
            UPDATE sync_outbox
            SET status = 'rejected', last_error = ?, updated_at = ?
            WHERE op_id = ? AND status IN ('queued', 'in_flight')
            """
        ) { statement in
            try statement.bind(1, text: reason)
            try statement.bind(2, text: timestamp)
            try statement.bind(3, text: operation.opId)
            try statement.step()
        }
        try blockDependents(connection, opId: operation.opId, now: now)
    }

    func requireNoPendingSnapshotImport(_ connection: SQLiteConnection) throws {
        if let pending = try readPendingSnapshotImport(connection) {
            throw StoreError.snapshotImportPending(
                "import \(pending.importId) must be accepted before ordinary sync state changes."
            )
        }
    }

    func outboxIdentifiers(_ connection: SQLiteConnection) throws -> [String] {
        try connection.withStatement(
            "SELECT op_id FROM sync_outbox ORDER BY row_id"
        ) { statement in
            var identifiers: [String] = []
            while try statement.step() {
                if let identifier = statement.text(0) {
                    identifiers.append(identifier)
                }
            }
            return identifiers
        }
    }

    func insertPendingSnapshotImport(
        _ connection: SQLiteConnection,
        request: SnapshotImportRequest,
        snapshotText: String,
        serverURL: String,
        coveredOperationIDs: [String],
        now: Date
    ) throws {
        try connection.withStatement(
            """
            INSERT INTO sync_pending_import
                (id, import_id, station_id, server_instance_id, server_url,
                 protocol_version, data_epoch, payload_hash, snapshot,
                 covered_op_ids, created_at)
            VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """
        ) { statement in
            try statement.bind(1, text: request.importId)
            try statement.bind(2, text: request.stationId)
            try statement.bind(3, text: request.serverInstanceId)
            try statement.bind(4, text: serverURL)
            try statement.bind(5, int: request.protocolVersion)
            try statement.bind(6, int: request.dataEpoch)
            try statement.bind(7, text: request.payloadHash)
            try statement.bind(8, text: snapshotText)
            try statement.bind(
                9,
                text: try Self.stringArrayJSON(coveredOperationIDs)
            )
            try statement.bind(10, text: Self.iso(now))
            try statement.step()
        }
    }

    func readPendingSnapshotImport(
        _ connection: SQLiteConnection
    ) throws -> SnapshotImportCheckpoint? {
        let row: (
            importId: String,
            stationId: String,
            serverInstanceId: String,
            serverURL: String,
            protocolVersion: Int,
            dataEpoch: Int,
            payloadHash: String,
            snapshotText: String,
            coveredText: String
        )? = try connection.withStatement(
            """
            SELECT import_id, station_id, server_instance_id, server_url,
                   protocol_version, data_epoch, payload_hash, snapshot,
                   covered_op_ids
            FROM sync_pending_import WHERE id = 1
            """
        ) { statement in
            guard try statement.step(),
                  let importId = statement.text(0),
                  let stationId = statement.text(1),
                  let serverInstanceId = statement.text(2),
                  let serverURL = statement.text(3),
                  let payloadHash = statement.text(6),
                  let snapshotText = statement.text(7),
                  let coveredText = statement.text(8) else {
                return nil
            }
            return (
                importId: importId,
                stationId: stationId,
                serverInstanceId: serverInstanceId,
                serverURL: serverURL,
                protocolVersion: Int(statement.int64(4)),
                dataEpoch: Int(statement.int64(5)),
                payloadHash: payloadHash,
                snapshotText: snapshotText,
                coveredText: coveredText
            )
        }
        guard let row else { return nil }

        let snapshotValue = try JSONValue(parsing: row.snapshotText)
        let request = SnapshotImportRequest(
            protocolVersion: row.protocolVersion,
            stationId: row.stationId,
            serverInstanceId: row.serverInstanceId,
            dataEpoch: row.dataEpoch,
            importId: row.importId,
            snapshot: snapshotValue,
            payloadHash: row.payloadHash
        )
        guard try request.computedPayloadHash() == row.payloadHash else {
            throw StoreError.invalidImport(
                "The frozen snapshot import hash no longer matches its stored fields."
            )
        }
        let covered = try Self.parseStringArray(
            row.coveredText,
            field: "covered_op_ids"
        )
        let body = try request.bodyData()
        guard body.count <= SyncProtocol.maximumImportBytes else {
            throw StoreError.invalidImport(
                "The frozen snapshot import body exceeds its transport bound."
            )
        }
        return SnapshotImportCheckpoint(
            importId: request.importId,
            stationId: request.stationId,
            serverInstanceId: request.serverInstanceId,
            serverURL: row.serverURL,
            dataEpoch: request.dataEpoch,
            protocolVersion: request.protocolVersion,
            payloadHash: request.payloadHash,
            body: body,
            coveredOperationIDs: covered,
            counts: try request.counts()
        )
    }

    /// Mints fresh 15-character identifiers for every stored entity in the
    /// seven collections and rewrites every record, relation, revision and
    /// stored conflict in the same transaction.
    @discardableResult
    func remapLocalNamespace(
        _ connection: SQLiteConnection,
        now: Date
    ) throws -> [EntityType: [String: String]] {
        var keys: [(type: EntityType, id: String)] = []
        try connection.withStatement(
            """
            SELECT entity_type, entity_id FROM base_entities
            UNION
            SELECT entity_type, entity_id FROM working_entities
            """
        ) { statement in
            while try statement.step() {
                guard let typeRaw = statement.text(0),
                      let identifier = statement.text(1),
                      let type = EntityType(rawValue: typeRaw) else {
                    throw StoreError.corruptDatabase(
                        path: databaseURL.path,
                        reason: "stored entity row has an unknown type"
                    )
                }
                keys.append((type, identifier))
            }
        }
        guard !keys.isEmpty else { return [:] }

        var oldIdentifiers = Set(keys.map { $0.id })
        var mapping: [EntityType: [String: String]] = [:]
        for entry in keys.sorted(by: {
            $0.type.rawValue == $1.type.rawValue
                ? $0.id < $1.id
                : $0.type.rawValue < $1.type.rawValue
        }) {
            var newID = EntityID.generate(at: now)
            while oldIdentifiers.contains(newID) || mapping[entry.type]?[newID] != nil {
                newID = EntityID.generate(at: now)
            }
            oldIdentifiers.insert(newID)
            mapping[entry.type, default: [:]][entry.id] = newID
        }

        struct StoredRow {
            let type: EntityType
            let id: String
            let revision: Int
            let localRevision: Int
            let deleted: Int
            let record: String?
        }

        var flattened: [String: String] = [:]
        for entries in mapping.values {
            for (oldID, newID) in entries {
                if let existing = flattened[oldID], existing != newID {
                    throw StoreError.invalidImport(
                        "identifier \(oldID) maps to two different fresh identifiers"
                    )
                }
                flattened[oldID] = newID
            }
        }

        var baseRows: [StoredRow] = []
        try connection.withStatement(
            "SELECT entity_type, entity_id, revision, deleted, record FROM base_entities"
        ) { statement in
            while try statement.step() {
                guard let typeRaw = statement.text(0),
                      let identifier = statement.text(1),
                      let type = EntityType(rawValue: typeRaw) else {
                    throw StoreError.corruptDatabase(
                        path: databaseURL.path,
                        reason: "base entity row has an unknown type"
                    )
                }
                baseRows.append(
                    StoredRow(
                        type: type,
                        id: identifier,
                        revision: Int(statement.int64(2)),
                        localRevision: 0,
                        deleted: Int(statement.int64(3)),
                        record: statement.text(4)
                    )
                )
            }
        }

        var workingRows: [StoredRow] = []
        try connection.withStatement(
            "SELECT entity_type, entity_id, deleted, record FROM working_entities"
        ) { statement in
            while try statement.step() {
                guard let typeRaw = statement.text(0),
                      let identifier = statement.text(1),
                      let type = EntityType(rawValue: typeRaw) else {
                    throw StoreError.corruptDatabase(
                        path: databaseURL.path,
                        reason: "working entity row has an unknown type"
                    )
                }
                workingRows.append(
                    StoredRow(
                        type: type,
                        id: identifier,
                        revision: 0,
                        localRevision: 0,
                        deleted: Int(statement.int64(2)),
                        record: statement.text(3)
                    )
                )
            }
        }

        var versionRows: [StoredRow] = []
        try connection.withStatement(
            """
            SELECT entity_type, entity_id, server_revision, local_revision, deleted
            FROM entity_versions
            """
        ) { statement in
            while try statement.step() {
                guard let typeRaw = statement.text(0),
                      let identifier = statement.text(1),
                      let type = EntityType(rawValue: typeRaw) else {
                    throw StoreError.corruptDatabase(
                        path: databaseURL.path,
                        reason: "entity_versions row has an unknown type"
                    )
                }
                versionRows.append(
                    StoredRow(
                        type: type,
                        id: identifier,
                        revision: Int(statement.int64(2)),
                        localRevision: Int(statement.int64(3)),
                        deleted: Int(statement.int64(4)),
                        record: nil
                    )
                )
            }
        }

        let timestamp = Self.iso(now)
        try connection.execute("DELETE FROM base_entities;")
        try connection.execute("DELETE FROM working_entities;")
        try connection.execute("DELETE FROM entity_versions;")

        for row in baseRows {
            guard let newID = mapping[row.type]?[row.id] else {
                throw StoreError.invalidImport("base entity \(row.type.rawValue):\(row.id) was not remapped")
            }
            let record = try rewriteImportRecordText(
                row.record,
                mapping: flattened
            )
            try connection.withStatement(
                """
                INSERT INTO base_entities
                    (entity_type, entity_id, revision, deleted, record, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """
            ) { statement in
                try statement.bind(1, text: row.type.rawValue)
                try statement.bind(2, text: newID)
                try statement.bind(3, int: row.revision)
                try statement.bind(4, int: row.deleted)
                try statement.bind(5, text: record)
                try statement.bind(6, text: timestamp)
                try statement.step()
            }
        }

        for row in workingRows {
            guard let newID = mapping[row.type]?[row.id] else {
                throw StoreError.invalidImport("working entity \(row.type.rawValue):\(row.id) was not remapped")
            }
            let record = try rewriteImportRecordText(
                row.record,
                mapping: flattened
            )
            try connection.withStatement(
                """
                INSERT INTO working_entities
                    (entity_type, entity_id, record, deleted, updated_at)
                VALUES (?, ?, ?, ?, ?)
                """
            ) { statement in
                try statement.bind(1, text: row.type.rawValue)
                try statement.bind(2, text: newID)
                try statement.bind(3, text: record)
                try statement.bind(4, int: row.deleted)
                try statement.bind(5, text: timestamp)
                try statement.step()
            }
        }

        for row in versionRows {
            guard let newID = mapping[row.type]?[row.id] else {
                throw StoreError.invalidImport("entity version \(row.type.rawValue):\(row.id) was not remapped")
            }
            try connection.withStatement(
                """
                INSERT INTO entity_versions
                    (entity_type, entity_id, server_revision, local_revision,
                     deleted, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """
            ) { statement in
                try statement.bind(1, text: row.type.rawValue)
                try statement.bind(2, text: newID)
                try statement.bind(3, int: row.revision)
                try statement.bind(4, int: row.localRevision)
                try statement.bind(5, int: row.deleted)
                try statement.bind(6, text: timestamp)
                try statement.step()
            }
        }

        var conflicts: [(conflictID: Int64, entityType: EntityType, entityID: String, recordText: String?)] = []
        try connection.withStatement(
            "SELECT conflict_id, entity_type, entity_id, current_record FROM sync_conflicts"
        ) { statement in
            while try statement.step() {
                guard let typeRaw = statement.text(1),
                      let identifier = statement.text(2),
                      let type = EntityType(rawValue: typeRaw) else {
                    throw StoreError.corruptDatabase(
                        path: databaseURL.path,
                        reason: "conflict row has an unknown entity type"
                    )
                }
                conflicts.append(
                    (
                        conflictID: statement.int64(0),
                        entityType: type,
                        entityID: identifier,
                        recordText: statement.text(3)
                    )
                )
            }
        }
        for conflict in conflicts {
            guard let newID = mapping[conflict.entityType]?[conflict.entityID] else {
                throw StoreError.invalidImport("conflict entity was not remapped")
            }
            let record = try rewriteImportRecordText(
                conflict.recordText,
                mapping: flattened
            )
            try connection.withStatement(
                """
                UPDATE sync_conflicts
                SET entity_id = ?, current_record = ?, updated_at = ?
                WHERE conflict_id = ?
                """
            ) { statement in
                try statement.bind(1, text: newID)
                try statement.bind(2, text: record)
                try statement.bind(3, text: timestamp)
                try statement.bind(4, int64: conflict.conflictID)
                try statement.step()
            }
        }

        return mapping
    }

    /// Rewrites every JSON string VALUE that is exactly one of the remapped
    /// identifiers, leaving keys, whitespace and every other byte — including
    /// the exact decimal text of amounts — untouched.
    ///
    /// The identifiers are lowercase alphanumeric, so their JSON encoding is a
    /// plain quoted string. That makes this a byte-preserving remap instead of
    /// a decode/re-encode that would round financial decimals through a binary
    /// double. Field names do not matter, so `id`, `invoice_id`,
    /// `source_invoice_id` and any future relation are all covered.
    func rewriteImportRecordText(
        _ text: String?,
        mapping: [String: String]
    ) throws -> String? {
        guard let text, !mapping.isEmpty else { return text }
        let scalars = text.unicodeScalars
        var output = String()
        output.reserveCapacity(text.count)
        var index = scalars.startIndex

        while index < scalars.endIndex {
            let scalar = scalars[index]
            guard scalar == "\"" else {
                output.unicodeScalars.append(scalar)
                index = scalars.index(after: index)
                continue
            }

            guard let closeQuote = Self.stringTokenEnd(in: scalars, from: index) else {
                throw StoreError.invalidImport("a record contains an unterminated JSON string")
            }
            let contentStart = scalars.index(after: index)
            let content = String(text[contentStart..<closeQuote])

            var lookahead = scalars.index(after: closeQuote)
            while lookahead < scalars.endIndex,
                  Self.isJSONWhitespace(scalars[lookahead]) {
                lookahead = scalars.index(after: lookahead)
            }
            let isKey = lookahead < scalars.endIndex && scalars[lookahead] == ":"

            if !isKey, !content.contains("\\"), let mapped = mapping[content] {
                output.append("\"")
                output.append(mapped)
                output.append("\"")
            } else {
                output.unicodeScalars.append(contentsOf: scalars[index...closeQuote])
            }
            index = scalars.index(after: closeQuote)
        }
        return output
    }

    static func isJSONWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        scalar == " " || scalar == "\t" || scalar == "\n" || scalar == "\r"
    }

    /// Index of the closing quote of a JSON string token that starts at `start`.
    /// Scalars, not Characters: a combining mark after a quote is its own
    /// scalar and can never merge with the structural quote.
    static func stringTokenEnd(
        in scalars: String.UnicodeScalarView,
        from start: String.Index
    ) -> String.Index? {
        var index = scalars.index(after: start)
        var escaped = false
        while index < scalars.endIndex {
            let scalar = scalars[index]
            if escaped {
                escaped = false
            } else if scalar == "\\" {
                escaped = true
            } else if scalar == "\"" {
                return index
            }
            index = scalars.index(after: index)
        }
        return nil
    }

    static func validateServerCounts(
        _ counts: [String: Int],
        expected: EntityCounts
    ) throws {
        let expectedCounts: [EntityType: Int] = [
            .account: expected.accounts,
            .card: expected.cards,
            .category: expected.categories,
            .invoice: expected.invoices,
            .project: expected.projects,
            .recurrence: expected.recurrences,
            .transaction: expected.transactions
        ]
        guard counts.count == expectedCounts.count else {
            throw StoreError.invalidImport(
                "The import response must report exactly the seven singular entity counts."
            )
        }
        for (type, value) in expectedCounts {
            guard counts[type.rawValue] == value else {
                throw StoreError.invalidImport(
                    "The import response reports \(type.rawValue) \(counts[type.rawValue] ?? -1), expected \(value)."
                )
            }
        }
    }
}

// MARK: - Initialization helpers

private extension ObolDatabase {
    static func resolveDirectory(_ explicit: URL?, fileManager: FileManager) throws -> URL {
        if let explicit {
            return explicit.standardizedFileURL
        }
        do {
            let support = try fileManager.url(
                for: .applicationSupportDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            )
            return support
                .appendingPathComponent("Obol", isDirectory: true)
                .standardizedFileURL
        } catch {
            throw StoreError.invalidDirectory(
                path: "Application Support",
                reason: String(describing: error)
            )
        }
    }

    static func prepareDirectory(_ directory: URL, fileManager: FileManager) throws {
        var isDirectory: ObjCBool = false
        if fileManager.fileExists(atPath: directory.path, isDirectory: &isDirectory) {
            guard isDirectory.boolValue else {
                throw StoreError.invalidDirectory(
                    path: directory.path,
                    reason: "the path exists and is not a directory"
                )
            }
        } else {
            do {
                try fileManager.createDirectory(
                    at: directory,
                    withIntermediateDirectories: true
                )
            } catch {
                throw StoreError.invalidDirectory(
                    path: directory.path,
                    reason: String(describing: error)
                )
            }
        }

        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableDirectory = directory
        do {
            try mutableDirectory.setResourceValues(values)
        } catch {
            #if os(iOS) || os(tvOS) || os(watchOS)
            throw StoreError.backupExclusionFailed(
                path: directory.path,
                reason: String(describing: error)
            )
            #else
            // macOS harness volumes and some filesystems do not implement the
            // backup-exclusion attribute. The iOS app container does, and there
            // the failure is fatal.
            #endif
        }

        #if os(iOS)
        do {
            try fileManager.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: directory.path
            )
        } catch {
            throw StoreError.protectionFailed(
                path: directory.path,
                reason: String(describing: error)
            )
        }
        #endif
    }

    static func applyDataProtection(
        directory: URL,
        databaseURL: URL,
        fileManager: FileManager
    ) throws {
        #if os(iOS)
        let protection = FileProtectionType.completeUntilFirstUserAuthentication
        let paths = [
            directory.path,
            databaseURL.path,
            databaseURL.path + "-wal",
            databaseURL.path + "-shm"
        ]
        for path in paths where fileManager.fileExists(atPath: path) {
            do {
                try fileManager.setAttributes([.protectionKey: protection], ofItemAtPath: path)
            } catch {
                throw StoreError.protectionFailed(
                    path: path,
                    reason: String(describing: error)
                )
            }
        }
        #endif
    }

    static func ensureSyncState(
        connection: SQLiteConnection,
        stationId: String,
        databasePath: String,
        now: Date
    ) throws {
        let count = try connection.scalarInt("SELECT COUNT(*) FROM sync_state")
        if count > 0 {
            guard let stored = try connection.scalarText(
                "SELECT station_id FROM sync_state WHERE id = 1"
            ) else {
                throw StoreError.corruptDatabase(
                    path: databasePath,
                    reason: "sync_state row is missing"
                )
            }
            guard Self.isSameStationIdentity(stored, stationId) else {
                throw StoreError.stationIdentityMismatch(
                    stored: stored,
                    installation: stationId
                )
            }
            return
        }
        let timestamp = iso(now)
        try connection.transaction {
            try connection.withStatement(
                """
                INSERT INTO sync_state
                    (id, station_id, mode, protocol_version, data_epoch, cursor,
                     last_chain_hash, stop_reason, created_at, updated_at)
                VALUES (1, ?, 'standalone', ?, 1, 0, '', 'none', ?, ?)
                """
            ) { statement in
                try statement.bind(1, text: stationId)
                try statement.bind(2, int: SyncProtocol.version)
                try statement.bind(3, text: timestamp)
                try statement.bind(4, text: timestamp)
                try statement.step()
            }
        }
    }

    /// Compares two station identifiers as UUIDs so a differently cased
    /// spelling of the same UUID is not reported as an identity change. An
    /// unparseable stored value can never match a validated installation UUID.
    static func isSameStationIdentity(_ stored: String, _ installation: String) -> Bool {
        guard let storedUUID = UUID(uuidString: stored),
              let installationUUID = UUID(uuidString: installation) else {
            return false
        }
        return storedUUID == installationUUID
    }

    fileprivate static func iso(_ date: Date) -> String {
        ObolDate.string(date)
    }

    fileprivate static func sanitizedServerURL(_ value: String?) -> String? {
        guard let value else { return nil }
        guard var components = URLComponents(string: value) else { return nil }
        components.user = nil
        components.password = nil
        components.query = nil
        components.fragment = nil
        return components.string
    }

    fileprivate static func date(_ string: String, entityType: String, entityId: String) throws -> Date {
        guard let parsed = ObolDate.parse(string) else {
            throw StoreError.corruptRecord(
                entityType: entityType,
                entityId: entityId,
                reason: "invalid ISO-8601 date \(string)"
            )
        }
        return parsed
    }
}

// MARK: - Core persistence helpers

private extension ObolDatabase {
    func requireConnection() throws -> SQLiteConnection {
        guard let connection else { throw StoreError.notOpen }
        return connection
    }

    func loadSnapshot(_ connection: SQLiteConnection) throws -> FinancialSnapshot {
        var accounts: [Account] = []
        var cards: [Card] = []
        var categories: [ObolCore.Category] = []
        var invoices: [Invoice] = []
        var projects: [Project] = []
        var recurrences: [Recurrence] = []
        var transactions: [Transaction] = []

        try connection.withStatement(
            """
            SELECT entity_type, entity_id, record
            FROM working_entities
            WHERE deleted = 0 AND record IS NOT NULL
            ORDER BY entity_type, entity_id
            """
        ) { statement in
            while try statement.step() {
                guard let typeRaw = statement.text(0),
                      let identifier = statement.text(1),
                      let record = statement.text(2),
                      let type = EntityType(rawValue: typeRaw) else {
                    throw StoreError.corruptDatabase(
                        path: databaseURL.path,
                        reason: "working entity row is incomplete"
                    )
                }
                let key = EntityKey(entityType: type, entityId: identifier)
                switch type {
                case .account:
                    accounts.append(try decode(Account.self, record, key: key))
                case .card:
                    cards.append(try decode(Card.self, record, key: key))
                case .category:
                    categories.append(try decode(ObolCore.Category.self, record, key: key))
                case .invoice:
                    invoices.append(try decode(Invoice.self, record, key: key))
                case .project:
                    projects.append(try decode(Project.self, record, key: key))
                case .recurrence:
                    recurrences.append(try decode(Recurrence.self, record, key: key))
                case .transaction:
                    transactions.append(try decode(Transaction.self, record, key: key))
                }
            }
        }

        return FinancialSnapshot(
            accounts: accounts,
            cards: cards,
            categories: categories,
            invoices: invoices,
            projects: projects,
            recurrences: recurrences,
            transactions: transactions
        )
    }

    func decode<T: Decodable>(_ type: T.Type, _ record: String, key: EntityKey) throws -> T {
        do {
            return try ObolRecordCodec.decode(type, from: record)
        } catch {
            throw StoreError.corruptRecord(
                entityType: key.entityType.rawValue,
                entityId: key.entityId,
                reason: String(describing: error)
            )
        }
    }

    func loadBinding(_ connection: SQLiteConnection) throws -> SyncBinding {
        try connection.withStatement(
            """
            SELECT station_id, mode, server_url, server_instance_id, owner_fingerprint,
                   protocol_version, protocol_min, protocol_max, data_epoch, cursor,
                   cursor_commit_index, cursor_commit_size, last_chain_hash,
                   server_head_cursor, server_head_hash, has_financial_data,
                   stop_reason, stop_detail
            FROM sync_state WHERE id = 1
            """
        ) { statement in
            guard try statement.step(),
                  let stationID = statement.text(0),
                  let modeRaw = statement.text(1),
                  let mode = StoreMode(rawValue: modeRaw),
                  let stopRaw = statement.text(16),
                  let stopReason = SyncStopReason(rawValue: stopRaw) else {
                throw StoreError.corruptDatabase(
                    path: databaseURL.path,
                    reason: "sync_state row is missing or invalid"
                )
            }
            return SyncBinding(
                stationId: stationID,
                mode: mode,
                serverURL: statement.text(2),
                serverInstanceId: statement.text(3),
                ownerFingerprint: statement.text(4),
                protocolVersion: Int(statement.int64(5)),
                protocolMin: statement.isNull(6) ? nil : Int(statement.int64(6)),
                protocolMax: statement.isNull(7) ? nil : Int(statement.int64(7)),
                dataEpoch: Int(statement.int64(8)),
                cursor: statement.int64(9),
                cursorCommitIndex: statement.isNull(10) ? nil : Int(statement.int64(10)),
                cursorCommitSize: statement.isNull(11) ? nil : Int(statement.int64(11)),
                lastChainHash: statement.text(12) ?? "",
                serverHeadCursor: statement.isNull(13) ? nil : statement.int64(13),
                serverHeadHash: statement.text(14),
                hasFinancialData: statement.isNull(15) ? nil : statement.int64(15) != 0,
                stopReason: stopReason,
                stopDetail: statement.text(17)
            )
        }
    }

    func updateStopReason(
        _ connection: SQLiteConnection,
        reason: SyncStopReason,
        detail: String?,
        now: Date
    ) throws {
        try connection.withStatement(
            """
            UPDATE sync_state
            SET stop_reason = ?, stop_detail = ?, updated_at = ?
            WHERE id = 1
            """
        ) { statement in
            try statement.bind(1, text: reason.rawValue)
            try statement.bind(2, text: detail)
            try statement.bind(3, text: Self.iso(now))
            try statement.step()
        }
    }

    func planningContext(
        _ connection: SQLiteConnection,
        effectiveAt: Date,
        clientCreatedAt: Date
    ) throws -> OperationPlanningContext {
        let binding = try loadBinding(connection)
        let revisions = try loadServerRevisions(connection)
        let pending = try loadPendingOperationIdsByEntity(connection)
        return OperationPlanningContext(
            stationId: binding.stationId,
            protocolVersion: SyncProtocol.version,
            clientCreatedAt: clientCreatedAt,
            effectiveAt: effectiveAt,
            observedServerRevisions: revisions,
            pendingOperationIdsByEntity: pending
        )
    }

    func loadServerRevisions(_ connection: SQLiteConnection) throws -> [EntityKey: Int] {
        var revisions: [EntityKey: Int] = [:]
        try connection.withStatement(
            """
            SELECT entity_type, entity_id, server_revision
            FROM entity_versions
            WHERE server_revision > 0
            """
        ) { statement in
            while try statement.step() {
                guard let typeRaw = statement.text(0),
                      let identifier = statement.text(1),
                      let type = EntityType(rawValue: typeRaw) else {
                    throw StoreError.corruptDatabase(
                        path: databaseURL.path,
                        reason: "entity_versions row is invalid"
                    )
                }
                revisions[EntityKey(entityType: type, entityId: identifier)] =
                    Int(statement.int64(2))
            }
        }
        return revisions
    }

    func loadPendingOperationIdsByEntity(
        _ connection: SQLiteConnection
    ) throws -> [EntityKey: [String]] {
        let operations = try loadPendingOperations(connection)
        var result: [EntityKey: [String]] = [:]
        for operation in operations {
            var keys = Set(operation.writeSet)
            keys.insert(EntityKey(entityType: operation.entityType, entityId: operation.entityId))
            keys.formUnion(operation.beforeSnapshots.map(\.key))
            for key in keys {
                result[key, default: []].append(operation.opId)
            }
        }
        return result
    }

    func loadPendingOperations(_ connection: SQLiteConnection) throws -> [OutboxOperation] {
        try readOutbox(connection, opId: nil).filter { $0.status != .accepted }
    }

    func pendingEntityKeys(
        _ connection: SQLiteConnection,
        excludingOpId: String?
    ) throws -> Set<EntityKey> {
        var keys = Set<EntityKey>()
        for operation in try readOutbox(connection, opId: nil) {
            if let excludingOpId, operation.opId == excludingOpId { continue }
            keys.formUnion(operation.writeSet)
            keys.insert(EntityKey(entityType: operation.entityType, entityId: operation.entityId))
            keys.formUnion(operation.beforeSnapshots.map(\.key))
        }
        return keys
    }

    func writeWorkingChanges(
        _ connection: SQLiteConnection,
        after: FinancialSnapshot,
        changed: [EntityKey],
        now: Date
    ) throws {
        let afterMap = try OperationBuilder.snapshotMap(after)
        let timestamp = Self.iso(now)
        for key in changed {
            let recordText: String?
            if let record = afterMap[key] {
                recordText = CanonicalJSON.string(record)
            } else {
                recordText = nil
            }
            let nextLocal = try localRevision(connection, key: key) + 1

            try connection.withStatement(
                """
                INSERT INTO working_entities (entity_type, entity_id, record, deleted, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(entity_type, entity_id) DO UPDATE SET
                    record = excluded.record,
                    deleted = excluded.deleted,
                    updated_at = excluded.updated_at
                """
            ) { statement in
                try statement.bind(1, text: key.entityType.rawValue)
                try statement.bind(2, text: key.entityId)
                try statement.bind(3, text: recordText)
                try statement.bind(4, int: recordText == nil ? 1 : 0)
                try statement.bind(5, text: timestamp)
                try statement.step()
            }

            try connection.withStatement(
                """
                INSERT INTO entity_versions
                    (entity_type, entity_id, server_revision, local_revision, deleted, updated_at)
                VALUES (?, ?, 0, ?, ?, ?)
                ON CONFLICT(entity_type, entity_id) DO UPDATE SET
                    local_revision = excluded.local_revision,
                    deleted = excluded.deleted,
                    updated_at = excluded.updated_at
                """
            ) { statement in
                try statement.bind(1, text: key.entityType.rawValue)
                try statement.bind(2, text: key.entityId)
                try statement.bind(3, int: nextLocal)
                try statement.bind(4, int: recordText == nil ? 1 : 0)
                try statement.bind(5, text: timestamp)
                try statement.step()
            }
        }
    }

    func localRevision(_ connection: SQLiteConnection, key: EntityKey) throws -> Int {
        try connection.withStatement(
            """
            SELECT local_revision FROM entity_versions
            WHERE entity_type = ? AND entity_id = ?
            """
        ) { statement in
            try statement.bind(1, text: key.entityType.rawValue)
            try statement.bind(2, text: key.entityId)
            guard try statement.step() else { return 0 }
            return Int(statement.int64(0))
        }
    }

    func serverRevision(_ connection: SQLiteConnection, key: EntityKey) throws -> Int? {
        try connection.withStatement(
            """
            SELECT server_revision FROM entity_versions
            WHERE entity_type = ? AND entity_id = ?
            """
        ) { statement in
            try statement.bind(1, text: key.entityType.rawValue)
            try statement.bind(2, text: key.entityId)
            guard try statement.step() else { return nil }
            return Int(statement.int64(0))
        }
    }

    func insertOperations(
        _ connection: SQLiteConnection,
        planned: [PlannedOperation],
        context: OperationPlanningContext
    ) throws {
        for operation in planned {
            let envelope = SyncOperationEnvelope(
                protocolVersion: context.protocolVersion,
                stationId: context.stationId,
                opId: operation.opId,
                type: operation.type,
                entityType: operation.entityType,
                entityId: operation.entityId,
                payload: operation.payload,
                baseRevisions: operation.baseRevisions,
                dependsOn: operation.dependsOn,
                clientCreatedAt: context.clientCreatedAt,
                effectiveAt: context.effectiveAt,
                payloadHash: ""
            )
            let hash = try SyncHashing.hashEnvelope(envelope)
            let timestamp = Self.iso(context.clientCreatedAt)

            var beforeObject: [String: JSONValue] = [:]
            for snapshot in operation.beforeSnapshots {
                beforeObject[snapshot.key.description] = snapshot.record ?? .null
            }

            try connection.withStatement(
                """
                INSERT INTO sync_outbox
                    (op_id, station_id, protocol_version, operation_type, entity_type,
                     entity_id, payload, base_revisions, depends_on, write_set,
                     client_created_at, effective_at, payload_hash, status,
                     envelope_locked, attempts, last_error, blocked_by,
                     before_snapshots, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 0,
                        NULL, NULL, ?, ?, ?)
                """
            ) { statement in
                try statement.bind(1, text: operation.opId)
                try statement.bind(2, text: context.stationId)
                try statement.bind(3, int: context.protocolVersion)
                try statement.bind(4, text: operation.type.rawValue)
                try statement.bind(5, text: operation.entityType.rawValue)
                try statement.bind(6, text: operation.entityId)
                try statement.bind(7, text: CanonicalJSON.string(operation.payload))
                try statement.bind(8, text: try Self.baseRevisionsJSON(operation.baseRevisions))
                try statement.bind(9, text: try Self.stringArrayJSON(operation.dependsOn))
                try statement.bind(
                    10,
                    text: try Self.stringArrayJSON(
                        operation.writeSet.map(\.description)
                    )
                )
                try statement.bind(11, text: Self.iso(context.clientCreatedAt))
                try statement.bind(12, text: Self.iso(context.effectiveAt))
                try statement.bind(13, text: hash)
                try statement.bind(14, text: CanonicalJSON.string(.object(beforeObject)))
                try statement.bind(15, text: timestamp)
                try statement.bind(16, text: timestamp)
                try statement.step()
            }
        }
    }

    fileprivate static func baseRevisionsJSON(_ values: [String: Int]) throws -> String {
        var object: [String: JSONValue] = [:]
        for (key, value) in values {
            object[key] = .number(Decimal(value))
        }
        return CanonicalJSON.string(.object(object))
    }

    fileprivate static func stringArrayJSON(_ values: [String]) throws -> String {
        CanonicalJSON.string(.array(values.map { .string($0) }))
    }

    func readOutbox(
        _ connection: SQLiteConnection,
        opId: String?
    ) throws -> [OutboxOperation] {
        let sql: String
        if opId == nil {
            sql = """
                SELECT op_id, station_id, protocol_version, operation_type, entity_type,
                       entity_id, payload, base_revisions, depends_on, write_set,
                       client_created_at, effective_at, payload_hash, status,
                       envelope_locked, attempts, last_error, blocked_by,
                       before_snapshots, created_at, updated_at
                FROM sync_outbox
                ORDER BY row_id
                """
        } else {
            sql = """
                SELECT op_id, station_id, protocol_version, operation_type, entity_type,
                       entity_id, payload, base_revisions, depends_on, write_set,
                       client_created_at, effective_at, payload_hash, status,
                       envelope_locked, attempts, last_error, blocked_by,
                       before_snapshots, created_at, updated_at
                FROM sync_outbox
                WHERE op_id = ?
                ORDER BY row_id
                """
        }

        return try connection.withStatement(sql) { statement in
            if let opId {
                try statement.bind(1, text: opId)
            }
            var operations: [OutboxOperation] = []
            while try statement.step() {
                guard let identifier = statement.text(0),
                      let stationID = statement.text(1),
                      let typeRaw = statement.text(3),
                      let type = OperationType(rawValue: typeRaw),
                      let entityTypeRaw = statement.text(4),
                      let entityType = EntityType(rawValue: entityTypeRaw),
                      let entityID = statement.text(5),
                      let payloadText = statement.text(6),
                      let baseText = statement.text(7),
                      let dependsText = statement.text(8),
                      let writeSetText = statement.text(9),
                      let clientText = statement.text(10),
                      let effectiveText = statement.text(11),
                      let hash = statement.text(12),
                      let statusRaw = statement.text(13),
                      let status = OutboxStatus(rawValue: statusRaw),
                      let beforeText = statement.text(18),
                      let createdText = statement.text(19),
                      let updatedText = statement.text(20) else {
                    throw StoreError.corruptDatabase(
                        path: databaseURL.path,
                        reason: "outbox row is incomplete"
                    )
                }

                let baseRevisions = try Self.parseBaseRevisions(baseText)
                let dependsOn = try Self.parseStringArray(dependsText, field: "depends_on")
                let writeSet = try Self.parseEntityKeys(writeSetText)
                let beforeSnapshots = try Self.parseBeforeSnapshots(beforeText)

                operations.append(
                    OutboxOperation(
                        opId: identifier,
                        stationId: stationID,
                        protocolVersion: Int(statement.int64(2)),
                        type: type,
                        entityType: entityType,
                        entityId: entityID,
                        payload: try JSONValue(parsing: payloadText),
                        baseRevisions: baseRevisions,
                        dependsOn: dependsOn,
                        writeSet: writeSet,
                        clientCreatedAt: try Self.date(
                            clientText,
                            entityType: "outbox",
                            entityId: identifier
                        ),
                        effectiveAt: try Self.date(
                            effectiveText,
                            entityType: "outbox",
                            entityId: identifier
                        ),
                        payloadHash: hash,
                        status: status,
                        isEnvelopeLocked: statement.int64(14) != 0,
                        attempts: Int(statement.int64(15)),
                        lastError: statement.text(16),
                        blockedBy: statement.text(17),
                        beforeSnapshots: beforeSnapshots,
                        createdAt: try Self.date(
                            createdText,
                            entityType: "outbox",
                            entityId: identifier
                        ),
                        updatedAt: try Self.date(
                            updatedText,
                            entityType: "outbox",
                            entityId: identifier
                        )
                    )
                )
            }
            return operations
        }
    }

    static func parseBaseRevisions(_ text: String) throws -> [String: Int] {
        let value: JSONValue
        do {
            value = try JSONValue(parsing: text)
        } catch {
            throw StoreError.corruptDatabase(
                path: "<outbox>",
                reason: "base_revisions is not JSON: \(error)"
            )
        }
        guard case .object(let object) = value else {
            throw StoreError.corruptDatabase(
                path: "<outbox>",
                reason: "base_revisions is not an object"
            )
        }
        var result: [String: Int] = [:]
        for (key, element) in object {
            guard let number = element.intValue else {
                throw StoreError.corruptDatabase(
                    path: "<outbox>",
                    reason: "base_revisions value for \(key) is not an integer"
                )
            }
            result[key] = number
        }
        return result
    }

    static func parseStringArray(_ text: String, field: String) throws -> [String] {
        let value: JSONValue
        do {
            value = try JSONValue(parsing: text)
        } catch {
            throw StoreError.corruptDatabase(
                path: "<outbox>",
                reason: "\(field) is not JSON: \(error)"
            )
        }
        guard case .array(let array) = value else {
            throw StoreError.corruptDatabase(
                path: "<outbox>",
                reason: "\(field) is not an array"
            )
        }
        return try array.map { element in
            guard let string = element.stringValue else {
                throw StoreError.corruptDatabase(
                    path: "<outbox>",
                    reason: "\(field) entry is not a string"
                )
            }
            return string
        }
    }

    static func parseEntityKeys(_ text: String) throws -> [EntityKey] {
        let values = try parseStringArray(text, field: "write_set")
        return try values.map { value in
            guard let key = EntityKey(description: value) else {
                throw StoreError.corruptDatabase(
                    path: "<outbox>",
                    reason: "write_set entry \(value) is invalid"
                )
            }
            return key
        }
    }

    static func parseBeforeSnapshots(_ text: String) throws -> [EntitySnapshot] {
        let value: JSONValue
        do {
            value = try JSONValue(parsing: text)
        } catch {
            throw StoreError.corruptDatabase(
                path: "<outbox>",
                reason: "before_snapshots is not JSON: \(error)"
            )
        }
        guard case .object(let object) = value else {
            throw StoreError.corruptDatabase(
                path: "<outbox>",
                reason: "before_snapshots is not an object"
            )
        }
        return try object.keys.sorted().map { keyText in
            guard let key = EntityKey(description: keyText) else {
                throw StoreError.corruptDatabase(
                    path: "<outbox>",
                    reason: "before_snapshots key \(keyText) is invalid"
                )
            }
            let record: JSONValue?
            if let element = object[keyText], element != .null {
                record = element
            } else {
                record = nil
            }
            return EntitySnapshot(key: key, record: record)
        }
    }

    func removeOutbox(_ connection: SQLiteConnection, opId: String) throws {
        try connection.withStatement("DELETE FROM sync_outbox WHERE op_id = ?") { statement in
            try statement.bind(1, text: opId)
            try statement.step()
        }
        guard try connection.changes() == 1 else {
            throw StoreError.operationNotFound(opId)
        }
    }

    func outboxQueuedIdentifiers(_ connection: SQLiteConnection) throws -> [String] {
        try connection.withStatement(
            "SELECT op_id FROM sync_outbox WHERE status = 'queued' ORDER BY row_id"
        ) { statement in
            var identifiers: [String] = []
            while try statement.step() {
                if let identifier = statement.text(0) {
                    identifiers.append(identifier)
                }
            }
            return identifiers
        }
    }

    func dependenciesSatisfied(
        _ connection: SQLiteConnection,
        _ dependencies: [String]
    ) throws -> Bool {
        for dependency in dependencies {
            if let receipt = try readReceipt(connection, opId: dependency) {
                if receipt.status == "applied" || receipt.status == "duplicate" {
                    continue
                }
                return false
            }
            if let operation = try readOutbox(connection, opId: dependency).first {
                if operation.status == .accepted { continue }
                return false
            }
            return false
        }
        return true
    }

    /// The exact envelope `finalizeForSend` would persist, before any write.
    /// The placeholder hash has the real 50-character shape so the byte bound
    /// measurement is not optimistic.
    func projectedEnvelopeForSend(
        _ connection: SQLiteConnection,
        operation: OutboxOperation
    ) throws -> SyncOperationEnvelope {
        let baseRevisions: [String: Int]
        if operation.isEnvelopeLocked {
            baseRevisions = operation.baseRevisions
        } else {
            var computed: [String: Int] = [:]
            for key in operation.writeSet {
                if let revision = try serverRevision(connection, key: key), revision > 0 {
                    computed[key.description] = revision
                }
            }
            baseRevisions = computed
        }
        return SyncOperationEnvelope(
            protocolVersion: operation.protocolVersion,
            stationId: operation.stationId,
            opId: operation.opId,
            type: operation.type,
            entityType: operation.entityType,
            entityId: operation.entityId,
            payload: operation.payload,
            baseRevisions: baseRevisions,
            dependsOn: operation.dependsOn,
            clientCreatedAt: operation.clientCreatedAt,
            effectiveAt: operation.effectiveAt,
            payloadHash: operation.isEnvelopeLocked
                ? operation.payloadHash
                : "sha256:" + String(repeating: "A", count: 43)
        )
    }

    func finalizeForSend(
        _ connection: SQLiteConnection,
        operation: OutboxOperation,
        now: Date
    ) throws -> OutboxOperation {
        let timestamp = Self.iso(now)
        let nextAttempt = operation.attempts + 1

        if operation.isEnvelopeLocked {
            try connection.withStatement(
                """
                UPDATE sync_outbox
                SET status = 'in_flight', attempts = ?, last_error = NULL, updated_at = ?
                WHERE op_id = ?
                """
            ) { statement in
                try statement.bind(1, int: nextAttempt)
                try statement.bind(2, text: timestamp)
                try statement.bind(3, text: operation.opId)
                try statement.step()
            }
            return Self.copy(
                operation,
                status: .inFlight,
                attempts: nextAttempt,
                updatedAt: now
            )
        }

        var baseRevisions: [String: Int] = [:]
        for key in operation.writeSet {
            if let revision = try serverRevision(connection, key: key), revision > 0 {
                baseRevisions[key.description] = revision
            }
        }
        let envelope = SyncOperationEnvelope(
            protocolVersion: operation.protocolVersion,
            stationId: operation.stationId,
            opId: operation.opId,
            type: operation.type,
            entityType: operation.entityType,
            entityId: operation.entityId,
            payload: operation.payload,
            baseRevisions: baseRevisions,
            dependsOn: operation.dependsOn,
            clientCreatedAt: operation.clientCreatedAt,
            effectiveAt: operation.effectiveAt,
            payloadHash: ""
        )
        let hash = try SyncHashing.hashEnvelope(envelope)

        try connection.withStatement(
            """
            UPDATE sync_outbox
            SET base_revisions = ?, payload_hash = ?, status = 'in_flight',
                envelope_locked = 1, attempts = ?, last_error = NULL, updated_at = ?
            WHERE op_id = ?
            """
        ) { statement in
            try statement.bind(1, text: try Self.baseRevisionsJSON(baseRevisions))
            try statement.bind(2, text: hash)
            try statement.bind(3, int: nextAttempt)
            try statement.bind(4, text: timestamp)
            try statement.bind(5, text: operation.opId)
            try statement.step()
        }

        return Self.copy(
            operation,
            baseRevisions: baseRevisions,
            payloadHash: hash,
            status: .inFlight,
            isEnvelopeLocked: true,
            attempts: nextAttempt,
            updatedAt: now
        )
    }

    static func copy(
        _ operation: OutboxOperation,
        baseRevisions: [String: Int]? = nil,
        payloadHash: String? = nil,
        status: OutboxStatus? = nil,
        isEnvelopeLocked: Bool? = nil,
        attempts: Int? = nil,
        updatedAt: Date? = nil
    ) -> OutboxOperation {
        OutboxOperation(
            opId: operation.opId,
            stationId: operation.stationId,
            protocolVersion: operation.protocolVersion,
            type: operation.type,
            entityType: operation.entityType,
            entityId: operation.entityId,
            payload: operation.payload,
            baseRevisions: baseRevisions ?? operation.baseRevisions,
            dependsOn: operation.dependsOn,
            writeSet: operation.writeSet,
            clientCreatedAt: operation.clientCreatedAt,
            effectiveAt: operation.effectiveAt,
            payloadHash: payloadHash ?? operation.payloadHash,
            status: status ?? operation.status,
            isEnvelopeLocked: isEnvelopeLocked ?? operation.isEnvelopeLocked,
            attempts: attempts ?? operation.attempts,
            lastError: operation.lastError,
            blockedBy: operation.blockedBy,
            beforeSnapshots: operation.beforeSnapshots,
            createdAt: operation.createdAt,
            updatedAt: updatedAt ?? operation.updatedAt
        )
    }
}

// MARK: - Server entity application

private extension ObolDatabase {
    @discardableResult
    func applyServerEntity(
        _ connection: SQLiteConnection,
        entity: ServerEntity,
        now: Date,
        pendingKeys: Set<EntityKey>
    ) throws -> Bool {
        try validateServerEntity(entity)
        let key = EntityKey(entityType: entity.entityType, entityId: entity.entityId)
        let current = try serverRevision(connection, key: key) ?? 0
        let advanced = entity.revision > current

        let recordText: String?
        if let record = entity.record {
            recordText = CanonicalJSON.string(record)
        } else {
            recordText = nil
        }
        let timestamp = Self.iso(now)
        let deleted = recordText == nil ? 1 : 0

        if advanced {
            try upsertBase(
                connection,
                key: key,
                revision: entity.revision,
                deleted: deleted,
                record: recordText,
                now: timestamp
            )
            try upsertServerRevision(
                connection,
                key: key,
                revision: entity.revision,
                deleted: deleted,
                now: timestamp
            )
        }

        if entity.revision >= current, !pendingKeys.contains(key) {
            try upsertWorking(
                connection,
                key: key,
                record: recordText,
                deleted: deleted,
                now: timestamp
            )
            try setLocalRevision(
                connection,
                key: key,
                localRevision: try localRevision(connection, key: key) + 1,
                deleted: deleted,
                now: timestamp
            )
        }
        return advanced
    }

    func validateServerEntity(_ entity: ServerEntity) throws {
        guard !entity.entityId.isEmpty else {
            throw StoreError.invalidServerEntity("empty entity id")
        }
        guard entity.revision > 0 else {
            throw StoreError.invalidServerEntity("revision must be positive")
        }
        if let record = entity.record {
            guard let object = record.objectValue,
                  let identifier = object["id"]?.stringValue,
                  identifier == entity.entityId else {
                throw StoreError.invalidServerEntity(
                    "record id does not match \(entity.entityType.rawValue):\(entity.entityId)"
                )
            }
            let recordText = CanonicalJSON.string(record)
            do {
                switch entity.entityType {
                case .account:
                    _ = try ObolRecordCodec.decode(Account.self, from: recordText)
                case .card:
                    _ = try ObolRecordCodec.decode(Card.self, from: recordText)
                case .category:
                    _ = try ObolRecordCodec.decode(ObolCore.Category.self, from: recordText)
                case .invoice:
                    _ = try ObolRecordCodec.decode(Invoice.self, from: recordText)
                case .project:
                    _ = try ObolRecordCodec.decode(Project.self, from: recordText)
                case .recurrence:
                    _ = try ObolRecordCodec.decode(Recurrence.self, from: recordText)
                case .transaction:
                    _ = try ObolRecordCodec.decode(Transaction.self, from: recordText)
                }
            } catch {
                throw StoreError.invalidServerEntity(
                    "record for \(entity.entityType.rawValue):\(entity.entityId) cannot be decoded: \(error)"
                )
            }
        }
    }

    func upsertBase(
        _ connection: SQLiteConnection,
        key: EntityKey,
        revision: Int,
        deleted: Int,
        record: String?,
        now: String
    ) throws {
        try connection.withStatement(
            """
            INSERT INTO base_entities (entity_type, entity_id, revision, deleted, record, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(entity_type, entity_id) DO UPDATE SET
                revision = excluded.revision,
                deleted = excluded.deleted,
                record = excluded.record,
                updated_at = excluded.updated_at
            """
        ) { statement in
            try statement.bind(1, text: key.entityType.rawValue)
            try statement.bind(2, text: key.entityId)
            try statement.bind(3, int: revision)
            try statement.bind(4, int: deleted)
            try statement.bind(5, text: record)
            try statement.bind(6, text: now)
            try statement.step()
        }
    }

    func upsertServerRevision(
        _ connection: SQLiteConnection,
        key: EntityKey,
        revision: Int,
        deleted: Int,
        now: String
    ) throws {
        try connection.withStatement(
            """
            INSERT INTO entity_versions
                (entity_type, entity_id, server_revision, local_revision, deleted, updated_at)
            VALUES (?, ?, ?, 0, ?, ?)
            ON CONFLICT(entity_type, entity_id) DO UPDATE SET
                server_revision = excluded.server_revision,
                deleted = excluded.deleted,
                updated_at = excluded.updated_at
            """
        ) { statement in
            try statement.bind(1, text: key.entityType.rawValue)
            try statement.bind(2, text: key.entityId)
            try statement.bind(3, int: revision)
            try statement.bind(4, int: deleted)
            try statement.bind(5, text: now)
            try statement.step()
        }
    }

    func upsertWorking(
        _ connection: SQLiteConnection,
        key: EntityKey,
        record: String?,
        deleted: Int,
        now: String
    ) throws {
        try connection.withStatement(
            """
            INSERT INTO working_entities (entity_type, entity_id, record, deleted, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(entity_type, entity_id) DO UPDATE SET
                record = excluded.record,
                deleted = excluded.deleted,
                updated_at = excluded.updated_at
            """
        ) { statement in
            try statement.bind(1, text: key.entityType.rawValue)
            try statement.bind(2, text: key.entityId)
            try statement.bind(3, text: record)
            try statement.bind(4, int: deleted)
            try statement.bind(5, text: now)
            try statement.step()
        }
    }

    func setLocalRevision(
        _ connection: SQLiteConnection,
        key: EntityKey,
        localRevision: Int,
        deleted: Int,
        now: String
    ) throws {
        try connection.withStatement(
            """
            INSERT INTO entity_versions
                (entity_type, entity_id, server_revision, local_revision, deleted, updated_at)
            VALUES (?, ?, 0, ?, ?, ?)
            ON CONFLICT(entity_type, entity_id) DO UPDATE SET
                local_revision = excluded.local_revision,
                deleted = excluded.deleted,
                updated_at = excluded.updated_at
            """
        ) { statement in
            try statement.bind(1, text: key.entityType.rawValue)
            try statement.bind(2, text: key.entityId)
            try statement.bind(3, int: localRevision)
            try statement.bind(4, int: deleted)
            try statement.bind(5, text: now)
            try statement.step()
        }
    }

    func restoreWorkingFromBase(
        _ connection: SQLiteConnection,
        key: EntityKey,
        now: Date
    ) throws {
        let timestamp = Self.iso(now)
        let base = try baseEntity(connection, key: key)
        if let base {
            try upsertWorking(
                connection,
                key: key,
                record: base.record,
                deleted: base.deleted,
                now: timestamp
            )
            try setLocalRevision(
                connection,
                key: key,
                localRevision: try localRevision(connection, key: key) + 1,
                deleted: base.deleted,
                now: timestamp
            )
        } else {
            try upsertWorking(
                connection,
                key: key,
                record: nil,
                deleted: 1,
                now: timestamp
            )
            try setLocalRevision(
                connection,
                key: key,
                localRevision: try localRevision(connection, key: key) + 1,
                deleted: 1,
                now: timestamp
            )
        }
    }

    func baseEntity(
        _ connection: SQLiteConnection,
        key: EntityKey
    ) throws -> (record: String?, deleted: Int)? {
        try connection.withStatement(
            """
            SELECT record, deleted FROM base_entities
            WHERE entity_type = ? AND entity_id = ?
            """
        ) { statement in
            try statement.bind(1, text: key.entityType.rawValue)
            try statement.bind(2, text: key.entityId)
            guard try statement.step() else { return nil }
            return (statement.text(0), Int(statement.int64(1)))
        }
    }
}

// MARK: - Pull validation and conflicts

private extension ObolDatabase {
    func failPull(
        _ connection: SQLiteConnection,
        reason: SyncStopReason,
        message: String
    ) throws -> Never {
        try connection.transaction {
            try updateStopReason(connection, reason: reason, detail: message, now: Date())
        }
        throw StoreError.syncStopped(reason: reason, message: message)
    }

    func validatePullPage(
        _ page: PullPage,
        binding: SyncBinding,
        connection: SQLiteConnection
    ) throws {
        if page.events.isEmpty {
            guard page.nextCursor == binding.cursor else {
                try failPull(
                    connection,
                    reason: .pageInvalid,
                    message: "Empty page advanced cursor from \(binding.cursor) to \(page.nextCursor)."
                )
            }
            return
        }

        var expectedSequence = binding.cursor + 1
        var expectedPreviousHash = binding.lastChainHash
        var seenCommits = Set<String>()
        var index = 0

        while index < page.events.count {
            let groupStart = index
            let first = page.events[groupStart]
            let commitId = first.commitId
            guard !commitId.isEmpty,
                  !seenCommits.contains(commitId),
                  first.commitIndex == 0,
                  first.commitSize >= 1,
                  first.commitSize <= SyncProtocol.maximumCommitEvents else {
                try failPull(
                    connection,
                    reason: .pageInvalid,
                    message: "Commit group is malformed at seq \(first.seq)."
                )
            }
            seenCommits.insert(commitId)

            var groupIndex = 0
            while index < page.events.count {
                let event = page.events[index]
                guard event.commitId == commitId else { break }
                guard event.seq == expectedSequence else {
                    try failPull(
                        connection,
                        reason: .pageInvalid,
                        message: "Event sequence \(event.seq) is not contiguous (expected \(expectedSequence))."
                    )
                }
                guard event.commitIndex == groupIndex,
                      event.commitSize == first.commitSize else {
                    try failPull(
                        connection,
                        reason: .pageInvalid,
                        message: "Commit \(commitId) has a broken index/size at seq \(event.seq)."
                    )
                }
                guard event.prevHash == expectedPreviousHash else {
                    try failPull(
                        connection,
                        reason: .serverRollbackDetected,
                        message: "Hash chain break at seq \(event.seq)."
                    )
                }
                guard event.revision > 0,
                      !event.entityId.isEmpty,
                      !event.chainHash.isEmpty else {
                    try failPull(
                        connection,
                        reason: .pageInvalid,
                        message: "Event \(event.seq) has an invalid revision, entity, or hash."
                    )
                }
                if event.kind == .upsert {
                    guard let record = event.record,
                          let object = record.objectValue,
                          object["id"]?.stringValue == event.entityId else {
                        try failPull(
                            connection,
                            reason: .pageInvalid,
                            message: "Upsert event \(event.seq) has no matching object record."
                        )
                    }
                } else {
                    guard event.record == nil else {
                        try failPull(
                            connection,
                            reason: .pageInvalid,
                            message: "Delete event \(event.seq) carries a record."
                        )
                    }
                }
                // Full chain hash validation: the journal event's own cover
                // hash must recompute from the canonical identity bytes of
                // record + group metadata + createdAt. A delete record hashes
                // canonical JSON `null` (a sha256 value), never the empty
                // genesis string; the empty string appears only as the
                // genesis prev/cursor/head hash.
                let computedChainHash = try self.chainHash(
                    for: event,
                    connection: connection
                )
                guard computedChainHash == event.chainHash else {
                    try failPull(
                        connection,
                        reason: .pageInvalid,
                        message: "Event \(event.seq) chain hash does not match its canonical identity values."
                    )
                }

                expectedSequence += 1
                expectedPreviousHash = event.chainHash
                groupIndex += 1
                index += 1

                if groupIndex == first.commitSize {
                    break
                }
            }

            guard groupIndex == first.commitSize else {
                try failPull(
                    connection,
                    reason: .pageInvalid,
                    message: "Commit \(commitId) is incomplete at the page boundary."
                )
            }
        }

        guard let last = page.events.last,
              page.nextCursor == last.seq,
              last.commitIndex == last.commitSize - 1 else {
            try failPull(
                connection,
                reason: .cursorNotOnCommitBoundary,
                message: "Page does not end on a commit boundary."
            )
        }
    }

    /// Recomputes the canonical chain hash of one journal event exactly as
    /// the server defines it: `"sha256:" + unpadded base64url` of canonical
    /// JSON over seq, commitId, commitIndex, commitSize, kind, entityType,
    /// entityId, revision, recordHash, origin, stationId, opId, createdAt
    /// and prevHash. Absent optional stationId/opId encode as JSON null,
    /// and a delete record hashes canonical `null` (never the genesis
    /// empty string, which belongs only to the genesis prev/head/cursor).
    func chainHash(
        for event: SyncChangeEvent,
        connection: SQLiteConnection
    ) throws -> String {
        guard let createdAt = event.createdAt, !createdAt.isEmpty else {
            throw StoreError.corruptRecord(
                entityType: event.entityType.rawValue,
                entityId: event.entityId,
                reason: "journal event \(event.seq) carries no UTC createdAt"
            )
        }
        let recordHash: String
        do {
            recordHash = try SyncHashing.hashRecord(event.record)
        } catch {
            throw StoreError.corruptRecord(
                entityType: event.entityType.rawValue,
                entityId: event.entityId,
                reason: "journal event \(event.seq) record could not be canonically encoded"
            )
        }
        let identity: JSONValue = .object([
            "seq": .number(Decimal(event.seq)),
            "commitId": .string(event.commitId),
            "commitIndex": .number(Decimal(event.commitIndex)),
            "commitSize": .number(Decimal(event.commitSize)),
            "kind": .string(event.kind.rawValue),
            "entityType": .string(event.entityType.rawValue),
            "entityId": .string(event.entityId),
            "revision": .number(Decimal(event.revision)),
            "recordHash": .string(recordHash),
            "origin": .string(event.origin.rawValue),
            "stationId": event.stationId.map { JSONValue.string($0) } ?? .null,
            "opId": event.opId.map { JSONValue.string($0) } ?? .null,
            "createdAt": .string(createdAt),
            "prevHash": .string(event.prevHash)
        ])
        do {
            return try SyncHashing.hashJSON(identity)
        } catch {
            throw StoreError.corruptRecord(
                entityType: event.entityType.rawValue,
                entityId: event.entityId,
                reason: "journal event \(event.seq) chain identity could not be canonically encoded"
            )
        }
    }

    func conflictCandidates(
        event: SyncChangeEvent,
        operations: [OutboxOperation]
    ) -> [ConflictCandidate] {
        let key = EntityKey(entityType: event.entityType, entityId: event.entityId)
        var candidates: [ConflictCandidate] = []

        for operation in operations {
            if operation.status == .rejected { continue }
            if operation.opId == event.opId { continue }
            if let eventOpId = event.opId,
               operation.dependsOn.contains(eventOpId) {
                continue
            }

            let base = operation.baseRevisions[key.description]
            if let base, base < event.revision {
                candidates.append(
                    ConflictCandidate(
                        opId: operation.opId,
                        kind: .syncConflict,
                        entityType: event.entityType,
                        entityId: event.entityId,
                        baseRevision: base,
                        currentRevision: event.revision,
                        currentRecord: event.record,
                        message: "Base revision \(base) is stale; server revision is \(event.revision)."
                    )
                )
            } else if base == nil,
                      operation.type.createsEntityIdentifier,
                      operation.entityType == event.entityType,
                      operation.entityId == event.entityId {
                candidates.append(
                    ConflictCandidate(
                        opId: operation.opId,
                        kind: .entityIdTaken,
                        entityType: event.entityType,
                        entityId: event.entityId,
                        baseRevision: nil,
                        currentRevision: event.revision,
                        currentRecord: event.record,
                        message: "Entity id was taken by another writer."
                    )
                )
            }
        }
        return candidates
    }

    func detectPushConflicts(
        _ connection: SQLiteConnection,
        entities: [ServerEntity],
        acceptedOpId: String?,
        now: Date
    ) throws {
        let operations = try loadPendingOperations(connection)
        var candidates: [ConflictCandidate] = []

        for entity in entities {
            let key = EntityKey(entityType: entity.entityType, entityId: entity.entityId)
            let current = try serverRevision(connection, key: key) ?? 0
            guard entity.revision > current else { continue }

            for operation in operations {
                if let acceptedOpId {
                    if operation.opId == acceptedOpId { continue }
                    if operation.dependsOn.contains(acceptedOpId) { continue }
                }
                if operation.status == .rejected { continue }

                let base = operation.baseRevisions[key.description]
                if let base, base < entity.revision {
                    candidates.append(
                        ConflictCandidate(
                            opId: operation.opId,
                            kind: .syncConflict,
                            entityType: entity.entityType,
                            entityId: entity.entityId,
                            baseRevision: base,
                            currentRevision: entity.revision,
                            currentRecord: entity.record,
                            message: "Base revision \(base) is stale; accepted revision is \(entity.revision)."
                        )
                    )
                } else if base == nil,
                          operation.type.createsEntityIdentifier,
                          operation.entityType == entity.entityType,
                          operation.entityId == entity.entityId {
                    candidates.append(
                        ConflictCandidate(
                            opId: operation.opId,
                            kind: .entityIdTaken,
                            entityType: entity.entityType,
                            entityId: entity.entityId,
                            baseRevision: nil,
                            currentRevision: entity.revision,
                            currentRecord: entity.record,
                            message: "Entity id was taken by another writer."
                        )
                    )
                }
            }
        }

        _ = try markConflictCandidates(connection, candidates: candidates, now: now)
    }

    @discardableResult
    func markConflictCandidates(
        _ connection: SQLiteConnection,
        candidates: [ConflictCandidate],
        now: Date
    ) throws -> (created: Int, updated: Int) {
        var created = 0
        var updated = 0
        var markedOperations = Set<String>()

        for candidate in candidates {
            let existing = try conflictRevision(
                connection,
                opId: candidate.opId,
                entityType: candidate.entityType,
                entityId: candidate.entityId
            )
            let recordText: String?
            if let record = candidate.currentRecord {
                recordText = CanonicalJSON.string(record)
            } else {
                recordText = nil
            }
            let timestamp = Self.iso(now)

            try connection.withStatement(
                """
                INSERT INTO sync_conflicts
                    (op_id, conflict_kind, entity_type, entity_id, base_revision,
                     current_revision, current_record, message, resolution,
                     created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                ON CONFLICT(op_id, entity_type, entity_id) DO UPDATE SET
                    conflict_kind = excluded.conflict_kind,
                    base_revision = excluded.base_revision,
                    current_revision = excluded.current_revision,
                    current_record = excluded.current_record,
                    message = excluded.message,
                    resolution = 'pending',
                    updated_at = excluded.updated_at
                WHERE excluded.current_revision >= sync_conflicts.current_revision
                """
            ) { statement in
                try statement.bind(1, text: candidate.opId)
                try statement.bind(2, text: candidate.kind.rawValue)
                try statement.bind(3, text: candidate.entityType.rawValue)
                try statement.bind(4, text: candidate.entityId)
                if let base = candidate.baseRevision {
                    try statement.bind(5, int: base)
                } else {
                    try statement.bindNull(5)
                }
                try statement.bind(6, int: candidate.currentRevision)
                try statement.bind(7, text: recordText)
                try statement.bind(8, text: candidate.message)
                try statement.bind(9, text: timestamp)
                try statement.bind(10, text: timestamp)
                try statement.step()
            }

            if existing == nil {
                created += 1
            } else if let existing, candidate.currentRevision > existing {
                updated += 1
            }

            if markedOperations.insert(candidate.opId).inserted {
                try connection.withStatement(
                    """
                    UPDATE sync_outbox SET status = 'conflict', updated_at = ?
                    WHERE op_id = ? AND status IN ('queued', 'in_flight')
                    """
                ) { statement in
                    try statement.bind(1, text: timestamp)
                    try statement.bind(2, text: candidate.opId)
                    try statement.step()
                }
                try blockDependents(connection, opId: candidate.opId, now: now)
            }
        }

        return (created, updated)
    }

    func conflictRevision(
        _ connection: SQLiteConnection,
        opId: String,
        entityType: EntityType,
        entityId: String
    ) throws -> Int? {
        try connection.withStatement(
            """
            SELECT current_revision FROM sync_conflicts
            WHERE op_id = ? AND entity_type = ? AND entity_id = ?
            """
        ) { statement in
            try statement.bind(1, text: opId)
            try statement.bind(2, text: entityType.rawValue)
            try statement.bind(3, text: entityId)
            guard try statement.step() else { return nil }
            return Int(statement.int64(0))
        }
    }

    func readConflicts(_ connection: SQLiteConnection) throws -> [ConflictRecord] {
        try connection.withStatement(
            """
            SELECT op_id, conflict_kind, entity_type, entity_id, base_revision,
                   current_revision, current_record, message, resolution,
                   created_at, updated_at
            FROM sync_conflicts
            ORDER BY conflict_id
            """
        ) { statement in
            var records: [ConflictRecord] = []
            while try statement.step() {
                guard let opId = statement.text(0),
                      let kindRaw = statement.text(1),
                      let kind = ConflictKind(rawValue: kindRaw),
                      let entityTypeRaw = statement.text(2),
                      let entityType = EntityType(rawValue: entityTypeRaw),
                      let entityId = statement.text(3),
                      let message = statement.text(7),
                      let resolutionRaw = statement.text(8),
                      let resolution = ConflictResolutionState(rawValue: resolutionRaw),
                      let createdText = statement.text(9),
                      let updatedText = statement.text(10) else {
                    throw StoreError.corruptDatabase(
                        path: databaseURL.path,
                        reason: "conflict row is incomplete"
                    )
                }
                let currentRecord: JSONValue?
                if let recordText = statement.text(6) {
                    currentRecord = try JSONValue(parsing: recordText)
                } else {
                    currentRecord = nil
                }
                records.append(
                    ConflictRecord(
                        opId: opId,
                        kind: kind,
                        entityType: entityType,
                        entityId: entityId,
                        baseRevision: statement.isNull(4) ? nil : Int(statement.int64(4)),
                        currentRevision: Int(statement.int64(5)),
                        currentRecord: currentRecord,
                        message: message,
                        resolution: resolution,
                        createdAt: try Self.date(
                            createdText,
                            entityType: "conflict",
                            entityId: opId
                        ),
                        updatedAt: try Self.date(
                            updatedText,
                            entityType: "conflict",
                            entityId: opId
                        )
                    )
                )
            }
            return records
        }
    }

    func readConflicts(
        _ connection: SQLiteConnection,
        opId: String
    ) throws -> [ConflictRecord] {
        try readConflicts(connection).filter { $0.opId == opId }
    }

    func setConflictResolution(
        _ connection: SQLiteConnection,
        opId: String,
        resolution: ConflictResolutionState,
        now: Date
    ) throws {
        try connection.withStatement(
            "UPDATE sync_conflicts SET resolution = ?, updated_at = ? WHERE op_id = ?"
        ) { statement in
            try statement.bind(1, text: resolution.rawValue)
            try statement.bind(2, text: Self.iso(now))
            try statement.bind(3, text: opId)
            try statement.step()
        }
    }

    func deleteConflicts(_ connection: SQLiteConnection, opId: String) throws {
        try connection.withStatement("DELETE FROM sync_conflicts WHERE op_id = ?") { statement in
            try statement.bind(1, text: opId)
            try statement.step()
        }
    }

    func markPushConflict(
        _ connection: SQLiteConnection,
        operation: OutboxOperation,
        conflicts: [PushConflict],
        code: String?,
        message: String?,
        now: Date
    ) throws -> (created: Int, updated: Int) {
        var candidates: [ConflictCandidate] = []
        let kind: ConflictKind = code == "ENTITY_ID_TAKEN" ? .entityIdTaken : .syncConflict
        for conflict in conflicts {
            candidates.append(
                ConflictCandidate(
                    opId: operation.opId,
                    kind: kind,
                    entityType: conflict.entityType,
                    entityId: conflict.entityId,
                    baseRevision: conflict.baseRevision,
                    currentRevision: conflict.currentRevision,
                    currentRecord: conflict.current,
                    message: message ?? code ?? "The server rejected a stale base revision."
                )
            )
        }
        let counts = try markConflictCandidates(connection, candidates: candidates, now: now)
        try connection.withStatement(
            "UPDATE sync_outbox SET status = 'conflict', last_error = ?, updated_at = ? WHERE op_id = ?"
        ) { statement in
            try statement.bind(1, text: Self.combine(code: code, message: message))
            try statement.bind(2, text: Self.iso(now))
            try statement.bind(3, text: operation.opId)
            try statement.step()
        }
        try blockDependents(connection, opId: operation.opId, now: now)
        return counts
    }

    func markPushRejected(
        _ connection: SQLiteConnection,
        operation: OutboxOperation,
        code: String?,
        message: String?,
        now: Date
    ) throws {
        try connection.withStatement(
            "UPDATE sync_outbox SET status = 'rejected', last_error = ?, updated_at = ? WHERE op_id = ?"
        ) { statement in
            try statement.bind(1, text: Self.combine(code: code, message: message))
            try statement.bind(2, text: Self.iso(now))
            try statement.bind(3, text: operation.opId)
            try statement.step()
        }
        try blockDependents(connection, opId: operation.opId, now: now)
    }

    func markPushBlocked(
        _ connection: SQLiteConnection,
        operation: OutboxOperation,
        code: String?,
        message: String?,
        now: Date
    ) throws {
        try connection.withStatement(
            "UPDATE sync_outbox SET status = 'queued', last_error = ?, updated_at = ? WHERE op_id = ?"
        ) { statement in
            try statement.bind(1, text: Self.combine(code: code, message: message))
            try statement.bind(2, text: Self.iso(now))
            try statement.bind(3, text: operation.opId)
            try statement.step()
        }
    }

    static func combine(code: String?, message: String?) -> String {
        switch (code, message) {
        case let (code?, message?):
            return "\(code): \(message)"
        case let (code?, nil):
            return code
        case let (nil, message?):
            return message
        case (nil, nil):
            return "Operation was not applied."
        }
    }
}

// MARK: - Dependents and restoration

private extension ObolDatabase {
    func blockDependents(
        _ connection: SQLiteConnection,
        opId: String,
        now: Date
    ) throws {
        for operation in try readOutbox(connection, opId: nil) {
            guard operation.dependsOn.contains(opId) else { continue }
            guard operation.status == .queued || operation.status == .inFlight else { continue }
            try connection.withStatement(
                "UPDATE sync_outbox SET blocked_by = ?, updated_at = ? WHERE op_id = ?"
            ) { statement in
                try statement.bind(1, text: opId)
                try statement.bind(2, text: Self.iso(now))
                try statement.bind(3, text: operation.opId)
                try statement.step()
            }
        }
    }

    func refreshBlockedState(_ connection: SQLiteConnection, now: Date) throws {
        for operation in try readOutbox(connection, opId: nil) {
            guard operation.status == .queued else { continue }

            let unsatisfied = try firstUnsatisfiedDependency(
                connection,
                operation.dependsOn
            )
            let newValue = unsatisfied
            if newValue != operation.blockedBy {
                try connection.withStatement(
                    "UPDATE sync_outbox SET blocked_by = ?, updated_at = ? WHERE op_id = ?"
                ) { statement in
                    try statement.bind(1, text: newValue)
                    try statement.bind(2, text: Self.iso(now))
                    try statement.bind(3, text: operation.opId)
                    try statement.step()
                }
            }
        }
    }

    func firstUnsatisfiedDependency(
        _ connection: SQLiteConnection,
        _ dependencies: [String]
    ) throws -> String? {
        for dependency in dependencies {
            if let receipt = try readReceipt(connection, opId: dependency) {
                if receipt.status == "applied" || receipt.status == "duplicate" {
                    continue
                }
                return dependency
            }
            if let operation = try readOutbox(connection, opId: dependency).first {
                if operation.status == .accepted { continue }
                return dependency
            }
            return dependency
        }
        return nil
    }

    func applyDependentStrategy(
        _ connection: SQLiteConnection,
        resolvedOpId: String,
        strategy: DependentStrategy,
        now: Date,
        alreadyRebased: Set<String> = []
    ) throws -> [String] {
        let dependents = try readOutbox(connection, opId: nil).filter {
            $0.dependsOn.contains(resolvedOpId)
        }
        var newIDs: [String] = []

        switch strategy {
        case .blockQueued:
            for dependent in dependents {
                try connection.withStatement(
                    "UPDATE sync_outbox SET blocked_by = ?, updated_at = ? WHERE op_id = ?"
                ) { statement in
                    try statement.bind(1, text: resolvedOpId)
                    try statement.bind(2, text: Self.iso(now))
                    try statement.bind(3, text: dependent.opId)
                    try statement.step()
                }
            }

        case .rejectDependents:
            for dependent in dependents {
                try connection.withStatement(
                    """
                    UPDATE sync_outbox SET status = 'rejected', last_error = ?, updated_at = ?
                    WHERE op_id = ?
                    """
                ) { statement in
                    try statement.bind(
                        1,
                        text: "Dependency \(resolvedOpId) was rejected or discarded."
                    )
                    try statement.bind(2, text: Self.iso(now))
                    try statement.bind(3, text: dependent.opId)
                    try statement.step()
                }
                try blockDependents(connection, opId: dependent.opId, now: now)
            }

        case .retryWithoutDependency:
            var targets: [OutboxOperation] = []
            for dependent in dependents where !alreadyRebased.contains(dependent.opId) {
                if dependent.status == .rejected || dependent.status == .conflict {
                    continue
                }
                guard dependent.status == .queued, !dependent.isEnvelopeLocked else {
                    throw StoreError.immutableOperationConflict(opId: dependent.opId)
                }
                targets.append(dependent)
            }
            guard !targets.isEmpty else { return [] }
            let mapping = try rebaseOperations(
                connection,
                initialOpIds: targets.map(\.opId),
                now: now
            ) { operation in
                RebasedOperation(
                    identity: operation,
                    dependsOn: operation.dependsOn.filter { $0 != resolvedOpId }
                )
            }
            newIDs = Array(mapping.values).sorted()
        }

        return newIDs
    }

    func restoreBeforeSnapshots(
        _ connection: SQLiteConnection,
        operation: OutboxOperation,
        now: Date
    ) throws -> (restored: [EntityKey], skipped: [EntityKey]) {
        let allOperations = try readOutbox(connection, opId: nil)
        var claimed = Set<EntityKey>()
        for other in allOperations where other.opId != operation.opId {
            claimed.formUnion(other.writeSet)
            claimed.insert(EntityKey(entityType: other.entityType, entityId: other.entityId))
            claimed.formUnion(other.beforeSnapshots.map(\.key))
        }

        let timestamp = Self.iso(now)
        var restored: [EntityKey] = []
        var skipped: [EntityKey] = []

        for snapshot in operation.beforeSnapshots {
            if claimed.contains(snapshot.key) {
                skipped.append(snapshot.key)
                continue
            }
            if try baseEntity(connection, key: snapshot.key) != nil {
                try restoreWorkingFromBase(connection, key: snapshot.key, now: now)
                restored.append(snapshot.key)
                continue
            }
            let recordText: String?
            if let record = snapshot.record {
                recordText = CanonicalJSON.string(record)
            } else {
                recordText = nil
            }
            let deleted = recordText == nil ? 1 : 0
            try upsertWorking(
                connection,
                key: snapshot.key,
                record: recordText,
                deleted: deleted,
                now: timestamp
            )
            try setLocalRevision(
                connection,
                key: snapshot.key,
                localRevision: try localRevision(connection, key: snapshot.key) + 1,
                deleted: deleted,
                now: timestamp
            )
            restored.append(snapshot.key)
        }

        return (restored, skipped)
    }
}

// MARK: - Rebasing, remapping, receipts

fileprivate extension ObolDatabase {
    struct RebasedOperation {
        let type: OperationType
        let entityType: EntityType
        let entityId: String
        let payload: JSONValue
        let baseRevisions: [String: Int]
        let dependsOn: [String]?
        let writeSet: [EntityKey]
        let beforeSnapshots: [EntitySnapshot]
        let freezeEnvelope: Bool

        init(
            identity operation: OutboxOperation,
            baseRevisions: [String: Int]? = nil,
            entityType: EntityType? = nil,
            entityId: String? = nil,
            payload: JSONValue? = nil,
            dependsOn: [String]? = nil,
            writeSet: [EntityKey]? = nil,
            beforeSnapshots: [EntitySnapshot]? = nil,
            freezeEnvelope: Bool = false
        ) {
            type = operation.type
            self.entityType = entityType ?? operation.entityType
            self.entityId = entityId ?? operation.entityId
            self.payload = payload ?? operation.payload
            self.baseRevisions = baseRevisions ?? operation.baseRevisions
            self.dependsOn = dependsOn
            self.writeSet = writeSet ?? operation.writeSet
            self.beforeSnapshots = beforeSnapshots ?? operation.beforeSnapshots
            self.freezeEnvelope = freezeEnvelope
        }
    }

    func rebaseOperations(
        _ connection: SQLiteConnection,
        initialOpIds: [String],
        excluding: Set<String> = [],
        now: Date,
        transform: (OutboxOperation) throws -> RebasedOperation
    ) throws -> [String: String] {
        let operations = try readOutbox(connection, opId: nil)
        let byID = Dictionary(uniqueKeysWithValues: operations.map { ($0.opId, $0) })
        let initial = Set(initialOpIds.filter { byID[$0] != nil && !excluding.contains($0) })
        guard !initial.isEmpty else { return [:] }

        var closure = initial
        var changed = true
        while changed {
            changed = false
            for operation in operations where !closure.contains(operation.opId) {
                if excluding.contains(operation.opId) { continue }
                guard operation.dependsOn.contains(where: { closure.contains($0) }) else {
                    continue
                }
                if operation.status == .rejected || operation.status == .conflict {
                    continue
                }
                guard operation.status == .queued, !operation.isEnvelopeLocked else {
                    throw StoreError.immutableOperationConflict(opId: operation.opId)
                }
                closure.insert(operation.opId)
                changed = true
            }
        }

        var mapping: [String: String] = [:]
        for opId in closure {
            var newID = SyncIdentifier.uuidv7(at: now)
            while mapping.values.contains(newID) || byID[newID] != nil {
                newID = SyncIdentifier.uuidv7(at: now)
            }
            mapping[opId] = newID
        }

        for operation in operations where closure.contains(operation.opId) {
            guard let newID = mapping[operation.opId] else { continue }
            let rebased = initial.contains(operation.opId)
                ? try transform(operation)
                : RebasedOperation(identity: operation)
            let mappedDependencies: [String]
            if let override = rebased.dependsOn {
                mappedDependencies = Array(Set(override.map { mapping[$0] ?? $0 })).sorted()
            } else {
                mappedDependencies = Array(Set(operation.dependsOn.map { mapping[$0] ?? $0 })).sorted()
            }
            let timestamp = Self.iso(now)
            var beforeObject: [String: JSONValue] = [:]
            for snapshot in rebased.beforeSnapshots {
                beforeObject[snapshot.key.description] = snapshot.record ?? .null
            }
            let envelope = SyncOperationEnvelope(
                protocolVersion: operation.protocolVersion,
                stationId: operation.stationId,
                opId: newID,
                type: rebased.type,
                entityType: rebased.entityType,
                entityId: rebased.entityId,
                payload: rebased.payload,
                baseRevisions: rebased.baseRevisions,
                dependsOn: mappedDependencies,
                clientCreatedAt: operation.clientCreatedAt,
                effectiveAt: operation.effectiveAt,
                payloadHash: ""
            )
            let hash = try SyncHashing.hashEnvelope(envelope)

            try connection.withStatement(
                """
                INSERT INTO sync_outbox
                    (op_id, station_id, protocol_version, operation_type, entity_type,
                     entity_id, payload, base_revisions, depends_on, write_set,
                     client_created_at, effective_at, payload_hash, status,
                     envelope_locked, attempts, last_error, blocked_by,
                     before_snapshots, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, 0,
                        NULL, NULL, ?, ?, ?)
                """
            ) { statement in
                try statement.bind(1, text: newID)
                try statement.bind(2, text: operation.stationId)
                try statement.bind(3, int: operation.protocolVersion)
                try statement.bind(4, text: rebased.type.rawValue)
                try statement.bind(5, text: rebased.entityType.rawValue)
                try statement.bind(6, text: rebased.entityId)
                try statement.bind(7, text: CanonicalJSON.string(rebased.payload))
                try statement.bind(
                    8,
                    text: try Self.baseRevisionsJSON(rebased.baseRevisions)
                )
                try statement.bind(9, text: try Self.stringArrayJSON(mappedDependencies))
                try statement.bind(
                    10,
                    text: try Self.stringArrayJSON(rebased.writeSet.map(\.description))
                )
                try statement.bind(11, text: Self.iso(operation.clientCreatedAt))
                try statement.bind(12, text: Self.iso(operation.effectiveAt))
                try statement.bind(13, text: hash)
                try statement.bind(14, int: rebased.freezeEnvelope ? 1 : 0)
                try statement.bind(15, text: CanonicalJSON.string(.object(beforeObject)))
                try statement.bind(16, text: timestamp)
                try statement.bind(17, text: timestamp)
                try statement.step()
            }
            try connection.withStatement("DELETE FROM sync_outbox WHERE op_id = ?") { statement in
                try statement.bind(1, text: operation.opId)
                try statement.step()
            }
        }

        return mapping
    }

    func remapCreatedEntities(
        _ connection: SQLiteConnection,
        operation: OutboxOperation,
        result: PushAcknowledgement,
        now: Date
    ) throws -> [ClientEntityRemap] {
        let target = EntityKey(entityType: operation.entityType, entityId: operation.entityId)
        let created = operation.beforeSnapshots.filter {
            $0.record == nil && $0.key != target
        }
        guard !created.isEmpty else { return [] }

        var remaps: [ClientEntityRemap] = []
        for snapshot in created {
            let oldID = snapshot.key.entityId
            let existingRevision = try serverRevision(connection, key: snapshot.key) ?? 0
            if existingRevision > 0 {
                continue
            }
            let serverRecognizesOldID = result.entities.contains {
                $0.entityType == snapshot.key.entityType && $0.entityId == oldID
            } || result.entityVersions.contains {
                $0.entityType == snapshot.key.entityType && $0.entityId == oldID
            }
            if serverRecognizesOldID {
                continue
            }
            let candidates = result.entities.filter {
                $0.entityType == snapshot.key.entityType && $0.entityId != oldID
            }
            guard !candidates.isEmpty || !result.entityVersions.isEmpty else {
                throw StoreError.identifierRemapAmbiguous(
                    "server returned no identity for created \(snapshot.key.description)"
                )
            }

            var unseenCandidates: [ServerEntity] = []
            for candidate in candidates {
                let key = EntityKey(
                    entityType: candidate.entityType,
                    entityId: candidate.entityId
                )
                let exists = try entityExists(connection, key: key)
                if !exists {
                    unseenCandidates.append(candidate)
                }
            }
            let matchable = unseenCandidates.isEmpty ? candidates : unseenCandidates

            var newID: String?
            if matchable.count == 1 {
                newID = matchable[0].entityId
            } else if !matchable.isEmpty, let localRecord = try workingRecord(connection, key: snapshot.key) {
                let localFingerprint = Self.fingerprint(
                    type: snapshot.key.entityType,
                    record: localRecord
                )
                let matches = matchable.filter {
                    Self.fingerprint(type: $0.entityType, record: $0.record) == localFingerprint
                }
                if matches.count == 1 {
                    newID = matches[0].entityId
                }
            } else if candidates.isEmpty {
                var versionIDs: [String] = []
                var unseenVersions: [String] = []
                for version in result.entityVersions
                    where version.entityType == snapshot.key.entityType
                    && version.entityId != oldID {
                    versionIDs.append(version.entityId)
                    let key = EntityKey(
                        entityType: version.entityType,
                        entityId: version.entityId
                    )
                    let exists = try entityExists(connection, key: key)
                    if !exists {
                        unseenVersions.append(version.entityId)
                    }
                }
                if unseenVersions.count == 1 {
                    newID = unseenVersions[0]
                } else if versionIDs.count == 1 {
                    newID = versionIDs[0]
                }
            }

            guard let resolved = newID else {
                throw StoreError.identifierRemapAmbiguous(
                    "\(snapshot.key.entityType.rawValue):\(oldID)"
                )
            }
            if remaps.contains(where: { $0.to == resolved }) {
                throw StoreError.identifierRemapAmbiguous(
                    "multiple local \(snapshot.key.entityType.rawValue) rows matched \(resolved)"
                )
            }
            try remapEntity(
                connection,
                type: snapshot.key.entityType,
                from: oldID,
                to: resolved,
                excludingOpId: operation.opId,
                now: now
            )
            remaps.append(
                ClientEntityRemap(
                    entityType: snapshot.key.entityType,
                    from: oldID,
                    to: resolved
                )
            )
        }
        return remaps
    }

    func remapEntity(
        _ connection: SQLiteConnection,
        type: EntityType,
        from oldID: String,
        to newID: String,
        excludingOpId: String?,
        now: Date
    ) throws {
        guard oldID != newID else { return }
        let oldKey = EntityKey(entityType: type, entityId: oldID)
        let newKey = EntityKey(entityType: type, entityId: newID)
        let timestamp = Self.iso(now)

        if let base = try baseEntity(connection, key: oldKey) {
            let oldRevision = try baseRevisionValue(connection, key: oldKey) ?? 0
            let existingNewRevision = try baseRevisionValue(connection, key: newKey) ?? 0
            if oldRevision >= existingNewRevision {
                let recordText: String?
                if let record = base.record {
                    recordText = CanonicalJSON.string(
                        try Self.rewriteJSON(try JSONValue(parsing: record), oldID: oldID, newID: newID)
                    )
                } else {
                    recordText = nil
                }
                try upsertBase(
                    connection,
                    key: newKey,
                    revision: oldRevision,
                    deleted: base.deleted,
                    record: recordText,
                    now: timestamp
                )
            }
        }

        if let working = try workingRecordText(connection, key: oldKey) {
            let recordText: String?
            if let record = try workingRecord(connection, key: oldKey) {
                recordText = CanonicalJSON.string(
                    try Self.rewriteJSON(record, oldID: oldID, newID: newID)
                )
            } else {
                recordText = nil
            }
            try upsertWorking(
                connection,
                key: newKey,
                record: recordText,
                deleted: working.deleted,
                now: timestamp
            )
        }

        let oldVersion = try versionRow(connection, key: oldKey)
        let newVersion = try versionRow(connection, key: newKey)
        let serverRevision = max(oldVersion?.server ?? 0, newVersion?.server ?? 0)
        let localRevision = max(oldVersion?.local ?? 0, newVersion?.local ?? 0)
        let deleted = oldVersion?.deleted ?? newVersion?.deleted ?? 0
        try connection.withStatement(
            """
            INSERT INTO entity_versions
                (entity_type, entity_id, server_revision, local_revision, deleted, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(entity_type, entity_id) DO UPDATE SET
                server_revision = excluded.server_revision,
                local_revision = excluded.local_revision,
                deleted = excluded.deleted,
                updated_at = excluded.updated_at
            """
        ) { statement in
            try statement.bind(1, text: type.rawValue)
            try statement.bind(2, text: newID)
            try statement.bind(3, int: serverRevision)
            try statement.bind(4, int: localRevision)
            try statement.bind(5, int: deleted)
            try statement.bind(6, text: timestamp)
            try statement.step()
        }

        try connection.withStatement("DELETE FROM base_entities WHERE entity_type = ? AND entity_id = ?") { statement in
            try statement.bind(1, text: type.rawValue)
            try statement.bind(2, text: oldID)
            try statement.step()
        }
        try connection.withStatement("DELETE FROM working_entities WHERE entity_type = ? AND entity_id = ?") { statement in
            try statement.bind(1, text: type.rawValue)
            try statement.bind(2, text: oldID)
            try statement.step()
        }
        try connection.withStatement("DELETE FROM entity_versions WHERE entity_type = ? AND entity_id = ?") { statement in
            try statement.bind(1, text: type.rawValue)
            try statement.bind(2, text: oldID)
            try statement.step()
        }

        try connection.withStatement(
            "UPDATE sync_conflicts SET entity_id = ? WHERE entity_type = ? AND entity_id = ?"
        ) { statement in
            try statement.bind(1, text: newID)
            try statement.bind(2, text: type.rawValue)
            try statement.bind(3, text: oldID)
            try statement.step()
        }

        try rewriteStoredReferences(
            connection,
            type: type,
            oldID: oldID,
            newID: newID,
            now: timestamp
        )

        let referencing = try readOutbox(connection, opId: nil).filter { operation in
            if let excludingOpId, operation.opId == excludingOpId { return false }
            return Self.referencesEntity(operation, type: type, id: oldID)
        }
        var affected: [OutboxOperation] = []
        for operation in referencing {
            if operation.status == .rejected || operation.status == .conflict {
                continue
            }
            guard operation.status == .queued, !operation.isEnvelopeLocked else {
                throw StoreError.immutableOperationConflict(opId: operation.opId)
            }
            affected.append(operation)
        }
        if !affected.isEmpty {
            _ = try rebaseOperations(
                connection,
                initialOpIds: affected.map(\.opId),
                excluding: excludingOpId.map { Set([$0]) } ?? [],
                now: now
            ) { operation in
                let rewritten = try Self.rewriteOperationEntity(
                    operation,
                    type: type,
                    oldID: oldID,
                    newID: newID
                )
                return RebasedOperation(
                    identity: operation,
                    baseRevisions: rewritten.baseRevisions,
                    entityType: rewritten.entityType,
                    entityId: rewritten.entityId,
                    payload: rewritten.payload,
                    dependsOn: rewritten.dependsOn,
                    writeSet: rewritten.writeSet,
                    beforeSnapshots: rewritten.beforeSnapshots
                )
            }
        }
    }

    func rewriteStoredReferences(
        _ connection: SQLiteConnection,
        type: EntityType,
        oldID: String,
        newID: String,
        now: String
    ) throws {
        for table in ["base_entities", "working_entities"] {
            var updates: [(entityType: String, entityID: String, record: String)] = []
            try connection.withStatement(
                "SELECT entity_type, entity_id, record FROM \(table) WHERE record IS NOT NULL"
            ) { statement in
                while try statement.step() {
                    guard let entityType = statement.text(0),
                          let entityID = statement.text(1),
                          let recordText = statement.text(2) else { continue }
                    let record = try JSONValue(parsing: recordText)
                    let rewritten = try Self.rewriteJSON(record, oldID: oldID, newID: newID)
                    let rewrittenText = CanonicalJSON.string(rewritten)
                    if rewrittenText != recordText {
                        updates.append((entityType, entityID, rewrittenText))
                    }
                }
            }
            for update in updates {
                try connection.withStatement(
                    """
                    UPDATE \(table)
                    SET record = ?, updated_at = ?
                    WHERE entity_type = ? AND entity_id = ?
                    """
                ) { statement in
                    try statement.bind(1, text: update.record)
                    try statement.bind(2, text: now)
                    try statement.bind(3, text: update.entityType)
                    try statement.bind(4, text: update.entityID)
                    try statement.step()
                }
            }
        }

        var conflictUpdates: [(Int64, String)] = []
        try connection.withStatement(
            "SELECT conflict_id, current_record FROM sync_conflicts WHERE current_record IS NOT NULL"
        ) { statement in
            while try statement.step() {
                let conflictID = statement.int64(0)
                guard let recordText = statement.text(1) else { continue }
                let record = try JSONValue(parsing: recordText)
                let rewritten = try Self.rewriteJSON(record, oldID: oldID, newID: newID)
                let rewrittenText = CanonicalJSON.string(rewritten)
                if rewrittenText != recordText {
                    conflictUpdates.append((conflictID, rewrittenText))
                }
            }
        }
        for update in conflictUpdates {
            try connection.withStatement(
                "UPDATE sync_conflicts SET current_record = ?, updated_at = ? WHERE conflict_id = ?"
            ) { statement in
                try statement.bind(1, text: update.1)
                try statement.bind(2, text: now)
                try statement.bind(3, int64: update.0)
                try statement.step()
            }
        }
    }

    func workingRecordText(
        _ connection: SQLiteConnection,
        key: EntityKey
    ) throws -> (text: String?, deleted: Int)? {
        try connection.withStatement(
            """
            SELECT record, deleted FROM working_entities
            WHERE entity_type = ? AND entity_id = ?
            """
        ) { statement in
            try statement.bind(1, text: key.entityType.rawValue)
            try statement.bind(2, text: key.entityId)
            guard try statement.step() else { return nil }
            return (statement.text(0), Int(statement.int64(1)))
        }
    }

    func workingRecord(
        _ connection: SQLiteConnection,
        key: EntityKey
    ) throws -> JSONValue? {
        guard let row = try workingRecordText(connection, key: key),
              let text = row.text else { return nil }
        return try JSONValue(parsing: text)
    }

    func baseRevisionValue(
        _ connection: SQLiteConnection,
        key: EntityKey
    ) throws -> Int? {
        try connection.withStatement(
            """
            SELECT revision FROM base_entities
            WHERE entity_type = ? AND entity_id = ?
            """
        ) { statement in
            try statement.bind(1, text: key.entityType.rawValue)
            try statement.bind(2, text: key.entityId)
            guard try statement.step() else { return nil }
            return Int(statement.int64(0))
        }
    }

    func entityExists(
        _ connection: SQLiteConnection,
        key: EntityKey
    ) throws -> Bool {
        if try baseEntity(connection, key: key) != nil { return true }
        return try workingRecordText(connection, key: key) != nil
    }

    func versionRow(
        _ connection: SQLiteConnection,
        key: EntityKey
    ) throws -> (server: Int, local: Int, deleted: Int)? {
        try connection.withStatement(
            """
            SELECT server_revision, local_revision, deleted FROM entity_versions
            WHERE entity_type = ? AND entity_id = ?
            """
        ) { statement in
            try statement.bind(1, text: key.entityType.rawValue)
            try statement.bind(2, text: key.entityId)
            guard try statement.step() else { return nil }
            return (
                Int(statement.int64(0)),
                Int(statement.int64(1)),
                Int(statement.int64(2))
            )
        }
    }

    static func rewriteJSON(
        _ value: JSONValue,
        oldID: String,
        newID: String
    ) throws -> JSONValue {
        switch value {
        case .object(let object):
            var rewritten: [String: JSONValue] = [:]
            for (key, element) in object {
                if key == "id", element.stringValue == oldID {
                    rewritten[key] = .string(newID)
                } else if Self.relationFields.contains(key), element.stringValue == oldID {
                    rewritten[key] = .string(newID)
                } else {
                    rewritten[key] = try rewriteJSON(element, oldID: oldID, newID: newID)
                }
            }
            return .object(rewritten)
        case .array(let array):
            return .array(try array.map { try rewriteJSON($0, oldID: oldID, newID: newID) })
        default:
            return value
        }
    }

    static func rewriteRecord(
        _ record: JSONValue?,
        oldID: String,
        newID: String
    ) throws -> JSONValue? {
        guard let record else { return nil }
        return try rewriteJSON(record, oldID: oldID, newID: newID)
    }

    struct RewrittenOperation {
        let type: OperationType
        let entityType: EntityType
        let entityId: String
        let payload: JSONValue
        let baseRevisions: [String: Int]
        let dependsOn: [String]?
        let writeSet: [EntityKey]
        let beforeSnapshots: [EntitySnapshot]
    }

    static func rewriteOperationEntity(
        _ operation: OutboxOperation,
        type: EntityType,
        oldID: String,
        newID: String
    ) throws -> RewrittenOperation {
        let entityType = operation.entityType == type && operation.entityId == oldID
            ? type
            : operation.entityType
        let entityId = entityType == type && operation.entityId == oldID
            ? newID
            : operation.entityId

        var baseRevisions: [String: Int] = [:]
        let oldKey = "\(type.rawValue):\(oldID)"
        let newKey = "\(type.rawValue):\(newID)"
        for (key, value) in operation.baseRevisions {
            baseRevisions[key == oldKey ? newKey : key] = value
        }

        var writeSet: [EntityKey] = []
        for key in operation.writeSet {
            if key.entityType == type && key.entityId == oldID {
                writeSet.append(EntityKey(entityType: type, entityId: newID))
            } else {
                writeSet.append(key)
            }
        }

        var snapshots: [EntitySnapshot] = []
        for snapshot in operation.beforeSnapshots {
            let key = snapshot.key.entityType == type && snapshot.key.entityId == oldID
                ? EntityKey(entityType: type, entityId: newID)
                : snapshot.key
            snapshots.append(
                EntitySnapshot(
                    key: key,
                    record: try rewriteRecord(snapshot.record, oldID: oldID, newID: newID)
                )
            )
        }

        return RewrittenOperation(
            type: operation.type,
            entityType: entityType,
            entityId: entityId,
            payload: try rewriteJSON(operation.payload, oldID: oldID, newID: newID),
            baseRevisions: baseRevisions,
            dependsOn: nil,
            writeSet: writeSet,
            beforeSnapshots: snapshots
        )
    }

    static func referencesEntity(
        _ operation: OutboxOperation,
        type: EntityType,
        id: String
    ) -> Bool {
        if operation.entityType == type && operation.entityId == id { return true }
        if operation.writeSet.contains(where: { $0.entityType == type && $0.entityId == id }) {
            return true
        }
        if operation.baseRevisions["\(type.rawValue):\(id)"] != nil { return true }
        if operation.beforeSnapshots.contains(where: { $0.key.entityType == type && $0.key.entityId == id }) {
            return true
        }
        if operation.payload.containsEntityID(id) { return true }
        return false
    }

    fileprivate static let relationFields: Set<String> = [
        "account_id",
        "card_id",
        "category_id",
        "project_id",
        "invoice_id",
        "recurrence_id",
        "destination_account_id"
    ]

    static func fingerprint(type: EntityType, record: JSONValue?) -> String {
        guard let record else { return "\(type.rawValue)|deleted" }
        guard case .object(let object) = record else { return CanonicalJSON.string(record) }
        switch type {
        case .invoice:
            let card = object["card_id"]?.stringValue ?? ""
            let period = object["period"]?.stringValue ?? ""
            return "invoice|\(card)|\(period)"
        case .transaction:
            let title = object["title"]?.stringValue ?? ""
            let amount = object["amount"]?.decimalValue.map { CanonicalJSON.string(.number($0)) } ?? ""
            let type = object["type"]?.stringValue ?? ""
            let project = object["project_id"]?.stringValue ?? ""
            let destination = object["destination_account_id"]?.stringValue ?? ""
            return "transaction|\(title)|\(amount)|\(type)|\(project)|\(destination)"
        default:
            var copy = object
            copy.removeValue(forKey: "id")
            copy.removeValue(forKey: "created")
            copy.removeValue(forKey: "updated")
            return CanonicalJSON.string(.object(copy))
        }
    }

    func readReceipt(
        _ connection: SQLiteConnection,
        opId: String
    ) throws -> (status: String, appliedAt: String)? {
        try connection.withStatement(
            "SELECT status, applied_at FROM sync_applied_ops WHERE op_id = ?"
        ) { statement in
            try statement.bind(1, text: opId)
            guard try statement.step(), let status = statement.text(0) else { return nil }
            return (status, statement.text(1) ?? "")
        }
    }

    func insertReceipt(
        _ connection: SQLiteConnection,
        opId: String,
        status: String,
        result: String,
        now: Date
    ) throws {
        try connection.withStatement(
            """
            INSERT INTO sync_applied_ops (op_id, status, result, applied_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(op_id) DO UPDATE SET
                status = excluded.status,
                result = excluded.result,
                applied_at = excluded.applied_at
            """
        ) { statement in
            try statement.bind(1, text: opId)
            try statement.bind(2, text: status)
            try statement.bind(3, text: result)
            try statement.bind(4, text: Self.iso(now))
            try statement.step()
        }
    }

    func receiptMatches(stored: String, incoming: PushResultStatus) -> Bool {
        if stored == incoming.rawValue { return true }
        if (stored == "applied" || stored == "duplicate") && incoming.isSuccessful {
            return true
        }
        return false
    }

    func encodeAcknowledgement(_ acknowledgement: PushAcknowledgement) throws -> String {
        let data = try ObolRecordCodec.encoder.encode(acknowledgement)
        guard let text = String(data: data, encoding: .utf8) else {
            throw CanonicalJSONError.unsupportedValue
        }
        return text
    }
}

// MARK: - Import validation and export values

fileprivate extension ObolDatabase {
    struct ExportCounts: Codable {
        let entities: EntityCounts
        let baseRows: Int
        let workingRows: Int
        let outboxRows: Int
        let conflicts: Int
        let appliedOperations: Int
    }

    struct ExportEnvelope: Codable {
        let format: String
        let schemaVersion: Int
        let exportedAt: Date
        let counts: ExportCounts
        let snapshot: FinancialSnapshot
        let binding: SyncBinding
        let outbox: [OutboxOperation]
        let conflicts: [ConflictRecord]
    }

    fileprivate static func validateSnapshot(_ snapshot: FinancialSnapshot) throws {
        var identifiers = Set<String>()

        func validateID(_ id: String, entity: String) throws {
            guard EntityID.isValid(id) else {
                throw StoreError.invalidImport("\(entity) id '\(id)' is not a 15-character PocketBase id")
            }
            guard identifiers.insert(id).inserted else {
                throw StoreError.invalidImport("duplicate entity id '\(id)'")
            }
        }

        func validAmount(_ value: Decimal) -> Bool {
            !value.isNaN
        }

        func nonEmpty(_ value: String, entity: String) throws {
            guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw StoreError.invalidImport("\(entity) name/title is empty")
            }
        }

        let accountIDs = Set(snapshot.accounts.map(\.id))
        let cardIDs = Set(snapshot.cards.map(\.id))
        let categoryIDs = Set(snapshot.categories.map(\.id))
        let projectIDs = Set(snapshot.projects.map(\.id))
        let invoiceByID = Dictionary(
            snapshot.invoices.map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first }
        )

        for account in snapshot.accounts {
            try validateID(account.id, entity: "Account")
            try nonEmpty(account.name, entity: "Account")
            guard validAmount(account.initialBalance) else {
                throw StoreError.invalidImport("Account '\(account.id)' has an invalid balance")
            }
        }
        for card in snapshot.cards {
            try validateID(card.id, entity: "Card")
            try nonEmpty(card.name, entity: "Card")
            guard (1...31).contains(card.closingDay),
                  (1...31).contains(card.dueDay),
                  validAmount(card.limit),
                  card.limit >= 0 else {
                throw StoreError.invalidImport("Card '\(card.id)' has invalid fields")
            }
        }
        for category in snapshot.categories {
            try validateID(category.id, entity: "Category")
            try nonEmpty(category.name, entity: "Category")
            if let budget = category.monthlyBudget {
                guard validAmount(budget), budget >= 0 else {
                    throw StoreError.invalidImport("Category '\(category.id)' has an invalid budget")
                }
            }
        }
        for project in snapshot.projects {
            try validateID(project.id, entity: "Project")
            try nonEmpty(project.name, entity: "Project")
            guard validAmount(project.totalValue), project.totalValue >= 0 else {
                throw StoreError.invalidImport("Project '\(project.id)' has an invalid total")
            }
        }
        for recurrence in snapshot.recurrences {
            try validateID(recurrence.id, entity: "Recurrence")
            try nonEmpty(recurrence.name, entity: "Recurrence")
            guard validAmount(recurrence.amount), recurrence.amount > 0,
                  (1...31).contains(recurrence.payday) else {
                throw StoreError.invalidImport("Recurrence '\(recurrence.id)' has invalid fields")
            }
            if let total = recurrence.totalInstallments, total <= 0 {
                throw StoreError.invalidImport("Recurrence '\(recurrence.id)' has invalid installments")
            }
            // An imported weekly row without a usable weekday is invalid state;
            // a monthly row keeps whatever weekday the snapshot carried.
            if recurrence.cadence == .weekly {
                guard let weekday = recurrence.weekday, (1...7).contains(weekday) else {
                    throw StoreError.invalidImport(
                        "Recurrence '\(recurrence.id)' requires a weekday between 1 and 7"
                    )
                }
            }
            if let accountID = recurrence.accountID, !accountIDs.contains(accountID) {
                throw StoreError.invalidImport("Recurrence '\(recurrence.id)' references a missing account")
            }
            if let cardID = recurrence.cardID, !cardIDs.contains(cardID) {
                throw StoreError.invalidImport("Recurrence '\(recurrence.id)' references a missing card")
            }
            if let categoryID = recurrence.categoryID, !categoryIDs.contains(categoryID) {
                throw StoreError.invalidImport("Recurrence '\(recurrence.id)' references a missing category")
            }
            if recurrence.accountID != nil && recurrence.cardID != nil {
                throw StoreError.invalidImport("Recurrence '\(recurrence.id)' uses both an account and a card")
            }
        }
        for invoice in snapshot.invoices {
            try validateID(invoice.id, entity: "Invoice")
            guard cardIDs.contains(invoice.cardID) else {
                throw StoreError.invalidImport("Invoice '\(invoice.id)' references a missing card")
            }
            guard invoice.period.range(of: #"^\d{4}-\d{2}$"#, options: .regularExpression) != nil else {
                throw StoreError.invalidImport("Invoice '\(invoice.id)' has an invalid period")
            }
            guard validAmount(invoice.totalAmount),
                  (invoice.paidAmount.map(validAmount) ?? true) else {
                throw StoreError.invalidImport("Invoice '\(invoice.id)' has an invalid amount")
            }
        }
        for transaction in snapshot.transactions {
            try validateID(transaction.id, entity: "Transaction")
            try nonEmpty(transaction.title, entity: "Transaction")
            guard validAmount(transaction.amount), transaction.amount > 0 else {
                throw StoreError.invalidImport("Transaction '\(transaction.id)' has an invalid amount")
            }
            if let accountID = transaction.accountID, !accountIDs.contains(accountID) {
                throw StoreError.invalidImport("Transaction '\(transaction.id)' references a missing account")
            }
            if let destinationID = transaction.destinationAccountID, !accountIDs.contains(destinationID) {
                throw StoreError.invalidImport("Transaction '\(transaction.id)' references a missing destination account")
            }
            if let cardID = transaction.cardID, !cardIDs.contains(cardID) {
                throw StoreError.invalidImport("Transaction '\(transaction.id)' references a missing card")
            }
            if let categoryID = transaction.categoryID, !categoryIDs.contains(categoryID) {
                throw StoreError.invalidImport("Transaction '\(transaction.id)' references a missing category")
            }
            if let projectID = transaction.projectID, !projectIDs.contains(projectID) {
                throw StoreError.invalidImport("Transaction '\(transaction.id)' references a missing project")
            }
            if let recurrenceID = transaction.recurrenceID {
                guard let recurrence = snapshot.recurrence(id: recurrenceID) else {
                    throw StoreError.invalidImport("Transaction '\(transaction.id)' references a missing recurrence")
                }
                guard recurrence.type.rawValue == transaction.type.rawValue else {
                    throw StoreError.invalidImport("Transaction '\(transaction.id)' type does not match its recurrence")
                }
            }
            if let invoiceID = transaction.invoiceID {
                guard let invoice = invoiceByID[invoiceID] else {
                    throw StoreError.invalidImport("Transaction '\(transaction.id)' references a missing invoice")
                }
                guard transaction.cardID == invoice.cardID else {
                    throw StoreError.invalidImport("Transaction '\(transaction.id)' invoice belongs to another card")
                }
            }
            if transaction.type == .transfer {
                guard let source = transaction.accountID,
                      let destination = transaction.destinationAccountID,
                      source != destination,
                      accountIDs.contains(source),
                      accountIDs.contains(destination),
                      transaction.cardID == nil,
                      transaction.invoiceID == nil,
                      transaction.categoryID == nil else {
                    throw StoreError.invalidImport("Transfer '\(transaction.id)' is not a valid transfer")
                }
            } else {
                guard transaction.destinationAccountID == nil else {
                    throw StoreError.invalidImport("Transaction '\(transaction.id)' has a destination without being a transfer")
                }
                if transaction.cardID != nil && transaction.accountID != nil {
                    throw StoreError.invalidImport("Transaction '\(transaction.id)' uses both a card and an account")
                }
                if transaction.isSimulated == true && transaction.invoiceID != nil {
                    throw StoreError.invalidImport("Simulated transaction '\(transaction.id)' has an invoice")
                }
            }
        }
    }
}

fileprivate extension JSONValue {
    func containsEntityID(_ identifier: String) -> Bool {
        switch self {
        case .object(let object):
            for (key, value) in object {
                if ObolDatabase.relationFields.contains(key),
                   value.stringValue == identifier {
                    return true
                }
                if value.containsEntityID(identifier) { return true }
            }
            return false
        case .array(let array):
            return array.contains { $0.containsEntityID(identifier) }
        default:
            return false
        }
    }
}
