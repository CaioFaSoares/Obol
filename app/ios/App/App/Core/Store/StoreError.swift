import Foundation

/// Every failure the local SQLite store can report.
///
/// Finance validation failures are thrown as ``FinanceError`` from `ObolCore`
/// and are not wrapped here. This type owns storage, schema, outbox, pull, and
/// import failures. Reads and writes never reset or discard local data on their
/// own; destructive replacement only happens through an explicit import.
public enum StoreError: Error, Equatable, Sendable, LocalizedError {
    case notOpen
    case invalidDirectory(path: String, reason: String)
    case backupExclusionFailed(path: String, reason: String)
    case protectionFailed(path: String, reason: String)
    case openFailed(path: String, code: Int32, message: String)
    case sqlite(operation: String, code: Int32, message: String)
    case corruptDatabase(path: String, reason: String)
    case unsupportedSchemaVersion(found: Int, supported: Int)
    case migrationFailed(from: Int, to: Int, reason: String)
    case corruptRecord(entityType: String, entityId: String, reason: String)
    case unsupportedCommand(String)
    case unsupportedOperation(String)
    case invalidArgument(String)
    case invalidServerEntity(String)
    case operationNotFound(String)
    case conflictingAcknowledgement(opId: String, stored: String, incoming: String)
    case immutableOperationConflict(opId: String)
    case noOperationMapping(String)
    case identifierRemapAmbiguous(String)
    case stationIdentityMismatch(stored: String, installation: String)
    case pendingOperationsPresent(Int)
    case snapshotImportPending(String)
    case invalidImport(String)
    case syncStopped(reason: SyncStopReason, message: String)
    case pairedAutomaticRecurrenceDisabled

    public var errorDescription: String? {
        switch self {
        case .notOpen:
            return "The local store is closed."
        case .invalidDirectory(let path, let reason):
            return "The local store directory '\(path)' is invalid: \(reason)"
        case .backupExclusionFailed(let path, let reason):
            return "The local store directory '\(path)' could not be excluded from backup: \(reason)"
        case .protectionFailed(let path, let reason):
            return "Data protection could not be applied to '\(path)': \(reason)"
        case .openFailed(let path, let code, let message):
            return "The SQLite database '\(path)' could not be opened (code \(code)): \(message)"
        case .sqlite(let operation, let code, let message):
            return "SQLite \(operation) failed (code \(code)): \(message)"
        case .corruptDatabase(let path, let reason):
            return "The SQLite database '\(path)' is corrupt: \(reason)"
        case .unsupportedSchemaVersion(let found, let supported):
            return "Local store schema version \(found) is newer than supported version \(supported)."
        case .migrationFailed(let from, let to, let reason):
            return "Local store migration \(from) -> \(to) failed: \(reason)"
        case .corruptRecord(let entityType, let entityId, let reason):
            return "Stored \(entityType) '\(entityId)' could not be decoded: \(reason)"
        case .unsupportedCommand(let command):
            return "The command '\(command)' has no supported sync operation and was rejected."
        case .unsupportedOperation(let operation):
            return "The operation '\(operation)' is not supported."
        case .invalidArgument(let message):
            return "Invalid store request: \(message)"
        case .invalidServerEntity(let message):
            return "The server supplied an invalid entity: \(message)"
        case .operationNotFound(let opId):
            return "Outbox operation '\(opId)' was not found."
        case .conflictingAcknowledgement(let opId, let stored, let incoming):
            return "Operation '\(opId)' has stored acknowledgement '\(stored)' but received '\(incoming)'."
        case .immutableOperationConflict(let opId):
            return "Operation '\(opId)' is already sent or resolved and its envelope cannot be rewritten."
        case .noOperationMapping(let command):
            return "The local change from '\(command)' could not be mapped to an outbox operation."
        case .identifierRemapAmbiguous(let message):
            return "A server-created identifier could not be matched to exactly one local entity: \(message)"
        case .stationIdentityMismatch(let stored, let installation):
            return "The local store belongs to station '\(stored)' but this installation's station identifier is '\(installation)'. The stored station identity was left unchanged and no financial data was modified."
        case .pendingOperationsPresent(let count):
            return "The store has \(count) pending operations; discard them explicitly before replacing financial data."
        case .snapshotImportPending(let detail):
            return "A snapshot import is pending and must be resumed or explicitly replaced: \(detail)"
        case .invalidImport(let message):
            return "The imported local snapshot is invalid: \(message)"
        case .syncStopped(let reason, let message):
            return "Synchronization stopped (\(reason.rawValue)): \(message)"
        case .pairedAutomaticRecurrenceDisabled:
            return "Automatic recurrence materialization is disabled while this store is paired."
        }
    }
}
