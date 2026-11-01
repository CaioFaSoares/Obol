import Foundation
import ObolCore
import ObolNativeRuntime

enum ProjectionActual {
    case forecast(options: ForecastOptions, result: ForecastResult)
    case budgets(at: Date, rows: [BudgetSummary])
    case projects(rows: [ProjectSummary])
    case invoiceTimeline(cardID: String, rows: [CardInvoiceSummary])

    var kind: String {
        switch self {
        case .forecast: return "forecast"
        case .budgets: return "budgets"
        case .projects: return "projects"
        case .invoiceTimeline: return "invoice_timeline"
        }
    }
}

enum ParityProjections {
    static func compare(
        caseID: String,
        expected: [JSONValue],
        actual: [ProjectionActual],
        captures: [String: String]
    ) throws {
        guard expected.count == actual.count else {
            throw ParityFailure(
                "case \(caseID): expected \(expected.count) projections, product produced \(actual.count)"
            )
        }
        for (index, rawExpected) in expected.enumerated() {
            let resolved = try FixtureTokens.resolve(
                rawExpected,
                captures: captures,
                path: "projections[\(index)]"
            )
            try compareOne(
                caseID: caseID,
                index: index,
                expected: resolved,
                actual: actual[index]
            )
        }
    }

    private static func compareOne(
        caseID: String,
        index: Int,
        expected: JSONValue,
        actual: ProjectionActual
    ) throws {
        guard case .object(let object) = expected else {
            throw ParityFailure("case \(caseID): projections[\(index)] must be an object")
        }
        let kind = try FixtureJSON.string(
            object["kind"] ?? .null,
            path: "projections[\(index)].kind"
        )
        guard kind == actual.kind else {
            throw ParityFailure(
                "case \(caseID): projections[\(index)].kind expected '\(kind)', actual '\(actual.kind)'"
            )
        }
        switch actual {
        case .forecast(let options, let result):
            try compareForecast(
                caseID: caseID,
                index: index,
                object: object,
                options: options,
                result: result
            )
        case .budgets(let at, let rows):
            try compareBudgets(
                caseID: caseID,
                index: index,
                object: object,
                at: at,
                rows: rows
            )
        case .projects(let rows):
            try compareProjects(caseID: caseID, index: index, object: object, rows: rows)
        case .invoiceTimeline(let cardID, let rows):
            try compareInvoiceTimeline(
                caseID: caseID,
                index: index,
                object: object,
                cardID: cardID,
                rows: rows
            )
        }
    }

