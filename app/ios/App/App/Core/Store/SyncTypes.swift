import Foundation
import CryptoKit
import CoreFoundation
import ObolCore

// MARK: - Protocol constants

public enum SyncProtocol {
    /// The only protocol version this client speaks.
    public static let version = 1
    /// Hard bound of one atomic commit group.
    public static let maximumCommitEvents = 10_000
    /// Target pull page size. The server never splits a commit to honor it.
    public static let targetPullLimit = 500
    /// Push request bound.
    public static let maximumPushOperations = 100
    /// Complete push request body bound (1 MiB).
    public static let maximumPushBodyBytes = 1_048_576
    /// One serialized operation bound inside a push request (64 KiB).
    public static let maximumOperationBytes = 65_536
    /// Snapshot import: at most 10,000 financial rows.
    public static let maximumImportRows = 10_000
    /// Snapshot import: at most 10 MiB for the complete request body.
    public static let maximumImportBytes = 10_485_760
}

// MARK: - Entity identity

public enum EntityType: String, Codable, CaseIterable, Sendable {
    case account
    case card
    case category
    case invoice
    case project
    case recurrence
    case transaction

    public var collectionName: String {
        switch self {
        case .account: return "accounts"
        case .card: return "cards"
        case .category: return "categories"
        case .invoice: return "invoices"
        case .project: return "projects"
        case .recurrence: return "recurrences"
        case .transaction: return "transactions"
        }
    }
}

public struct EntityKey: Hashable, Codable, Sendable, CustomStringConvertible {
    public let entityType: EntityType
    public let entityId: String

    public init(entityType: EntityType, entityId: String) {
        self.entityType = entityType
        self.entityId = entityId
    }

    public init?(description: String) {
        guard let separator = description.firstIndex(of: ":") else { return nil }
        let typePart = String(description[description.startIndex..<separator])
        let idPart = String(description[description.index(after: separator)...])
        guard let type = EntityType(rawValue: typePart), !idPart.isEmpty else { return nil }
        self.entityType = type
        self.entityId = idPart
    }

    public var description: String { "\(entityType.rawValue):\(entityId)" }
}

// MARK: - Operation identity

public enum OperationType: String, Codable, CaseIterable, Sendable {
    case accountCreate = "account.create"
    case cardCreate = "card.create"
    case cardUpdate = "card.update"
    case categoryCreate = "category.create"
    case projectCreate = "project.create"
    case projectPayment = "project.payment"
    case projectComplete = "project.complete"
    case recurrenceCreate = "recurrence.create"
    case recurrenceUpdate = "recurrence.update"
    case recurrenceDelete = "recurrence.delete"
    case recurrenceToggleStatus = "recurrence.toggleStatus"
    case recurrenceLaunch = "recurrence.launch"
    case transactionCreate = "transaction.create"
    case transactionUpdate = "transaction.update"
    case transactionRealize = "transaction.realize"
    case transactionDelete = "transaction.delete"
    case invoicePay = "invoice.pay"
    case invoiceDelete = "invoice.delete"

    public var entityType: EntityType {
        switch self {
        case .accountCreate:
            return .account
        case .cardCreate, .cardUpdate:
            return .card
        case .categoryCreate:
            return .category
        case .projectCreate, .projectPayment, .projectComplete:
            return .project
        case .recurrenceCreate, .recurrenceUpdate, .recurrenceDelete,
             .recurrenceToggleStatus, .recurrenceLaunch:
            return .recurrence
        case .transactionCreate, .transactionUpdate, .transactionRealize, .transactionDelete:
            return .transaction
        case .invoicePay, .invoiceDelete:
            return .invoice
        }
    }

    /// Operations that create the entity named by `entityId` on the client.
    /// A pull event for that id is a preemptive `ENTITY_ID_TAKEN` conflict.
    public var createsEntityIdentifier: Bool {
        switch self {
        case .accountCreate, .cardCreate, .categoryCreate, .projectCreate,
             .recurrenceCreate, .transactionCreate:
            return true
        default:
            return false
        }
    }
}

public enum OutboxStatus: String, Codable, CaseIterable, Sendable {
    case queued
    case inFlight = "in_flight"
    case accepted
    case conflict
    case rejected

    public var isTerminal: Bool { self == .accepted }
}

public enum PushResultStatus: String, Codable, CaseIterable, Sendable {
    case applied
    case duplicate
    case conflict
    case rejected
    case blocked

    public var isSuccessful: Bool { self == .applied || self == .duplicate }
}

public enum ConflictKind: String, Codable, CaseIterable, Sendable {
    case syncConflict = "SYNC_CONFLICT"
    case entityIdTaken = "ENTITY_ID_TAKEN"
}

public enum ConflictResolutionState: String, Codable, CaseIterable, Sendable {
    case pending
    case server
    case retry
    case discarded
}

public enum StoreMode: String, Codable, CaseIterable, Sendable {
    case standalone
    case paired
}

public enum SyncStopReason: String, Codable, CaseIterable, Sendable {
    case none
    case authRequired = "AUTH_REQUIRED"
    case endpointMismatch = "ENDPOINT_MISMATCH"
    case dataEpochChanged = "DATA_EPOCH_CHANGED"
    case protocolUnsupported = "PROTOCOL_UNSUPPORTED"
    case serverRollbackDetected = "SERVER_ROLLBACK_DETECTED"
    case cursorNotOnCommitBoundary = "CURSOR_NOT_ON_COMMIT_BOUNDARY"
    case pageInvalid = "PAGE_INVALID"
}

// MARK: - Canonical JSON

public enum CanonicalJSONError: Error, Equatable, Sendable {
    case invalidNumber
    case unsupportedValue
}

/// JSON value used for wire payloads, stored server records, and hashing.
///
/// The type has no dictionary ordering of its own: the canonical writer sorts
/// every object key recursively, emits UTF-8, and never emits insignificant
/// whitespace. Financial numbers stay `Decimal`, so they never round-trip
/// through a binary floating-point value.
public enum JSONValue: Equatable, Sendable, Codable {
    case null
    case bool(Bool)
    case number(Decimal)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(parsing data: Data) throws {
        let object = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        self = try JSONValue(any: object)
    }

