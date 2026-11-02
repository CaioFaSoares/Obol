import XCTest
import ObolCore

/// Weekly recurrence cadence (canon §6/§7, D019): UTC ISO week occurrence math,
/// generation, idempotency, launch, forecast projection and card invoices.
final class WeeklyRecurrenceTests: XCTestCase {
    /// Wednesday 2026-11-04; its ISO week starts Monday 2026-11-02.
    private let clock = fixtureDate("2026-11-04T12:00:00.000Z")

    // MARK: - Calendar helpers

    func testISOWeekStartsOnUTCMonday() {
        XCTAssertEqual(ObolDate.isoWeekday(clock), 3)
        XCTAssertEqual(ObolDate.dayKey(ObolDate.startOfISOWeek(clock)), "2026-11-02")
        XCTAssertEqual(ObolDate.dayKey(ObolDate.isoWeekOccurrence(clock, weekday: 1)), "2026-11-02")
        XCTAssertEqual(ObolDate.dayKey(ObolDate.isoWeekOccurrence(clock, weekday: 2)), "2026-11-03")
        XCTAssertEqual(ObolDate.weeklyOccurrenceKey(clock, weekday: 7), "2026-11-08")
    }

    func testSundayBelongsToTheWeekThatStartedMonday() {
        let sunday = fixtureDate("2026-11-08T23:59:59.999Z")
        XCTAssertEqual(ObolDate.isoWeekday(sunday), 7)
        XCTAssertEqual(ObolDate.dayKey(ObolDate.startOfISOWeek(sunday)), "2026-11-02")
        XCTAssertEqual(ObolDate.weeklyOccurrenceKey(sunday, weekday: 2), "2026-11-03")
    }

    // MARK: - Generation

    func testWeeklyGenerationUsesTheISOWeekAndNotPayday() throws {
        let recurrence = weeklyRecurrence(payday: 15, weekday: 2)
        let after = try FinanceEngine().apply(
            .processMonthlyRecurrences,
            to: FinancialSnapshot(recurrences: [recurrence]),
            now: clock
        )

        let children = after.transactions.filter { $0.recurrenceID == recurrence.id }
        XCTAssertEqual(children.count, 1)
        let child = try XCTUnwrap(children.first)
        XCTAssertEqual(ObolDate.dayKey(child.expectedDate), "2026-11-03")
        XCTAssertEqual(ObolDate.dayKey(try XCTUnwrap(child.purchaseDate)), "2026-11-03")
        XCTAssertEqual(child.title, "Rent - 2026-11-03")
        XCTAssertEqual(child.status, .pending)
        XCTAssertEqual(child.isRecurring, true)
        XCTAssertEqual(child.amount, 100)
    }

    func testWeeklyGenerationIsIdempotentWithinTheSameWeek() throws {
        let recurrence = weeklyRecurrence(weekday: 2)
        let engine = FinanceEngine()
        let once = try engine.apply(
            .processMonthlyRecurrences,
            to: FinancialSnapshot(recurrences: [recurrence]),
            now: clock
        )
        let twice = try engine.apply(.processMonthlyRecurrences, to: once, now: clock)
        XCTAssertEqual(twice.transactions.filter { $0.recurrenceID == recurrence.id }.count, 1)
        XCTAssertEqual(twice, once)
    }

    func testWeeklyWeekCrossingTheMonthBoundary() throws {
        let recurrence = weeklyRecurrence(payday: 15, weekday: 4)
        let after = try FinanceEngine().apply(
            .processMonthlyRecurrences,
            to: FinancialSnapshot(recurrences: [recurrence]),
            now: fixtureDate("2027-01-01T09:00:00.000Z")
        )

        let child = try XCTUnwrap(after.transactions.first)
        XCTAssertEqual(ObolDate.dayKey(child.expectedDate), "2026-12-31")
        XCTAssertEqual(child.title, "Rent - 2026-12-31")
    }

