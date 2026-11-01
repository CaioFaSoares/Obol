import Foundation
import SQLite3
import ObolCore
import ObolNativeRuntime

struct StoreContext {
    let store: ObolDatabase
    let directory: URL

    var databaseURL: URL {
        directory.appendingPathComponent(ObolDatabase.databaseFileName, isDirectory: false)
    }
}

enum StoreTestSupport {
    static func withStore<T>(_ body: (StoreContext) async throws -> T) async throws -> T {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ObolFinanceParity-\(UUID().uuidString)", isDirectory: true)
        let store: ObolDatabase
        do {
            store = try ObolDatabase(
                stationId: UUID().uuidString,
                directoryURL: directory
            )
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
        let context = StoreContext(store: store, directory: directory)

        do {
            let result = try await body(context)
            try await store.close()
            try? FileManager.default.removeItem(at: directory)
            return result
        } catch {
            try? await store.close()
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    static func envelope(
        store: ObolDatabase,
        snapshot: JSONValue,
        now: Date
    ) async throws -> Data {
        let exported = try await store.exportJSON()
        let exportedValue = try JSONValue(parsing: exported)
        guard case .object(var root) = exportedValue else {
            throw ParityFailure("local export is not a JSON object")
        }
        guard let countsValue = root["counts"],
              case .object(var counts) = countsValue else {
            throw ParityFailure("local export has no counts object")
        }
        guard let entitiesValue = counts["entities"],
              case .object(var entities) = entitiesValue else {
            throw ParityFailure("local export counts have no entities object")
        }
        guard case .object(let snapshotObject) = snapshot else {
            throw ParityFailure("seed snapshot must be a JSON object")
        }

        var total = 0
        for collection in ParityCollection.allCases {
            let value = snapshotObject[collection.rawValue] ?? .array([])
            guard case .array(let records) = value else {
                throw ParityFailure("seed snapshot collection '\(collection.rawValue)' is not an array")
            }
            entities[collection.rawValue] = .number(Decimal(records.count))
            total += records.count
        }
        counts["entities"] = .object(entities)
        counts["baseRows"] = .number(Decimal(total))
        counts["workingRows"] = .number(Decimal(total))
        counts["outboxRows"] = .number(0)
        counts["conflicts"] = .number(0)
        counts["appliedOperations"] = .number(0)

        root["counts"] = .object(counts)
        root["snapshot"] = snapshot
        root["exportedAt"] = .string(ObolDate.string(now))

        return try CanonicalJSON.data(.object(root))
    }

    static func seed(
        _ context: StoreContext,
        snapshot: JSONValue,
        now: Date
    ) async throws {
        try await seed(store: context.store, snapshot: snapshot, now: now)
    }

    static func seed(
        store: ObolDatabase,
        snapshot: JSONValue,
        now: Date
    ) async throws {
        let data = try await envelope(
            store: store,
            snapshot: snapshot,
            now: now
        )
        _ = try await store.importJSON(
            data,
            mode: .replaceFinancialData(discardPendingOperations: false)
        )
    }

    static func seed(
        _ context: StoreContext,
        snapshot: FinancialSnapshot,
        now: Date
    ) async throws {
        try await seed(context, snapshot: snapshotJSON(snapshot), now: now)
    }

    static func snapshotJSON(_ snapshot: FinancialSnapshot) -> JSONValue {
        .object([
            ParityCollection.accounts.rawValue: .array(snapshot.accounts.map { accountJSON($0) }),
            ParityCollection.cards.rawValue: .array(snapshot.cards.map { cardJSON($0) }),
            ParityCollection.categories.rawValue: .array(snapshot.categories.map { categoryJSON($0) }),
            ParityCollection.invoices.rawValue: .array(snapshot.invoices.map { invoiceJSON($0) }),
            ParityCollection.projects.rawValue: .array(snapshot.projects.map { projectJSON($0) }),
            ParityCollection.recurrences.rawValue: .array(snapshot.recurrences.map { recurrenceJSON($0) }),
            ParityCollection.transactions.rawValue: .array(snapshot.transactions.map { transactionJSON($0) })
        ])
    }

    private static func accountJSON(_ account: Account) -> JSONValue {
        .object([
            "id": .string(account.id),
            "name": .string(account.name),
            "type": .string(account.type.rawValue),
            "initial_balance": .number(account.initialBalance)
        ])
    }

    private static func cardJSON(_ card: Card) -> JSONValue {
        .object([
            "id": .string(card.id),
            "name": .string(card.name),
            "closing_day": .number(Decimal(card.closingDay)),
            "due_day": .number(Decimal(card.dueDay)),
            "limit": .number(card.limit)
        ])
    }

    private static func categoryJSON(_ category: ObolCore.Category) -> JSONValue {
        var object: [String: JSONValue] = [
            "id": .string(category.id),
            "name": .string(category.name),
            "type": .string(category.type.rawValue)
        ]
        if let budget = category.monthlyBudget {
            object["monthly_budget"] = .number(budget)
        }
        return .object(object)
    }

    private static func invoiceJSON(_ invoice: Invoice) -> JSONValue {
        var object: [String: JSONValue] = [
            "id": .string(invoice.id),
            "card_id": .string(invoice.cardID),
            "period": .string(invoice.period),
            "due_date": .string(ObolDate.string(invoice.dueDate)),
            "status": .string(invoice.status.rawValue),
            "total_amount": .number(invoice.totalAmount)
        ]
        if let paid = invoice.paidAmount {
            object["paid_amount"] = .number(paid)
        }
        return .object(object)
    }

    private static func projectJSON(_ project: Project) -> JSONValue {
        .object([
            "id": .string(project.id),
            "name": .string(project.name),
            "total_value": .number(project.totalValue),
            "status": .string(project.status.rawValue)
        ])
    }

    private static func recurrenceJSON(_ recurrence: Recurrence) -> JSONValue {
        var object: [String: JSONValue] = [
            "id": .string(recurrence.id),
            "name": .string(recurrence.name),
            "amount": .number(recurrence.amount),
            "payday": .number(Decimal(recurrence.payday)),
            "type": .string(recurrence.type.rawValue),
            "status": .string(recurrence.status.rawValue)
        ]
        if let accountID = recurrence.accountID { object["account_id"] = .string(accountID) }
        if let cardID = recurrence.cardID { object["card_id"] = .string(cardID) }
        if let categoryID = recurrence.categoryID { object["category_id"] = .string(categoryID) }
        if let endDate = recurrence.endDate { object["end_date"] = .string(ObolDate.string(endDate)) }
        if let installments = recurrence.totalInstallments {
            object["total_installments"] = .number(Decimal(installments))
        }
        if let skipped = recurrence.skippedPeriods, !skipped.isEmpty {
            object["skipped_periods"] = .array(skipped.map { .string($0) })
        }
        return .object(object)
    }

    private static func transactionJSON(_ transaction: Transaction) -> JSONValue {
        var object: [String: JSONValue] = [
            "id": .string(transaction.id),
            "title": .string(transaction.title),
            "amount": .number(transaction.amount),
            "type": .string(transaction.type.rawValue),
            "status": .string(transaction.status.rawValue),
            "expected_date": .string(ObolDate.string(transaction.expectedDate))
        ]
        if let realized = transaction.realizedDate {
            object["realized_date"] = .string(ObolDate.string(realized))
        }
        if let purchase = transaction.purchaseDate {
            object["purchase_date"] = .string(ObolDate.string(purchase))
        }
        if let value = transaction.isRecurring { object["is_recurring"] = .bool(value) }
        if let value = transaction.isSilent { object["is_silent"] = .bool(value) }
        if let value = transaction.isSimulated { object["is_simulated"] = .bool(value) }
        if let value = transaction.isScheduled { object["is_scheduled"] = .bool(value) }
        if let accountID = transaction.accountID { object["account_id"] = .string(accountID) }
        if let cardID = transaction.cardID { object["card_id"] = .string(cardID) }
        if let categoryID = transaction.categoryID { object["category_id"] = .string(categoryID) }
        if let projectID = transaction.projectID { object["project_id"] = .string(projectID) }
        if let invoiceID = transaction.invoiceID { object["invoice_id"] = .string(invoiceID) }
        if let recurrenceID = transaction.recurrenceID {
            object["recurrence_id"] = .string(recurrenceID)
        }
        if let destinationID = transaction.destinationAccountID {
            object["destination_account_id"] = .string(destinationID)
        }
        return .object(object)
    }
}

final class ParityFaultTrigger {
    private var handle: OpaquePointer?
    private var names: [String] = []
    private let suffix = UUID().uuidString.replacingOccurrences(of: "-", with: "")

    init(databasePath: String) throws {
        var database: OpaquePointer?
        let result = sqlite3_open_v2(
            databasePath,
            &database,
            SQLITE_OPEN_READWRITE,
            nil
        )
        guard result == SQLITE_OK, let database else {
            let message = database.map { String(cString: sqlite3_errmsg($0)) }
                ?? "unknown SQLite error"
            if let database { sqlite3_close_v2(database) }
            throw ParityFailure(
                "fault injector could not open \(databasePath): \(message)"
            )
        }
        sqlite3_busy_timeout(database, 5_000)
        self.handle = database
    }

    deinit {
        _ = try? removeAll()
        if let handle {
            sqlite3_close_v2(handle)
        }
        handle = nil
    }

    func install(
        collection: ParityCollection,
        recordID: String?,
        operation: String?
    ) throws {
        if let recordID, FixtureTokens.isToken(recordID) {
            throw ParityFailure(
                "fault record id '\(recordID)' was not resolved before installation"
            )
        }
        let variants: [(event: String, row: String, deleted: Int?)]
        if let operation {
            switch operation {
            case "create":
                variants = [("INSERT", "NEW", nil)]
            case "update":
                variants = [("UPDATE", "NEW", 0)]
            case "delete":
                variants = [("UPDATE", "NEW", 1)]
            default:
                throw ParityFailure("unknown fault operation '\(operation)'")
            }
        } else {
            variants = [("INSERT", "NEW", nil), ("UPDATE", "NEW", nil), ("DELETE", "OLD", nil)]
        }
        for (index, variant) in variants.enumerated() {
            let name = "obol_parity_fault_\(suffix)_\(index)"
            var condition = "\(variant.row).entity_type = '\(escape(collection.entityType))'"
            if let recordID {
                condition += " AND \(variant.row).entity_id = '\(escape(recordID))'"
            }
            if let deleted = variant.deleted {
                condition += " AND \(variant.row).deleted = \(deleted)"
            }
            let sql = """
            CREATE TRIGGER "\(name)" BEFORE \(variant.event) ON working_entities
            WHEN \(condition)
            BEGIN SELECT RAISE(ABORT, 'obol parity injected storage failure'); END;
            """
            try execute(sql)
            names.append(name)
        }
    }

    func removeAll() throws {
        for name in names.reversed() {
            try execute("DROP TRIGGER IF EXISTS \"\(name)\";")
        }
        names.removeAll()
    }

    func close() {
        _ = try? removeAll()
        if let handle {
            sqlite3_close_v2(handle)
        }
        handle = nil
    }

    private func execute(_ sql: String) throws {
        guard let handle else {
            throw ParityFailure("fault injector is closed")
        }
        var errorMessage: UnsafeMutablePointer<CChar>?
        let result = sqlite3_exec(handle, sql, nil, nil, &errorMessage)
        guard result == SQLITE_OK else {
            let message = errorMessage.map { String(cString: $0) }
                ?? String(cString: sqlite3_errmsg(handle))
            if let errorMessage { sqlite3_free(errorMessage) }
            throw ParityFailure("fault injector SQL failed: \(message)")
        }
        if let errorMessage { sqlite3_free(errorMessage) }
    }

    private func escape(_ value: String) -> String {
        value.replacingOccurrences(of: "'", with: "''")
    }
}