    private static func compareForecast(
        caseID: String,
        index: Int,
        object: [String: JSONValue],
        options: ForecastOptions,
        result: ForecastResult
    ) throws {
        let path = "projections[\(index)]"
        _ = try FixtureJSON.object(
            .object(object),
            path: path,
            allowed: [
                "kind", "start_date", "end_date", "include_simulations",
                "timeline", "upcoming_invoices", "first_negative_date"
            ],
            required: [
                "kind", "start_date", "end_date", "include_simulations",
                "timeline", "upcoming_invoices", "first_negative_date"
            ]
        )

        let expectedStart = try FixtureDates.parseDay(
            object["start_date"] ?? .null,
            path: "\(path).start_date"
        )
        try requireDay(
            caseID: caseID,
            path: "\(path).start_date",
            expected: expectedStart,
            actual: result.startDate
        )
        let expectedEnd = try FixtureDates.parseDay(
            object["end_date"] ?? .null,
            path: "\(path).end_date"
        )
        try requireDay(
            caseID: caseID,
            path: "\(path).end_date",
            expected: expectedEnd,
            actual: result.endDate
        )
        let includeSimulations = try FixtureJSON.bool(
            object["include_simulations"] ?? .null,
            path: "\(path).include_simulations"
        )
        guard includeSimulations == options.includeSimulations else {
            throw ParityFailure(
                "case \(caseID): \(path).include_simulations expected \(includeSimulations), actual \(options.includeSimulations)"
            )
        }

        let timeline = try FixtureJSON.array(
            object["timeline"] ?? .null,
            path: "\(path).timeline"
        )
        guard timeline.count == result.timeline.count else {
            throw ParityFailure(
                "case \(caseID): \(path).timeline expected \(timeline.count) days, actual \(result.timeline.count)"
            )
        }
        for (dayIndex, rawDay) in timeline.enumerated() {
            let dayPath = "\(path).timeline[\(dayIndex)]"
            let day = try FixtureJSON.object(
                rawDay,
                path: dayPath,
                allowed: ["date", "balance"],
                required: ["date", "balance"]
            )
            let expectedDate = try FixtureDates.parseDay(
                day["date"] ?? .null,
                path: "\(dayPath).date"
            )
            let actualDay = result.timeline[dayIndex]
            try requireDay(
                caseID: caseID,
                path: "\(dayPath).date",
                expected: expectedDate,
                actual: actualDay.date
            )
            let expectedBalance = try FixtureMoney.parse(
                day["balance"] ?? .null,
                path: "\(dayPath).balance"
            )
            guard FixtureMoney.equal(expectedBalance, actualDay.balance) else {
                throw ParityFailure(
                    "case \(caseID): \(dayPath).balance expected \(FixtureMoney.format(expectedBalance)), actual \(FixtureMoney.format(actualDay.balance))"
                )
            }
        }

        let invoices = try FixtureJSON.array(
            object["upcoming_invoices"] ?? .null,
            path: "\(path).upcoming_invoices"
        )
        guard invoices.count == result.upcomingInvoices.count else {
            throw ParityFailure(
                "case \(caseID): \(path).upcoming_invoices expected \(invoices.count), actual \(result.upcomingInvoices.count)"
            )
        }
        for (invoiceIndex, rawInvoice) in invoices.enumerated() {
            let invoicePath = "\(path).upcoming_invoices[\(invoiceIndex)]"
            let invoice = try FixtureJSON.object(
                rawInvoice,
                path: invoicePath,
                allowed: ["card_id", "card_name", "due_date", "amount_due", "status"],
                required: ["card_id", "card_name", "due_date", "amount_due", "status"]
            )
            let actualInvoice = result.upcomingInvoices[invoiceIndex]
            let expectedCardID = try FixtureJSON.string(
                invoice["card_id"] ?? .null,
                path: "\(invoicePath).card_id"
            )
            try requireText(
                caseID: caseID,
                path: "\(invoicePath).card_id",
                expected: expectedCardID,
                actual: actualInvoice.cardID
            )
            let expectedCardName = try FixtureJSON.string(
                invoice["card_name"] ?? .null,
                path: "\(invoicePath).card_name"
            )
            try requireText(
                caseID: caseID,
                path: "\(invoicePath).card_name",
                expected: expectedCardName,
                actual: actualInvoice.cardName
            )
            let expectedDue = try FixtureDates.parseInstant(
                invoice["due_date"] ?? .null,
                path: "\(invoicePath).due_date"
            )
            guard expectedDue == actualInvoice.dueDate else {
                throw ParityFailure(
                    "case \(caseID): \(invoicePath).due_date expected \(FixtureDates.instantString(expectedDue)), actual \(FixtureDates.instantString(actualInvoice.dueDate))"
                )
            }
            let expectedAmount = try FixtureMoney.parse(
                invoice["amount_due"] ?? .null,
                path: "\(invoicePath).amount_due"
            )
            guard FixtureMoney.equal(expectedAmount, actualInvoice.amountDue) else {
                throw ParityFailure(
                    "case \(caseID): \(invoicePath).amount_due expected \(FixtureMoney.format(expectedAmount)), actual \(FixtureMoney.format(actualInvoice.amountDue))"
                )
            }
            let expectedStatus = try FixtureJSON.string(
                invoice["status"] ?? .null,
                path: "\(invoicePath).status"
            )
            try requireText(
                caseID: caseID,
                path: "\(invoicePath).status",
                expected: expectedStatus,
                actual: actualInvoice.status.rawValue
            )
        }

        let firstNegative = object["first_negative_date"] ?? .null
        if FixtureJSON.isNull(firstNegative) {
            guard result.firstNegativeDate == nil else {
                throw ParityFailure(
                    "case \(caseID): \(path).first_negative_date expected null, actual \(FixtureDates.instantString(result.firstNegativeDate ?? Date(timeIntervalSince1970: 0)))"
                )
            }
        } else {
            let expected = try FixtureDates.parseInstant(
                firstNegative,
                path: "\(path).first_negative_date"
            )
            guard let actual = result.firstNegativeDate, actual == expected else {
                throw ParityFailure(
                    "case \(caseID): \(path).first_negative_date expected \(FixtureDates.instantString(expected)), actual \(result.firstNegativeDate.map(FixtureDates.instantString) ?? "null")"
                )
            }
        }
    }