    func testWeeklySkipsAStoredOccurrenceDay() throws {
        let recurrence = weeklyRecurrence(weekday: 2, skippedPeriods: ["2026-11-03"])
        let after = try FinanceEngine().apply(
            .processMonthlyRecurrences,
            to: FinancialSnapshot(recurrences: [recurrence]),
            now: clock
        )
        XCTAssertTrue(after.transactions.isEmpty)
    }

    func testWeeklyInstallmentsCountWeeklyChildren() throws {
        let recurrence = weeklyRecurrence(weekday: 2, totalInstallments: 2)
        let existing = weeklyChild(
            recurrenceID: recurrence.id,
            day: "2026-10-27",
            title: "Rent - Parcela 1/2"
        )
        let after = try FinanceEngine().apply(
            .processMonthlyRecurrences,
            to: FinancialSnapshot(recurrences: [recurrence], transactions: [existing]),
            now: clock
        )

        let children = after.transactions.filter { $0.recurrenceID == recurrence.id }
        XCTAssertEqual(children.count, 2)
        XCTAssertEqual(children.map(\.title).sorted().last, "Rent - Parcela 2/2")
        XCTAssertEqual(after.recurrence(id: recurrence.id)?.status, .active)

        let exhausted = try FinanceEngine().apply(
            .processMonthlyRecurrences,
            to: after,
            now: fixtureDate("2026-11-11T12:00:00.000Z")
        )
        XCTAssertEqual(exhausted.transactions.filter { $0.recurrenceID == recurrence.id }.count, 2)
        XCTAssertEqual(exhausted.recurrence(id: recurrence.id)?.status, .ended)
    }

    // MARK: - Manual launch

    func testManualLaunchTargetsTheNextISOWeek() throws {
        let recurrence = weeklyRecurrence(weekday: 2)
        let after = try FinanceEngine().apply(
            .launchRecurrence(id: recurrence.id),
            to: FinancialSnapshot(recurrences: [recurrence]),
            now: clock
        )

        let child = try XCTUnwrap(after.transactions.first)
        XCTAssertEqual(ObolDate.dayKey(child.expectedDate), "2026-11-10")
        XCTAssertEqual(child.title, "Rent - 2026-11-10")

        XCTAssertThrowsError(
            try FinanceEngine().apply(
                .launchRecurrence(id: recurrence.id),
                to: after,
                now: clock
            )
        ) { error in
            XCTAssertEqual((error as? FinanceError)?.code, .conflict)
        }
    }

    // MARK: - Validation

    func testWeeklyCreateRequiresAWeekdayInOneToSeven() {
        let engine = FinanceEngine()
        for weekday in [nil, 0, 8] as [Int?] {
            let recurrence = weeklyRecurrence(weekday: weekday)
            XCTAssertThrowsError(
                try engine.apply(
                    .createRecurrence(recurrence),
                    to: FinancialSnapshot(),
                    now: clock
                )
            ) { error in
                XCTAssertEqual((error as? FinanceError)?.code, .validation)
            }
        }
    }

    func testMonthlyCreateDropsTheWeekday() throws {
        let recurrence = Recurrence(
            id: "rec000000000041",
            name: "Rent",
            amount: 100,
            payday: 5,
            type: .expense,
            frequency: .monthly,
            weekday: 3
        )
        let after = try FinanceEngine().apply(
            .createRecurrence(recurrence),
            to: FinancialSnapshot(),
            now: clock
        )
        XCTAssertEqual(after.recurrence(id: recurrence.id)?.cadence, .monthly)
        XCTAssertNil(after.recurrence(id: recurrence.id)?.weekday)
    }

