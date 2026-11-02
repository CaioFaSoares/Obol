import Foundation
import SQLite3

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

// MARK: - Connection

/// One SQLite connection owned by ``ObolDatabase``. The actor is the only
/// caller; no statement or connection handle leaves the store.
final class SQLiteConnection {
    let path: String
    private(set) var handle: OpaquePointer?

    init(path: String) throws {
        self.path = path
        var database: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE
        let result = sqlite3_open_v2(path, &database, flags, nil)
        guard result == SQLITE_OK, let database else {
            let message = database.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown SQLite error"
            if let database {
                sqlite3_close_v2(database)
            }
            throw StoreError.openFailed(path: path, code: result, message: message)
        }
        self.handle = database
        sqlite3_busy_timeout(database, 5_000)

        do {
            try execute("PRAGMA journal_mode = WAL;")
            try execute("PRAGMA synchronous = FULL;")
            try execute("PRAGMA foreign_keys = ON;")
            try execute("PRAGMA temp_store = MEMORY;")

            let journal = (try scalarText("PRAGMA journal_mode"))?.lowercased()
            guard journal == "wal" else {
                throw StoreError.openFailed(
                    path: path,
                    code: SQLITE_ERROR,
                    message: "WAL journal mode could not be enabled (got \(journal ?? "nil"))."
                )
            }
            let foreignKeys = try scalarInt("PRAGMA foreign_keys")
            guard foreignKeys == 1 else {
                throw StoreError.openFailed(
                    path: path,
                    code: SQLITE_ERROR,
                    message: "foreign_keys could not be enabled."
                )
            }
            try quickCheck()
        } catch {
            closeSilently()
            throw error
        }
    }

    deinit {
        closeSilently()
    }

    func close() throws {
        guard let handle else { return }
        let result = sqlite3_close_v2(handle)
        guard result == SQLITE_OK else {
            throw StoreError.sqlite(
                operation: "close",
                code: result,
                message: String(cString: sqlite3_errmsg(handle))
            )
        }
        self.handle = nil
    }

    func closeSilently() {
        if let handle {
            sqlite3_close_v2(handle)
        }
        handle = nil
    }

    func execute(_ sql: String) throws {
        guard let handle else { throw StoreError.notOpen }
        var errorMessage: UnsafeMutablePointer<CChar>?
        let result = sqlite3_exec(handle, sql, nil, nil, &errorMessage)
        guard result == SQLITE_OK else {
            let message = errorMessage.map { String(cString: $0) }
                ?? String(cString: sqlite3_errmsg(handle))
            if let errorMessage {
                sqlite3_free(errorMessage)
            }
            throw mapError(operation: "exec", code: result, message: message)
        }
        if let errorMessage {
            sqlite3_free(errorMessage)
        }
    }

    func prepare(_ sql: String) throws -> SQLiteStatement {
        guard let handle else { throw StoreError.notOpen }
        var statement: OpaquePointer?
        let result = sqlite3_prepare_v2(handle, sql, -1, &statement, nil)
        guard result == SQLITE_OK, let statement else {
            throw mapError(
                operation: "prepare",
                code: result,
                message: String(cString: sqlite3_errmsg(handle))
            )
        }
        return SQLiteStatement(database: handle, statement: statement)
    }

    func withStatement<T>(_ sql: String, _ body: (SQLiteStatement) throws -> T) throws -> T {
        let statement = try prepare(sql)
        defer { statement.finalize() }
        return try body(statement)
    }

    func transaction<T>(_ body: () throws -> T) throws -> T {
        try execute("BEGIN IMMEDIATE")
        do {
            let value = try body()
            try execute("COMMIT")
            return value
        } catch let failure {
            do {
                try execute("ROLLBACK")
            } catch {
                // The original failure is the useful error. If SQLite already
                // rolled the transaction back, the second error adds nothing.
            }
            throw failure
        }
    }

    func userVersion() throws -> Int {
        try scalarInt("PRAGMA user_version")
    }

    func setUserVersion(_ version: Int) throws {
        try execute("PRAGMA user_version = \(max(0, version));")
    }

    func scalarInt(_ sql: String) throws -> Int {
        try withStatement(sql) { statement in
            guard try statement.step() else { return 0 }
            return Int(statement.int64(0))
        }
    }

