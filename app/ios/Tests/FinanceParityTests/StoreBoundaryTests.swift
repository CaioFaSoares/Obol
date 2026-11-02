import XCTest
import ObolCore
import ObolNativeRuntime

final class StoreBoundaryTests: XCTestCase {
    private let boundaryNow = "2026-03-15T12:00:00.000Z"

    func testPersistedEmptyOptionalDatesAndRelations() async throws {
        try await StoreTestSupport.withStore { context in
            let now = try FixtureDates.parseInstant(boundaryNow, path: "boundaryNow")
            let seed = try optionalShapeSnapshot(malformedDate: false)
            try await StoreTestSupport.seed(context, snapshot: seed, now: now)
            let snapshot = try await context.store.loadFinancialSnapshot()

            XCTAssertEqual(snapshot.transactions.count, 1)
            let transaction = try XCTUnwrap(snapshot.transactions.first)
            XCTAssertNil(transaction.realizedDate)
            XCTAssertNil(transaction.purchaseDate)
            XCTAssertNil(transaction.accountID)
            XCTAssertNil(transaction.cardID)
            XCTAssertNil(transaction.categoryID)
            XCTAssertNil(transaction.projectID)
            XCTAssertNil(transaction.invoiceID)
            XCTAssertNil(transaction.recurrenceID)
            XCTAssertNil(transaction.destinationAccountID)

            XCTAssertEqual(snapshot.recurrences.count, 1)
            let recurrence = try XCTUnwrap(snapshot.recurrences.first)
            XCTAssertNil(recurrence.accountID)
            XCTAssertNil(recurrence.cardID)
            XCTAssertNil(recurrence.categoryID)
            XCTAssertNil(recurrence.endDate)
            XCTAssertNil(recurrence.totalInstallments)
        }
    }

    func testPersistedZeroInstallmentsAndZeroMoney() async throws {
        try await StoreTestSupport.withStore { context in
            let now = try FixtureDates.parseInstant(boundaryNow, path: "boundaryNow")
            let seed = try optionalShapeSnapshot(malformedDate: false)
            try await StoreTestSupport.seed(context, snapshot: seed, now: now)
            let snapshot = try await context.store.loadFinancialSnapshot()

            let account = try XCTUnwrap(snapshot.accounts.first)
            XCTAssertEqual(account.initialBalance, Decimal(0))

            let card = try XCTUnwrap(snapshot.cards.first)
            XCTAssertEqual(card.limit, Decimal(0))

            let category = try XCTUnwrap(snapshot.categories.first)
            XCTAssertNotNil(category.monthlyBudget)
            XCTAssertEqual(category.monthlyBudget ?? -1, Decimal(0))

            let invoice = try XCTUnwrap(snapshot.invoices.first)
            XCTAssertEqual(invoice.totalAmount, Decimal(0))
            XCTAssertEqual(invoice.paidAmount ?? -1, Decimal(0))

            let recurrence = try XCTUnwrap(snapshot.recurrences.first)
            XCTAssertNil(recurrence.totalInstallments)
        }
    }

    func testMalformedNonEmptyOptionalDateFailsImport() async throws {
        try await StoreTestSupport.withStore { context in
            let now = try FixtureDates.parseInstant(boundaryNow, path: "boundaryNow")
            let seed = try optionalShapeSnapshot(malformedDate: true)
            var failed = false
            do {
                try await StoreTestSupport.seed(context, snapshot: seed, now: now)
            } catch let error as StoreError {
                guard case .invalidImport = error else {
                    XCTFail("expected StoreError.invalidImport, got \(error)")
                    return
                }
                failed = true
            } catch {
                XCTFail("expected StoreError.invalidImport, got \(error)")
                return
            }
            XCTAssertTrue(failed)

            let snapshot = try await context.store.loadFinancialSnapshot()
            XCTAssertTrue(snapshot.transactions.isEmpty)
            XCTAssertTrue(snapshot.accounts.isEmpty)
        }
    }