    func testCadencePatchAcceptsAWeeklySwitchAndClearsTheWeekday() throws {
        let original = Recurrence(
            id: "rec000000000042",
            name: "Rent",
            amount: 100,
            payday: 5,
            type: .expense
        )
        let engine = FinanceEngine()
        let weekly = try engine.apply(
            .updateRecurrence(
                id: original.id,
                patch: RecurrencePatch(frequency: .set(.weekly), weekday: .set(3))
            ),
            to: FinancialSnapshot(recurrences: [original]),
            now: clock
        )
        XCTAssertEqual(weekly.recurrence(id: original.id)?.cadence, .weekly)
        XCTAssertEqual(weekly.recurrence(id: original.id)?.weekday, 3)

        let monthly = try engine.apply(
            .updateRecurrence(
                id: original.id,
                patch: RecurrencePatch(frequency: .set(.monthly), weekday: .clear)
            ),
            to: weekly,
            now: clock
        )
        XCTAssertEqual(monthly.recurrence(id: original.id)?.cadence, .monthly)
        XCTAssertNil(monthly.recurrence(id: original.id)?.weekday)
    }

    // MARK: - Skip keys

    func testDeletingAWeeklyChildSkipsItsOccurrenceDay() throws {
        let recurrence = weeklyRecurrence(weekday: 2)
        let generated = try FinanceEngine().apply(
            .processMonthlyRecurrences,
            to: FinancialSnapshot(recurrences: [recurrence]),
            now: clock
        )
        let child = try XCTUnwrap(generated.transactions.first)

        let afterDelete = try FinanceEngine().apply(
            .deleteTransaction(id: child.id),
            to: generated,
            now: clock
        )
        XCTAssertEqual(afterDelete.recurrence(id: recurrence.id)?.skippedPeriods, ["2026-11-03"])

        let afterProcess = try FinanceEngine().apply(
            .processMonthlyRecurrences,
            to: afterDelete,
            now: clock
        )
        XCTAssertTrue(afterProcess.transactions.isEmpty)
    }

    func testDeletingAWeeklyInvoiceSkipsEveryOccurrenceDay() throws {
        let card = Card(id: "crd000000000001", name: "Visa", closingDay: 14, dueDay: 20, limit: 5000)
        let recurrence = weeklyRecurrence(weekday: 2, amount: 50, cardID: card.id)
        let generated = try FinanceEngine().apply(
            .processMonthlyRecurrences,
            to: FinancialSnapshot(cards: [card], recurrences: [recurrence]),
            now: clock
        )
        let child = try XCTUnwrap(generated.transactions.first)
        let invoiceID = try XCTUnwrap(child.invoiceID)
        XCTAssertEqual(generated.invoice(id: invoiceID)?.period, "2026-11")

        let afterDelete = try FinanceEngine().apply(
            .deleteInvoice(cardID: card.id, period: "2026-11"),
            to: generated,
            now: clock
        )
        XCTAssertEqual(afterDelete.recurrence(id: recurrence.id)?.skippedPeriods, ["2026-11-03"])
    }

    // MARK: - Forecast

    func testForecastProjectsEveryWeeklyOccurrence() throws {
        let account = Account(id: "acc000000000001", name: "Checking", type: .checking, initialBalance: 1000)
        let recurrence = weeklyRecurrence(weekday: 2, accountID: account.id)
        let result = try ForecastEngine().forecast(
            FinancialSnapshot(accounts: [account], recurrences: [recurrence]),
            options: ForecastOptions(
                startDate: fixtureDate("2026-11-01T00:00:00.000Z"),
                endDate: fixtureDate("2026-11-30T00:00:00.000Z")
            ),
            now: clock
        )

        let projected = result.timeline
            .flatMap(\.events)
            .filter { $0.sourceID == recurrence.id }
        XCTAssertEqual(projected.count, 4)
        XCTAssertEqual(
            projected.map { ObolDate.dayKey($0.date) }.sorted(),
            ["2026-11-04", "2026-11-10", "2026-11-17", "2026-11-24"]
        )
        XCTAssertEqual(result.timeline.last?.balance, 600)
    }