    func scalarText(_ sql: String) throws -> String? {
        try withStatement(sql) { statement in
            guard try statement.step() else { return nil }
            return statement.text(0)
        }
    }

    func changes() throws -> Int {
        guard let handle else { throw StoreError.notOpen }
        return Int(sqlite3_changes(handle))
    }

    private func quickCheck() throws {
        let result = (try scalarText("PRAGMA quick_check"))?.lowercased()
        guard result == "ok" else {
            throw StoreError.corruptDatabase(
                path: path,
                reason: result ?? "quick_check returned no result"
            )
        }
    }

    private func mapError(operation: String, code: Int32, message: String) -> StoreError {
        switch code {
        case SQLITE_CORRUPT, SQLITE_NOTADB:
            return .corruptDatabase(path: path, reason: message)
        default:
            return .sqlite(operation: operation, code: code, message: message)
        }
    }
}

// MARK: - Statement

final class SQLiteStatement {
    private let database: OpaquePointer
    private var statement: OpaquePointer?

    init(database: OpaquePointer, statement: OpaquePointer) {
        self.database = database
        self.statement = statement
    }

    deinit {
        finalize()
    }

    func finalize() {
        if let statement {
            sqlite3_finalize(statement)
        }
        statement = nil
    }

    func bind(_ index: Int32, text: String?) throws {
        guard let statement else { throw StoreError.notOpen }
        let result: Int32
        if let text {
            result = sqlite3_bind_text(statement, index, text, -1, sqliteTransient)
        } else {
            result = sqlite3_bind_null(statement, index)
        }
        guard result == SQLITE_OK else {
            throw StoreError.sqlite(
                operation: "bind_text",
                code: result,
                message: String(cString: sqlite3_errmsg(database))
            )
        }
    }

    func bind(_ index: Int32, int: Int) throws {
        try bind(index, int64: Int64(int))
    }

    func bind(_ index: Int32, int64: Int64) throws {
        guard let statement else { throw StoreError.notOpen }
        let result = sqlite3_bind_int64(statement, index, int64)
        guard result == SQLITE_OK else {
            throw StoreError.sqlite(
                operation: "bind_int",
                code: result,
                message: String(cString: sqlite3_errmsg(database))
            )
        }
    }

    func bindNull(_ index: Int32) throws {
        guard let statement else { throw StoreError.notOpen }
        let result = sqlite3_bind_null(statement, index)
        guard result == SQLITE_OK else {
            throw StoreError.sqlite(
                operation: "bind_null",
                code: result,
                message: String(cString: sqlite3_errmsg(database))
            )
        }
    }

    @discardableResult
    func step() throws -> Bool {
        guard let statement else { throw StoreError.notOpen }
        let result = sqlite3_step(statement)
        switch result {
        case SQLITE_ROW:
            return true
        case SQLITE_DONE:
            return false
        default:
            throw StoreError.sqlite(
                operation: "step",
                code: result,
                message: String(cString: sqlite3_errmsg(database))
            )
        }
    }

    func text(_ index: Int32) -> String? {
        guard let statement else { return nil }
        guard sqlite3_column_type(statement, index) != SQLITE_NULL else { return nil }
        guard let pointer = sqlite3_column_text(statement, index) else { return nil }
        return String(cString: pointer)
    }

    func int64(_ index: Int32) -> Int64 {
        guard let statement else { return 0 }
        return sqlite3_column_int64(statement, index)
    }

    func isNull(_ index: Int32) -> Bool {
        guard let statement else { return true }
        return sqlite3_column_type(statement, index) == SQLITE_NULL
    }
}

// MARK: - Schema and migrations

enum SQLiteSchema {
    static let currentVersion = 2

    private struct Migration {
        let version: Int
        let statements: [String]
    }

    static func migrate(_ connection: SQLiteConnection) throws {
        let existing = try connection.userVersion()
        guard existing <= currentVersion else {
            throw StoreError.unsupportedSchemaVersion(found: existing, supported: currentVersion)
        }
        guard existing < currentVersion else { return }

        for migration in migrations where migration.version > existing {
            do {
                try connection.transaction {
                    for statement in migration.statements {
                        try connection.execute(statement)
                    }
                    try connection.setUserVersion(migration.version)
                }
            } catch {
                throw StoreError.migrationFailed(
                    from: existing,
                    to: migration.version,
                    reason: String(describing: error)
                )
            }
        }
    }

