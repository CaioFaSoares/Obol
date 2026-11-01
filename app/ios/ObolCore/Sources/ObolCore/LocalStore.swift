import Foundation

public enum LocalStoreError: Error, Equatable, Sendable, LocalizedError {
    case invalidDirectory(path: String, reason: String)
    case notLoaded
    case corruptData(path: String, reason: String)
    case unsupportedSchemaVersion(Int)
    case readFailed(path: String, reason: String)
    case writeFailed(path: String, reason: String)

    public var errorDescription: String? {
        switch self {
        case .invalidDirectory(let path, let reason):
            return "The local store directory '\(path)' is invalid: \(reason)"
        case .notLoaded:
            return "The local store has not been loaded; refusing to overwrite an existing file."
        case .corruptData(let path, let reason):
            return "The local store file '\(path)' is corrupt: \(reason)"
        case .unsupportedSchemaVersion(let version):
            return "Local store schema version \(version) is not supported."
        case .readFailed(let path, let reason):
            return "The local store file '\(path)' could not be read: \(reason)"
        case .writeFailed(let path, let reason):
            return "The local store file '\(path)' could not be written: \(reason)"
        }
    }
}

/// Durable, offline JSON snapshot store.
///
/// The store owns one file inside its own directory. A save is encoded,
/// written atomically, and only then published to the in-memory snapshot.
/// A corrupt file is never replaced by an empty state; every read failure is
/// surfaced so the caller can decide what to do with the file.
public actor LocalStore {
    public static let currentSchemaVersion = 1
    public static let fileName = "obol-finance.json"

    public nonisolated let directoryURL: URL
    public nonisolated let fileURL: URL

    private let fileManager: FileManager
    private var envelope: Envelope?
    private var loaded = false

    public init(directoryURL: URL, fileManager: FileManager = .default) throws {
        let standardized = directoryURL.standardizedFileURL
        var isDirectory: ObjCBool = false

        if fileManager.fileExists(atPath: standardized.path, isDirectory: &isDirectory) {
            guard isDirectory.boolValue else {
                throw LocalStoreError.invalidDirectory(
                    path: standardized.path,
                    reason: "the path exists and is not a directory"
                )
            }
        } else {
            do {
                try fileManager.createDirectory(at: standardized, withIntermediateDirectories: true)
            } catch {
                throw LocalStoreError.invalidDirectory(
                    path: standardized.path,
                    reason: String(describing: error)
                )
            }
        }

        self.directoryURL = standardized
        self.fileURL = standardized.appendingPathComponent(Self.fileName, isDirectory: false)
        self.fileManager = fileManager

        #if os(iOS)
        try? fileManager.setAttributes(
            [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
            ofItemAtPath: standardized.path
        )
        #endif
    }

    public var publishedSnapshot: FinancialSnapshot? {
        envelope?.snapshot
    }

    public var deviceIdentifier: UUID? {
        envelope?.deviceID
    }

    public var isLoaded: Bool {
        loaded
    }

    /// Reads the prior snapshot. A missing file yields an empty snapshot without
    /// creating a file; a present but corrupt file throws and is left untouched.
    public func load(now: Date = Date()) throws -> FinancialSnapshot {
        if loaded, let envelope {
            return envelope.snapshot
        }

        guard fileManager.fileExists(atPath: fileURL.path) else {
            let emptyEnvelope = Envelope(
                schemaVersion: Self.currentSchemaVersion,
                deviceID: UUID(),
                savedAt: ObolDate.normalize(now),
                snapshot: .empty
            )
            envelope = emptyEnvelope
            loaded = true
            return .empty
        }

        let data: Data
        do {
            data = try Data(contentsOf: fileURL)
        } catch {
            throw LocalStoreError.readFailed(path: fileURL.path, reason: String(describing: error))
        }

        let decoded: Envelope
        do {
            decoded = try Self.makeDecoder().decode(Envelope.self, from: data)
        } catch {
            throw LocalStoreError.corruptData(path: fileURL.path, reason: String(describing: error))
        }

        guard decoded.schemaVersion == Self.currentSchemaVersion else {
            throw LocalStoreError.unsupportedSchemaVersion(decoded.schemaVersion)
        }

        envelope = decoded
        loaded = true
        return decoded.snapshot
    }

    /// Loads prior state, or creates and persists an empty store when no file
    /// exists. A corrupt existing file throws instead of being replaced.
    @discardableResult
    public func loadOrCreate(now: Date = Date()) throws -> FinancialSnapshot {
        if fileManager.fileExists(atPath: fileURL.path) {
            return try load(now: now)
        }

        let emptyEnvelope = Envelope(
            schemaVersion: Self.currentSchemaVersion,
            deviceID: UUID(),
            savedAt: ObolDate.normalize(now),
            snapshot: .empty
        )
        try write(emptyEnvelope)
        envelope = emptyEnvelope
        loaded = true
        return .empty
    }

    /// Encodes and atomically writes the snapshot before publishing it. If the
    /// write fails, the previously published snapshot remains unchanged.
    @discardableResult
    public func save(_ snapshot: FinancialSnapshot, now: Date = Date()) throws -> FinancialSnapshot {
        if !loaded && fileManager.fileExists(atPath: fileURL.path) {
            throw LocalStoreError.notLoaded
        }

        let normalized = normalizedSnapshot(snapshot)
        let newEnvelope = Envelope(
            schemaVersion: Self.currentSchemaVersion,
            deviceID: envelope?.deviceID ?? UUID(),
            savedAt: ObolDate.normalize(now),
            snapshot: normalized
        )

        try write(newEnvelope)
        envelope = newEnvelope
        loaded = true
        return normalized
    }

    /// Loads the current state, applies one command, and persists the result.
    /// Any engine or write failure leaves the published state untouched.
    @discardableResult
    public func apply(_ command: FinancialCommand, now: Date = Date()) throws -> FinancialSnapshot {
        let current = try load(now: now)
        let updated = try FinanceEngine().apply(command, to: current, now: now)
        return try save(updated, now: now)
    }

    /// Exports the full local envelope for the pairing wizard. No credentials,
    /// tokens, or network state are included.
    public func exportJSON(now: Date = Date()) throws -> Data {
        let current = try load(now: now)
        let exportEnvelope = Envelope(
            schemaVersion: Self.currentSchemaVersion,
            deviceID: envelope?.deviceID ?? UUID(),
            savedAt: ObolDate.normalize(now),
            snapshot: normalizedSnapshot(current)
        )

        do {
            return try Self.makeEncoder().encode(exportEnvelope)
        } catch {
            throw LocalStoreError.writeFailed(path: fileURL.path, reason: String(describing: error))
        }
    }

    /// Explicitly replaces the local store from a previously exported envelope.
    /// The decoded data is validated and written before it is published.
    @discardableResult
    public func importJSON(_ data: Data, now: Date = Date()) throws -> FinancialSnapshot {
        let decoded: Envelope
        do {
            decoded = try Self.makeDecoder().decode(Envelope.self, from: data)
        } catch {
            throw LocalStoreError.corruptData(path: "<imported-data>", reason: String(describing: error))
        }

        guard decoded.schemaVersion == Self.currentSchemaVersion else {
            throw LocalStoreError.unsupportedSchemaVersion(decoded.schemaVersion)
        }

        let normalized = normalizedSnapshot(decoded.snapshot)
        let newEnvelope = Envelope(
            schemaVersion: Self.currentSchemaVersion,
            deviceID: decoded.deviceID,
            savedAt: ObolDate.normalize(now),
            snapshot: normalized
        )

        try write(newEnvelope)
        envelope = newEnvelope
        loaded = true
        return normalized
    }
}

// MARK: - Private persistence

private extension LocalStore {
    struct Envelope: Codable {
        var schemaVersion: Int
        var deviceID: UUID
        var savedAt: Date
        var snapshot: FinancialSnapshot
    }

    static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(ObolDate.string(date))
        }
        return encoder
    }

    static func makeDecoder() -> JSONDecoder {
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
        return decoder
    }

    func write(_ envelope: Envelope) throws {
        let data: Data
        do {
            data = try Self.makeEncoder().encode(envelope)
        } catch {
            throw LocalStoreError.writeFailed(path: fileURL.path, reason: String(describing: error))
        }

        do {
            try data.write(to: fileURL, options: .atomic)
            #if os(iOS)
            try? fileManager.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: fileURL.path
            )
            #endif
        } catch {
            throw LocalStoreError.writeFailed(path: fileURL.path, reason: String(describing: error))
        }
    }

    func normalizedSnapshot(_ snapshot: FinancialSnapshot) -> FinancialSnapshot {
        var result = snapshot

        for index in result.accounts.indices {
            result.accounts[index].created = normalized(result.accounts[index].created)
            result.accounts[index].updated = normalized(result.accounts[index].updated)
        }
        for index in result.cards.indices {
            result.cards[index].created = normalized(result.cards[index].created)
            result.cards[index].updated = normalized(result.cards[index].updated)
        }
        for index in result.categories.indices {
            result.categories[index].created = normalized(result.categories[index].created)
            result.categories[index].updated = normalized(result.categories[index].updated)
        }
        for index in result.invoices.indices {
            result.invoices[index].dueDate = ObolDate.normalize(result.invoices[index].dueDate)
            result.invoices[index].created = normalized(result.invoices[index].created)
            result.invoices[index].updated = normalized(result.invoices[index].updated)
        }
        for index in result.projects.indices {
            result.projects[index].created = normalized(result.projects[index].created)
            result.projects[index].updated = normalized(result.projects[index].updated)
        }
        for index in result.recurrences.indices {
            result.recurrences[index].endDate = normalized(result.recurrences[index].endDate)
            result.recurrences[index].created = normalized(result.recurrences[index].created)
            result.recurrences[index].updated = normalized(result.recurrences[index].updated)
        }
        for index in result.transactions.indices {
            result.transactions[index].expectedDate = ObolDate.normalize(result.transactions[index].expectedDate)
            result.transactions[index].realizedDate = normalized(result.transactions[index].realizedDate)
            result.transactions[index].purchaseDate = normalized(result.transactions[index].purchaseDate)
            result.transactions[index].created = normalized(result.transactions[index].created)
            result.transactions[index].updated = normalized(result.transactions[index].updated)
        }

        return result
    }

    func normalized(_ date: Date?) -> Date? {
        date.map(ObolDate.normalize)
    }
}
