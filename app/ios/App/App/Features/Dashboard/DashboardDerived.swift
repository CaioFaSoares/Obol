import Foundation
import ObolCore
import ObolNativeRuntime

/// Local display preferences shared by the dashboard and the day detail sheet.
/// These are UI settings, never financial state, so they stay out of `AppState`.
enum DashboardPreferences {
    static let horizonKey = "obol.dashboard.horizonDays"
    static let simulationsKey = "obol.dashboard.includeSimulations"
}

extension ForecastDay {
    /// Stable key for dashboard lookups. Derived from the UTC financial
    /// calendar so chart taps, calendar cells and day details agree.
    var dashboardKey: String { ObolDate.dayKey(date) }
}

extension TransactionType {
    var dashboardLabel: String {
        switch self {
        case .income: return "Income"
        case .expense: return "Expense"
        case .transfer: return "Transfer"
        }
    }
}

/// One day selected from the trajectory chart or the calendar.
struct DashboardDaySelection: Identifiable, Hashable {
    let date: Date
    var id: String { ObolDate.dayKey(date) }
}

/// The three activity lists. Simulated rows are kept apart so they can never be
/// read as realized or pending.
enum DashboardListTab: String, CaseIterable, Identifiable {
    case realized
    case pending
    case simulated

    var id: String { rawValue }

    var title: String {
        switch self {
        case .realized: return "Realized"
        case .pending: return "Pending"
        case .simulated: return "Simulated"
        }
    }
}

/// Product rules a surface must honor before offering a realization.
enum DashboardEligibility {
    /// Card rows are settled through their invoice, and a simulated row must be
    /// converted first. A scheduled row is only realizable once its date
    /// arrives, because `is_scheduled` marks an agenda item awaiting manual
    /// confirmation (canon §4). Core clears the flag on realize.
    static func canRealize(_ transaction: ObolCore.Transaction, today: Date) -> Bool {
        guard transaction.status == .pending,
              transaction.isSimulated != true,
              transaction.cardID == nil else {
            return false
        }
        if transaction.isScheduled == true {
            return ObolDate.startOfDay(transaction.expectedDate) <= today
        }
        return true
    }
}

/// Immutable dashboard input for one snapshot and one settings pair.
///
/// `ForecastEngine` runs exactly once here. Activity lists, the day lookup and
/// the chart bounds come out of that same pass, so scrolling, resizing or
/// opening the day sheet never rescans or re-sorts the ledger.
struct DashboardDerived {
    static let horizonChoices = [15, 30, 60, 90]

    static func normalizedHorizon(_ value: Int) -> Int {
        horizonChoices.contains(value) ? value : 30
    }

    let horizonDays: Int
    let today: Date
    let todayKey: String
    let result: ForecastResult
    let dayIndex: [String: ForecastDay]
    let firstMonth: Date
    let lastMonth: Date
    let realizedTransactions: [ObolCore.Transaction]
    let pendingTransactions: [ObolCore.Transaction]
    let simulatedTransactions: [ObolCore.Transaction]
    let accountsByID: [String: Account]
    let cardsByID: [String: Card]
    let categoriesByID: [String: ObolCore.Category]
    let projectsByID: [String: Project]
    let invoicesInHorizon: [ForecastInvoice]
    let laterInvoiceCount: Int
    let chartLowerBound: Double
    let chartUpperBound: Double
    let chartSummary: String
    let todayExplanation: String?