    private static func compareBudgets(
        caseID: String,
        index: Int,
        object: [String: JSONValue],
        at: Date,
        rows: [BudgetSummary]
    ) throws {
        let path = "projections[\(index)]"
        _ = try FixtureJSON.object(
            .object(object),
            path: path,
            allowed: ["kind", "as_of", "categories"],
            required: ["kind", "as_of", "categories"]
        )
        let expectedAt = try FixtureDates.parseInstant(
            object["as_of"] ?? .null,
            path: "\(path).as_of"
        )
        guard expectedAt == at else {
            throw ParityFailure(
                "case \(caseID): \(path).as_of expected \(FixtureDates.instantString(expectedAt)), actual \(FixtureDates.instantString(at))"
            )
        }

        let categories = try FixtureJSON.array(
            object["categories"] ?? .null,
            path: "\(path).categories"
        )
        guard categories.count == rows.count else {
            throw ParityFailure(
                "case \(caseID): \(path).categories expected \(categories.count), actual \(rows.count)"
            )
        }
        for (rowIndex, rawRow) in categories.enumerated() {
            let rowPath = "\(path).categories[\(rowIndex)]"
            let category = try FixtureJSON.object(
                rawRow,
                path: rowPath,
                allowed: ["category_id", "monthly_budget", "spent"],
                required: ["category_id", "monthly_budget", "spent"]
            )
            let row = rows[rowIndex]
            let expectedID = try FixtureJSON.string(
                category["category_id"] ?? .null,
                path: "\(rowPath).category_id"
            )
            try requireText(
                caseID: caseID,
                path: "\(rowPath).category_id",
                expected: expectedID,
                actual: row.categoryID
            )
            let expectedBudget = try FixtureMoney.parse(
                category["monthly_budget"] ?? .null,
                path: "\(rowPath).monthly_budget"
            )
            guard FixtureMoney.equal(expectedBudget, row.monthlyBudget) else {
                throw ParityFailure(
                    "case \(caseID): \(rowPath).monthly_budget expected \(FixtureMoney.format(expectedBudget)), actual \(FixtureMoney.format(row.monthlyBudget))"
                )
            }
            let expectedSpent = try FixtureMoney.parse(
                category["spent"] ?? .null,
                path: "\(rowPath).spent"
            )
            guard FixtureMoney.equal(expectedSpent, row.spent) else {
                throw ParityFailure(
                    "case \(caseID): \(rowPath).spent expected \(FixtureMoney.format(expectedSpent)), actual \(FixtureMoney.format(row.spent))"
                )
            }
        }
    }

    private static func compareProjects(
        caseID: String,
        index: Int,
        object: [String: JSONValue],
        rows: [ProjectSummary]
    ) throws {
        let path = "projections[\(index)]"
        _ = try FixtureJSON.object(
            .object(object),
            path: path,
            allowed: ["kind", "projects"],
            required: ["kind", "projects"]
        )
        let projects = try FixtureJSON.array(
            object["projects"] ?? .null,
            path: "\(path).projects"
        )
        guard projects.count == rows.count else {
            throw ParityFailure(
                "case \(caseID): \(path).projects expected \(projects.count), actual \(rows.count)"
            )
        }
        for (rowIndex, rawProject) in projects.enumerated() {
            let rowPath = "\(path).projects[\(rowIndex)]"
            let project = try FixtureJSON.object(
                rawProject,
                path: rowPath,
                allowed: ["project_id", "status", "total_value", "paid", "remaining"],
                required: ["project_id", "status", "total_value", "paid", "remaining"]
            )
            let row = rows[rowIndex]
            let expectedID = try FixtureJSON.string(
                project["project_id"] ?? .null,
                path: "\(rowPath).project_id"
            )
            try requireText(
                caseID: caseID,
                path: "\(rowPath).project_id",
                expected: expectedID,
                actual: row.projectID
            )
            let expectedStatus = try FixtureJSON.string(
                project["status"] ?? .null,
                path: "\(rowPath).status"
            )
            try requireText(
                caseID: caseID,
                path: "\(rowPath).status",
                expected: expectedStatus,
                actual: row.status.rawValue
            )
            try requireMoney(
                caseID: caseID,
                path: "\(rowPath).total_value",
                expected: try FixtureMoney.parse(
                    project["total_value"] ?? .null,
                    path: "\(rowPath).total_value"
                ),
                actual: row.totalValue
            )
            try requireMoney(
                caseID: caseID,
                path: "\(rowPath).paid",
                expected: try FixtureMoney.parse(
                    project["paid"] ?? .null,
                    path: "\(rowPath).paid"
                ),
                actual: row.paid
            )
            try requireMoney(
                caseID: caseID,
                path: "\(rowPath).remaining",
                expected: try FixtureMoney.parse(
                    project["remaining"] ?? .null,
                    path: "\(rowPath).remaining"
                ),
                actual: row.remaining
            )
        }
    }

