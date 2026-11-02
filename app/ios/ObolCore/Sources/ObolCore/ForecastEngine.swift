import Foundation

// MARK: - Forecast projections

public struct ForecastOptions: Codable, Equatable, Sendable {
    public var startDate: Date
    public var endDate: Date
    public var includeSimulations: Bool

    public init(startDate: Date, endDate: Date, includeSimulations: Bool = false) {
        self.startDate = startDate
        self.endDate = endDate
        self.includeSimulations = includeSimulations
    }
}

public enum ForecastEventKind: String, Codable, Sendable {
    case realized
    case pending
    case transfer
    case invoice
    case recurrence
    case projectedInvoice
    case simulated
}

/// Projection-only invoice status. Persisted invoices stay limited to
/// `InvoiceStatus` (`OPEN`/`CLOSED`/`PAID`); `projected` marks the virtual
/// next-period row derived from active card recurrences and is never stored.
public enum InvoiceProjectionStatus: String, Codable, Sendable {
    case open = "OPEN"
    case closed = "CLOSED"
    case paid = "PAID"
    case projected = "PROJECTED"
}

/// Status of a line inside the projected invoice timeline. A projected line is
/// derived from an active recurrence and is not a stored transaction.
public enum CardInvoiceLineStatus: String, Codable, Sendable {
    case pending
    case realized
    case projected
}

public struct ForecastEvent: Codable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let kind: ForecastEventKind
    public let date: Date
    /// Signed cash effect: positive is inflow, negative is outflow.
    public let amount: Decimal
    public let sourceID: String?

    public init(
        id: String,
        title: String,
        kind: ForecastEventKind,
        date: Date,
        amount: Decimal,
        sourceID: String? = nil
    ) {
        self.id = id
        self.title = title
        self.kind = kind
        self.date = date
        self.amount = amount
        self.sourceID = sourceID
    }
}

public struct ForecastDay: Codable, Equatable, Sendable {
    public let date: Date
    /// End-of-day projected cash for liquid (non-investment) accounts.
    public let balance: Decimal
    public let income: Decimal
    public let expense: Decimal
    public let events: [ForecastEvent]

    public init(
        date: Date,
        balance: Decimal,
        income: Decimal,
        expense: Decimal,
        events: [ForecastEvent]
    ) {
        self.date = date
        self.balance = balance
        self.income = income
        self.expense = expense
        self.events = events
    }
}

public struct ForecastInvoice: Codable, Equatable, Sendable {
    public let id: String
    public let cardID: String
    public let cardName: String
    public let period: String
    public let dueDate: Date
    public let amountDue: Decimal
    public let status: InvoiceStatus

    public init(
        id: String,
        cardID: String,
        cardName: String,
        period: String,
        dueDate: Date,
        amountDue: Decimal,
        status: InvoiceStatus
    ) {
        self.id = id
        self.cardID = cardID
        self.cardName = cardName
        self.period = period
        self.dueDate = dueDate
        self.amountDue = amountDue
        self.status = status
    }
}

public struct ForecastResult: Codable, Equatable, Sendable {
    public let startDate: Date
    public let endDate: Date
    /// Balance at the beginning of `startDate`, before that day's events.
    public let startBalance: Decimal
    /// Current available cash: the sum of non-investment account balances at
    /// `now`. This is the account snapshot, not an end-of-day projection, so it
    /// can differ from today's `timeline` balance while today still has pending
    /// or unpaid obligations.
    public let currentAvailableCash: Decimal
    /// End-of-day projected balance on `endDate`.
    public let endBalance: Decimal
    public let timeline: [ForecastDay]
    public let upcomingInvoices: [ForecastInvoice]
    public let firstNegativeDate: Date?

    public init(
        startDate: Date,
        endDate: Date,
        startBalance: Decimal,
        currentAvailableCash: Decimal,
        endBalance: Decimal,
        timeline: [ForecastDay],
        upcomingInvoices: [ForecastInvoice],
        firstNegativeDate: Date?
    ) {
        self.startDate = startDate
        self.endDate = endDate
        self.startBalance = startBalance
        self.currentAvailableCash = currentAvailableCash
        self.endBalance = endBalance
        self.timeline = timeline
        self.upcomingInvoices = upcomingInvoices
        self.firstNegativeDate = firstNegativeDate
    }
}

public struct BudgetSummary: Codable, Equatable, Sendable {
    public let categoryID: String
    public let name: String
    public let monthlyBudget: Decimal
    public let spent: Decimal
    public let remaining: Decimal
    public let isOverBudget: Bool

    public init(
        categoryID: String,
        name: String,
        monthlyBudget: Decimal,
        spent: Decimal,
        remaining: Decimal,
        isOverBudget: Bool
    ) {
        self.categoryID = categoryID
        self.name = name
        self.monthlyBudget = monthlyBudget
        self.spent = spent
        self.remaining = remaining
        self.isOverBudget = isOverBudget
    }
}

public struct ProjectSummary: Codable, Equatable, Sendable {
    public let projectID: String
    public let name: String
    public let status: ProjectStatus
    public let totalValue: Decimal
    public let paid: Decimal
    public let remaining: Decimal
    public let progress: Double

    public init(
        projectID: String,
        name: String,
        status: ProjectStatus,
        totalValue: Decimal,
        paid: Decimal,
        remaining: Decimal,
        progress: Double
    ) {
        self.projectID = projectID
        self.name = name
        self.status = status
        self.totalValue = totalValue
        self.paid = paid
        self.remaining = remaining
        self.progress = progress
    }
}

