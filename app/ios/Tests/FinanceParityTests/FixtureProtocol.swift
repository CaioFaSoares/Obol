import Foundation
import ObolCore
import ObolNativeRuntime

struct ParityFailure: Error, CustomStringConvertible, Equatable {
    let message: String
    init(_ message: String) { self.message = message }
    var description: String { message }
}

enum ParityCollection: String, CaseIterable, Hashable {
    case accounts
    case cards
    case categories
    case invoices
    case projects
    case recurrences
    case transactions

    var entityType: String {
        switch self {
        case .accounts: return "account"
        case .cards: return "card"
        case .categories: return "category"
        case .invoices: return "invoice"
        case .projects: return "project"
        case .recurrences: return "recurrence"
        case .transactions: return "transaction"
        }
    }

    private static let kinds: [ParityCollection: [String: CanonicalFieldKind]] = [
        .accounts: [
            "name": .text,
            "type": .text,
            "initial_balance": .money
        ],
        .cards: [
            "name": .text,
            "closing_day": .integer,
            "due_day": .integer,
            "limit": .money
        ],
        .categories: [
            "name": .text,
            "type": .text,
            "monthly_budget": .money
        ],
        .invoices: [
            "card_id": .relation,
            "period": .text,
            "due_date": .instant,
            "status": .text,
            "total_amount": .money,
            "paid_amount": .money
        ],
        .projects: [
            "name": .text,
            "total_value": .money,
            "status": .text
        ],
        .recurrences: [
            "name": .text,
            "amount": .money,
            "payday": .integer,
            "type": .text,
            "status": .text,
            "account_id": .relation,
            "card_id": .relation,
            "category_id": .relation,
            "end_date": .instant,
            "total_installments": .integer,
            "skipped_periods": .periods,
            "frequency": .text,
            "weekday": .integer
        ],
        .transactions: [
            "title": .text,
            "amount": .money,
            "type": .text,
            "status": .text,
            "expected_date": .instant,
            "realized_date": .instant,
            "purchase_date": .instant,
            "is_recurring": .boolean,
            "is_silent": .boolean,
            "is_simulated": .boolean,
            "is_scheduled": .boolean,
            "account_id": .relation,
            "card_id": .relation,
            "category_id": .relation,
            "project_id": .relation,
            "invoice_id": .relation,
            "recurrence_id": .relation,
            "destination_account_id": .relation
        ]
    ]

    private static let required: [ParityCollection: Set<String>] = [
        .accounts: ["name", "type", "initial_balance"],
        .cards: ["name", "closing_day", "due_day", "limit"],
        .categories: ["name", "type"],
        .invoices: ["card_id", "period", "due_date", "status", "total_amount"],
        .projects: ["name", "total_value", "status"],
        .recurrences: ["name", "amount", "payday", "type", "status"],
        .transactions: ["title", "amount", "type", "status", "expected_date"]
    ]

    var fieldKinds: [String: CanonicalFieldKind] { Self.kinds[self] ?? [:] }
    var requiredKeys: Set<String> { Self.required[self] ?? [] }
    var canonicalKeys: [String] { fieldKinds.keys.sorted() }
    var allowedRecordKeys: Set<String> { Set(canonicalKeys).union(["id", "created", "updated"]) }
    func kind(for key: String) -> CanonicalFieldKind? { fieldKinds[key] }
}

enum CanonicalFieldKind {
    case text
    case money
    case integer
    case boolean
    case instant
    case relation
    case periods
}

enum CanonicalValue: Equatable {
    case text(String)
    case money(Decimal)
    case integer(Int)
    case boolean(Bool)
    case instant(Date)
    case periods([String])
    case null
}

struct NormalizedRecord: Equatable {
    let id: String
    let fields: [String: CanonicalValue]
}

enum FixtureMoney {
    private static let moneyPattern = #"^-?\d+(?:\.\d+)?$"#

    static func parse(_ value: JSONValue, path: String) throws -> Decimal {
        guard case .string(let raw) = value else {
            throw ParityFailure("\(path): money must be a decimal string")
        }
        return try parse(raw, path: path)
    }