    public init(parsing string: String) throws {
        guard let data = string.data(using: .utf8) else {
            throw CanonicalJSONError.unsupportedValue
        }
        try self.init(parsing: data)
    }

    private init(any: Any) throws {
        if any is NSNull {
            self = .null
            return
        }
        if let number = any as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                self = .bool(number.boolValue)
            } else {
                self = .number(number.decimalValue)
            }
            return
        }
        if let string = any as? String {
            self = .string(string)
            return
        }
        if let array = any as? [Any] {
            self = .array(try array.map { try JSONValue(any: $0) })
            return
        }
        if let dictionary = any as? [String: Any] {
            var object: [String: JSONValue] = [:]
            object.reserveCapacity(dictionary.count)
            for (key, value) in dictionary {
                object[key] = try JSONValue(any: value)
            }
            self = .object(object)
            return
        }
        throw CanonicalJSONError.unsupportedValue
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
            return
        }
        if let value = try? container.decode(Bool.self) {
            self = .bool(value)
            return
        }
        if let value = try? container.decode(Decimal.self) {
            self = .number(value)
            return
        }
        if let value = try? container.decode(String.self) {
            self = .string(value)
            return
        }
        if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
            return
        }
        if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
            return
        }
        throw DecodingError.dataCorruptedError(
            in: container,
            debugDescription: "Unsupported JSON value"
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null:
            try container.encodeNil()
        case .bool(let value):
            try container.encode(value)
        case .number(let value):
            try container.encode(value)
        case .string(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        }
    }

    public var objectValue: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var decimalValue: Decimal? {
        if case .number(let value) = self { return value }
        return nil
    }

    /// The exact `Int` this number denotes, or `nil`.
    ///
    /// `NSDecimalNumber.intValue` truncates a fractional part and has no
    /// defined result outside `Int`'s range, so a protocol integer
    /// (`protocolVersion`, `dataEpoch`, counts) is only produced after the
    /// number is proven integral and inside that range. Decoding is therefore
    /// total and strict: a fractional or out-of-range wire value yields `nil`
    /// and fails the enclosing validation instead of being narrowed.
    public var intValue: Int? {
        guard case .number(let value) = self else { return nil }
        return JSONValue.exactInteger(value)
    }

    /// Proves `value` is integral and exactly representable as `Int` before
    /// any narrowing conversion.
    static func exactInteger(_ value: Decimal) -> Int? {
        guard !value.isNaN, !value.isInfinite else { return nil }
        var source = value
        var rounded = Decimal()
        NSDecimalRound(&rounded, &source, 0, .plain)
        guard rounded == value else { return nil }
        guard value >= Decimal(Int.min), value <= Decimal(Int.max) else { return nil }
        return NSDecimalNumber(decimal: value).intValue
    }

    public var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }
}

public enum CanonicalJSON {
    public static func data(_ value: JSONValue) throws -> Data {
        try validateHashingValue(value)
        guard let data = string(value).data(using: .utf8) else {
            throw CanonicalJSONError.unsupportedValue
        }
        return data
    }

    public static func string(_ value: JSONValue) -> String {
        var output = ""
        append(value, to: &output)
        return output
    }

    /// Recursively proves that every number has a binary64 representation.
    /// The canonical writer is non-throwing for storage convenience, so the
    /// hashing entry points run this check first and never hash a silently
    /// substituted `null`.
    static func validateHashingValue(_ value: JSONValue) throws {
        switch value {
        case .number(let decimal):
            guard binary64(decimal) != nil else {
                throw CanonicalJSONError.invalidNumber
            }
        case .array(let values):
            for element in values {
                try validateHashingValue(element)
            }
        case .object(let object):
            for element in object.values {
                try validateHashingValue(element)
            }
        case .null, .bool, .string:
            break
        }
    }

    private static func append(_ value: JSONValue, to output: inout String) {
        switch value {
        case .null:
            output.append("null")
        case .bool(let flag):
            output.append(flag ? "true" : "false")
        case .number(let decimal):
            appendNumber(decimal, to: &output)
        case .string(let string):
            appendString(string, to: &output)
        case .array(let values):
            output.append("[")
            for (index, element) in values.enumerated() {
                if index > 0 { output.append(",") }
                append(element, to: &output)
            }
            output.append("]")
        case .object(let object):
            output.append("{")
            // ECMAScript sorts object keys by UTF-16 code units, not UTF-8
            // bytes and not the Unicode-collation order of `String <`.
            let keys = object.keys.sorted { lhs, rhs in
                lhs.utf16.lexicographicallyPrecedes(rhs.utf16)
            }
            for (index, key) in keys.enumerated() {
                if index > 0 { output.append(",") }
                appendString(key, to: &output)
                output.append(":")
                append(object[key] ?? .null, to: &output)
            }
            output.append("}")
        }
    }

    /// Encodes one finite number exactly as ECMAScript `JSON.stringify` does.
    ///
    /// The wire is JavaScript: a JSON number is a binary64 value and the
    /// shortest round-trip decimal is the canonical text. The binary64 value
    /// is selected by parsing Foundation's exact decimal text with the
    /// standard correctly-rounded `Double` parser (see `binary64`), and
    /// Swift's shortest round-trip description yields the same digits
    /// JavaScript produces. Those digits are then re-rendered with the
    /// ECMAScript thresholds (`1e-7`, `1e+21`, fixed notation in between)
    /// instead of the platform's own exponent spelling. Financial values stay
    /// `Decimal` everywhere; this conversion exists only for the canonical
    /// wire representation and never feeds stored arithmetic.
    private static func appendNumber(_ decimal: Decimal, to output: inout String) {
        if decimal.isNaN || decimal.isInfinite {
            // Unreachable through a hashing entry point (validated first) and
            // impossible for a stored financial record. `string` is
            // non-throwing only as a storage convenience.
            output.append("null")
            return
        }
        if decimal == 0 {
            output.append("0")
            return
        }
        guard let value = binary64(decimal) else {
            // A finite value the platform cannot represent has no honest
            // canonical text; refuse instead of emitting `0`/`null` and
            // hashing a different number.
            preconditionFailure(
                "finite Decimal \(decimal) has no binary64 representation"
            )
        }
        appendJavascriptNumber(value, to: &output)
    }