public struct CardInvoiceLine: Codable, Equatable, Sendable {
    /// Stored transaction id. `nil` for a projected recurrence line.
    public let id: String?
    /// Stored transaction title. `nil` for a monthly projected recurrence line;
    /// a weekly projected line carries its occurrence title (`<name> - <day>`
    /// or the installment label) because one invoice holds several of them.
    public let title: String?
    public let amount: Decimal
    public let status: CardInvoiceLineStatus
    /// Stored transaction expected date for a real line. For a projected line
    /// this is the recurrence purchase date, matching GetCardInvoicesUseCase.
    public let expectedDate: Date
    /// Stored purchase date for a real card line. `nil` for a projected line.
    public let purchaseDate: Date?
    public let recurrenceID: String?

    public var isProjected: Bool { status == .projected }

    public init(
        id: String?,
        title: String?,
        amount: Decimal,
        status: CardInvoiceLineStatus,
        expectedDate: Date,
        purchaseDate: Date?,
        recurrenceID: String?
    ) {
        self.id = id
        self.title = title
        self.amount = amount
        self.status = status
        self.expectedDate = expectedDate
        self.purchaseDate = purchaseDate
        self.recurrenceID = recurrenceID
    }
}

public struct CardInvoiceSummary: Codable, Equatable, Sendable {
    /// Stored invoice id. `nil` for the virtual projected invoice.
    public let id: String?
    public let cardID: String
    public let period: String
    public let dueDate: Date
    public let status: InvoiceProjectionStatus
    /// Remaining debt: `total_amount - paid_amount`, plus any projected
    /// recurrence lines. It is not a stored field.
    public let totalAmount: Decimal
    public let paidAmount: Decimal
    /// Gross spent: real child expenses minus real child incomes, plus any
    /// projected recurrence lines.
    public let totalSpent: Decimal
    public let transactions: [CardInvoiceLine]

    public var isProjected: Bool { status == .projected }

    public init(
        id: String?,
        cardID: String,
        period: String,
        dueDate: Date,
        status: InvoiceProjectionStatus,
        totalAmount: Decimal,
        paidAmount: Decimal,
        totalSpent: Decimal,
        transactions: [CardInvoiceLine]
    ) {
        self.id = id
        self.cardID = cardID
        self.period = period
        self.dueDate = dueDate
        self.status = status
        self.totalAmount = totalAmount
        self.paidAmount = paidAmount
        self.totalSpent = totalSpent
        self.transactions = transactions
    }
}

// MARK: - Engine

public struct ForecastEngine: Sendable {
    public init() {}

