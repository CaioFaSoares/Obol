import Foundation
import ObolCore
import ObolNativeRuntime

/// One cash event of the selected day, already resolved against the snapshot so
/// the sheet renders without searching the ledger.
struct DayDetailRow: Identifiable {
    let id: String
    let kind: ForecastEventKind
    let event: ForecastEvent
    let transaction: ObolCore.Transaction?
    let invoice: Invoice?
    let card: Card?
    let detailLine: String
}

/// Immutable day detail input for one snapshot, date and settings pair.
///
/// The reconstruction window is the last 30 days of realized history plus the
/// dashboard horizon. A date outside it is reported as outside the projection
/// range instead of inventing a balance; stored records on that date are still
/// listed with their own labels.
struct DayDetailDerived {
    static let historyDays = 30

    let targetDate: Date
    let today: Date
    let isToday: Bool
    let rangeStart: Date
    let rangeEnd: Date
    let inRange: Bool
    let day: ForecastDay?
    let events: [DayDetailRow]
    let overdueEventCount: Int
    let cardActivity: [ObolCore.Transaction]
    let silentRealizations: [ObolCore.Transaction]
    let storedRecords: [ObolCore.Transaction]
    let accountsByID: [String: Account]
    let cardsByID: [String: Card]
    let categoriesByID: [String: ObolCore.Category]
    let projectsByID: [String: Project]

    static func build(
        snapshot: FinancialSnapshot,
        horizonDays: Int,
        includeSimulations: Bool,
        date: Date,
        now: Date
    ) throws -> DayDetailDerived {
        let horizon = DashboardDerived.normalizedHorizon(horizonDays)
        let today = ObolDate.startOfDay(now)
        let target = ObolDate.startOfDay(date)
        let rangeStart = ObolDate.calendar.date(byAdding: .day, value: -historyDays, to: today) ?? today
        let rangeEnd = ObolDate.calendar.date(byAdding: .day, value: horizon, to: today) ?? today
        let inRange = target >= rangeStart && target <= rangeEnd
        let targetKey = ObolDate.dayKey(target)

        var accountsByID: [String: Account] = [:]
        for account in snapshot.accounts where accountsByID[account.id] == nil {
            accountsByID[account.id] = account
        }
        var cardsByID: [String: Card] = [:]
        for card in snapshot.cards where cardsByID[card.id] == nil {
            cardsByID[card.id] = card
        }
        var categoriesByID: [String: ObolCore.Category] = [:]
        for category in snapshot.categories where categoriesByID[category.id] == nil {
            categoriesByID[category.id] = category
        }
        var projectsByID: [String: Project] = [:]
        for project in snapshot.projects where projectsByID[project.id] == nil {
            projectsByID[project.id] = project
        }

        var day: ForecastDay?
        if inRange {
            let options = ForecastOptions(
                startDate: rangeStart,
                endDate: rangeEnd,
                includeSimulations: includeSimulations
            )
            let result = try ForecastEngine().forecast(snapshot, options: options, now: now)
            var dayIndex: [String: ForecastDay] = [:]
            dayIndex.reserveCapacity(result.timeline.count)
            for item in result.timeline {
                let key = ObolDate.dayKey(item.date)
                if dayIndex[key] == nil { dayIndex[key] = item }
            }
            day = dayIndex[targetKey]
        }

        var transactionsByID: [String: ObolCore.Transaction] = [:]
        for transaction in snapshot.transactions where transactionsByID[transaction.id] == nil {
            transactionsByID[transaction.id] = transaction
        }
        var invoicesByID: [String: Invoice] = [:]
        for invoice in snapshot.invoices where invoicesByID[invoice.id] == nil {
            invoicesByID[invoice.id] = invoice
        }
        var recurrencesByID: [String: Recurrence] = [:]
        for recurrence in snapshot.recurrences where recurrencesByID[recurrence.id] == nil {
            recurrencesByID[recurrence.id] = recurrence
        }

        var events: [DayDetailRow] = []
        var overdueEventCount = 0

        if let day {
            for event in day.events {
                let transaction = event.sourceID.flatMap { transactionsByID[$0] }
                var invoice: Invoice?
                var card: Card?

                switch event.kind {
                case .invoice:
                    if let sourceID = event.sourceID, let found = invoicesByID[sourceID] {
                        invoice = found
                        card = cardsByID[found.cardID]
                        if ObolDate.startOfDay(found.dueDate) < today { overdueEventCount += 1 }
                    }
                case .projectedInvoice:
                    if let sourceID = event.sourceID,
                       let recurrence = recurrencesByID[sourceID],
                       let cardID = recurrence.cardID {
                        card = cardsByID[cardID]
                    }
                default:
                    break
                }

                if event.kind == .pending,
                   let transaction,
                   ObolDate.startOfDay(transaction.expectedDate) < today {
                    overdueEventCount += 1
                }

                events.append(
                    DayDetailRow(
                        id: "\(event.kind.rawValue)-\(event.id)",
                        kind: event.kind,
                        event: event,
                        transaction: transaction,
                        invoice: invoice,
                        card: card,
                        detailLine: detailLine(
                            event: event,
                            transaction: transaction,
                            invoice: invoice,
                            card: card,
                            today: today,
                            accountsByID: accountsByID,
                            cardsByID: cardsByID,
                            categoriesByID: categoriesByID,
                            projectsByID: projectsByID
                        )
                    )
                )
            }
        }

        var cardActivity: [ObolCore.Transaction] = []
        var silentRealizations: [ObolCore.Transaction] = []
        var storedRecords: [ObolCore.Transaction] = []

        for transaction in snapshot.transactions {
            if transaction.cardID != nil {
                let purchaseDay = ObolDate.startOfDay(transaction.purchaseDate ?? transaction.expectedDate)
                if ObolDate.dayKey(purchaseDay) == targetKey {
                    cardActivity.append(transaction)
                }
            }

            let recordDate = transaction.status == .realized
                ? (transaction.realizedDate ?? transaction.expectedDate)
                : transaction.expectedDate
            guard ObolDate.dayKey(recordDate) == targetKey else { continue }

            storedRecords.append(transaction)
            if transaction.status == .realized,
               transaction.isSilent == true,
               transaction.cardID == nil {
                silentRealizations.append(transaction)
            }
        }

        cardActivity.sort { $0.title < $1.title }
        silentRealizations.sort { $0.title < $1.title }
        storedRecords.sort { lhs, rhs in
            if lhs.status != rhs.status { return lhs.status == .pending }
            if lhs.title != rhs.title { return lhs.title < rhs.title }
            return lhs.id < rhs.id
        }

        return DayDetailDerived(
            targetDate: target,
            today: today,
            isToday: targetKey == ObolDate.dayKey(today),
            rangeStart: rangeStart,
            rangeEnd: rangeEnd,
            inRange: inRange,
            day: day,
            events: events,
            overdueEventCount: overdueEventCount,
            cardActivity: cardActivity,
            silentRealizations: silentRealizations,
            storedRecords: storedRecords,
            accountsByID: accountsByID,
            cardsByID: cardsByID,
            categoriesByID: categoriesByID,
            projectsByID: projectsByID
        )
    }