    /// The nearest binary64 value for an exact `Decimal`.
    ///
    /// `NSDecimalNumber.doubleValue` is Foundation's decimal-to-binary bridge
    /// but it is not correctly rounded: the exact `Decimal` `0.0000001`
    /// becomes `1.0000000000000002e-7`, whose shortest description differs
    /// from the `1e-7` JavaScript produces for the same wire literal. A
    /// `Decimal` stores an exact base-10 significand and exponent, and its
    /// `description` is the exact locale-independent decimal text, so the
    /// standard `Double` parser on that text selects the same correctly
    /// rounded binary64 value as ECMAScript.
    static func binary64(_ decimal: Decimal) -> Double? {
        guard !decimal.isNaN, !decimal.isInfinite else { return nil }
        guard let value = Double(decimal.description), value.isFinite else {
            return nil
        }
        return value
    }

    private static func appendJavascriptNumber(_ value: Double, to output: inout String) {
        if value == 0 {
            output.append("0")
            return
        }
        if value < 0 {
            output.append("-")
            appendJavascriptNumber(-value, to: &output)
            return
        }
        if !value.isFinite {
            output.append("null")
            return
        }

        let description = value.description
        var mantissa = Substring(description)
        var exponent = 0
        if let marker = description.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            mantissa = description[..<marker]
            exponent = Int(description[description.index(after: marker)...]) ?? 0
        }

        var digits = String(mantissa)
        var integerDigitCount: Int
        if let dot = digits.firstIndex(of: ".") {
            integerDigitCount = digits.distance(from: digits.startIndex, to: dot)
            digits.remove(at: dot)
        } else {
            integerDigitCount = digits.count
        }

        var leadingZeros = 0
        for character in digits {
            guard character == "0" else { break }
            leadingZeros += 1
        }
        var significant = String(digits.dropFirst(leadingZeros))
        while significant.last == "0" {
            significant.removeLast()
        }
        guard !significant.isEmpty else {
            output.append("0")
            return
        }

        let digitCount = significant.count
        let pointPosition = integerDigitCount - leadingZeros + exponent

        if digitCount <= pointPosition && pointPosition <= 21 {
            output.append(significant)
            if pointPosition > digitCount {
                output.append(String(repeating: "0", count: pointPosition - digitCount))
            }
        } else if 0 < pointPosition && pointPosition <= 21 {
            let split = significant.index(
                significant.startIndex,
                offsetBy: pointPosition
            )
            output.append(contentsOf: significant[..<split])
            output.append(".")
            output.append(contentsOf: significant[split...])
        } else if -6 < pointPosition && pointPosition <= 0 {
            output.append("0.")
            if pointPosition < 0 {
                output.append(String(repeating: "0", count: -pointPosition))
            }
            output.append(significant)
        } else {
            let first = significant.first ?? "0"
            output.append(first)
            if digitCount > 1 {
                output.append(".")
                output.append(contentsOf: significant.dropFirst())
            }
            output.append("e")
            let renderedExponent = pointPosition - 1
            if renderedExponent >= 0 {
                output.append("+")
            }
            output.append(String(renderedExponent))
        }
    }

    private static func appendString(_ string: String, to output: inout String) {
        output.append("\"")
        for scalar in string.unicodeScalars {
            switch scalar.value {
            case 0x22:
                output.append("\\\"")
            case 0x5C:
                output.append("\\\\")
            case 0x08:
                output.append("\\b")
            case 0x0C:
                output.append("\\f")
            case 0x0A:
                output.append("\\n")
            case 0x0D:
                output.append("\\r")
            case 0x09:
                output.append("\\t")
            case 0x00...0x1F:
                output.append(String(format: "\\u%04x", scalar.value))
            default:
                output.unicodeScalars.append(scalar)
            }
        }
        output.append("\"")
    }
}

// MARK: - Hashing

public enum SyncHashing {
    /// The empty genesis value before the first event.
    public static let emptyGenesisHash = ""

    public static func sha256(_ data: Data) -> String {
        let digest = SHA256.hash(data: data)
        let encoded = Data(digest).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return "sha256:\(encoded)"
    }

    public static func hashJSON(_ value: JSONValue) throws -> String {
        sha256(try CanonicalJSON.data(value))
    }

    public static func hashRecord(_ record: JSONValue?) throws -> String {
        try hashJSON(record ?? .null)
    }

    public static func hashEnvelope(_ envelope: SyncOperationEnvelope) throws -> String {
        try hashJSON(envelope.canonicalObject())
    }

    /// Hash input of the D7 snapshot import: exactly six fields, excluding the
    /// transmitted `payloadHash` itself. The order is fixed by the shared
    /// canonical writer, which sorts keys anyway.
    public static func hashSnapshotImport(
        protocolVersion: Int,
        stationId: String,
        serverInstanceId: String,
        dataEpoch: Int,
        importId: String,
        snapshot: JSONValue
    ) throws -> String {
        try hashJSON(
            .object([
                "protocolVersion": .number(Decimal(protocolVersion)),
                "stationId": .string(stationId),
                "serverInstanceId": .string(serverInstanceId),
                "dataEpoch": .number(Decimal(dataEpoch)),
                "importId": .string(importId),
                "snapshot": snapshot
            ])
        )
    }
}