    /// Reconstructs the balance at `startDate`, then projects every day through
    /// `endDate`. Card purchases never hit cash directly; unpaid invoice debt is
    /// applied once on its due date. Overdue pending rows and unpaid invoices are
    /// applied on `today`, never on a reconstructed past day. Active recurrences
    /// are projected only when the period has not already been launched.
    ///
    /// `ForecastResult.currentAvailableCash` is the liquid account snapshot at
    /// `now`; timeline balances are end-of-day projections and need not match it
    /// while today still has pending or unpaid obligations.
    public func forecast(
        _ snapshot: FinancialSnapshot,
        options: ForecastOptions,
        now: Date = Date()
    ) throws -> ForecastResult {
        let start = ObolDate.startOfDay(options.startDate)
        let end = ObolDate.startOfDay(options.endDate)
        guard start <= end else {
            throw FinanceError.validation("Forecast start date must be on or before the end date.")
        }

        let today = ObolDate.startOfDay(now)
        let calcStart = min(start, today)

        var accountsByID: [String: Account] = [:]
        accountsByID.reserveCapacity(snapshot.accounts.count)
        var currentAvailableCash = Decimal(0)
        for account in snapshot.accounts {
            if accountsByID[account.id] == nil {
                accountsByID[account.id] = account
            }
            if account.type != .investment {
                currentAvailableCash = Money.roundCurrency(currentAvailableCash + account.initialBalance)
            }
        }

        var balance = currentAvailableCash

        // Roll the snapshot balance back to the start of the calculation window.
        // Only realized, non-silent, non-simulated rows moved cash. A realized
        // unassigned fact never moved an account, so it contributes nothing.
        for transaction in snapshot.transactions
        where transaction.status == .realized
            && transaction.isSilent != true
            && transaction.isSimulated != true {
            guard let realizedDate = transaction.realizedDate else { continue }
            let day = ObolDate.startOfDay(realizedDate)
            guard day >= calcStart && day <= today else { continue }
            let effect = cashEffect(
                transaction,
                accounts: accountsByID,
                includeSimulated: false,
                includeUnassigned: false
            )
            balance = Money.roundCurrency(balance - effect)
        }

        var childrenByInvoice: [String: [Transaction]] = [:]
        childrenByInvoice.reserveCapacity(snapshot.invoices.count)
        for transaction in snapshot.transactions {
            guard let invoiceID = transaction.invoiceID else { continue }
            childrenByInvoice[invoiceID, default: []].append(transaction)
        }

        // Existing unpaid invoice debt, applied once per invoice. An invoice due
        // before today is projected today; a reconstructed past day never
        // deducts unpaid debt.
        var invoiceEventsByDay: [Date: [ForecastEvent]] = [:]
        var upcomingInvoices: [ForecastInvoice] = []
        upcomingInvoices.reserveCapacity(snapshot.invoices.count)

        for invoice in snapshot.invoices {
            guard let card = snapshot.card(id: invoice.cardID) else { continue }
            let children = childrenByInvoice[invoice.id] ?? []
            let status = effectiveInvoiceStatus(
                invoice,
                children: children,
                card: card,
                now: now
            )
            let amountDue = Money.roundCurrency(invoice.totalAmount - (invoice.paidAmount ?? 0))
            guard status != .paid, amountDue > 0 else { continue }

            upcomingInvoices.append(
                ForecastInvoice(
                    id: invoice.id,
                    cardID: invoice.cardID,
                    cardName: card.name,
                    period: invoice.period,
                    dueDate: invoice.dueDate,
                    amountDue: amountDue,
                    status: status
                )
            )

            let dueDay = ObolDate.startOfDay(invoice.dueDate)
            let eventDay = max(dueDay, today)
            guard eventDay >= calcStart, eventDay <= end else { continue }
            let event = ForecastEvent(
                id: invoice.id,
                title: "Fatura \(card.name) \(invoice.period)",
                kind: .invoice,
                date: eventDay,
                amount: -amountDue,
                sourceID: invoice.id
            )
            invoiceEventsByDay[eventDay, default: []].append(event)
        }

        // Future recurrence occurrences that were not already launched.
        var recurrenceEventsByDay: [Date: [ForecastEvent]] = [:]

        if today <= end {
            let firstMonth = ObolDate.startOfMonth(today)
            let lastMonth = ObolDate.startOfMonth(end)
            let recurrenceIndex = indexRecurrenceOccurrences(snapshot.transactions)

            for recurrence in snapshot.recurrences where recurrence.status == .active {
                if recurrence.cardID == nil,
                   !recurrenceAffectsLiquidCash(recurrence, accounts: accountsByID) {
                    continue
                }

                var projectedCount = recurrenceIndex.childCounts[recurrence.id] ?? 0

                if recurrence.cadence == .weekly {
                    guard let weekday = recurrence.weekday, (1...7).contains(weekday) else {
                        throw FinanceError.validation(
                            "Weekly recurrence requires a weekday between 1 and 7.",
                            entity: "Recurrence",
                            entityID: recurrence.id
                        )
                    }
                    let launchedDays = recurrenceIndex.primaryDays[recurrence.id] ?? []
                    let lastWeek = ObolDate.startOfISOWeek(end)
                    var weekStart = ObolDate.startOfISOWeek(today)

                    while weekStart <= lastWeek {
                        let occurrence = ObolDate.isoWeekOccurrence(weekStart, weekday: weekday)

                        if let endDate = recurrence.endDate, occurrence > endDate {
                            break
                        }

                        let occurrenceDay = ObolDate.dayKey(occurrence)
                        if let skipped = recurrence.skippedPeriods, skipped.contains(occurrenceDay) {
                            weekStart = ObolDate.addingDays(7, to: weekStart)
                            continue
                        }

                        var cardDueDate: Date?
                        if let cardID = recurrence.cardID {
                            guard let card = snapshot.card(id: cardID) else {
                                throw FinanceError.notFound("Card", id: cardID)
                            }
                            cardDueDate = ObolDate.calculateCardDueDate(
                                purchaseDate: occurrence,
                                closingDay: card.closingDay,
                                dueDay: card.dueDay
                            )
                        }

                        if launchedDays.contains(occurrenceDay) {
                            weekStart = ObolDate.addingDays(7, to: weekStart)
                            continue
                        }

                        if let total = recurrence.totalInstallments,
                           total > 0,
                           projectedCount + 1 > total {
                            break
                        }

                        let signedAmount: Decimal = recurrence.type == .expense
                            ? -recurrence.amount
                            : recurrence.amount

                        if let cardDueDate {
                            let eventDay = max(ObolDate.startOfDay(cardDueDate), today)
                            if eventDay >= calcStart && eventDay <= end {
                                let event = ForecastEvent(
                                    id: "projected-\(recurrence.id)-\(occurrenceDay)",
                                    title: "\(recurrence.name) - \(occurrenceDay)",
                                    kind: .projectedInvoice,
                                    date: eventDay,
                                    amount: signedAmount,
                                    sourceID: recurrence.id
                                )
                                recurrenceEventsByDay[eventDay, default: []].append(event)
                            }
                            projectedCount += 1
                        } else {
                            let eventDay = max(occurrence, today)
                            if eventDay >= calcStart && eventDay <= end {
                                let event = ForecastEvent(
                                    id: "recurrence-\(recurrence.id)-\(occurrenceDay)",
                                    title: recurrence.name,
                                    kind: .recurrence,
                                    date: eventDay,
                                    amount: signedAmount,
                                    sourceID: recurrence.id
                                )
                                recurrenceEventsByDay[eventDay, default: []].append(event)
                            }
                            projectedCount += 1
                        }

                        weekStart = ObolDate.addingDays(7, to: weekStart)
                    }
                    continue
                }

                let launchedMonths = recurrence.cardID != nil
                    ? recurrenceIndex.primaryMonths[recurrence.id]
                    : recurrenceIndex.anyMonths[recurrence.id]
                var monthStart = firstMonth

                while monthStart <= lastMonth {
                    let year = ObolDate.calendar.component(.year, from: monthStart)
                    let month = ObolDate.calendar.component(.month, from: monthStart)
                    let occurrence = ObolDate.clampedDate(year: year, month: month, day: recurrence.payday)

                    if let endDate = recurrence.endDate, occurrence > endDate {
                        break
                    }

                    let period = ObolDate.monthKey(occurrence)
                    if let skipped = recurrence.skippedPeriods, skipped.contains(period) {
                        monthStart = ObolDate.addingMonths(1, to: monthStart)
                        continue
                    }

                    var cardDueDate: Date?
                    var invoicePeriod: String?
                    if let cardID = recurrence.cardID {
                        guard let card = snapshot.card(id: cardID) else {
                            throw FinanceError.notFound("Card", id: cardID)
                        }
                        let dueDate = ObolDate.calculateCardDueDate(
                            purchaseDate: occurrence,
                            closingDay: card.closingDay,
                            dueDay: card.dueDay
                        )
                        cardDueDate = dueDate
                        invoicePeriod = ObolDate.monthKey(dueDate)
                        if let skipped = recurrence.skippedPeriods,
                           let invoicePeriod,
                           skipped.contains(invoicePeriod) {
                            monthStart = ObolDate.addingMonths(1, to: monthStart)
                            continue
                        }
                    }

                    if launchedMonths?.contains(period) == true {
                        monthStart = ObolDate.addingMonths(1, to: monthStart)
                        continue
                    }

                    if let total = recurrence.totalInstallments,
                       total > 0,
                       projectedCount + 1 > total {
                        break
                    }

                    let signedAmount: Decimal = recurrence.type == .expense
                        ? -recurrence.amount
                        : recurrence.amount

                    if let cardDueDate, let invoicePeriod {
                        let eventDay = max(ObolDate.startOfDay(cardDueDate), today)
                        if eventDay >= calcStart && eventDay <= end {
                            let event = ForecastEvent(
                                id: "projected-\(recurrence.id)-\(invoicePeriod)",
                                title: "\(recurrence.name) - \(invoicePeriod)",
                                kind: .projectedInvoice,
                                date: eventDay,
                                amount: signedAmount,
                                sourceID: recurrence.id
                            )
                            recurrenceEventsByDay[eventDay, default: []].append(event)
                        }
                        projectedCount += 1
                    } else {
                        let eventDay = max(occurrence, today)
                        if eventDay >= calcStart && eventDay <= end {
                            let event = ForecastEvent(
                                id: "recurrence-\(recurrence.id)-\(period)",
                                title: recurrence.name,
                                kind: .recurrence,
                                date: eventDay,
                                amount: signedAmount,
                                sourceID: recurrence.id
                            )
                            recurrenceEventsByDay[eventDay, default: []].append(event)
                        }
                        projectedCount += 1
                    }

                    monthStart = ObolDate.addingMonths(1, to: monthStart)
                }
            }
        }

        // Bucket realized and pending rows by their effective event day.
        var eventsByDay: [Date: [ForecastEvent]] = [:]

        for transaction in snapshot.transactions
        where transaction.status == .realized
            && transaction.isSilent != true
            && transaction.isSimulated != true {
            guard let realizedDate = transaction.realizedDate else { continue }
            let day = ObolDate.startOfDay(realizedDate)
            guard day >= calcStart, day <= today, day <= end else { continue }
            let effect = cashEffect(
                transaction,
                accounts: accountsByID,
                includeSimulated: false,
                includeUnassigned: false
            )
            guard effect != 0 else { continue }
            eventsByDay[day, default: []].append(
                ForecastEvent(
                    id: transaction.id,
                    title: transaction.title,
                    kind: transaction.type == .transfer ? .transfer : .realized,
                    date: day,
                    amount: effect,
                    sourceID: transaction.id
                )
            )
        }

        for transaction in snapshot.transactions where transaction.status == .pending {
            if transaction.isSimulated == true && !options.includeSimulations { continue }
            let expectedDay = ObolDate.startOfDay(transaction.expectedDate)
            let eventDay = expectedDay < today ? today : expectedDay
            guard eventDay >= calcStart, eventDay <= end else { continue }
            let effect = cashEffect(
                transaction,
                accounts: accountsByID,
                includeSimulated: options.includeSimulations,
                includeUnassigned: true
            )
            guard effect != 0 else { continue }
            let kind: ForecastEventKind
            if transaction.isSimulated == true {
                kind = .simulated
            } else if transaction.type == .transfer {
                kind = .transfer
            } else {
                kind = .pending
            }
            eventsByDay[eventDay, default: []].append(
                ForecastEvent(
                    id: transaction.id,
                    title: transaction.title,
                    kind: kind,
                    date: eventDay,
                    amount: effect,
                    sourceID: transaction.id
                )
            )
        }

        if options.includeSimulations {
            for transaction in snapshot.transactions
            where transaction.status == .pending
                && transaction.isSimulated == true
                && transaction.isSilent != true {
                guard let cardID = transaction.cardID,
                      let card = snapshot.card(id: cardID) else {
                    continue
                }
                let purchaseDate = transaction.purchaseDate ?? transaction.expectedDate
                let dueDate = ObolDate.calculateCardDueDate(
                    purchaseDate: purchaseDate,
                    closingDay: card.closingDay,
                    dueDay: card.dueDay
                )
                let eventDay = max(ObolDate.startOfDay(dueDate), today)
                guard eventDay >= calcStart, eventDay <= end else { continue }
                let signedAmount: Decimal = transaction.type == .expense
                    ? -transaction.amount
                    : transaction.amount
                eventsByDay[eventDay, default: []].append(
                    ForecastEvent(
                        id: transaction.id,
                        title: transaction.title,
                        kind: .simulated,
                        date: eventDay,
                        amount: signedAmount,
                        sourceID: transaction.id
                    )
                )
            }
        }

        for (day, events) in invoiceEventsByDay {
            eventsByDay[day, default: []].append(contentsOf: events)
        }
        for (day, events) in recurrenceEventsByDay {
            eventsByDay[day, default: []].append(contentsOf: events)
        }

        var timeline: [ForecastDay] = []
        let dayCount = ObolDate.calendar.dateComponents([.day], from: calcStart, to: end).day ?? 0
        timeline.reserveCapacity(max(0, dayCount) + 1)
        var startBalance: Decimal?
        var firstNegativeDate: Date?
        var day = calcStart

        while day <= end {
            if startBalance == nil && day == start {
                startBalance = balance
            }

            let events = eventsByDay[day] ?? []
            let ordered: [ForecastEvent]
            if events.count > 1 {
                ordered = events.sorted { lhs, rhs in
                    if lhs.kind.rawValue != rhs.kind.rawValue {
                        return lhs.kind.rawValue < rhs.kind.rawValue
                    }
                    if lhs.title != rhs.title {
                        return lhs.title < rhs.title
                    }
                    return lhs.id < rhs.id
                }
            } else {
                ordered = events
            }

            var net = Decimal(0)
            var income = Decimal(0)
            var expense = Decimal(0)
            for event in ordered {
                net = Money.roundCurrency(net + event.amount)
                if event.amount > 0 {
                    income = Money.roundCurrency(income + event.amount)
                } else if event.amount < 0 {
                    expense = Money.roundCurrency(expense - event.amount)
                }
            }

            balance = Money.roundCurrency(balance + net)

            if day >= start {
                timeline.append(
                    ForecastDay(
                        date: day,
                        balance: balance,
                        income: income,
                        expense: expense,
                        events: ordered
                    )
                )
                if firstNegativeDate == nil && balance < 0 {
                    firstNegativeDate = day
                }
            }

            day = ObolDate.startOfDay(day.addingTimeInterval(86_400))
        }

        upcomingInvoices.sort {
            if $0.dueDate != $1.dueDate { return $0.dueDate < $1.dueDate }
            if $0.cardName != $1.cardName { return $0.cardName < $1.cardName }
            return $0.period < $1.period
        }

        return ForecastResult(
            startDate: start,
            endDate: end,
            startBalance: startBalance ?? balance,
            currentAvailableCash: currentAvailableCash,
            endBalance: balance,
            timeline: timeline,
            upcomingInvoices: upcomingInvoices,
            firstNegativeDate: firstNegativeDate
        )
    }