    func testStationIdentityMismatchPreservesDataAndOutbox() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ObolFinanceParityIdentity-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let station = UUID().uuidString
        let now = try FixtureDates.parseInstant(boundaryNow, path: "boundaryNow")

        let before = try await withStoreDirectory(stationID: station, directory: directory) { store in
            let seed = try self.transferSeedSnapshot()
            try await StoreTestSupport.seed(store: store, snapshot: seed, now: now)
            let snapshot = try await store.loadFinancialSnapshot()
            let operations = try await store.pendingOperations()
            XCTAssertTrue(operations.isEmpty)
            return snapshot
        }

        var mismatch: Error?
        do {
            let store = try ObolDatabase(
                stationId: UUID().uuidString,
                directoryURL: directory
            )
            try await store.close()
        } catch {
            mismatch = error
        }
        guard let mismatch else {
            XCTFail("a different station identifier opened the existing store")
            return
        }
        guard let storeError = mismatch as? StoreError else {
            XCTFail("expected StoreError.stationIdentityMismatch, got \(mismatch)")
            return
        }
        guard case .stationIdentityMismatch(let stored, let installation) = storeError else {
            XCTFail("expected StoreError.stationIdentityMismatch, got \(storeError)")
            return
        }
        XCTAssertEqual(stored, station)
        XCTAssertNotEqual(installation, station)