    /// Context line for a stored transaction row.
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
            if let purchaseDate = transaction.purchaseDate {
                parts.append("Purchased \(AppFormatting.day(purchaseDate))")
            }
        }
        return parts.joined(separator: " · ")
    }

    private static func detailLine(
        event: ForecastEvent,
        transaction: ObolCore.Transaction?,
        invoice: Invoice?,
        card: Card?,
        today: Date,
        accountsByID: [String: Account],
        cardsByID: [String: Card],
        categoriesByID: [String: ObolCore.Category],
        projectsByID: [String: Project]
    ) -> String {
        switch event.kind {
        case .invoice:
            var parts: [String] = []
            if let card { parts.append("\(card.name) invoice") }
            if let invoice { parts.append(invoice.period) }
            parts.append("Due \(AppFormatting.day(event.date))")
            if let invoice, ObolDate.startOfDay(invoice.dueDate) < today {
                parts.append("Projected on today")
            }
            return parts.joined(separator: " · ")
        case .projectedInvoice:
            var parts: [String] = []
            if let card { parts.append("\(card.name) projected invoice") }
            parts.append("Due \(AppFormatting.day(event.date))")
            return parts.joined(separator: " · ")
        case .recurrence:
            return "Projected recurrence · \(AppFormatting.day(event.date))"
        default:
            guard let transaction else { return AppFormatting.day(event.date) }
            var parts: [String] = []
            if transaction.status == .realized {
                parts.append("Realized \(AppFormatting.day(transaction.realizedDate ?? transaction.expectedDate))")
            } else {
                parts.append("Expected \(AppFormatting.day(transaction.expectedDate))")
                if ObolDate.startOfDay(transaction.expectedDate) < today {
                    parts.append("Projected on today")
                }
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
    }
}