public enum SyncIdentifier {
    /// UUIDv7 as lowercase hyphenated text, used for operation and station ids.
    public static func uuidv7(at date: Date = Date()) -> String {
        let milliseconds = UInt64(max(0.0, date.timeIntervalSince1970 * 1000).rounded(.down))
        var bytes = [UInt8](repeating: 0, count: 16)
        bytes[0] = UInt8((milliseconds >> 40) & 0xFF)
        bytes[1] = UInt8((milliseconds >> 32) & 0xFF)
        bytes[2] = UInt8((milliseconds >> 24) & 0xFF)
        bytes[3] = UInt8((milliseconds >> 16) & 0xFF)
        bytes[4] = UInt8((milliseconds >> 8) & 0xFF)
        bytes[5] = UInt8(milliseconds & 0xFF)

        var generator = SystemRandomNumberGenerator()
        for index in 6..<16 {
            bytes[index] = UInt8.random(in: 0...255, using: &generator)
        }
        bytes[6] = (bytes[6] & 0x0F) | 0x70
        bytes[8] = (bytes[8] & 0x3F) | 0x80

        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        let first = hex.index(hex.startIndex, offsetBy: 8)
        let second = hex.index(first, offsetBy: 4)
        let third = hex.index(second, offsetBy: 4)
        let fourth = hex.index(third, offsetBy: 4)
        return [
            String(hex[hex.startIndex..<first]),
            String(hex[first..<second]),
            String(hex[second..<third]),
            String(hex[third..<fourth]),
            String(hex[fourth...])
        ].joined(separator: "-")
    }
}

// MARK: - Envelope and local outbox

public struct SyncOperationEnvelope: Equatable, Sendable {
    public let protocolVersion: Int
    public let stationId: String
    public let opId: String
    public let type: OperationType
    public let entityType: EntityType
    public let entityId: String
    public let payload: JSONValue
    public let baseRevisions: [String: Int]
    public let dependsOn: [String]
    public let clientCreatedAt: Date
    public let effectiveAt: Date
    public let payloadHash: String

    public init(
        protocolVersion: Int,
        stationId: String,
        opId: String,
        type: OperationType,
        entityType: EntityType,
        entityId: String,
        payload: JSONValue,
        baseRevisions: [String: Int],
        dependsOn: [String],
        clientCreatedAt: Date,
        effectiveAt: Date,
        payloadHash: String
    ) {
        self.protocolVersion = protocolVersion
        self.stationId = stationId
        self.opId = opId
        self.type = type
        self.entityType = entityType
        self.entityId = entityId
        self.payload = payload
        self.baseRevisions = baseRevisions
        self.dependsOn = dependsOn
        self.clientCreatedAt = clientCreatedAt
        self.effectiveAt = effectiveAt
        self.payloadHash = payloadHash
    }

    /// The exact object hashed by `payloadHash`. `payloadHash` is not included.
    public func canonicalObject() -> JSONValue {
        var revisions: [String: JSONValue] = [:]
        revisions.reserveCapacity(baseRevisions.count)
        for (key, value) in baseRevisions {
            revisions[key] = .number(Decimal(value))
        }
        return .object([
            "protocolVersion": .number(Decimal(protocolVersion)),
            "stationId": .string(stationId),
            "opId": .string(opId),
            "type": .string(type.rawValue),
            "entityType": .string(entityType.rawValue),
            "entityId": .string(entityId),
            "payload": payload,
            "baseRevisions": .object(revisions),
            "dependsOn": .array(dependsOn.map { .string($0) }),
            "clientCreatedAt": .string(ObolDate.string(clientCreatedAt)),
            "effectiveAt": .string(ObolDate.string(effectiveAt))
        ])
    }

    /// The complete wire operation: hashed fields plus `payloadHash`.
    public func wireObject() -> JSONValue {
        guard case .object(var object) = canonicalObject() else { return .null }
        object["payloadHash"] = .string(payloadHash)
        return .object(object)
    }

    public func computedPayloadHash() throws -> String {
        try SyncHashing.hashEnvelope(self)
    }
}

public struct EntitySnapshot: Codable, Equatable, Sendable {
    public let key: EntityKey
    /// `nil` means the entity did not exist before the operation.
    public let record: JSONValue?

    public init(key: EntityKey, record: JSONValue?) {
        self.key = key
        self.record = record
    }
}

public struct OutboxOperation: Codable, Equatable, Sendable {
    public let opId: String
    public let stationId: String
    public let protocolVersion: Int
    public let type: OperationType
    public let entityType: EntityType
    public let entityId: String
    public let payload: JSONValue
    public let baseRevisions: [String: Int]
    public let dependsOn: [String]
    public let writeSet: [EntityKey]
    public let clientCreatedAt: Date
    public let effectiveAt: Date
    public let payloadHash: String
    public let status: OutboxStatus
    public let isEnvelopeLocked: Bool
    public let attempts: Int
    public let lastError: String?
    public let blockedBy: String?
    public let beforeSnapshots: [EntitySnapshot]
    public let createdAt: Date
    public let updatedAt: Date

    public init(
        opId: String,
        stationId: String,
        protocolVersion: Int,
        type: OperationType,
        entityType: EntityType,
        entityId: String,
        payload: JSONValue,
        baseRevisions: [String: Int],
        dependsOn: [String],
        writeSet: [EntityKey],
        clientCreatedAt: Date,
        effectiveAt: Date,
        payloadHash: String,
        status: OutboxStatus,
        isEnvelopeLocked: Bool,
        attempts: Int,
        lastError: String?,
        blockedBy: String?,
        beforeSnapshots: [EntitySnapshot],
        createdAt: Date,
        updatedAt: Date
    ) {
        self.opId = opId
        self.stationId = stationId
        self.protocolVersion = protocolVersion
        self.type = type
        self.entityType = entityType
        self.entityId = entityId
        self.payload = payload
        self.baseRevisions = baseRevisions
        self.dependsOn = dependsOn
        self.writeSet = writeSet
        self.clientCreatedAt = clientCreatedAt
        self.effectiveAt = effectiveAt
        self.payloadHash = payloadHash
        self.status = status
        self.isEnvelopeLocked = isEnvelopeLocked
        self.attempts = attempts
        self.lastError = lastError
        self.blockedBy = blockedBy
        self.beforeSnapshots = beforeSnapshots
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    public var envelope: SyncOperationEnvelope {
        SyncOperationEnvelope(
            protocolVersion: protocolVersion,
            stationId: stationId,
            opId: opId,
            type: type,
            entityType: entityType,
            entityId: entityId,
            payload: payload,
            baseRevisions: baseRevisions,
            dependsOn: dependsOn,
            clientCreatedAt: clientCreatedAt,
            effectiveAt: effectiveAt,
            payloadHash: payloadHash
        )
    }
}

// MARK: - Conflicts

public struct ConflictRecord: Codable, Equatable, Sendable {
    public let opId: String
    public let kind: ConflictKind
    public let entityType: EntityType
    public let entityId: String
    public let baseRevision: Int?
    public let currentRevision: Int
    public let currentRecord: JSONValue?
    public let message: String
    public let resolution: ConflictResolutionState
    public let createdAt: Date
    public let updatedAt: Date