    /// Budget accrual follows canon §8: an expense counts on `purchase_date`
    /// when present, otherwise `expected_date`, regardless of status.
    /// Simulations are included by default to mirror the server projection.
    public func budgetSummaries(
        _ snapshot: FinancialSnapshot,
        at date: Date = Date(),
        includeSimulations: Bool = true
    ) -> [BudgetSummary] {
        let monthStart = ObolDate.startOfMonth(date)
        let nextMonth = ObolDate.addingMonths(1, to: monthStart)
        var totals: [String: Decimal] = [:]

        for transaction in snapshot.transactions {
            guard transaction.type == .income || transaction.type == .expense else { continue }
            if transaction.isSimulated == true && !includeSimulations { continue }
            guard let categoryID = transaction.categoryID, !categoryID.isEmpty else { continue }
            let accrualDate = transaction.purchaseDate ?? transaction.expectedDate
            guard accrualDate >= monthStart && accrualDate < nextMonth else { continue }
            let signedAmount: Decimal = transaction.type == .expense
                ? transaction.amount
                : -transaction.amount
            let current = totals[categoryID] ?? 0
            totals[categoryID] = Money.roundCurrency(current + signedAmount)
        }

        return snapshot.categories
            .map { category in
                let spent = totals[category.id] ?? 0
                let budget = category.monthlyBudget ?? 0
                return BudgetSummary(
                    categoryID: category.id,
                    name: category.name,
                    monthlyBudget: budget,
                    spent: spent,
                    remaining: Money.roundCurrency(budget - spent),
                    isOverBudget: spent > budget
                )
            }
            .sorted { $0.categoryID < $1.categoryID }
    }