    private static func compareInvoiceTimeline(
        caseID: String,
        index: Int,
        object: [String: JSONValue],
        cardID: String,
        rows: [CardInvoiceSummary]
    ) throws {
        let path = "projections[\(index)]"
        _ = try FixtureJSON.object(
            .object(object),
            path: path,
            allowed: ["kind", "card_id", "invoices"],
            required: ["kind", "card_id", "invoices"]
        )
        let expectedCardID = try FixtureJSON.string(
            object["card_id"] ?? .null,
            path: "\(path).card_id"
        )
        try requireText(
            caseID: caseID,
            path: "\(path).card_id",
            expected: expectedCardID,
            actual: cardID
        )

        let invoices = try FixtureJSON.array(
            object["invoices"] ?? .null,
            path: "\(path).invoices"
        )
        guard invoices.count == rows.count else {
            throw ParityFailure(
                "case \(caseID): \(path).invoices expected \(invoices.count), actual \(rows.count)"
            )
        }
        for (invoiceIndex, rawInvoice) in invoices.enumerated() {
            let invoicePath = "\(path).invoices[\(invoiceIndex)]"
            let invoice = try FixtureJSON.object(
                rawInvoice,
                path: invoicePath,
                allowed: ["period", "due_date", "status", "debt", "paid_amount", "total_spent", "lines"],
                required: ["period", "due_date", "status", "debt", "paid_amount", "total_spent", "lines"]
            )
            let row = rows[invoiceIndex]
            let expectedPeriod = try FixtureJSON.string(
                invoice["period"] ?? .null,
                path: "\(invoicePath).period"
            )
            try requireText(
                caseID: caseID,
                path: "\(invoicePath).period",
                expected: expectedPeriod,
                actual: row.period
            )
            let expectedDue = try FixtureDates.parseInstant(
                invoice["due_date"] ?? .null,
                path: "\(invoicePath).due_date"
            )
            guard expectedDue == row.dueDate else {
                throw ParityFailure(
                    "case \(caseID): \(invoicePath).due_date expected \(FixtureDates.instantString(expectedDue)), actual \(FixtureDates.instantString(row.dueDate))"
                )
            }
            let expectedStatus = try FixtureJSON.string(
                invoice["status"] ?? .null,
                path: "\(invoicePath).status"
            )
            try requireText(
                caseID: caseID,
                path: "\(invoicePath).status",
                expected: expectedStatus,
                actual: row.status.rawValue
            )
            try requireMoney(
                caseID: caseID,
                path: "\(invoicePath).debt",
                expected: try FixtureMoney.parse(
                    invoice["debt"] ?? .null,
                    path: "\(invoicePath).debt"
                ),
                actual: row.totalAmount
            )
            try requireMoney(
                caseID: caseID,
                path: "\(invoicePath).paid_amount",
                expected: try FixtureMoney.parse(
                    invoice["paid_amount"] ?? .null,
                    path: "\(invoicePath).paid_amount"
                ),
                actual: row.paidAmount
            )
            try requireMoney(
                caseID: caseID,
                path: "\(invoicePath).total_spent",
                expected: try FixtureMoney.parse(
                    invoice["total_spent"] ?? .null,
                    path: "\(invoicePath).total_spent"
                ),
                actual: row.totalSpent
            )

            let lines = try FixtureJSON.array(
                invoice["lines"] ?? .null,
                path: "\(invoicePath).lines"
            )
            guard lines.count == row.transactions.count else {
                throw ParityFailure(
                    "case \(caseID): \(invoicePath).lines expected \(lines.count), actual \(row.transactions.count)"
                )
            }
            for (lineIndex, rawLine) in lines.enumerated() {
                let linePath = "\(invoicePath).lines[\(lineIndex)]"
                let line = try FixtureJSON.object(
                    rawLine,
                    path: linePath,
                    allowed: ["amount", "status", "expected_date", "recurrence_id", "id", "purchase_date"],
                    required: ["amount", "status", "expected_date"]
                )
                let actualLine = row.transactions[lineIndex]
                try requireMoney(
                    caseID: caseID,
                    path: "\(linePath).amount",
                    expected: try FixtureMoney.parse(
                        line["amount"] ?? .null,
                        path: "\(linePath).amount"
                    ),
                    actual: actualLine.amount
                )
                let expectedLineStatus = try FixtureJSON.string(
                    line["status"] ?? .null,
                    path: "\(linePath).status"
                )
                try requireText(
                    caseID: caseID,
                    path: "\(linePath).status",
                    expected: expectedLineStatus,
                    actual: actualLine.status.rawValue
                )
                let expectedDate = try FixtureDates.parseInstant(
                    line["expected_date"] ?? .null,
                    path: "\(linePath).expected_date"
                )
                guard expectedDate == actualLine.expectedDate else {
                    throw ParityFailure(
                        "case \(caseID): \(linePath).expected_date expected \(FixtureDates.instantString(expectedDate)), actual \(FixtureDates.instantString(actualLine.expectedDate))"
                    )
                }
                if let rawID = line["id"] {
                    if FixtureJSON.isNull(rawID) {
                        guard actualLine.id == nil else {
                            throw ParityFailure(
                                "case \(caseID): \(linePath).id expected null, actual \(actualLine.id ?? "nil")"
                            )
                        }
                    } else {
                        let expectedID = try FixtureJSON.string(rawID, path: "\(linePath).id")
                        try requireOptionalText(
                            caseID: caseID,
                            path: "\(linePath).id",
                            expected: expectedID,
                            actual: actualLine.id
                        )
                    }
                }
                if let rawPurchase = line["purchase_date"] {
                    if FixtureJSON.isNull(rawPurchase) {
                        guard actualLine.purchaseDate == nil else {
                            throw ParityFailure(
                                "case \(caseID): \(linePath).purchase_date expected null, actual \(FixtureDates.instantString(actualLine.purchaseDate ?? Date(timeIntervalSince1970: 0)))"
                            )
                        }
                    } else {
                        let expectedPurchase = try FixtureDates.parseInstant(
                            rawPurchase,
                            path: "\(linePath).purchase_date"
                        )
                        guard actualLine.purchaseDate == expectedPurchase else {
                            throw ParityFailure(
                                "case \(caseID): \(linePath).purchase_date expected \(FixtureDates.instantString(expectedPurchase)), actual \(actualLine.purchaseDate.map(FixtureDates.instantString) ?? "null")"
                            )
                        }
                    }
                }
                if let rawRecurrence = line["recurrence_id"] {
                    if FixtureJSON.isNull(rawRecurrence) {
                        guard actualLine.recurrenceID == nil else {
                            throw ParityFailure(
                                "case \(caseID): \(linePath).recurrence_id expected null, actual \(actualLine.recurrenceID ?? "nil")"
                            )
                        }
                    } else {
                        let expectedRecurrence = try FixtureJSON.string(
                            rawRecurrence,
                            path: "\(linePath).recurrence_id"
                        )
                        try requireOptionalText(
                            caseID: caseID,
                            path: "\(linePath).recurrence_id",
                            expected: expectedRecurrence,
                            actual: actualLine.recurrenceID
                        )
                    }
                }
            }
        }
    }