    func testForecastSkipsTheLaunchedWeeklyOccurrenceOnly() throws {
        let account = Account(id: "acc000000000001", name: "Checking", type: .checking, initialBalance: 1000)
        let recurrence = weeklyRecurrence(weekday: 2, accountID: account.id)
        let launched = weeklyChild(
            recurrenceID: recurrence.id,
            day: "2026-11-03",
            accountID: account.id
        )
        let result = try ForecastEngine().forecast(
            FinancialSnapshot(
                accounts: [account],
                recurrences: [recurrence],
                transactions: [launched]
            ),
            options: ForecastOptions(
                startDate: fixtureDate("2026-11-01T00:00:00.000Z"),
                endDate: fixtureDate("2026-11-30T00:00:00.000Z")
            ),
            now: clock
        )

        let projectedDays = result.timeline
            .flatMap(\.events)
            .filter { $0.kind == .recurrence }
            .map { ObolDate.dayKey($0.date) }
            .sorted()
        XCTAssertEqual(projectedDays, ["2026-11-10", "2026-11-17", "2026-11-24"])
    }

    // MARK: - Card invoice projection

    func testWeeklyCardRecurrenceProjectsOneLinePerOccurrence() throws {
        let card = Card(id: "crd000000000001", name: "Visa", closingDay: 14, dueDay: 20, limit: 5000)
        let recurrence = weeklyRecurrence(weekday: 2, amount: 50, cardID: card.id)
        let invoice = Invoice(
            id: "inv000000000001",
            cardID: card.id,
            period: "2026-11",
            dueDate: fixtureDate("2026-11-20T00:00:00.000Z"),
            status: .open,
            totalAmount: 50,
            paidAmount: 0
        )
        let realChild = Transaction(
            id: "txn000000000001",
            title: "Rent - 2026-10-27",
            amount: 50,
            type: .expense,
            status: .pending,
            expectedDate: fixtureDate("2026-11-20T00:00:00.000Z"),
            purchaseDate: fixtureDate("2026-10-27T00:00:00.000Z"),
            isRecurring: true,
            cardID: card.id,
            invoiceID: invoice.id,
            recurrenceID: recurrence.id
        )

        let summaries = try ForecastEngine().cardInvoiceSummaries(
            FinancialSnapshot(
                cards: [card],
                invoices: [invoice],
                recurrences: [recurrence],
                transactions: [realChild]
            ),
            cardID: card.id,
            now: clock
        )

        let november = try XCTUnwrap(summaries.first { $0.period == "2026-11" })
        XCTAssertEqual(november.transactions.count, 4)
        XCTAssertEqual(november.totalAmount, 200)
        XCTAssertEqual(november.totalSpent, 200)
        XCTAssertEqual(
            november.transactions.map { ObolDate.dayKey($0.expectedDate) },
            ["2026-10-20", "2026-11-03", "2026-11-10", "2026-11-20"]
        )
        XCTAssertEqual(
            november.transactions.filter { $0.isProjected }.map { $0.title },
            ["Rent - 2026-10-20", "Rent - 2026-11-03", "Rent - 2026-11-10"]
        )

        let december = try XCTUnwrap(summaries.first { $0.period == "2026-12" })
        XCTAssertEqual(december.status, .projected)
        XCTAssertEqual(december.transactions.count, 4)
        XCTAssertEqual(december.totalAmount, 200)
        XCTAssertEqual(
            december.transactions.map { ObolDate.dayKey($0.expectedDate) },
            ["2026-11-17", "2026-11-24", "2026-12-01", "2026-12-08"]
        )
    }

    func testWeeklyCardProjectionNumbersInstallmentsPerOccurrence() throws {
        let card = Card(id: "crd000000000001", name: "Visa", closingDay: 14, dueDay: 20, limit: 5000)
        let recurrence = weeklyRecurrence(weekday: 2, cardID: card.id, totalInstallments: 8)
        let summaries = try ForecastEngine().cardInvoiceSummaries(
            FinancialSnapshot(cards: [card], recurrences: [recurrence]),
            cardID: card.id,
            now: clock
        )

        // No stored invoice exists, so the only row is the virtual next month.
        let december = try XCTUnwrap(summaries.first { $0.period == "2026-12" })
        XCTAssertEqual(december.status, .projected)
        XCTAssertEqual(
            december.transactions.map(\.title),
            [
                "Rent - Parcela 1/8",
                "Rent - Parcela 2/8",
                "Rent - Parcela 3/8",
                "Rent - Parcela 4/8"
            ]
        )
    }

