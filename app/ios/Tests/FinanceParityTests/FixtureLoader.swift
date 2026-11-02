import Foundation
import ObolCore
import ObolNativeRuntime

enum FixtureFileID: String, CaseIterable, Hashable {
    case transactions
    case invoices
    case recurrences
    case forecast
    case budgets
    case projects

    var fileName: String { rawValue + ".json" }
}

enum CommandKind: String {
    case accountCreate = "account.create"
    case transactionCreate = "transaction.create"
    case transactionUpdate = "transaction.update"
    case transactionRealize = "transaction.realize"
    case transactionDelete = "transaction.delete"
    case transactionSetSimulated = "transaction.set_simulated"
    case invoicePay = "invoice.pay"
    case invoiceDelete = "invoice.delete"
    case invoiceSummaries = "invoice.summaries"
    case recurrenceCreate = "recurrence.create"
    case recurrenceSetStatus = "recurrence.set_status"
    case recurrenceLaunch = "recurrence.launch"
    case recurrenceProcessMonth = "recurrence.process_month"
    case forecastGenerate = "forecast.generate"
    case budgetSummaries = "budget.summaries"
    case projectPayment = "project.payment"
    case projectComplete = "project.complete"
    case projectSummaries = "project.summaries"

    var isProjection: Bool {
        switch self {
        case .invoiceSummaries, .forecastGenerate, .budgetSummaries, .projectSummaries:
            return true
        default:
            return false
        }
    }
}

struct CaptureSpec {
    let collection: ParityCollection
    let whereFields: [String: JSONValue]
}

struct CommandFault {
    let collection: ParityCollection
    let recordID: String?
    let operation: String?
}

struct ExpectedError {
    let code: String
    let entity: String?
    let entityID: String?
}

struct ParsedCommand {
    let kind: CommandKind
    let object: [String: JSONValue]
    let captures: [String: CaptureSpec]
    let fault: CommandFault?
}

struct InitialFixture {
    let snapshot: FinancialSnapshot
    let normalized: [ParityCollection: [String: NormalizedRecord]]
}

struct ParityCase {
    let file: FixtureFileID
    let id: String
    let purpose: String
    let now: Date
    let effectiveAt: Date?
    let appliedAt: Date?
    let requires: [String]
    let initial: InitialFixture
    let commands: [ParsedCommand]
    let expectedError: ExpectedError?
    let expectedSnapshot: JSONValue?
    let expectedProjections: [JSONValue]?

    var operationClock: Date { effectiveAt ?? now }
}

struct FixtureFile {
    let id: FixtureFileID
    let path: URL
    let cases: [ParityCase]

    func parityCase(id: String) throws -> ParityCase {
        guard let value = cases.first(where: { $0.id == id }) else {
            throw ParityFailure("\(self.id.rawValue).json: case '\(id)' not found")
        }
        return value
    }
}

enum FixtureLoader {
    static let canonicalErrorCodes: Set<String> = [
        "validation",
        "not_found",
        "conflict",
        "referenced",
        "already_realized",
        "already_paid",
        "invalid_state",
        "invalid_identifier",
        "storage_failure"
    ]

    static let knownCapabilities: Set<String> = [
        "exact_decimal_money",
        "relation_validation",
        "atomic_compound_writes",
        "effective_at_clock",
        "invoice_projection"
    ]

    private static let topLevelKeys: Set<String> = ["protocol", "file", "title", "cases"]