    private static let migrations: [Migration] = [
        Migration(
            version: 1,
            statements: [
                """
                CREATE TABLE IF NOT EXISTS sync_state (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    station_id TEXT NOT NULL,
                    mode TEXT NOT NULL,
                    server_url TEXT,
                    server_instance_id TEXT,
                    owner_fingerprint TEXT,
                    protocol_version INTEGER NOT NULL,
                    protocol_min INTEGER,
                    protocol_max INTEGER,
                    data_epoch INTEGER NOT NULL,
                    cursor INTEGER NOT NULL,
                    cursor_commit_index INTEGER,
                    cursor_commit_size INTEGER,
                    last_chain_hash TEXT NOT NULL,
                    server_head_cursor INTEGER,
                    server_head_hash TEXT,
                    has_financial_data INTEGER,
                    stop_reason TEXT NOT NULL,
                    stop_detail TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                """,
                """
                CREATE TABLE IF NOT EXISTS base_entities (
                    entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    deleted INTEGER NOT NULL DEFAULT 0,
                    record TEXT,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (entity_type, entity_id)
                );
                """,
                """
                CREATE TABLE IF NOT EXISTS working_entities (
                    entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    record TEXT,
                    deleted INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (entity_type, entity_id)
                );
                """,
                """
                CREATE TABLE IF NOT EXISTS entity_versions (
                    entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    server_revision INTEGER NOT NULL DEFAULT 0,
                    local_revision INTEGER NOT NULL DEFAULT 0,
                    deleted INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (entity_type, entity_id)
                );
                """,
                """
                CREATE TABLE IF NOT EXISTS sync_outbox (
                    row_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    op_id TEXT NOT NULL UNIQUE,
                    station_id TEXT NOT NULL,
                    protocol_version INTEGER NOT NULL,
                    operation_type TEXT NOT NULL,
                    entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    base_revisions TEXT NOT NULL,
                    depends_on TEXT NOT NULL,
                    write_set TEXT NOT NULL,
                    client_created_at TEXT NOT NULL,
                    effective_at TEXT NOT NULL,
                    payload_hash TEXT NOT NULL,
                    status TEXT NOT NULL,
                    envelope_locked INTEGER NOT NULL DEFAULT 0,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT,
                    blocked_by TEXT,
                    before_snapshots TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                """,
                "CREATE INDEX IF NOT EXISTS sync_outbox_status_idx ON sync_outbox(status, row_id);",
                """
                CREATE TABLE IF NOT EXISTS sync_conflicts (
                    conflict_id INTEGER PRIMARY KEY AUTOINCREMENT,
                    op_id TEXT NOT NULL,
                    conflict_kind TEXT NOT NULL,
                    entity_type TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    base_revision INTEGER,
                    current_revision INTEGER NOT NULL,
                    current_record TEXT,
                    message TEXT NOT NULL,
                    resolution TEXT NOT NULL DEFAULT 'pending',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE (op_id, entity_type, entity_id)
                );
                """,
                "CREATE INDEX IF NOT EXISTS sync_conflicts_entity_idx ON sync_conflicts(entity_type, entity_id);",
                """
                CREATE TABLE IF NOT EXISTS sync_applied_ops (
                    op_id TEXT PRIMARY KEY,
                    status TEXT NOT NULL,
                    result TEXT NOT NULL,
                    applied_at TEXT NOT NULL
                );
                """
            ]
        ),
        Migration(
            version: 2,
            statements: [
                """
                CREATE TABLE IF NOT EXISTS sync_pending_import (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    import_id TEXT NOT NULL,
                    station_id TEXT NOT NULL,
                    server_instance_id TEXT NOT NULL,
                    server_url TEXT NOT NULL,
                    protocol_version INTEGER NOT NULL,
                    data_epoch INTEGER NOT NULL,
                    payload_hash TEXT NOT NULL,
                    snapshot TEXT NOT NULL,
                    covered_op_ids TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                """
            ]
        )
    ]
}