    // MARK: - Model decoding

    func testRecurrenceDecodesCadenceTolerantly() throws {
        func decode(_ extra: String) throws -> Recurrence {
            let json = """
            {"id":"rec000000000001","name":"Rent","amount":10,"payday":5,\
            "type":"expense","status":"active"\(extra)}
            """
            return try JSONDecoder().decode(Recurrence.self, from: Data(json.utf8))
        }

        let weekly = try decode(",\"frequency\":\"weekly\",\"weekday\":3")
        XCTAssertEqual(weekly.cadence, .weekly)
        XCTAssertEqual(weekly.weekday, 3)

        let absent = try decode("")
        XCTAssertNil(absent.frequency)
        XCTAssertEqual(absent.cadence, .monthly)

        let blank = try decode(",\"frequency\":\"\",\"weekday\":0")
        XCTAssertNil(blank.frequency)
        XCTAssertNil(blank.weekday)
        XCTAssertEqual(blank.cadence, .monthly)

        let unknown = try decode(",\"frequency\":\"yearly\",\"weekday\":9")
        XCTAssertNil(unknown.frequency)
        XCTAssertEqual(unknown.cadence, .monthly)
        XCTAssertEqual(unknown.weekday, 9)
    }

    func testRecurrenceEncodesTheCadenceItCarries() throws {
        let weekly = weeklyRecurrence(weekday: 2)
        let encoded = try JSONEncoder().encode(weekly)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        )
        XCTAssertEqual(object["frequency"] as? String, "weekly")
        XCTAssertEqual(object["weekday"] as? Int, 2)

        let monthly = Recurrence(
            id: "rec000000000043",
            name: "Rent",
            amount: 100,
            payday: 5,
            type: .expense
        )
        let monthlyEncoded = try JSONEncoder().encode(monthly)
        let monthlyObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: monthlyEncoded) as? [String: Any]
        )
        XCTAssertNil(monthlyObject["frequency"])
        XCTAssertNil(monthlyObject["weekday"])
    }

    // MARK: - Fixtures

    private func weeklyRecurrence(
        payday: Int = 15,
        weekday: Int? = 2,
        amount: Decimal = 100,
        cardID: String? = nil,
        accountID: String? = nil,
        totalInstallments: Int? = nil,
        skippedPeriods: [String]? = nil
    ) -> Recurrence {
        Recurrence(
            id: "rec000000000001",
            name: "Rent",
            amount: amount,
            payday: payday,
            type: .expense,
            accountID: accountID,
            cardID: cardID,
            totalInstallments: totalInstallments,
            skippedPeriods: skippedPeriods,
            frequency: .weekly,
            weekday: weekday
        )
    }

    private func weeklyChild(
        recurrenceID: String,
        day: String,
        title: String = "Rent - 2026-10-27",
        accountID: String? = nil
    ) -> Transaction {
        let occurrence = fixtureDate("\(day)T00:00:00.000Z")
        return Transaction(
            id: "txn000000000002",
            title: title,
            amount: 100,
            type: .expense,
            status: .pending,
            expectedDate: occurrence,
            purchaseDate: occurrence,
            isRecurring: true,
            accountID: accountID,
            recurrenceID: recurrenceID
        )
    }
}

private func fixtureDate(_ value: String) -> Date {
    guard let parsed = ObolDate.parse(value) else {
        preconditionFailure("Fixture instant '\(value)' is not valid ISO-8601")
    }
    return parsed
}