    public func projectSummaries(_ snapshot: FinancialSnapshot) -> [ProjectSummary] {
        snapshot.projects
            .map { project in
                let paid = snapshot.transactions
                    .filter {
                        $0.projectID == project.id
                            && $0.type == .income
                            && $0.status == .realized
                            && $0.isSimulated != true
                    }
                    .reduce(Decimal(0)) { Money.roundCurrency($0 + $1.amount) }

                let remaining = Money.roundCurrency(project.totalValue - paid)
                let ratio: Double
                if project.totalValue > 0 {
                    let paidDouble = NSDecimalNumber(decimal: paid).doubleValue
                    let totalDouble = NSDecimalNumber(decimal: project.totalValue).doubleValue
                    ratio = min(1, max(0, paidDouble / totalDouble))
                } else {
                    ratio = 0
                }

                return ProjectSummary(
                    projectID: project.id,
                    name: project.name,
                    status: project.status,
                    totalValue: project.totalValue,
                    paid: paid,
                    remaining: remaining,
                    progress: ratio
                )
            }
            .sorted { $0.projectID < $1.projectID }
    }

    /// Builds the complete invoice timeline for one card: every stored invoice
    /// plus one virtual `PROJECTED` invoice for the next period. Stored invoices
    /// are mapped from their effective status (children and closing date) to
    /// `OPEN`/`CLOSED`/`PAID`; projected recurrence lines are derived here and
    /// are never persisted.
    ///
    /// A projected line is added only when the recurrence is active, the
    /// occurrence maps to this invoice period, the period was not skipped, the
    /// occurrence was not already launched, the occurrence is on or before
    /// `end_date`, and the installment count is not exhausted. Debt and gross
    /// spent include projected lines; no occurrence is counted twice.
    public func cardInvoiceSummaries(
        _ snapshot: FinancialSnapshot,
        cardID: String,
        now: Date = Date()
    ) throws -> [CardInvoiceSummary] {
        guard let card = snapshot.card(id: cardID) else {
            throw FinanceError.notFound("Card", id: cardID)
        }

        var childrenByInvoice: [String: [Transaction]] = [:]
        childrenByInvoice.reserveCapacity(snapshot.invoices.count)
        var childrenByRecurrence: [String: [Transaction]] = [:]
        for transaction in snapshot.transactions {
            if let invoiceID = transaction.invoiceID {
                childrenByInvoice[invoiceID, default: []].append(transaction)
            }
            if let recurrenceID = transaction.recurrenceID {
                childrenByRecurrence[recurrenceID, default: []].append(transaction)
            }
        }

        var launchedPeriodsByRecurrence: [String: Set<String>] = [:]
        launchedPeriodsByRecurrence.reserveCapacity(childrenByRecurrence.count)
        var launchedDaysByRecurrence: [String: Set<String>] = [:]
        launchedDaysByRecurrence.reserveCapacity(childrenByRecurrence.count)
        for (recurrenceID, children) in childrenByRecurrence {
            var periods: Set<String> = []
            periods.reserveCapacity(children.count)
            var days: Set<String> = []
            days.reserveCapacity(children.count)
            for child in children {
                let period = child.purchaseDate.map(ObolDate.monthKey) ?? ObolDate.monthKey(child.expectedDate)
                periods.insert(period)
                days.insert(ObolDate.dayKey(child.purchaseDate ?? child.expectedDate))
            }
            launchedPeriodsByRecurrence[recurrenceID] = periods
            launchedDaysByRecurrence[recurrenceID] = days
        }

        let cardInvoices = snapshot.invoices.filter { $0.cardID == cardID }
        let activeCardRecurrences = snapshot.recurrences.filter {
            $0.status == .active && $0.cardID == cardID
        }

        var plans: [String: InvoicePlan] = [:]
        plans.reserveCapacity(cardInvoices.count + 1)
        var physicalPeriods: Set<String> = []
        physicalPeriods.reserveCapacity(cardInvoices.count)
        var latestMonthStart: Date?

        for invoice in cardInvoices {
            physicalPeriods.insert(invoice.period)
            if let monthStart = monthStart(of: invoice.period) {
                if let currentLatest = latestMonthStart {
                    if monthStart > currentLatest {
                        latestMonthStart = monthStart
                    }
                } else {
                    latestMonthStart = monthStart
                }
            }

            let children = childrenByInvoice[invoice.id] ?? []
            let status = effectiveInvoiceStatus(
                invoice,
                children: children,
                card: card,
                now: now
            )

            var lines: [CardInvoiceLine] = []
            lines.reserveCapacity(children.count)
            var totalSpent = Decimal(0)
            for child in children {
                lines.append(
                    CardInvoiceLine(
                        id: child.id,
                        title: child.title,
                        amount: child.amount,
                        status: child.status == .realized ? .realized : .pending,
                        expectedDate: child.expectedDate,
                        purchaseDate: child.purchaseDate,
                        recurrenceID: child.recurrenceID
                    )
                )
                switch child.type {
                case .expense:
                    totalSpent = Money.roundCurrency(totalSpent + child.amount)
                case .income:
                    totalSpent = Money.roundCurrency(totalSpent - child.amount)
                case .transfer:
                    break
                }
            }

            plans[invoice.period] = InvoicePlan(
                period: invoice.period,
                dueDate: invoice.dueDate,
                status: projectionStatus(status),
                invoice: invoice,
                lines: lines,
                debt: Money.roundCurrency(invoice.totalAmount - (invoice.paidAmount ?? 0)),
                paidAmount: invoice.paidAmount ?? 0,
                totalSpent: totalSpent
            )
        }

        // The virtual row is the next period after the latest stored invoice and
        // never before the current period. With no stored invoice the current
        // period is the reference, matching GetCardInvoicesUseCase.
        let currentMonthStart = ObolDate.startOfMonth(now)
        let latest = latestMonthStart ?? currentMonthStart
        let virtualMonthStart: Date
        if latest < currentMonthStart {
            virtualMonthStart = currentMonthStart
        } else {
            virtualMonthStart = ObolDate.calendar.date(byAdding: .month, value: 1, to: latest) ?? latest
        }
        let virtualPeriod = ObolDate.monthKey(virtualMonthStart)

        if !physicalPeriods.contains(virtualPeriod) {
            let year = ObolDate.calendar.component(.year, from: virtualMonthStart)
            let month = ObolDate.calendar.component(.month, from: virtualMonthStart)
            plans[virtualPeriod] = InvoicePlan(
                period: virtualPeriod,
                dueDate: ObolDate.clampedDate(year: year, month: month, day: card.dueDay),
                status: .projected,
                invoice: nil,
                lines: [],
                debt: 0,
                paidAmount: 0,
                totalSpent: 0
            )
        }

        if !activeCardRecurrences.isEmpty {
            var existingChildCounts: [String: Int] = [:]
            existingChildCounts.reserveCapacity(activeCardRecurrences.count)
            for recurrence in activeCardRecurrences {
                existingChildCounts[recurrence.id] = childrenByRecurrence[recurrence.id]?.count ?? 0
            }

            var projectedCounts: [String: Int] = [:]
            var endedRecurrences: Set<String> = []

            // Ascending periods keep finite-installment sequencing deterministic.
            for period in plans.keys.sorted() {
                guard var plan = plans[period] else { continue }
                let canProject = plan.invoice == nil || plan.status == .open
                guard canProject, let periodStart = monthStart(of: period) else { continue }

                for recurrence in activeCardRecurrences {
                    if endedRecurrences.contains(recurrence.id) { continue }

                    let existing = existingChildCounts[recurrence.id] ?? 0
                    var projected = projectedCounts[recurrence.id] ?? 0
                    if let total = recurrence.totalInstallments,
                       total > 0,
                       existing + projected >= total {
                        endedRecurrences.insert(recurrence.id)
                        continue
                    }

                    var ended = false
                    let delta: Decimal = recurrence.type == .expense
                        ? recurrence.amount
                        : -recurrence.amount

                    if recurrence.cadence == .weekly {
                        guard let weekday = recurrence.weekday, (1...7).contains(weekday) else {
                            throw FinanceError.validation(
                                "Weekly recurrence requires a weekday between 1 and 7.",
                                entity: "Recurrence",
                                entityID: recurrence.id
                            )
                        }
                        // Every occurrence whose due date lands in this period is
                        // one line. Purchase dates mapping to a due month span at
                        // most the three preceding months, so the scan starts at
                        // the earliest of them and stops at the month end.
                        guard let windowStart = ObolDate.calendar.date(
                            byAdding: .month,
                            value: -2,
                            to: periodStart
                        ), let windowEnd = ObolDate.calendar.date(
                            byAdding: .month,
                            value: 1,
                            to: periodStart
                        ) else {
                            continue
                        }
                        let launchedDays = launchedDaysByRecurrence[recurrence.id] ?? []
                        var weekStart = ObolDate.startOfISOWeek(windowStart)
                        var periodOrdinal = 0

                        while true {
                            let purchaseDate = ObolDate.isoWeekOccurrence(weekStart, weekday: weekday)
                            if purchaseDate >= windowEnd { break }
                            weekStart = ObolDate.addingDays(7, to: weekStart)
                            if purchaseDate < windowStart { continue }

                            let dueDate = ObolDate.calculateCardDueDate(
                                purchaseDate: purchaseDate,
                                closingDay: card.closingDay,
                                dueDay: card.dueDay
                            )
                            guard ObolDate.monthKey(dueDate) == period else { continue }

                            if let endDate = recurrence.endDate, purchaseDate > endDate {
                                ended = true
                                break
                            }

                            let occurrenceKey = ObolDate.dayKey(purchaseDate)
                            if let skipped = recurrence.skippedPeriods,
                               skipped.contains(occurrenceKey) {
                                continue
                            }
                            if launchedDays.contains(occurrenceKey) {
                                continue
                            }
                            if let total = recurrence.totalInstallments,
                               total > 0,
                               existing + projected + 1 > total {
                                ended = true
                                break
                            }

                            let title: String
                            if let total = recurrence.totalInstallments, total > 0 {
                                title = "\(recurrence.name) - Parcela \(existing + periodOrdinal + 1)/\(total)"
                            } else {
                                title = "\(recurrence.name) - \(occurrenceKey)"
                            }

                            plan.lines.append(
                                CardInvoiceLine(
                                    id: nil,
                                    title: title,
                                    amount: recurrence.amount,
                                    status: .projected,
                                    expectedDate: purchaseDate,
                                    purchaseDate: nil,
                                    recurrenceID: recurrence.id
                                )
                            )
                            plan.debt = Money.roundCurrency(plan.debt + delta)
                            plan.totalSpent = Money.roundCurrency(plan.totalSpent + delta)
                            projected += 1
                            projectedCounts[recurrence.id] = projected
                            periodOrdinal += 1
                        }

                        if ended {
                            endedRecurrences.insert(recurrence.id)
                        }
                        continue
                    }

                    // A monthly occurrence maps to this invoice from one of the
                    // three surrounding purchase months (closing-day rollover can
                    // move it by two). Matching the due month keeps the period
                    // equal to the due month for every card rule.
                    for monthOffset in -2...0 {
                        guard let candidateMonth = ObolDate.calendar.date(
                            byAdding: .month,
                            value: monthOffset,
                            to: periodStart
                        ) else {
                            continue
                        }
                        let year = ObolDate.calendar.component(.year, from: candidateMonth)
                        let month = ObolDate.calendar.component(.month, from: candidateMonth)
                        let purchaseDate = ObolDate.clampedDate(
                            year: year,
                            month: month,
                            day: recurrence.payday
                        )
                        let dueDate = ObolDate.calculateCardDueDate(
                            purchaseDate: purchaseDate,
                            closingDay: card.closingDay,
                            dueDay: card.dueDay
                        )
                        guard ObolDate.monthKey(dueDate) == period else { continue }

                        if let endDate = recurrence.endDate, purchaseDate > endDate {
                            ended = true
                            break
                        }

                        let purchasePeriod = ObolDate.monthKey(purchaseDate)
                        if let skipped = recurrence.skippedPeriods,
                           skipped.contains(purchasePeriod) || skipped.contains(period) {
                            continue
                        }
                        if launchedPeriodsByRecurrence[recurrence.id]?.contains(purchasePeriod) == true {
                            continue
                        }
                        if let total = recurrence.totalInstallments,
                           total > 0,
                           existing + projected + 1 > total {
                            ended = true
                            break
                        }

                        plan.lines.append(
                            CardInvoiceLine(
                                id: nil,
                                title: nil,
                                amount: recurrence.amount,
                                status: .projected,
                                expectedDate: purchaseDate,
                                purchaseDate: nil,
                                recurrenceID: recurrence.id
                            )
                        )
                        plan.debt = Money.roundCurrency(plan.debt + delta)
                        plan.totalSpent = Money.roundCurrency(plan.totalSpent + delta)
                        projected += 1
                        projectedCounts[recurrence.id] = projected
                    }
                    if ended {
                        endedRecurrences.insert(recurrence.id)
                    }
                }

                plans[period] = plan
            }
        }

        var summaries: [CardInvoiceSummary] = []
        summaries.reserveCapacity(plans.count)
        for plan in plans.values {
            if plan.invoice == nil && plan.lines.isEmpty { continue }

            let sortedLines = plan.lines.sorted { lhs, rhs in
                if lhs.expectedDate != rhs.expectedDate {
                    return lhs.expectedDate < rhs.expectedDate
                }
                let lhsRecurrence = lhs.recurrenceID ?? ""
                let rhsRecurrence = rhs.recurrenceID ?? ""
                if lhsRecurrence != rhsRecurrence {
                    return lhsRecurrence < rhsRecurrence
                }
                return (lhs.id ?? "") < (rhs.id ?? "")
            }

            summaries.append(
                CardInvoiceSummary(
                    id: plan.invoice?.id,
                    cardID: cardID,
                    period: plan.period,
                    dueDate: plan.dueDate,
                    status: plan.status,
                    totalAmount: plan.debt,
                    paidAmount: plan.paidAmount,
                    totalSpent: plan.totalSpent,
                    transactions: sortedLines
                )
            )
        }
        summaries.sort { $0.period > $1.period }
        return summaries
    }
}