    public init(
        opId: String,
        kind: ConflictKind,
        entityType: EntityType,
        entityId: String,
        baseRevision: Int?,
        currentRevision: Int,
        currentRecord: JSONValue?,
        message: String,
        resolution: ConflictResolutionState,
        createdAt: Date,
        updatedAt: Date
    ) {
        self.opId = opId
        self.kind = kind
        self.entityType = entityType
        self.entityId = entityId
        self.baseRevision = baseRevision
        self.currentRevision = currentRevision
        self.currentRecord = currentRecord
        self.message = message
        self.resolution = resolution
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

// MARK: - Server wire values

public struct ServerEntity: Codable, Equatable, Sendable {
    public let entityType: EntityType
    public let entityId: String
    public let revision: Int
    /// Complete server record after the change; `nil` for a delete tombstone.
    public let record: JSONValue?

    public init(entityType: EntityType, entityId: String, revision: Int, record: JSONValue?) {
        self.entityType = entityType
        self.entityId = entityId
        self.revision = revision
        self.record = record
    }
}

public struct PushEntityVersion: Codable, Equatable, Sendable {
    public let entityType: EntityType
    public let entityId: String
    public let revision: Int

    public init(entityType: EntityType, entityId: String, revision: Int) {
        self.entityType = entityType
        self.entityId = entityId
        self.revision = revision
    }
}

public struct PushConflict: Codable, Equatable, Sendable {
    public let entityType: EntityType
    public let entityId: String
    public let baseRevision: Int?
    public let currentRevision: Int
    public let current: JSONValue?

    public init(
        entityType: EntityType,
        entityId: String,
        baseRevision: Int?,
        currentRevision: Int,
        current: JSONValue?
    ) {
        self.entityType = entityType
        self.entityId = entityId
        self.baseRevision = baseRevision
        self.currentRevision = currentRevision
        self.current = current
    }
}

public struct PushAcknowledgement: Codable, Equatable, Sendable {
    public let opId: String
    public let status: PushResultStatus
    public let entityVersions: [PushEntityVersion]
    public let entities: [ServerEntity]
    public let conflicts: [PushConflict]
    public let code: String?
    public let message: String?

    private enum CodingKeys: String, CodingKey {
        case opId
        case status
        case entityVersions
        case entities
        case conflicts
        case code
        case message
    }

    public init(
        opId: String,
        status: PushResultStatus,
        entityVersions: [PushEntityVersion] = [],
        entities: [ServerEntity] = [],
        conflicts: [PushConflict] = [],
        code: String? = nil,
        message: String? = nil
    ) {
        self.opId = opId
        self.status = status
        self.entityVersions = entityVersions
        self.entities = entities
        self.conflicts = conflicts
        self.code = code
        self.message = message
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        opId = try container.decode(String.self, forKey: .opId)
        status = try container.decode(PushResultStatus.self, forKey: .status)
        entityVersions = try container.decodeIfPresent(
            [PushEntityVersion].self,
            forKey: .entityVersions
        ) ?? []
        entities = try container.decodeIfPresent(
            [ServerEntity].self,
            forKey: .entities
        ) ?? []
        conflicts = try container.decodeIfPresent(
            [PushConflict].self,
            forKey: .conflicts
        ) ?? []
        code = try container.decodeIfPresent(String.self, forKey: .code)
        message = try container.decodeIfPresent(String.self, forKey: .message)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(opId, forKey: .opId)
        try container.encode(status, forKey: .status)
        try container.encode(entityVersions, forKey: .entityVersions)
        try container.encode(entities, forKey: .entities)
        try container.encode(conflicts, forKey: .conflicts)
        try container.encodeIfPresent(code, forKey: .code)
        try container.encodeIfPresent(message, forKey: .message)
    }
}

public enum SyncEventKind: String, Codable, CaseIterable, Sendable {
    case upsert
    case delete
}

public enum SyncEventOrigin: String, Codable, CaseIterable, Sendable {
    case station
    case web
    case job
    case admin
    case sync
    case seed
}

public struct SyncChangeEvent: Codable, Equatable, Sendable {
    public let seq: Int64
    public let commitId: String
    public let commitIndex: Int
    public let commitSize: Int
    public let kind: SyncEventKind
    public let entityType: EntityType
    public let entityId: String
    public let revision: Int
    public let record: JSONValue?
    public let origin: SyncEventOrigin
    public let stationId: String?
    public let opId: String?
    public let createdAt: String?
    public let prevHash: String
    public let chainHash: String

    public init(
        seq: Int64,
        commitId: String,
        commitIndex: Int,
        commitSize: Int,
        kind: SyncEventKind,
        entityType: EntityType,
        entityId: String,
        revision: Int,
        record: JSONValue?,
        origin: SyncEventOrigin,
        stationId: String?,
        opId: String?,
        createdAt: String? = nil,
        prevHash: String,
        chainHash: String
    ) {
        self.seq = seq
        self.commitId = commitId
        self.commitIndex = commitIndex
        self.commitSize = commitSize
        self.kind = kind
        self.entityType = entityType
        self.entityId = entityId
        self.revision = revision
        self.record = record
        self.origin = origin
        self.stationId = stationId
        self.opId = opId
        self.createdAt = createdAt
        self.prevHash = prevHash
        self.chainHash = chainHash
    }
}

public struct PullPage: Codable, Equatable, Sendable {
    public let serverInstanceId: String
    public let dataEpoch: Int
    public let events: [SyncChangeEvent]
    public let nextCursor: Int64
    public let hasMore: Bool

    public init(
        serverInstanceId: String,
        dataEpoch: Int,
        events: [SyncChangeEvent],
        nextCursor: Int64,
        hasMore: Bool
    ) {
        self.serverInstanceId = serverInstanceId
        self.dataEpoch = dataEpoch
        self.events = events
        self.nextCursor = nextCursor
        self.hasMore = hasMore
    }
}

public struct SyncHandshake: Codable, Equatable, Sendable {
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

    public init(
        serverInstanceId: String,
        ownerFingerprint: String,
        protocolVersion: Int,
        protocolMin: Int,
        protocolMax: Int,
        dataEpoch: Int,
        cursor: Int64,
        cursorHash: String,
        headHash: String,
        hasFinancialData: Bool,
        serverName: String
    ) {
        self.serverInstanceId = serverInstanceId
        self.ownerFingerprint = ownerFingerprint
        self.protocolVersion = protocolVersion
        self.protocolMin = protocolMin
        self.protocolMax = protocolMax
        self.dataEpoch = dataEpoch
        self.cursor = cursor
        self.cursorHash = cursorHash
        self.headHash = headHash
        self.hasFinancialData = hasFinancialData
        self.serverName = serverName
    }
}

// MARK: - Snapshot import (D7 import-as-new)

/// Frozen D7 snapshot-import request. The six hashed fields are exactly
/// `protocolVersion`, `stationId`, `serverInstanceId`, `dataEpoch`,
/// `importId` and `snapshot`; `payloadHash` is transmitted but never hashed.
///
/// The request body is the canonical JSON of the complete object. Rebuilding
/// it from the stored fields is deterministic, so a lost response, a restart
/// or a re-authentication retries byte-identical content.
public struct SnapshotImportRequest: Equatable, Sendable {
    public let protocolVersion: Int
    public let stationId: String
    public let serverInstanceId: String
    public let dataEpoch: Int
    public let importId: String
    public let snapshot: JSONValue
    public let payloadHash: String

    public init(
        protocolVersion: Int,
        stationId: String,
        serverInstanceId: String,
        dataEpoch: Int,
        importId: String,
        snapshot: JSONValue,
        payloadHash: String
    ) {
        self.protocolVersion = protocolVersion
        self.stationId = stationId
        self.serverInstanceId = serverInstanceId
        self.dataEpoch = dataEpoch
        self.importId = importId
        self.snapshot = snapshot
        self.payloadHash = payloadHash
    }

    /// Builds a request and its frozen hash from validated identity and a
    /// complete materialized snapshot.
    public static func make(
        protocolVersion: Int,
        stationId: String,
        serverInstanceId: String,
        dataEpoch: Int,
        importId: String,
        snapshot: JSONValue
    ) throws -> SnapshotImportRequest {
        let hash = try SyncHashing.hashSnapshotImport(
            protocolVersion: protocolVersion,
            stationId: stationId,
            serverInstanceId: serverInstanceId,
            dataEpoch: dataEpoch,
            importId: importId,
            snapshot: snapshot
        )
        return SnapshotImportRequest(
            protocolVersion: protocolVersion,
            stationId: stationId,
            serverInstanceId: serverInstanceId,
            dataEpoch: dataEpoch,
            importId: importId,
            snapshot: snapshot,
            payloadHash: hash
        )
    }

    public func hashInput() -> JSONValue {
        .object([
            "protocolVersion": .number(Decimal(protocolVersion)),
            "stationId": .string(stationId),
            "serverInstanceId": .string(serverInstanceId),
            "dataEpoch": .number(Decimal(dataEpoch)),
            "importId": .string(importId),
            "snapshot": snapshot
        ])
    }

    public func canonicalObject() -> JSONValue {
        guard case .object(var object) = hashInput() else { return .null }
        object["payloadHash"] = .string(payloadHash)
        return .object(object)
    }

    public func bodyData() throws -> Data {
        try CanonicalJSON.data(canonicalObject())
    }

    public func computedPayloadHash() throws -> String {
        try SyncHashing.hashJSON(hashInput())
    }

    /// Decodes one frozen request body and proves its hash still matches.
    ///
    /// Every integer field is read through `JSONValue.intValue`, which proves
    /// integrality and range before converting; a fractional or out-of-range
    /// `protocolVersion`/`dataEpoch` is malformed, never truncated.
    public static func decodeBody(_ data: Data) throws -> SnapshotImportRequest {
        let value = try JSONValue(parsing: data)
        guard let object = value.objectValue,
              let protocolVersion = object["protocolVersion"]?.intValue,
              let stationId = object["stationId"]?.stringValue,
              let serverInstanceId = object["serverInstanceId"]?.stringValue,
              let dataEpoch = object["dataEpoch"]?.intValue,
              let importId = object["importId"]?.stringValue,
              let payloadHash = object["payloadHash"]?.stringValue,
              let snapshot = object["snapshot"] else {
            throw CanonicalJSONError.unsupportedValue
        }
        let request = SnapshotImportRequest(
            protocolVersion: protocolVersion,
            stationId: stationId,
            serverInstanceId: serverInstanceId,
            dataEpoch: dataEpoch,
            importId: importId,
            snapshot: snapshot,
            payloadHash: payloadHash
        )
        guard try request.computedPayloadHash() == payloadHash else {
            throw CanonicalJSONError.unsupportedValue
        }
        return request
    }

    /// Entity records grouped by the singular entity type, in the seven
    /// collection names the seed/import wire uses.
    public func entityRecords() throws -> [EntityType: [JSONValue]] {
        guard let object = snapshot.objectValue else {
            throw CanonicalJSONError.unsupportedValue
        }
        var records: [EntityType: [JSONValue]] = [:]
        for type in EntityType.allCases {
            guard case .array(let values)? = object[type.collectionName] else {
                throw CanonicalJSONError.unsupportedValue
            }
            for value in values {
                guard let record = value.objectValue,
                      let identifier = record["id"]?.stringValue,
                      EntityID.isValid(identifier) else {
                    throw CanonicalJSONError.unsupportedValue
                }
            }
            records[type] = values
        }
        return records
    }

    public func counts() throws -> EntityCounts {
        let records = try entityRecords()
        return EntityCounts(
            accounts: records[.account]?.count ?? 0,
            cards: records[.card]?.count ?? 0,
            categories: records[.category]?.count ?? 0,
            invoices: records[.invoice]?.count ?? 0,
            projects: records[.project]?.count ?? 0,
            recurrences: records[.recurrence]?.count ?? 0,
            transactions: records[.transaction]?.count ?? 0
        )
    }
}

/// Durable local checkpoint written before the import reaches the network.
/// `body` is rebuilt from the stored frozen fields and is therefore stable
/// across restarts and re-authentication.
public struct SnapshotImportCheckpoint: Equatable, Sendable {
    public let importId: String
    public let stationId: String
    public let serverInstanceId: String
    public let serverURL: String
    public let dataEpoch: Int
    public let protocolVersion: Int
    public let payloadHash: String
    public let body: Data
    public let coveredOperationIDs: [String]
    public let counts: EntityCounts

    public init(
        importId: String,
        stationId: String,
        serverInstanceId: String,
        serverURL: String,
        dataEpoch: Int,
        protocolVersion: Int,
        payloadHash: String,
        body: Data,
        coveredOperationIDs: [String],
        counts: EntityCounts
    ) {
        self.importId = importId
        self.stationId = stationId
        self.serverInstanceId = serverInstanceId
        self.serverURL = serverURL
        self.dataEpoch = dataEpoch
        self.protocolVersion = protocolVersion
        self.payloadHash = payloadHash
        self.body = body
        self.coveredOperationIDs = coveredOperationIDs
        self.counts = counts
    }
}

/// Local outcome of one accepted import. The cursor is deliberately absent:
/// only a pull advances it.
public struct SnapshotImportOutcome: Equatable, Sendable {
    public let importId: String
    public let counts: EntityCounts
    public let retiredOperationIDs: [String]
    public let retainedOperationIDs: [String]
    public let advancedBaseRevisions: Int

    public init(
        importId: String,
        counts: EntityCounts,
        retiredOperationIDs: [String],
        retainedOperationIDs: [String],
        advancedBaseRevisions: Int
    ) {
        self.importId = importId
        self.counts = counts
        self.retiredOperationIDs = retiredOperationIDs
        self.retainedOperationIDs = retainedOperationIDs
        self.advancedBaseRevisions = advancedBaseRevisions
    }
}

// MARK: - Local state views

public struct SyncBinding: Codable, Equatable, Sendable {
    public let stationId: String
    public let mode: StoreMode
    public let serverURL: String?
    public let serverInstanceId: String?
    public let ownerFingerprint: String?
    public let protocolVersion: Int
    public let protocolMin: Int?
    public let protocolMax: Int?
    public let dataEpoch: Int
    public let cursor: Int64
    public let cursorCommitIndex: Int?
    public let cursorCommitSize: Int?
    public let lastChainHash: String
    public let serverHeadCursor: Int64?
    public let serverHeadHash: String?
    public let hasFinancialData: Bool?
    public let stopReason: SyncStopReason
    public let stopDetail: String?

    public init(
        stationId: String,
        mode: StoreMode,
        serverURL: String?,
        serverInstanceId: String?,
        ownerFingerprint: String?,
        protocolVersion: Int,
        protocolMin: Int?,
        protocolMax: Int?,
        dataEpoch: Int,
        cursor: Int64,
        cursorCommitIndex: Int?,
        cursorCommitSize: Int?,
        lastChainHash: String,
        serverHeadCursor: Int64?,
        serverHeadHash: String?,
        hasFinancialData: Bool?,
        stopReason: SyncStopReason,
        stopDetail: String?
    ) {
        self.stationId = stationId
        self.mode = mode
        self.serverURL = serverURL
        self.serverInstanceId = serverInstanceId
        self.ownerFingerprint = ownerFingerprint
        self.protocolVersion = protocolVersion
        self.protocolMin = protocolMin
        self.protocolMax = protocolMax
        self.dataEpoch = dataEpoch
        self.cursor = cursor
        self.cursorCommitIndex = cursorCommitIndex
        self.cursorCommitSize = cursorCommitSize
        self.lastChainHash = lastChainHash
        self.serverHeadCursor = serverHeadCursor
        self.serverHeadHash = serverHeadHash
        self.hasFinancialData = hasFinancialData
        self.stopReason = stopReason
        self.stopDetail = stopDetail
    }

    public var isPaired: Bool { mode == .paired }
}

public struct EntityCounts: Codable, Equatable, Sendable {
    public let accounts: Int
    public let cards: Int
    public let categories: Int
    public let invoices: Int
    public let projects: Int
    public let recurrences: Int
    public let transactions: Int

    public init(snapshot: FinancialSnapshot) {
        accounts = snapshot.accounts.count
        cards = snapshot.cards.count
        categories = snapshot.categories.count
        invoices = snapshot.invoices.count
        projects = snapshot.projects.count
        recurrences = snapshot.recurrences.count
        transactions = snapshot.transactions.count
    }

    public init(
        accounts: Int,
        cards: Int,
        categories: Int,
        invoices: Int,
        projects: Int,
        recurrences: Int,
        transactions: Int
    ) {
        self.accounts = accounts
        self.cards = cards
        self.categories = categories
        self.invoices = invoices
        self.projects = projects
        self.recurrences = recurrences
        self.transactions = transactions
    }

    public var total: Int {
        accounts + cards + categories + invoices + projects + recurrences + transactions
    }
}

public struct StoreStatus: Equatable, Sendable {
    public let schemaVersion: Int
    public let databasePath: String
    public let journalMode: String
    public let foreignKeysEnabled: Bool
    public let binding: SyncBinding
    public let counts: EntityCounts
    public let baseEntityCount: Int
    public let workingEntityCount: Int
    public let pendingOperationCount: Int
    public let conflictedOperationCount: Int
    public let conflictCount: Int
    public let appliedOperationCount: Int

    public init(
        schemaVersion: Int,
        databasePath: String,
        journalMode: String,
        foreignKeysEnabled: Bool,
        binding: SyncBinding,
        counts: EntityCounts,
        baseEntityCount: Int,
        workingEntityCount: Int,
        pendingOperationCount: Int,
        conflictedOperationCount: Int,
        conflictCount: Int,
        appliedOperationCount: Int
    ) {
        self.schemaVersion = schemaVersion
        self.databasePath = databasePath
        self.journalMode = journalMode
        self.foreignKeysEnabled = foreignKeysEnabled
        self.binding = binding
        self.counts = counts
        self.baseEntityCount = baseEntityCount
        self.workingEntityCount = workingEntityCount
        self.pendingOperationCount = pendingOperationCount
        self.conflictedOperationCount = conflictedOperationCount
        self.conflictCount = conflictCount
        self.appliedOperationCount = appliedOperationCount
    }
}

public struct LocalMutationResult: Equatable, Sendable {
    public let snapshot: FinancialSnapshot
    public let operations: [OutboxOperation]
    public let changedEntities: [EntityKey]

    public init(
        snapshot: FinancialSnapshot,
        operations: [OutboxOperation],
        changedEntities: [EntityKey]
    ) {
        self.snapshot = snapshot
        self.operations = operations
        self.changedEntities = changedEntities
    }
}

public struct ClientEntityRemap: Equatable, Sendable {
    public let entityType: EntityType
    public let from: String
    public let to: String

    public init(entityType: EntityType, from: String, to: String) {
        self.entityType = entityType
        self.from = from
        self.to = to
    }
}

public struct PushApplySummary: Equatable, Sendable {
    public let appliedOperationIDs: [String]
    public let duplicateOperationIDs: [String]
    public let conflictedOperationIDs: [String]
    public let rejectedOperationIDs: [String]
    public let blockedOperationIDs: [String]
    public let remappedEntities: [ClientEntityRemap]

    public init(
        appliedOperationIDs: [String] = [],
        duplicateOperationIDs: [String] = [],
        conflictedOperationIDs: [String] = [],
        rejectedOperationIDs: [String] = [],
        blockedOperationIDs: [String] = [],
        remappedEntities: [ClientEntityRemap] = []
    ) {
        self.appliedOperationIDs = appliedOperationIDs
        self.duplicateOperationIDs = duplicateOperationIDs
        self.conflictedOperationIDs = conflictedOperationIDs
        self.rejectedOperationIDs = rejectedOperationIDs
        self.blockedOperationIDs = blockedOperationIDs
        self.remappedEntities = remappedEntities
    }
}

public struct PullApplySummary: Equatable, Sendable {
    public let appliedEvents: Int
    public let ignoredEvents: Int
    public let conflictsCreated: Int
    public let conflictsUpdated: Int
    public let newCursor: Int64

    public init(
        appliedEvents: Int,
        ignoredEvents: Int,
        conflictsCreated: Int,
        conflictsUpdated: Int,
        newCursor: Int64
    ) {
        self.appliedEvents = appliedEvents
        self.ignoredEvents = ignoredEvents
        self.conflictsCreated = conflictsCreated
        self.conflictsUpdated = conflictsUpdated
        self.newCursor = newCursor
    }
}

public enum DependentStrategy: Equatable, Sendable {
    /// Keep dependent operations queued and blocked by the resolved operation.
    case blockQueued
    /// Mark direct dependents rejected, preserving their envelope and snapshots.
    case rejectDependents
    /// Remove the resolved dependency and assign each dependent a new `opId`.
    case retryWithoutDependency
}

public enum ConflictResolution: Equatable, Sendable {
    /// Adopt the current server record and discard the local intent.
    case useServer
    /// Rebase onto the conflict's current server revision under a new `opId`.
    case retryWithCurrentServerRevision
    /// Discard the local intent and restore its before-snapshots.
    case discard
}

public struct ConflictResolutionResult: Equatable, Sendable {
    public let opId: String
    public let newOperationIDs: [String]
    public let restoredEntities: [EntityKey]
    public let skippedEntities: [EntityKey]

    public init(
        opId: String,
        newOperationIDs: [String],
        restoredEntities: [EntityKey],
        skippedEntities: [EntityKey]
    ) {
        self.opId = opId
        self.newOperationIDs = newOperationIDs
        self.restoredEntities = restoredEntities
        self.skippedEntities = skippedEntities
    }
}

public enum ImportMode: Equatable, Sendable {
    /// Replace finance rows with a validated snapshot. Pending operations must
    /// be discarded explicitly; this never happens implicitly.
    case replaceFinancialData(discardPendingOperations: Bool)
}

public struct ImportResult: Equatable, Sendable {
    public let counts: EntityCounts
    public let discardedPendingOperations: Bool

    public init(counts: EntityCounts, discardedPendingOperations: Bool) {
        self.counts = counts
        self.discardedPendingOperations = discardedPendingOperations
    }
}

// MARK: - Record coding

/// Shared deterministic record codec. Models inside `ObolCore` encode their
/// own ISO-8601 dates, so no global date strategy is applied.
enum ObolRecordCodec {
    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }()

    static let decoder = JSONDecoder()

    static func encode<T: Encodable>(_ value: T) throws -> String {
        let data = try encoder.encode(value)
        guard let string = String(data: data, encoding: .utf8) else {
            throw CanonicalJSONError.unsupportedValue
        }
        return string
    }

    static func decode<T: Decodable>(_ type: T.Type, from string: String) throws -> T {
        guard let data = string.data(using: .utf8) else {
            throw CanonicalJSONError.unsupportedValue
        }
        return try decoder.decode(type, from: data)
    }

    static func jsonValue<T: Encodable>(_ value: T) throws -> JSONValue {
        let data = try encoder.encode(value)
        return try JSONValue(parsing: data)
    }

    static func jsonValue(parsing string: String) throws -> JSONValue {
        try JSONValue(parsing: string)
    }
}