    static func build(
        snapshot: FinancialSnapshot,
        horizonDays: Int,
        includeSimulations: Bool,
        now: Date
    ) throws -> DashboardDerived {
        let horizon = normalizedHorizon(horizonDays)
        let today = ObolDate.startOfDay(now)
        let todayKey = ObolDate.dayKey(today)
        let endDate = ObolDate.calendar.date(byAdding: .day, value: horizon, to: today) ?? today

        let options = ForecastOptions(
            startDate: today,
            endDate: endDate,
            includeSimulations: includeSimulations
        )
        let result = try ForecastEngine().forecast(snapshot, options: options, now: now)

        var dayIndex: [String: ForecastDay] = [:]
        dayIndex.reserveCapacity(result.timeline.count)
        for day in result.timeline {
            let key = ObolDate.dayKey(day.date)
            if dayIndex[key] == nil { dayIndex[key] = day }
        }

        var accountsByID: [String: Account] = [:]
        accountsByID.reserveCapacity(snapshot.accounts.count)
        for account in snapshot.accounts where accountsByID[account.id] == nil {
            accountsByID[account.id] = account
        }

        var cardsByID: [String: Card] = [:]
        cardsByID.reserveCapacity(snapshot.cards.count)
        for card in snapshot.cards where cardsByID[card.id] == nil {
            cardsByID[card.id] = card
        }

        var categoriesByID: [String: ObolCore.Category] = [:]
        categoriesByID.reserveCapacity(snapshot.categories.count)
        for category in snapshot.categories where categoriesByID[category.id] == nil {
            categoriesByID[category.id] = category
        }

        var projectsByID: [String: Project] = [:]
        projectsByID.reserveCapacity(snapshot.projects.count)
        for project in snapshot.projects where projectsByID[project.id] == nil {
            projectsByID[project.id] = project
        }

        var realized: [ObolCore.Transaction] = []
        var pending: [ObolCore.Transaction] = []
        var simulated: [ObolCore.Transaction] = []
        var overduePendingCount = 0

        for transaction in snapshot.transactions {
            // Card purchases are settled through their invoice, so they never
            // appear in these plain lists.
            if transaction.cardID != nil { continue }
            if transaction.isSimulated == true {
                simulated.append(transaction)
                continue
            }
            switch transaction.status {
            case .realized:
                realized.append(transaction)
            case .pending:
                pending.append(transaction)
                if ObolDate.startOfDay(transaction.expectedDate) < today {
                    overduePendingCount += 1
                }
            }
        }

        realized.sort { lhs, rhs in
            let leftDate = lhs.realizedDate ?? lhs.expectedDate
            let rightDate = rhs.realizedDate ?? rhs.expectedDate
            if leftDate != rightDate { return leftDate > rightDate }
            if lhs.title != rhs.title { return lhs.title < rhs.title }
            return lhs.id < rhs.id
        }
        pending.sort(by: pendingOrder)
        simulated.sort(by: pendingOrder)

        var invoicesInHorizon: [ForecastInvoice] = []
        var laterInvoiceCount = 0
        var overdueInvoiceCount = 0
        for invoice in result.upcomingInvoices {
            let due = ObolDate.startOfDay(invoice.dueDate)
            if due < today { overdueInvoiceCount += 1 }
            if due <= result.endDate {
                invoicesInHorizon.append(invoice)
            } else {
                laterInvoiceCount += 1
            }
        }

        var lowest = Decimal(0)
        var highest = Decimal(0)
        var lowestDay: ForecastDay?
        if let first = result.timeline.first {
            lowest = first.balance
            highest = first.balance
            lowestDay = first
            for day in result.timeline.dropFirst() {
                if day.balance < lowest {
                    lowest = day.balance
                    lowestDay = day
                }
                if day.balance > highest { highest = day.balance }
            }
        }

        // Chart geometry only. Monetary rules stay in ObolCore; `Decimal` is
        // converted to `Double` because Swift Charts requires a plottable value.
        let minValue = min(0, doubleValue(lowest))
        let maxValue = max(0, doubleValue(highest))
        let span = maxValue - minValue
        let padding = max(1, span * 0.08)

        var summary = "Projected end-of-day cash from \(AppFormatting.day(result.startDate)) to \(AppFormatting.day(result.endDate)), closing at \(AppFormatting.currency(result.endBalance))."
        if let lowestDay {
            summary += " Lowest balance \(AppFormatting.currency(lowestDay.balance)) on \(AppFormatting.day(lowestDay.date))."
        }
        if let firstNegative = result.firstNegativeDate {
            summary += " Cash turns negative on \(AppFormatting.day(firstNegative))."
        }

        var explanationParts: [String] = []
        if let todayDay = dayIndex[todayKey] {
            let difference = Money.sub(todayDay.balance, result.currentAvailableCash)
            if difference < 0 {
                explanationParts.append(
                    "Today's end-of-day projection subtracts \(AppFormatting.currency(-difference)) of obligations that available cash does not include yet."
                )
            } else if difference > 0 {
                explanationParts.append(
                    "Today's end-of-day projection adds \(AppFormatting.currency(difference)) of inflows that available cash does not include yet."
                )
            }
        }
        if overduePendingCount > 0 || overdueInvoiceCount > 0 {
            var items: [String] = []
            if overduePendingCount > 0 {
                items.append("\(overduePendingCount) overdue pending \(overduePendingCount == 1 ? "entry" : "entries")")
            }
            if overdueInvoiceCount > 0 {
                items.append("\(overdueInvoiceCount) unpaid \(overdueInvoiceCount == 1 ? "invoice" : "invoices")")
            }
            explanationParts.append(
                "Overdue items are projected on today, not on their original dates: \(items.joined(separator: " and "))."
            )
        }

        return DashboardDerived(
            horizonDays: horizon,
            today: today,
            todayKey: todayKey,
            result: result,
            dayIndex: dayIndex,
            firstMonth: ObolDate.startOfMonth(result.timeline.first?.date ?? today),
            lastMonth: ObolDate.startOfMonth(result.timeline.last?.date ?? today),
            realizedTransactions: realized,
            pendingTransactions: pending,
            simulatedTransactions: simulated,
            accountsByID: accountsByID,
            cardsByID: cardsByID,
            categoriesByID: categoriesByID,
            projectsByID: projectsByID,
            invoicesInHorizon: invoicesInHorizon,
            laterInvoiceCount: laterInvoiceCount,
            chartLowerBound: minValue - padding,
            chartUpperBound: maxValue + padding,
            chartSummary: summary,
            todayExplanation: explanationParts.isEmpty ? nil : explanationParts.joined(separator: " ")
        )
    }