        let after = try await withStoreDirectory(stationID: station, directory: directory) { store in
            let snapshot = try await store.loadFinancialSnapshot()
            let operations = try await store.pendingOperations()
            XCTAssertTrue(operations.isEmpty)
            return snapshot
        }
        XCTAssertEqual(after, before)
    }

    func testAtomicFinanceAndOutboxFailureOnWorkingEntityTrigger() async throws {
        try await StoreTestSupport.withStore { context in
            let now = try FixtureDates.parseInstant(boundaryNow, path: "boundaryNow")
            let seed = try transferSeedSnapshot()
            try await StoreTestSupport.seed(context, snapshot: seed, now: now)
            let before = try await context.store.loadFinancialSnapshot()
            let beforeOperations = try await context.store.pendingOperations()
            XCTAssertTrue(beforeOperations.isEmpty)

            let trigger = try ParityFaultTrigger(
                databasePath: context.databaseURL.path
            )
            try trigger.install(
                collection: .accounts,
                recordID: "acc000000000002",
                operation: "update"
            )

            var thrown: Error?
            do {
                _ = try await context.store.apply(
                    .createTransaction(
                        TransactionDraft(
                            title: "Move to savings",
                            amount: 25,
                            type: .transfer,
                            status: .realized,
                            expectedDate: now,
                            accountID: "acc000000000001",
                            destinationAccountID: "acc000000000002"
                        )
                    ),
                    effectiveAt: now
                )
            } catch {
                thrown = error
            }

            do {
                try trigger.removeAll()
            } catch {
                trigger.close()
                throw error
            }
            trigger.close()

            guard let thrown else {
                XCTFail("the SQLite working_entities trigger did not abort the transfer")
                return
            }
            guard let storeError = thrown as? StoreError else {
                XCTFail("expected a typed StoreError from the SQLite boundary, got \(thrown)")
                return
            }
            guard case .sqlite = storeError else {
                XCTFail("expected StoreError.sqlite, got \(storeError)")
                return
            }

            let after = try await context.store.loadFinancialSnapshot()
            let afterOperations = try await context.store.pendingOperations()
            XCTAssertEqual(after, before)
            XCTAssertEqual(afterOperations, beforeOperations)
            XCTAssertTrue(afterOperations.isEmpty)

            let source = try XCTUnwrap(after.account(id: "acc000000000001"))
            let destination = try XCTUnwrap(after.account(id: "acc000000000002"))
            XCTAssertEqual(source.initialBalance, Decimal(100))
            XCTAssertEqual(destination.initialBalance, Decimal(50))
            XCTAssertTrue(after.transactions.isEmpty)
        }
    }

    private func withStoreDirectory<T>(
        stationID: String,
        directory: URL,
        _ body: (ObolDatabase) async throws -> T
    ) async throws -> T {
        let store = try ObolDatabase(stationId: stationID, directoryURL: directory)
        do {
            let result = try await body(store)
            try await store.close()
            return result
        } catch {
            try? await store.close()
            throw error
        }
    }

    private func optionalShapeSnapshot(malformedDate: Bool) throws -> JSONValue {
        let transactionDate = malformedDate ? "not-a-date" : ""
        let transaction: [String: JSONValue] = [
            "id": .string("txn000000000001"),
            "title": .string("Empty optional refs"),
            "amount": .number(Decimal(10)),
            "type": .string("expense"),
            "status": .string("pending"),
            "expected_date": .string("2026-03-10T00:00:00.000Z"),
            "realized_date": .string(transactionDate),
            "purchase_date": .string(""),
            "is_recurring": .bool(false),
            "is_silent": .bool(false),
            "is_simulated": .bool(false),
            "is_scheduled": .bool(false),
            "account_id": .string(""),
            "card_id": .string(""),
            "category_id": .string(""),
            "project_id": .string(""),
            "invoice_id": .string(""),
            "recurrence_id": .string(""),
            "destination_account_id": .string("")
        ]

        return .object([
            "accounts": .array([
                .object([
                    "id": .string("acc000000000001"),
                    "name": .string("Zero"),
                    "type": .string("checking"),
                    "initial_balance": .number(Decimal(0))
                ])
            ]),
            "cards": .array([
                .object([
                    "id": .string("card00000000001"),
                    "name": .string("Zero Card"),
                    "closing_day": .number(Decimal(10)),
                    "due_day": .number(Decimal(20)),
                    "limit": .number(Decimal(0))
                ])
            ]),
            "categories": .array([
                .object([
                    "id": .string("cat000000000001"),
                    "name": .string("Zero Budget"),
                    "type": .string("variable"),
                    "monthly_budget": .number(Decimal(0))
                ])
            ]),
            "invoices": .array([
                .object([
                    "id": .string("inv000000000001"),
                    "card_id": .string("card00000000001"),
                    "period": .string("2026-03"),
                    "due_date": .string("2026-03-20T00:00:00.000Z"),
                    "status": .string("OPEN"),
                    "total_amount": .number(Decimal(0)),
                    "paid_amount": .number(Decimal(0))
                ])
            ]),
            "projects": .array([]),
            "recurrences": .array([
                .object([
                    "id": .string("rec000000000001"),
                    "name": .string("Unlimited"),
                    "amount": .number(Decimal(10)),
                    "payday": .number(Decimal(10)),
                    "type": .string("expense"),
                    "status": .string("active"),
                    "account_id": .string(""),
                    "card_id": .string(""),
                    "category_id": .string(""),
                    "end_date": .string(""),
                    "total_installments": .number(Decimal(0)),
                    "skipped_periods": .array([])
                ])
            ]),
            "transactions": .array([.object(transaction)])
        ])
    }

    private func transferSeedSnapshot() throws -> JSONValue {
        .object([
            "accounts": .array([
                .object([
                    "id": .string("acc000000000001"),
                    "name": .string("Checking"),
                    "type": .string("checking"),
                    "initial_balance": .number(Decimal(100))
                ]),
                .object([
                    "id": .string("acc000000000002"),
                    "name": .string("Savings"),
                    "type": .string("savings"),
                    "initial_balance": .number(Decimal(50))
                ])
            ]),
            "cards": .array([]),
            "categories": .array([]),
            "invoices": .array([]),
            "projects": .array([]),
            "recurrences": .array([]),
            "transactions": .array([])
        ])
    }
}