    private static func requireDay(
        caseID: String,
        path: String,
        expected: Date,
        actual: Date
    ) throws {
        let expectedDay = FixtureDates.dayString(expected)
        let actualDay = FixtureDates.dayString(actual)
        guard expectedDay == actualDay else {
            throw ParityFailure(
                "case \(caseID): \(path) expected \(expectedDay), actual \(actualDay)"
            )
        }
    }

    private static func requireText(
        caseID: String,
        path: String,
        expected: String,
        actual: String
    ) throws {
        guard expected == actual else {
            throw ParityFailure("case \(caseID): \(path) expected '\(expected)', actual '\(actual)'")
        }
    }

    private static func requireOptionalText(
        caseID: String,
        path: String,
        expected: String,
        actual: String?
    ) throws {
        guard let actual, actual == expected else {
            throw ParityFailure(
                "case \(caseID): \(path) expected '\(expected)', actual '\(actual ?? "nil")'"
            )
        }
    }

    private static func requireMoney(
        caseID: String,
        path: String,
        expected: Decimal,
        actual: Decimal
    ) throws {
        guard FixtureMoney.equal(expected, actual) else {
            throw ParityFailure(
                "case \(caseID): \(path) expected \(FixtureMoney.format(expected)), actual \(FixtureMoney.format(actual))"
            )
        }
    }
}