// MARK: - Private helpers

private extension ForecastEngine {
    func cashEffect(
        _ transaction: Transaction,
        accounts: [String: Account],
        includeSimulated: Bool,
        includeUnassigned: Bool
    ) -> Decimal {
        if transaction.isSilent == true { return 0 }
        if transaction.isSimulated == true && !includeSimulated { return 0 }
        if transaction.cardID != nil || transaction.invoiceID != nil { return 0 }

        if transaction.type == .transfer {
            guard let sourceID = transaction.accountID,
                  let destinationID = transaction.destinationAccountID,
                  let source = accounts[sourceID],
                  let destination = accounts[destinationID] else {
                return 0
            }
            var effect = Decimal(0)
            if source.type != .investment { effect -= transaction.amount }
            if destination.type != .investment { effect += transaction.amount }
            return Money.roundCurrency(effect)
        }

        let signed: Decimal = transaction.type == .income
            ? transaction.amount
            : -transaction.amount

        guard let accountID = transaction.accountID else {
            return includeUnassigned ? Money.roundCurrency(signed) : 0
        }
        guard let account = accounts[accountID], account.type != .investment else {
            return 0
        }
        return Money.roundCurrency(signed)
    }

    func recurrenceAffectsLiquidCash(
        _ recurrence: Recurrence,
        accounts: [String: Account]
    ) -> Bool {
        guard let accountID = recurrence.accountID else { return true }
        guard let account = accounts[accountID] else { return false }
        return account.type != .investment
    }