    static func parse(_ raw: String, path: String) throws -> Decimal {
        guard raw.range(of: moneyPattern, options: .regularExpression) != nil,
              !raw.contains(" ") else {
            throw ParityFailure("\(path): '\(raw)' is not a decimal money string")
        }
        guard let decimal = Decimal(string: raw, locale: Locale(identifier: "en_US_POSIX")) else {
            throw ParityFailure("\(path): '\(raw)' could not be parsed as Decimal")
        }
        return decimal
    }

    static func format(_ value: Decimal) -> String {
        var copy = value
        return NSDecimalString(&copy, Locale(identifier: "en_US_POSIX"))
    }

    static func equal(_ lhs: Decimal, _ rhs: Decimal) -> Bool {
        NSDecimalNumber(decimal: lhs).compare(NSDecimalNumber(decimal: rhs)) == .orderedSame
    }
}

enum FixtureInteger {
    static func parse(_ value: JSONValue, path: String) throws -> Int {
        guard case .number(let decimal) = value else {
            throw ParityFailure("\(path): expected an integer")
        }
        let number = NSDecimalNumber(decimal: decimal)
        let intValue = number.intValue
        guard NSDecimalNumber(value: intValue).compare(number) == .orderedSame else {
            throw ParityFailure("\(path): '\(FixtureMoney.format(decimal))' is not an integer")
        }
        return intValue
    }
}

enum FixtureDates {
    private static let dayPattern = #"^\d{4}-\d{2}-\d{2}$"#

    static func parseInstant(_ value: JSONValue, path: String) throws -> Date {
        guard case .string(let raw) = value else {
            throw ParityFailure("\(path): expected an ISO-8601 instant string")
        }
        return try parseInstant(raw, path: path)
    }

    static func parseInstant(_ raw: String, path: String) throws -> Date {
        if let parsed = ObolDate.parse(raw) {
            return parsed
        }
        let padded = padSingleDigitTimeComponents(raw)
        if padded != raw, let parsed = ObolDate.parse(padded) {
            return parsed
        }
        throw ParityFailure("\(path): '\(raw)' is not a valid ISO-8601 instant")
    }

    static func parseOptionalInstant(_ value: JSONValue, path: String) throws -> Date? {
        guard case .string(let raw) = value else {
            throw ParityFailure("\(path): expected an ISO-8601 instant string")
        }
        if raw.isEmpty { return nil }
        return try parseInstant(raw, path: path)
    }

    static func parseOptionalInstant(_ raw: String, path: String) throws -> Date? {
        if raw.isEmpty { return nil }
        return try parseInstant(raw, path: path)
    }

    static func parseDay(_ value: JSONValue, path: String) throws -> Date {
        guard case .string(let raw) = value else {
            throw ParityFailure("\(path): expected a YYYY-MM-DD day string")
        }
        guard raw.range(of: dayPattern, options: .regularExpression) != nil else {
            throw ParityFailure("\(path): '\(raw)' is not a YYYY-MM-DD day")
        }
        guard let parsed = ObolDate.parse(raw), ObolDate.dayKey(parsed) == raw else {
            throw ParityFailure("\(path): '\(raw)' is not a valid UTC day")
        }
        return parsed
    }

    static func dayString(_ date: Date) -> String { ObolDate.dayKey(date) }
    static func instantString(_ date: Date) -> String { ObolDate.string(date) }

    private static func padSingleDigitTimeComponents(_ raw: String) -> String {
        var value = raw
        value = value.replacingOccurrences(
            of: #"T(\d):"#,
            with: "T0$1:",
            options: .regularExpression
        )
        value = value.replacingOccurrences(
            of: #":(\d):"#,
            with: ":0$1:",
            options: .regularExpression
        )
        value = value.replacingOccurrences(
            of: #":(\d)\."#,
            with: ":0$1.",
            options: .regularExpression
        )
        return value
    }
}

enum FixtureJSON {
    static func object(
        _ value: JSONValue,
        path: String,
        allowed: Set<String>,
        required: Set<String>
    ) throws -> [String: JSONValue] {
        guard case .object(let object) = value else {
            throw ParityFailure("\(path): expected an object")
        }
        for key in object.keys.sorted() where !allowed.contains(key) {
            throw ParityFailure("\(path): unknown field '\(key)'")
        }
        for key in required.sorted() where object[key] == nil {
            throw ParityFailure("\(path): missing required field '\(key)'")
        }
        return object
    }