    /// One line of context for an activity row, resolved from the indexes built
    /// for this snapshot.
    func detailLine(for transaction: ObolCore.Transaction) -> String {
        var parts: [String] = []
        if transaction.status == .realized {
            parts.append("Realized \(AppFormatting.day(transaction.realizedDate ?? transaction.expectedDate))")
        } else {
            parts.append("Expected \(AppFormatting.day(transaction.expectedDate))")
        }

        if transaction.type == .transfer {
            let source = transaction.accountID.flatMap { accountsByID[$0]?.name }
            let destination = transaction.destinationAccountID.flatMap { accountsByID[$0]?.name }
            switch (source, destination) {
            case let (source?, destination?):
                parts.append("\(source) → \(destination)")
            case let (source?, nil):
                parts.append("From \(source)")
            case let (nil, destination?):
                parts.append("To \(destination)")
            case (nil, nil):
                break
            }
        } else {
            if let accountID = transaction.accountID, let name = accountsByID[accountID]?.name {
                parts.append(name)
            }
            if let cardID = transaction.cardID, let name = cardsByID[cardID]?.name {
                parts.append(name)
            }
            if let categoryID = transaction.categoryID, let name = categoriesByID[categoryID]?.name {
                parts.append(name)
            }
            if let projectID = transaction.projectID, let name = projectsByID[projectID]?.name {
                parts.append(name)
            }
        }
        return parts.joined(separator: " · ")
    }

    private static func pendingOrder(_ lhs: ObolCore.Transaction, _ rhs: ObolCore.Transaction) -> Bool {
        if lhs.expectedDate != rhs.expectedDate { return lhs.expectedDate < rhs.expectedDate }
        if lhs.title != rhs.title { return lhs.title < rhs.title }
        return lhs.id < rhs.id
    }

    private static func doubleValue(_ value: Decimal) -> Double {
        NSDecimalNumber(decimal: value).doubleValue
    }
}