    func indexRecurrenceOccurrences(
        _ transactions: [Transaction]
    ) -> (
        childCounts: [String: Int],
        primaryMonths: [String: Set<String>],
        anyMonths: [String: Set<String>],
        primaryDays: [String: Set<String>]
    ) {
        var childCounts: [String: Int] = [:]
        var primaryMonths: [String: Set<String>] = [:]
        var anyMonths: [String: Set<String>] = [:]
        var primaryDays: [String: Set<String>] = [:]

        for transaction in transactions {
            guard let recurrenceID = transaction.recurrenceID else { continue }
            childCounts[recurrenceID, default: 0] += 1

            let primaryDate = transaction.purchaseDate ?? transaction.expectedDate
            let purchaseMonth = transaction.purchaseDate.map(ObolDate.monthKey)
            let expectedMonth = ObolDate.monthKey(transaction.expectedDate)
            primaryMonths[recurrenceID, default: []].insert(purchaseMonth ?? expectedMonth)
            if let purchaseMonth {
                anyMonths[recurrenceID, default: []].insert(purchaseMonth)
            }
            anyMonths[recurrenceID, default: []].insert(expectedMonth)
            primaryDays[recurrenceID, default: []].insert(ObolDate.dayKey(primaryDate))
        }

        return (childCounts, primaryMonths, anyMonths, primaryDays)
    }