    static func array(_ value: JSONValue, path: String) throws -> [JSONValue] {
        guard case .array(let array) = value else {
            throw ParityFailure("\(path): expected an array")
        }
        return array
    }

    static func string(_ value: JSONValue, path: String) throws -> String {
        guard case .string(let string) = value else {
            throw ParityFailure("\(path): expected a string")
        }
        return string
    }

    static func bool(_ value: JSONValue, path: String) throws -> Bool {
        guard case .bool(let flag) = value else {
            throw ParityFailure("\(path): expected a boolean")
        }
        return flag
    }

    static func isNull(_ value: JSONValue?) -> Bool {
        guard let value else { return true }
        if case .null = value { return true }
        return false
    }
}

enum FixtureTokens {
    private static let namePattern = #"^[A-Za-z_][A-Za-z0-9_]*$"#

    static func name(in string: String) -> String? {
        guard string.hasPrefix("$") else { return nil }
        let candidate = String(string.dropFirst())
        guard candidate.range(of: namePattern, options: .regularExpression) != nil else {
            return nil
        }
        return candidate
    }

    static func isToken(_ string: String) -> Bool { name(in: string) != nil }

    static func validateName(_ name: String, path: String) throws {
        guard name.range(of: namePattern, options: .regularExpression) != nil else {
            throw ParityFailure("\(path): capture name '\(name)' is not a valid identifier")
        }
    }

    static func resolve(
        _ value: JSONValue,
        captures: [String: String],
        path: String
    ) throws -> JSONValue {
        switch value {
        case .string(let string):
            guard let name = name(in: string) else { return value }
            guard let resolved = captures[name] else {
                throw ParityFailure("\(path): unresolved capture reference '\(string)'")
            }
            return .string(resolved)
        case .array(let array):
            return .array(try array.enumerated().map { index, element in
                try resolve(element, captures: captures, path: "\(path)[\(index)]")
            })
        case .object(let object):
            var resolved: [String: JSONValue] = [:]
            resolved.reserveCapacity(object.count)
            for key in object.keys.sorted() {
                resolved[key] = try resolve(
                    object[key] ?? .null,
                    captures: captures,
                    path: "\(path).\(key)"
                )
            }
            return .object(resolved)
        default:
            return value
        }
    }
}

enum ParitySnapshots {
    static func normalizedSnapshot(
        _ value: JSONValue,
        path: String,
        allowGeneratedTitle: Bool
    ) throws -> [ParityCollection: [String: NormalizedRecord]] {
        let collections = Set(ParityCollection.allCases.map(\.rawValue))
        let object = try FixtureJSON.object(
            value,
            path: path,
            allowed: collections,
            required: collections
        )

        var result: [ParityCollection: [String: NormalizedRecord]] = [:]
        var seenIdentifiers = Set<String>()

        for collection in ParityCollection.allCases {
            let rawRecords = try FixtureJSON.array(
                object[collection.rawValue] ?? .array([]),
                path: "\(path).\(collection.rawValue)"
            )
            var records: [String: NormalizedRecord] = [:]
            records.reserveCapacity(rawRecords.count)
            for (index, rawRecord) in rawRecords.enumerated() {
                let recordPath = "\(path).\(collection.rawValue)[\(index)]"
                let record = try normalizedRecord(
                    collection,
                    value: rawRecord,
                    path: recordPath,
                    allowGeneratedTitle: allowGeneratedTitle
                )
                guard records[record.id] == nil else {
                    throw ParityFailure("\(recordPath): duplicate id '\(record.id)'")
                }
                guard seenIdentifiers.insert(record.id).inserted else {
                    throw ParityFailure("\(recordPath): id '\(record.id)' is used more than once")
                }
                records[record.id] = record
            }
            result[collection] = records
        }
        return result
    }