    static func parityDirectory() throws -> URL {
        let environment = ProcessInfo.processInfo.environment
        if let explicit = environment["OBOL_FINANCE_PARITY_DIR"], !explicit.isEmpty {
            let url = URL(fileURLWithPath: explicit, isDirectory: true).standardizedFileURL
            try validateDirectory(url, searched: [url])
            return url
        }

        var searched: [URL] = []
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = directory
                .appendingPathComponent("shared", isDirectory: true)
                .appendingPathComponent("finance-parity", isDirectory: true)
                .standardizedFileURL
            searched.append(candidate)
            if directoryHasFixtures(candidate) {
                return candidate
            }
            let parent = directory.deletingLastPathComponent()
            if parent.path == directory.path { break }
            directory = parent
        }
        throw ParityFailure(
            "finance parity fixtures were not found. Set OBOL_FINANCE_PARITY_DIR or run from the repository checkout. Searched:\n"
                + searched.map(\.path).joined(separator: "\n")
        )
    }

    private static func directoryHasFixtures(_ directory: URL) -> Bool {
        let fileManager = FileManager.default
        guard fileManager.fileExists(
            atPath: directory.appendingPathComponent("README.md").path
        ) else {
            return false
        }
        return FixtureFileID.allCases.allSatisfy { file in
            fileManager.fileExists(atPath: directory.appendingPathComponent(file.fileName).path)
        }
    }

    private static func validateDirectory(_ directory: URL, searched: [URL]) throws {
        guard directoryHasFixtures(directory) else {
            throw ParityFailure(
                "OBOL_FINANCE_PARITY_DIR '\(directory.path)' does not contain README.md and the six fixture files. Searched:\n"
                    + searched.map(\.path).joined(separator: "\n")
            )
        }
    }

    static func load(_ file: FixtureFileID) throws -> FixtureFile {
        let directory = try parityDirectory()
        let url = directory.appendingPathComponent(file.fileName)
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            throw ParityFailure("\(file.fileName): could not read \(url.path): \(error)")
        }
        let value: JSONValue
        do {
            value = try JSONValue(parsing: data)
        } catch {
            throw ParityFailure("\(file.fileName): invalid JSON: \(error)")
        }
        let root = try FixtureJSON.object(
            value,
            path: file.fileName,
            allowed: topLevelKeys,
            required: topLevelKeys
        )

        let protocolVersion = try FixtureInteger.parse(
            root["protocol"] ?? .null,
            path: "\(file.fileName).protocol"
        )
        guard protocolVersion == 1 else {
            throw ParityFailure("\(file.fileName).protocol: unsupported protocol \(protocolVersion)")
        }
        let declaredFile = try FixtureJSON.string(
            root["file"] ?? .null,
            path: "\(file.fileName).file"
        )
        guard declaredFile == file.rawValue else {
            throw ParityFailure(
                "\(file.fileName).file: declared '\(declaredFile)' but expected '\(file.rawValue)'"
            )
        }
        _ = try FixtureJSON.string(root["title"] ?? .null, path: "\(file.fileName).title")
        let rawCases = try FixtureJSON.array(
            root["cases"] ?? .null,
            path: "\(file.fileName).cases"
        )
        guard !rawCases.isEmpty else {
            throw ParityFailure("\(file.fileName).cases: no cases")
        }

        var cases: [ParityCase] = []
        cases.reserveCapacity(rawCases.count)
        var identifiers = Set<String>()
        for (index, rawCase) in rawCases.enumerated() {
            let parityCase = try parseCase(
                file,
                value: rawCase,
                path: "\(file.fileName).cases[\(index)]"
            )
            guard identifiers.insert(parityCase.id).inserted else {
                throw ParityFailure(
                    "\(file.fileName).cases[\(index)].id: duplicate case id '\(parityCase.id)'"
                )
            }
            cases.append(parityCase)
        }
        return FixtureFile(id: file, path: url, cases: cases)
    }

    static func loadAll() throws -> [FixtureFile] {
        var files: [FixtureFile] = []
        files.reserveCapacity(FixtureFileID.allCases.count)
        var identifiers = Set<String>()
        for file in FixtureFileID.allCases {
            let fixture = try load(file)
            for parityCase in fixture.cases {
                guard identifiers.insert(parityCase.id).inserted else {
                    throw ParityFailure(
                        "case id '\(parityCase.id)' appears in more than one fixture file"
                    )
                }
            }
            files.append(fixture)
        }
        return files
    }

    private static func parseCase(
        _ file: FixtureFileID,
        value: JSONValue,
        path: String
    ) throws -> ParityCase {
        let allowed: Set<String> = [
            "id", "purpose", "clock", "requires", "divergence",
            "known_blocker", "initial", "commands", "expect"
        ]
        let required: Set<String> = [
            "id", "purpose", "clock", "initial", "commands", "expect"
        ]
        let object = try FixtureJSON.object(
            value,
            path: path,
            allowed: allowed,
            required: required
        )

        let id = try FixtureJSON.string(object["id"] ?? .null, path: "\(path).id")
        guard id.range(of: #"^[a-z0-9]+(?:-[a-z0-9]+)*$"#, options: .regularExpression) != nil else {
            throw ParityFailure("\(path).id: '\(id)' is not lowercase kebab-case")
        }
        let purpose = try FixtureJSON.string(object["purpose"] ?? .null, path: "\(path).purpose")
        guard !purpose.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ParityFailure("\(path).purpose: must not be empty")
        }

        let clock = try parseClock(object["clock"] ?? .null, path: "\(path).clock")

        var requires: [String] = []
        if let rawRequires = object["requires"] {
            let array = try FixtureJSON.array(rawRequires, path: "\(path).requires")
            for (index, element) in array.enumerated() {
                let capability = try FixtureJSON.string(
                    element,
                    path: "\(path).requires[\(index)]"
                )
                guard knownCapabilities.contains(capability) else {
                    throw ParityFailure(
                        "\(path).requires[\(index)]: unknown capability '\(capability)'"
                    )
                }
                requires.append(capability)
            }
        }

        if let rawDivergence = object["divergence"] {
            _ = try FixtureJSON.object(
                rawDivergence,
                path: "\(path).divergence",
                allowed: ["against", "policy", "source", "note"],
                required: ["against", "policy", "source", "note"]
            )
        }
        if let rawBlocker = object["known_blocker"] {
            let blocker = try FixtureJSON.string(rawBlocker, path: "\(path).known_blocker")
            guard !blocker.isEmpty else {
                throw ParityFailure("\(path).known_blocker: must not be empty")
            }
        }

        let normalizedInitial = try ParitySnapshots.normalizedSnapshot(
            object["initial"] ?? .null,
            path: "\(path).initial",
            allowGeneratedTitle: false
        )
        let initial = InitialFixture(
            snapshot: try ParitySnapshots.buildSnapshot(normalizedInitial),
            normalized: normalizedInitial
        )

        let rawCommands = try FixtureJSON.array(
            object["commands"] ?? .null,
            path: "\(path).commands"
        )
        var commands: [ParsedCommand] = []
        commands.reserveCapacity(rawCommands.count)
        var captureNames = Set<String>()
        for (index, rawCommand) in rawCommands.enumerated() {
            let command = try parseCommand(
                rawCommand,
                path: "\(path).commands[\(index)]"
            )
            for name in command.captures.keys {
                guard captureNames.insert(name).inserted else {
                    throw ParityFailure(
                        "\(path).commands[\(index)].capture: duplicate capture name '\(name)'"
                    )
                }
            }
            commands.append(command)
        }

        let expectation = try parseExpectation(object["expect"] ?? .null, path: "\(path).expect")

        let projectionCount = commands.filter { $0.kind.isProjection }.count
        let expectedProjectionCount = expectation.projections?.count ?? 0
        guard projectionCount == expectedProjectionCount else {
            throw ParityFailure(
                "\(path).expect.projections: \(expectedProjectionCount) projections declared for \(projectionCount) projection commands"
            )
        }
        guard expectation.snapshot != nil || expectationProjectionCountExceedsZero(expectation) else {
            throw ParityFailure("\(path).expect: snapshot or projections is required")
        }
        if expectation.error != nil {
            guard expectation.snapshot != nil else {
                throw ParityFailure("\(path).expect: a failing case must pin the prior snapshot")
            }
            guard expectedProjectionCount == 0 else {
                throw ParityFailure("\(path).expect: a failing case cannot declare projections")
            }
        }

        for (index, command) in commands.enumerated() where command.fault != nil {
            guard index == commands.count - 1 else {
                throw ParityFailure("\(path).commands[\(index)].fault: only the final command may inject a fault")
            }
            guard expectation.error?.code == "storage_failure" else {
                throw ParityFailure(
                    "\(path).commands[\(index)].fault: expected error must be storage_failure"
                )
            }
        }

        return ParityCase(
            file: file,
            id: id,
            purpose: purpose,
            now: clock.now,
            effectiveAt: clock.effectiveAt,
            appliedAt: clock.appliedAt,
            requires: requires,
            initial: initial,
            commands: commands,
            expectedError: expectation.error,
            expectedSnapshot: expectation.snapshot,
            expectedProjections: expectation.projections
        )
    }

    private static func expectationProjectionCountExceedsZero(_ expectation: Expectation) -> Bool {
        (expectation.projections?.count ?? 0) > 0
    }

    private struct FixtureClock {
        let now: Date
        let effectiveAt: Date?
        let appliedAt: Date?
    }

    private static func parseClock(_ value: JSONValue, path: String) throws -> FixtureClock {
        let object = try FixtureJSON.object(
            value,
            path: path,
            allowed: ["now", "effective_at", "applied_at"],
            required: ["now"]
        )
        let now = try FixtureDates.parseInstant(object["now"] ?? .null, path: "\(path).now")
        let effectiveAt: Date?
        if let rawEffective = object["effective_at"] {
            effectiveAt = try FixtureDates.parseInstant(rawEffective, path: "\(path).effective_at")
        } else {
            effectiveAt = nil
        }
        let appliedAt: Date?
        if let rawApplied = object["applied_at"] {
            appliedAt = try FixtureDates.parseInstant(rawApplied, path: "\(path).applied_at")
        } else {
            appliedAt = nil
        }
        return FixtureClock(now: now, effectiveAt: effectiveAt, appliedAt: appliedAt)
    }

    private static func parseCommand(_ value: JSONValue, path: String) throws -> ParsedCommand {
        guard case .object(let rawObject) = value else {
            throw ParityFailure("\(path): expected an object")
        }
        let kindValue = try FixtureJSON.string(
            rawObject["kind"] ?? .null,
            path: "\(path).kind"
        )
        guard let kind = CommandKind(rawValue: kindValue) else {
            throw ParityFailure("\(path).kind: unsupported command '\(kindValue)'")
        }

        let schema = commandSchema(kind)
        let object = try FixtureJSON.object(
            value,
            path: path,
            allowed: schema.allowed,
            required: schema.required
        )

        switch kind {
        case .accountCreate:
            _ = try validateRecord(
                object["record"] ?? .null,
                collection: .accounts,
                allowed: ["name", "type", "initial_balance"],
                required: ["name", "type", "initial_balance"],
                path: "\(path).record"
            )
        case .transactionCreate:
            _ = try validateRecord(
                object["record"] ?? .null,
                collection: .transactions,
                allowed: [
                    "title", "amount", "type", "status", "expected_date",
                    "realized_date", "purchase_date", "is_recurring", "is_silent",
                    "is_simulated", "is_scheduled", "account_id", "card_id",
                    "category_id", "project_id", "recurrence_id",
                    "destination_account_id"
                ],
                required: ["title", "amount", "type", "status", "expected_date"],
                path: "\(path).record"
            )
        case .recurrenceCreate:
            _ = try validateRecord(
                object["record"] ?? .null,
                collection: .recurrences,
                allowed: [
                    "name", "amount", "payday", "type", "status", "account_id",
                    "card_id", "category_id", "end_date", "total_installments",
                    "skipped_periods"
                ],
                required: ["name", "amount", "payday", "type"],
                path: "\(path).record"
            )
        case .transactionUpdate:
            try validatePatch(object["patch"] ?? .null, path: "\(path).patch")
        case .transactionRealize:
            _ = try validateBoolean(object["update_balance"] ?? .null, path: "\(path).update_balance")
            try validateIdentifier(object["id"] ?? .null, path: "\(path).id")
        case .transactionDelete:
            try validateIdentifier(object["id"] ?? .null, path: "\(path).id")
        case .transactionSetSimulated:
            try validateIdentifier(object["id"] ?? .null, path: "\(path).id")
            _ = try validateBoolean(
                object["is_simulated"] ?? .null,
                path: "\(path).is_simulated"
            )
        case .invoicePay:
            try validateIdentifier(object["card_id"] ?? .null, path: "\(path).card_id")
            try validatePeriod(object["period"] ?? .null, path: "\(path).period")
            _ = try validateBoolean(
                object["ignore_balance"] ?? .null,
                path: "\(path).ignore_balance"
            )
            if let account = object["account_id"], !FixtureJSON.isNull(account) {
                try validateIdentifier(account, path: "\(path).account_id")
            }
            if let amount = object["amount_paid"], !FixtureJSON.isNull(amount) {
                _ = try FixtureMoney.parse(amount, path: "\(path).amount_paid")
            }
        case .invoiceDelete:
            try validateIdentifier(object["card_id"] ?? .null, path: "\(path).card_id")
            try validatePeriod(object["period"] ?? .null, path: "\(path).period")
        case .invoiceSummaries:
            try validateIdentifier(object["card_id"] ?? .null, path: "\(path).card_id")
        case .recurrenceSetStatus:
            try validateIdentifier(object["id"] ?? .null, path: "\(path).id")
            let status = try FixtureJSON.string(
                object["status"] ?? .null,
                path: "\(path).status"
            )
            guard RecurrenceStatus(rawValue: status) != nil else {
                throw ParityFailure("\(path).status: unknown recurrence status '\(status)'")
            }
        case .recurrenceLaunch:
            try validateIdentifier(object["id"] ?? .null, path: "\(path).id")
        case .recurrenceProcessMonth:
            break
        case .forecastGenerate:
            _ = try FixtureDates.parseDay(
                object["start_date"] ?? .null,
                path: "\(path).start_date"
            )
            _ = try FixtureDates.parseDay(
                object["end_date"] ?? .null,
                path: "\(path).end_date"
            )
            _ = try validateBoolean(
                object["include_simulations"] ?? .null,
                path: "\(path).include_simulations"
            )
        case .budgetSummaries:
            break
        case .projectPayment:
            try validateIdentifier(object["project_id"] ?? .null, path: "\(path).project_id")
            _ = try FixtureMoney.parse(object["amount"] ?? .null, path: "\(path).amount")
            if let description = object["description"], !FixtureJSON.isNull(description) {
                _ = try FixtureJSON.string(description, path: "\(path).description")
            }
        case .projectComplete:
            try validateIdentifier(object["id"] ?? .null, path: "\(path).id")
        case .projectSummaries:
            break
        }

        let captures = try parseCaptures(object["capture"], path: "\(path).capture")
        let fault = try parseFault(object["fault"], path: "\(path).fault")

        return ParsedCommand(
            kind: kind,
            object: object,
            captures: captures,
            fault: fault
        )
    }

    private struct CommandSchema {
        let allowed: Set<String>
        let required: Set<String>
    }

    private static func commandSchema(_ kind: CommandKind) -> CommandSchema {
        let readOnly: Set<String> = ["kind"]
        switch kind {
        case .accountCreate:
            return CommandSchema(
                allowed: ["kind", "record", "capture", "fault"],
                required: ["kind", "record"]
            )
        case .transactionCreate:
            return CommandSchema(
                allowed: ["kind", "record", "capture", "fault"],
                required: ["kind", "record"]
            )
        case .recurrenceCreate:
            return CommandSchema(
                allowed: ["kind", "record", "capture", "fault"],
                required: ["kind", "record"]
            )
        case .transactionUpdate:
            return CommandSchema(
                allowed: ["kind", "id", "patch", "capture", "fault"],
                required: ["kind", "id", "patch"]
            )
        case .transactionRealize:
            return CommandSchema(
                allowed: ["kind", "id", "update_balance", "capture", "fault"],
                required: ["kind", "id", "update_balance"]
            )
        case .transactionDelete:
            return CommandSchema(
                allowed: ["kind", "id", "capture", "fault"],
                required: ["kind", "id"]
            )
        case .transactionSetSimulated:
            return CommandSchema(
                allowed: ["kind", "id", "is_simulated", "capture", "fault"],
                required: ["kind", "id", "is_simulated"]
            )
        case .invoicePay:
            return CommandSchema(
                allowed: [
                    "kind", "card_id", "period", "account_id", "amount_paid",
                    "ignore_balance", "capture", "fault"
                ],
                required: ["kind", "card_id", "period", "ignore_balance"]
            )
        case .invoiceDelete:
            return CommandSchema(
                allowed: ["kind", "card_id", "period", "capture", "fault"],
                required: ["kind", "card_id", "period"]
            )
        case .invoiceSummaries:
            return CommandSchema(
                allowed: readOnly.union(["card_id"]),
                required: ["kind", "card_id"]
            )
        case .recurrenceSetStatus:
            return CommandSchema(
                allowed: ["kind", "id", "status", "capture", "fault"],
                required: ["kind", "id", "status"]
            )
        case .recurrenceLaunch:
            return CommandSchema(
                allowed: ["kind", "id", "capture", "fault"],
                required: ["kind", "id"]
            )
        case .recurrenceProcessMonth:
            return CommandSchema(
                allowed: readOnly.union(["capture", "fault"]),
                required: readOnly
            )
        case .forecastGenerate:
            return CommandSchema(
                allowed: readOnly.union(["start_date", "end_date", "include_simulations"]),
                required: ["kind", "start_date", "end_date", "include_simulations"]
            )
        case .budgetSummaries, .projectSummaries:
            return CommandSchema(allowed: readOnly, required: readOnly)
        case .projectPayment:
            return CommandSchema(
                allowed: ["kind", "project_id", "amount", "description", "capture", "fault"],
                required: ["kind", "project_id", "amount"]
            )
        case .projectComplete:
            return CommandSchema(
                allowed: ["kind", "id", "capture", "fault"],
                required: ["kind", "id"]
            )
        }
    }

    private static func parseCaptures(
        _ value: JSONValue?,
        path: String
    ) throws -> [String: CaptureSpec] {
        guard let value else { return [:] }
        guard case .object(let object) = value else {
            throw ParityFailure("\(path): expected an object")
        }
        var captures: [String: CaptureSpec] = [:]
        captures.reserveCapacity(object.count)
        for name in object.keys.sorted() {
            try FixtureTokens.validateName(name, path: path)
            let specPath = "\(path).\(name)"
            let spec = try FixtureJSON.object(
                object[name] ?? .null,
                path: specPath,
                allowed: ["collection", "where"],
                required: ["collection", "where"]
            )
            let collectionName = try FixtureJSON.string(
                spec["collection"] ?? .null,
                path: "\(specPath).collection"
            )
            guard let collection = ParityCollection(rawValue: collectionName) else {
                throw ParityFailure(
                    "\(specPath).collection: unknown collection '\(collectionName)'"
                )
            }
            let whereObject = try FixtureJSON.object(
                spec["where"] ?? .null,
                path: "\(specPath).where",
                allowed: Set(collection.canonicalKeys).union(["id"]),
                required: []
            )
            for key in whereObject.keys.sorted() {
                let fieldPath = "\(specPath).where.\(key)"
                if key == "id" {
                    try validateIdentifier(whereObject[key] ?? .null, path: fieldPath)
                } else {
                    try validateFieldValue(
                        collection,
                        key: key,
                        value: whereObject[key] ?? .null,
                        path: fieldPath,
                        allowEmptyOptional: true
                    )
                }
            }
            captures[name] = CaptureSpec(
                collection: collection,
                whereFields: whereObject
            )
        }
        return captures
    }

    private static func parseFault(_ value: JSONValue?, path: String) throws -> CommandFault? {
        guard let value else { return nil }
        let object = try FixtureJSON.object(
            value,
            path: path,
            allowed: ["on_write", "error"],
            required: ["on_write", "error"]
        )
        let error = try FixtureJSON.string(object["error"] ?? .null, path: "\(path).error")
        guard error == "storage_failure" else {
            throw ParityFailure("\(path).error: only storage_failure is defined, got '\(error)'")
        }
        let onWrite = try FixtureJSON.object(
            object["on_write"] ?? .null,
            path: "\(path).on_write",
            allowed: ["collection", "record_id", "operation"],
            required: ["collection"]
        )
        let collectionName = try FixtureJSON.string(
            onWrite["collection"] ?? .null,
            path: "\(path).on_write.collection"
        )
        guard let collection = ParityCollection(rawValue: collectionName) else {
            throw ParityFailure(
                "\(path).on_write.collection: unknown collection '\(collectionName)'"
            )
        }
        var recordID: String?
        if let rawRecordID = onWrite["record_id"] {
            recordID = try FixtureJSON.string(
                rawRecordID,
                path: "\(path).on_write.record_id"
            )
            if let recordID, !FixtureTokens.isToken(recordID), !EntityID.isValid(recordID) {
                throw ParityFailure(
                    "\(path).on_write.record_id: '\(recordID)' is not a valid identifier"
                )
            }
        }
        var operation: String?
        if let rawOperation = onWrite["operation"] {
            let value = try FixtureJSON.string(
                rawOperation,
                path: "\(path).on_write.operation"
            )
            guard ["create", "update", "delete"].contains(value) else {
                throw ParityFailure(
                    "\(path).on_write.operation: unknown operation '\(value)'"
                )
            }
            operation = value
        }
        return CommandFault(
            collection: collection,
            recordID: recordID,
            operation: operation
        )
    }

    private struct Expectation {
        let error: ExpectedError?
        let snapshot: JSONValue?
        let projections: [JSONValue]?
    }

    private static func parseExpectation(_ value: JSONValue, path: String) throws -> Expectation {
        let object = try FixtureJSON.object(
            value,
            path: path,
            allowed: ["error", "snapshot", "projections"],
            required: []
        )
        var error: ExpectedError?
        if let rawError = object["error"] {
            let errorObject = try FixtureJSON.object(
                rawError,
                path: "\(path).error",
                allowed: ["code", "entity", "entity_id"],
                required: ["code"]
            )
            let code = try FixtureJSON.string(
                errorObject["code"] ?? .null,
                path: "\(path).error.code"
            )
            guard canonicalErrorCodes.contains(code) else {
                throw ParityFailure("\(path).error.code: unknown canonical code '\(code)'")
            }
            let entity = try errorObject["entity"].map { value in
                try FixtureJSON.string(value, path: "\(path).error.entity")
            }
            let entityID = try errorObject["entity_id"].map { value in
                try FixtureJSON.string(value, path: "\(path).error.entity_id")
            }
            error = ExpectedError(code: code, entity: entity, entityID: entityID)
        }

        let projections: [JSONValue]?
        if let rawProjections = object["projections"] {
            projections = try FixtureJSON.array(
                rawProjections,
                path: "\(path).projections"
            )
        } else {
            projections = nil
        }

        return Expectation(
            error: error,
            snapshot: object["snapshot"],
            projections: projections
        )
    }

    private static func validateRecord(
        _ value: JSONValue,
        collection: ParityCollection,
        allowed: Set<String>,
        required: Set<String>,
        path: String
    ) throws -> [String: JSONValue] {
        let object = try FixtureJSON.object(
            value,
            path: path,
            allowed: allowed,
            required: required
        )
        for key in object.keys.sorted() {
            let value = object[key] ?? .null
            if FixtureJSON.isNull(value) {
                if required.contains(key) {
                    throw ParityFailure("\(path).\(key): required field cannot be null")
                }
                continue
            }
            try validateFieldValue(
                collection,
                key: key,
                value: value,
                path: "\(path).\(key)",
                allowEmptyOptional: !required.contains(key)
            )
        }
        return object
    }

    private static func validatePatch(_ value: JSONValue, path: String) throws {
        let allowed: Set<String> = [
            "title", "amount", "type", "status", "expected_date", "realized_date",
            "purchase_date", "is_recurring", "is_silent", "is_simulated",
            "is_scheduled", "account_id", "card_id", "category_id", "project_id",
            "recurrence_id", "destination_account_id"
        ]
        let object = try FixtureJSON.object(
            value,
            path: path,
            allowed: allowed,
            required: []
        )
        for key in object.keys.sorted() {
            let fieldPath = "\(path).\(key)"
            let fieldValue = object[key] ?? .null
            if FixtureJSON.isNull(fieldValue) {
                let nullable = [
                    "realized_date", "purchase_date", "account_id", "card_id",
                    "category_id", "project_id", "recurrence_id",
                    "destination_account_id"
                ].contains(key)
                guard nullable else {
                    throw ParityFailure("\(fieldPath): field cannot be cleared with null")
                }
                continue
            }
            try validateFieldValue(
                .transactions,
                key: key,
                value: fieldValue,
                path: fieldPath,
                allowEmptyOptional: true
            )
        }
    }

    private static func validateFieldValue(
        _ collection: ParityCollection,
        key: String,
        value: JSONValue,
        path: String,
        allowEmptyOptional: Bool
    ) throws {
        guard let kind = collection.kind(for: key) else {
            throw ParityFailure("\(path): unknown field '\(key)'")
        }
        switch kind {
        case .text:
            let string = try FixtureJSON.string(value, path: path)
            if FixtureTokens.isToken(string) { return }
            try ParitySnapshots.validateText(
                collection,
                key: key,
                value: string,
                path: path
            )
        case .money:
            _ = try FixtureMoney.parse(value, path: path)
        case .integer:
            _ = try FixtureInteger.parse(value, path: path)
        case .boolean:
            _ = try validateBoolean(value, path: path)
        case .instant:
            let string = try FixtureJSON.string(value, path: path)
            if string.isEmpty {
                if allowEmptyOptional { return }
                throw ParityFailure("\(path): required instant cannot be empty")
            }
            if FixtureTokens.isToken(string) { return }
            _ = try FixtureDates.parseInstant(string, path: path)
        case .relation:
            let string = try FixtureJSON.string(value, path: path)
            if string.isEmpty {
                if allowEmptyOptional { return }
                throw ParityFailure("\(path): required relation cannot be empty")
            }
            if FixtureTokens.isToken(string) { return }
            guard EntityID.isValid(string) else {
                throw ParityFailure("\(path): '\(string)' is not a valid identifier")
            }
        case .periods:
            let array = try FixtureJSON.array(value, path: path)
            for (index, element) in array.enumerated() {
                let period = try FixtureJSON.string(element, path: "\(path)[\(index)]")
                try ParitySnapshots.validatePeriod(period, path: "\(path)[\(index)]")
            }
        }
    }

    private static func validateIdentifier(_ value: JSONValue, path: String) throws {
        let string = try FixtureJSON.string(value, path: path)
        if FixtureTokens.isToken(string) { return }
        guard EntityID.isValid(string) else {
            throw ParityFailure("\(path): '\(string)' is not a valid identifier")
        }
    }

    private static func validatePeriod(_ value: JSONValue, path: String) throws {
        let string = try FixtureJSON.string(value, path: path)
        guard !FixtureTokens.isToken(string) else {
            throw ParityFailure("\(path): a period cannot be a capture reference")
        }
        try ParitySnapshots.validatePeriod(string, path: path)
    }

    private static func validateBoolean(_ value: JSONValue, path: String) throws -> Bool {
        try FixtureJSON.bool(value, path: path)
    }
}