    func effectiveInvoiceStatus(
        _ invoice: Invoice,
        children: [Transaction],
        card: Card?,
        now: Date
    ) -> InvoiceStatus {
        if !children.isEmpty && children.allSatisfy({ $0.status == .realized }) {
            return .paid
        }
        if invoice.status == .paid {
            return .paid
        }
        guard let card else {
            return invoice.status
        }
        let closingDate = ObolDate.closingDate(
            dueDate: invoice.dueDate,
            closingDay: card.closingDay,
            dueDay: card.dueDay
        )
        return now > closingDate ? .closed : .open
    }

    func projectionStatus(_ status: InvoiceStatus) -> InvoiceProjectionStatus {
        switch status {
        case .open:
            return .open
        case .closed:
            return .closed
        case .paid:
            return .paid
        }
    }

    func monthStart(of period: String) -> Date? {
        let parts = period.split(separator: "-", omittingEmptySubsequences: true)
        guard parts.count == 2,
              let year = Int(parts[0]),
              let month = Int(parts[1]),
              (1...12).contains(month) else {
            return nil
        }
        return ObolDate.startOfMonth(year: year, month: month)
    }
}

private struct InvoicePlan {
    var period: String
    var dueDate: Date
    var status: InvoiceProjectionStatus
    var invoice: Invoice?
    var lines: [CardInvoiceLine]
    var debt: Decimal
    var paidAmount: Decimal
    var totalSpent: Decimal
}