    static func normalizedRecord(
        _ collection: ParityCollection,
        value: JSONValue,
        path: String,
        allowGeneratedTitle: Bool
    ) throws -> NormalizedRecord {
        let object = try FixtureJSON.object(
            value,
            path: path,
            allowed: collection.allowedRecordKeys,
            required: collection.requiredKeys.union(["id"])
        )
        let id = try FixtureJSON.string(object["id"] ?? .null, path: "\(path).id")
        guard EntityID.isValid(id) else {
            throw ParityFailure("\(path).id: '\(id)' is not a 15-character lowercase alphanumeric id")
        }

        var fields: [String: CanonicalValue] = [:]
        fields.reserveCapacity(collection.canonicalKeys.count)

        for key in collection.canonicalKeys {
            guard let kind = collection.kind(for: key) else { continue }
            let required = collection.requiredKeys.contains(key)
            let fieldPath = "\(path).\(key)"
            guard let raw = object[key] else {
                if required {
                    throw ParityFailure("\(fieldPath): missing required field")
                }
                fields[key] = defaultValue(for: key, kind: kind)
                continue
            }
            if FixtureJSON.isNull(raw) {
                if required {
                    throw ParityFailure("\(fieldPath): required field cannot be null")
                }
                fields[key] = defaultValue(for: key, kind: kind)
                continue
            }
            fields[key] = try normalizedField(
                collection,
                key: key,
                kind: kind,
                required: required,
                value: raw,
                path: fieldPath,
                allowGeneratedTitle: allowGeneratedTitle
            )
        }

        return NormalizedRecord(id: id, fields: fields)
    }

    private static func normalizedField(
        _ collection: ParityCollection,
        key: String,
        kind: CanonicalFieldKind,
        required: Bool,
        value: JSONValue,
        path: String,
        allowGeneratedTitle: Bool
    ) throws -> CanonicalValue {
        switch kind {
        case .text:
            let string = try FixtureJSON.string(value, path: path)
            if key == "title" && allowGeneratedTitle && string == "*generated*" {
                return .text(string)
            }
            try validateText(collection, key: key, value: string, path: path)
            return .text(string)

        case .money:
            return .money(try FixtureMoney.parse(value, path: path))

        case .integer:
            let integer = try FixtureInteger.parse(value, path: path)
            if key == "total_installments" && integer == 0 {
                return .null
            }
            if key == "weekday" {
                guard (0...7).contains(integer) else {
                    throw ParityFailure("\(path): '\(integer)' is not an ISO weekday between 1 and 7")
                }
                // 0 is the stored blank weekday of a monthly row.
                if integer == 0 { return .null }
            }
            return .integer(integer)

        case .boolean:
            return .boolean(try FixtureJSON.bool(value, path: path))

        case .instant:
            let string = try FixtureJSON.string(value, path: path)
            if !required && string.isEmpty {
                return .null
            }
            return .instant(try FixtureDates.parseInstant(string, path: path))

        case .relation:
            let string = try FixtureJSON.string(value, path: path)
            if string.isEmpty {
                if required {
                    throw ParityFailure("\(path): required relation cannot be empty")
                }
                return .null
            }
            guard EntityID.isValid(string) else {
                throw ParityFailure("\(path): relation '\(string)' is not a valid identifier")
            }
            return .text(string)

        case .periods:
            let array = try FixtureJSON.array(value, path: path)
            var periods: [String] = []
            periods.reserveCapacity(array.count)
            for (index, element) in array.enumerated() {
                let period = try FixtureJSON.string(element, path: "\(path)[\(index)]")
                try validateSkipKey(period, path: "\(path)[\(index)]")
                periods.append(period)
            }
            return .periods(Array(Set(periods)).sorted())
        }
    }

    private static func defaultValue(for key: String, kind _: CanonicalFieldKind) -> CanonicalValue {
        switch key {
        case "paid_amount":
            return .money(0)
        case "is_recurring", "is_silent", "is_simulated", "is_scheduled":
            return .boolean(false)
        case "skipped_periods":
            return .periods([])
        case "frequency":
            // An absent cadence is monthly, exactly as the engine reads it.
            return .text(RecurrenceFrequency.monthly.rawValue)
        default:
            return .null
        }
    }

    static func validateText(
        _ collection: ParityCollection,
        key: String,
        value: String,
        path: String
    ) throws {
        switch (collection, key) {
        case (.accounts, "type"):
            guard AccountType(rawValue: value) != nil else {
                throw ParityFailure("\(path): unknown account type '\(value)'")
            }
        case (.categories, "type"):
            guard CategoryType(rawValue: value) != nil else {
                throw ParityFailure("\(path): unknown category type '\(value)'")
            }
        case (.invoices, "status"):
            guard InvoiceStatus(rawValue: value) != nil else {
                throw ParityFailure("\(path): unknown invoice status '\(value)'")
            }
        case (.projects, "status"):
            guard ProjectStatus(rawValue: value) != nil else {
                throw ParityFailure("\(path): unknown project status '\(value)'")
            }
        case (.recurrences, "type"):
            guard RecurrenceType(rawValue: value) != nil else {
                throw ParityFailure("\(path): unknown recurrence type '\(value)'")
            }
        case (.recurrences, "status"):
            guard RecurrenceStatus(rawValue: value) != nil else {
                throw ParityFailure("\(path): unknown recurrence status '\(value)'")
            }
        case (.recurrences, "frequency"):
            guard RecurrenceFrequency(rawValue: value) != nil else {
                throw ParityFailure("\(path): unknown recurrence frequency '\(value)'")
            }
        case (.transactions, "type"):
            guard TransactionType(rawValue: value) != nil else {
                throw ParityFailure("\(path): unknown transaction type '\(value)'")
            }
        case (.transactions, "status"):
            guard TransactionStatus(rawValue: value) != nil else {
                throw ParityFailure("\(path): unknown transaction status '\(value)'")
            }
        case (.invoices, "period"):
            try validatePeriod(value, path: path)
        default:
            break
        }
    }

    static func validatePeriod(_ value: String, path: String) throws {
        guard value.range(
            of: #"^\d{4}-(0[1-9]|1[0-2])$"#,
            options: .regularExpression
        ) != nil else {
            throw ParityFailure("\(path): '\(value)' is not a YYYY-MM period")
        }
    }

    /// `skipped_periods` holds both shapes: `YYYY-MM` for monthly rows and
    /// `YYYY-MM-DD` for weekly rows.
    static func validateSkipKey(_ value: String, path: String) throws {
        let month = value.range(of: #"^\d{4}-(0[1-9]|1[0-2])$"#, options: .regularExpression) != nil
        let day = value.range(
            of: #"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$"#,
            options: .regularExpression
        ) != nil
        guard month || day else {
            throw ParityFailure("\(path): '\(value)' is not a YYYY-MM or YYYY-MM-DD skip key")
        }
    }

    static func buildSnapshot(
        _ records: [ParityCollection: [String: NormalizedRecord]]
    ) throws -> FinancialSnapshot {
        var snapshot = FinancialSnapshot()

        snapshot.accounts = try (records[.accounts] ?? [:]).values.sorted { $0.id < $1.id }.map { record in
            Account(
                id: record.id,
                name: try text(record, "name"),
                type: try enumValue(AccountType.self, record, "type"),
                initialBalance: try money(record, "initial_balance")
            )
        }

        snapshot.cards = try (records[.cards] ?? [:]).values.sorted { $0.id < $1.id }.map { record in
            Card(
                id: record.id,
                name: try text(record, "name"),
                closingDay: try integer(record, "closing_day"),
                dueDay: try integer(record, "due_day"),
                limit: try money(record, "limit")
            )
        }

        snapshot.categories = try (records[.categories] ?? [:]).values.sorted { $0.id < $1.id }.map { record in
            Category(
                id: record.id,
                name: try text(record, "name"),
                type: try enumValue(CategoryType.self, record, "type"),
                monthlyBudget: try optionalMoney(record, "monthly_budget")
            )
        }

        snapshot.invoices = try (records[.invoices] ?? [:]).values.sorted { $0.id < $1.id }.map { record in
            Invoice(
                id: record.id,
                cardID: try text(record, "card_id"),
                period: try text(record, "period"),
                dueDate: try instant(record, "due_date"),
                status: try enumValue(InvoiceStatus.self, record, "status"),
                totalAmount: try money(record, "total_amount"),
                paidAmount: try money(record, "paid_amount")
            )
        }

        snapshot.projects = try (records[.projects] ?? [:]).values.sorted { $0.id < $1.id }.map { record in
            Project(
                id: record.id,
                name: try text(record, "name"),
                totalValue: try money(record, "total_value"),
                status: try enumValue(ProjectStatus.self, record, "status")
            )
        }

        snapshot.recurrences = try (records[.recurrences] ?? [:]).values.sorted { $0.id < $1.id }.map { record in
            let periods = periodsValue(record, "skipped_periods")
            return Recurrence(
                id: record.id,
                name: try text(record, "name"),
                amount: try money(record, "amount"),
                payday: try integer(record, "payday"),
                type: try enumValue(RecurrenceType.self, record, "type"),
                status: try enumValue(RecurrenceStatus.self, record, "status"),
                accountID: optionalText(record, "account_id"),
                cardID: optionalText(record, "card_id"),
                categoryID: optionalText(record, "category_id"),
                endDate: optionalInstant(record, "end_date"),
                totalInstallments: optionalInteger(record, "total_installments"),
                skippedPeriods: periods.isEmpty ? nil : periods,
                frequency: try enumValue(RecurrenceFrequency.self, record, "frequency"),
                weekday: optionalInteger(record, "weekday")
            )
        }

        snapshot.transactions = try (records[.transactions] ?? [:]).values.sorted { $0.id < $1.id }.map { record in
            Transaction(
                id: record.id,
                title: try text(record, "title"),
                amount: try money(record, "amount"),
                type: try enumValue(TransactionType.self, record, "type"),
                status: try enumValue(TransactionStatus.self, record, "status"),
                expectedDate: try instant(record, "expected_date"),
                realizedDate: optionalInstant(record, "realized_date"),
                purchaseDate: optionalInstant(record, "purchase_date"),
                isRecurring: boolean(record, "is_recurring"),
                isSilent: boolean(record, "is_silent"),
                isSimulated: boolean(record, "is_simulated"),
                isScheduled: boolean(record, "is_scheduled"),
                accountID: optionalText(record, "account_id"),
                cardID: optionalText(record, "card_id"),
                categoryID: optionalText(record, "category_id"),
                projectID: optionalText(record, "project_id"),
                invoiceID: optionalText(record, "invoice_id"),
                recurrenceID: optionalText(record, "recurrence_id"),
                destinationAccountID: optionalText(record, "destination_account_id")
            )
        }

        return snapshot
    }

    static func canonicalSnapshot(
        _ snapshot: FinancialSnapshot
    ) -> [ParityCollection: [String: NormalizedRecord]] {
        var result: [ParityCollection: [String: NormalizedRecord]] = [:]

        result[.accounts] = Dictionary(uniqueKeysWithValues: snapshot.accounts.map { account in
            (account.id, NormalizedRecord(id: account.id, fields: [
                "name": .text(account.name),
                "type": .text(account.type.rawValue),
                "initial_balance": .money(account.initialBalance)
            ]))
        })

        result[.cards] = Dictionary(uniqueKeysWithValues: snapshot.cards.map { card in
            (card.id, NormalizedRecord(id: card.id, fields: [
                "name": .text(card.name),
                "closing_day": .integer(card.closingDay),
                "due_day": .integer(card.dueDay),
                "limit": .money(card.limit)
            ]))
        })

        result[.categories] = Dictionary(uniqueKeysWithValues: snapshot.categories.map { category in
            (category.id, NormalizedRecord(id: category.id, fields: [
                "name": .text(category.name),
                "type": .text(category.type.rawValue),
                "monthly_budget": category.monthlyBudget.map { .money($0) } ?? .null
            ]))
        })

        result[.invoices] = Dictionary(uniqueKeysWithValues: snapshot.invoices.map { invoice in
            (invoice.id, NormalizedRecord(id: invoice.id, fields: [
                "card_id": .text(invoice.cardID),
                "period": .text(invoice.period),
                "due_date": .instant(invoice.dueDate),
                "status": .text(invoice.status.rawValue),
                "total_amount": .money(invoice.totalAmount),
                "paid_amount": .money(invoice.paidAmount ?? 0)
            ]))
        })

        result[.projects] = Dictionary(uniqueKeysWithValues: snapshot.projects.map { project in
            (project.id, NormalizedRecord(id: project.id, fields: [
                "name": .text(project.name),
                "total_value": .money(project.totalValue),
                "status": .text(project.status.rawValue)
            ]))
        })

        result[.recurrences] = Dictionary(uniqueKeysWithValues: snapshot.recurrences.map { recurrence in
            let installments: CanonicalValue
            if let total = recurrence.totalInstallments, total != 0 {
                installments = .integer(total)
            } else {
                installments = .null
            }
            return (recurrence.id, NormalizedRecord(id: recurrence.id, fields: [
                "name": .text(recurrence.name),
                "amount": .money(recurrence.amount),
                "payday": .integer(recurrence.payday),
                "type": .text(recurrence.type.rawValue),
                "status": .text(recurrence.status.rawValue),
                "account_id": relation(recurrence.accountID),
                "card_id": relation(recurrence.cardID),
                "category_id": relation(recurrence.categoryID),
                "end_date": recurrence.endDate.map { .instant($0) } ?? .null,
                "total_installments": installments,
                "skipped_periods": .periods((recurrence.skippedPeriods ?? []).sorted()),
                "frequency": .text(recurrence.cadence.rawValue),
                "weekday": recurrence.weekday.map { .integer($0) } ?? .null
            ]))
        })

        result[.transactions] = Dictionary(uniqueKeysWithValues: snapshot.transactions.map { transaction in
            (transaction.id, NormalizedRecord(id: transaction.id, fields: [
                "title": .text(transaction.title),
                "amount": .money(transaction.amount),
                "type": .text(transaction.type.rawValue),
                "status": .text(transaction.status.rawValue),
                "expected_date": .instant(transaction.expectedDate),
                "realized_date": transaction.realizedDate.map { .instant($0) } ?? .null,
                "purchase_date": transaction.purchaseDate.map { .instant($0) } ?? .null,
                "is_recurring": .boolean(transaction.isRecurring ?? false),
                "is_silent": .boolean(transaction.isSilent ?? false),
                "is_simulated": .boolean(transaction.isSimulated ?? false),
                "is_scheduled": .boolean(transaction.isScheduled ?? false),
                "account_id": relation(transaction.accountID),
                "card_id": relation(transaction.cardID),
                "category_id": relation(transaction.categoryID),
                "project_id": relation(transaction.projectID),
                "invoice_id": relation(transaction.invoiceID),
                "recurrence_id": relation(transaction.recurrenceID),
                "destination_account_id": relation(transaction.destinationAccountID)
            ]))
        })

        return result
    }

    static func compareSnapshots(
        caseID: String,
        expected: [ParityCollection: [String: NormalizedRecord]],
        actual: [ParityCollection: [String: NormalizedRecord]]
    ) throws {
        var differences: [String] = []

        for collection in ParityCollection.allCases {
            let expectedRecords = expected[collection] ?? [:]
            let actualRecords = actual[collection] ?? [:]
            let expectedIDs = Set(expectedRecords.keys)
            let actualIDs = Set(actualRecords.keys)

            for id in expectedIDs.subtracting(actualIDs).sorted() {
                differences.append("\(collection.rawValue)[\(id)]: missing record")
            }
            for id in actualIDs.subtracting(expectedIDs).sorted() {
                differences.append("\(collection.rawValue)[\(id)]: unexpected record")
            }

            for id in expectedIDs.intersection(actualIDs).sorted() {
                guard let expectedRecord = expectedRecords[id],
                      let actualRecord = actualRecords[id] else { continue }
                let keys = Set(expectedRecord.fields.keys)
                    .union(actualRecord.fields.keys)
                    .sorted()
                for key in keys {
                    let expectedValue = expectedRecord.fields[key] ?? .null
                    let actualValue = actualRecord.fields[key] ?? .null
                    if key == "title",
                       case .text("*generated*") = expectedValue,
                       case .text(let generated) = actualValue {
                        if !generated.isEmpty { continue }
                    }
                    if !valuesMatch(expectedValue, actualValue) {
                        differences.append(
                            "\(collection.rawValue)[\(id)].\(key): expected \(format(expectedValue)), actual \(format(actualValue))"
                        )
                    }
                }
            }
        }

        guard differences.isEmpty else {
            throw ParityFailure(
                "case \(caseID): snapshot mismatch\n" + differences.joined(separator: "\n")
            )
        }
    }

    static func valuesMatch(_ lhs: CanonicalValue, _ rhs: CanonicalValue) -> Bool {
        switch (lhs, rhs) {
        case (.money(let left), .money(let right)):
            return FixtureMoney.equal(left, right)
        case (.instant(let left), .instant(let right)):
            return left == right
        case (.periods(let left), .periods(let right)):
            return left == right
        case (.text(let left), .text(let right)):
            return left == right
        case (.integer(let left), .integer(let right)):
            return left == right
        case (.boolean(let left), .boolean(let right)):
            return left == right
        case (.null, .null):
            return true
        default:
            return false
        }
    }

    static func format(_ value: CanonicalValue) -> String {
        switch value {
        case .text(let string): return "'\(string)'"
        case .money(let decimal): return FixtureMoney.format(decimal)
        case .integer(let integer): return "\(integer)"
        case .boolean(let flag): return flag ? "true" : "false"
        case .instant(let date): return FixtureDates.instantString(date)
        case .periods(let periods): return "[" + periods.joined(separator: ",") + "]"
        case .null: return "null"
        }
    }

    static func relation(_ id: String?) -> CanonicalValue {
        id.map { .text($0) } ?? .null
    }

    private static func text(_ record: NormalizedRecord, _ key: String) throws -> String {
        guard case .text(let value) = record.fields[key] else {
            throw ParityFailure("record \(record.id) field '\(key)' is not text")
        }
        return value
    }

    private static func optionalText(_ record: NormalizedRecord, _ key: String) -> String? {
        guard case .text(let value) = record.fields[key] else { return nil }
        return value
    }

    private static func money(_ record: NormalizedRecord, _ key: String) throws -> Decimal {
        guard case .money(let value) = record.fields[key] else {
            throw ParityFailure("record \(record.id) field '\(key)' is not money")
        }
        return value
    }

    private static func optionalMoney(_ record: NormalizedRecord, _ key: String) throws -> Decimal? {
        guard case .money(let value) = record.fields[key] else { return nil }
        return value
    }

    private static func integer(_ record: NormalizedRecord, _ key: String) throws -> Int {
        guard case .integer(let value) = record.fields[key] else {
            throw ParityFailure("record \(record.id) field '\(key)' is not an integer")
        }
        return value
    }

    private static func optionalInteger(_ record: NormalizedRecord, _ key: String) -> Int? {
        guard case .integer(let value) = record.fields[key] else { return nil }
        return value
    }

    private static func boolean(_ record: NormalizedRecord, _ key: String) -> Bool {
        guard case .boolean(let value) = record.fields[key] else { return false }
        return value
    }

    private static func instant(_ record: NormalizedRecord, _ key: String) throws -> Date {
        guard case .instant(let value) = record.fields[key] else {
            throw ParityFailure("record \(record.id) field '\(key)' is not an instant")
        }
        return value
    }

    private static func optionalInstant(_ record: NormalizedRecord, _ key: String) -> Date? {
        guard case .instant(let value) = record.fields[key] else { return nil }
        return value
    }

    private static func periodsValue(_ record: NormalizedRecord, _ key: String) -> [String] {
        guard case .periods(let value) = record.fields[key] else { return [] }
        return value
    }

    private static func enumValue<T: RawRepresentable>(
        _ type: T.Type,
        _ record: NormalizedRecord,
        _ key: String
    ) throws -> T where T.RawValue == String {
        let raw = try text(record, key)
        guard let value = T(rawValue: raw) else {
            throw ParityFailure("record \(record.id) field '\(key)' has unknown value '\(raw)'")
        }
        return value
    }
}
