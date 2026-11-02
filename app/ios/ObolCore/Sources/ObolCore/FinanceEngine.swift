import Foundation

/// Pure, offline financial command engine. Every command is applied to a value
/// snapshot; a thrown error leaves the caller's snapshot untouched.
public struct FinanceEngine: Sendable {
    public init() {}

    public func apply(
        _ command: FinancialCommand,
        to snapshot: FinancialSnapshot,
        now: Date = Date()
    ) throws -> FinancialSnapshot {
        var state = snapshot
        let clock = ObolDate.normalize(now)

        switch command {
        case .createAccount(let account):
            try createAccount(account, in: &state, now: clock)
        case .updateAccount(let id, let patch):
            try updateAccount(id: id, patch: patch, in: &state, now: clock)
        case .deleteAccount(let id):
            try deleteAccount(id: id, in: &state)

        case .createCard(let card):
            try createCard(card, in: &state, now: clock)
        case .updateCard(let id, let patch):
            try updateCard(id: id, patch: patch, in: &state, now: clock)
        case .deleteCard(let id):
            try deleteCard(id: id, in: &state)

        case .createCategory(let category):
            try createCategory(category, in: &state, now: clock)
        case .updateCategory(let id, let patch):
            try updateCategory(id: id, patch: patch, in: &state, now: clock)
        case .deleteCategory(let id):
            try deleteCategory(id: id, in: &state)

        case .createProject(let project):
            try createProject(project, in: &state, now: clock)
        case .updateProject(let id, let patch):
            try updateProject(id: id, patch: patch, in: &state, now: clock)
        case .completeProject(let id):
            try completeProject(id: id, in: &state, now: clock)
        case .deleteProject(let id):
            try deleteProject(id: id, in: &state)
        case .registerProjectPayment(let projectID, let amount, let description):
            try registerProjectPayment(projectID: projectID, amount: amount, description: description, in: &state, now: clock)

        case .createRecurrence(let recurrence):
            try createRecurrence(recurrence, in: &state, now: clock)
        case .updateRecurrence(let id, let patch):
            try updateRecurrence(id: id, patch: patch, in: &state, now: clock)
        case .setRecurrenceStatus(let id, let status):
            try setRecurrenceStatus(id: id, status: status, in: &state, now: clock)
        case .deleteRecurrence(let id):
            try setRecurrenceStatus(id: id, status: .ended, in: &state, now: clock)
        case .launchRecurrence(let id):
            let nextPeriod: Date
            if state.recurrence(id: id)?.cadence == .weekly {
                nextPeriod = ObolDate.addingDays(7, to: ObolDate.startOfISOWeek(clock))
            } else {
                nextPeriod = ObolDate.addingMonths(1, to: ObolDate.startOfMonth(clock))
            }
            _ = try generateOccurrence(
                recurrenceID: id,
                periodStart: nextPeriod,
                manual: true,
                in: &state,
                now: clock
            )
        case .processMonthlyRecurrences:
            try processMonthlyRecurrences(in: &state, now: clock)

        case .createTransaction(let draft):
            _ = try createTransaction(draft, in: &state, now: clock)
        case .updateTransaction(let id, let patch):
            try updateTransaction(id: id, patch: patch, in: &state, now: clock)
        case .realizeTransaction(let id, let updateBalance):
            try realizeTransaction(id: id, updateBalance: updateBalance, in: &state, now: clock)
        case .deleteTransaction(let id):
            try deleteTransaction(id: id, in: &state, now: clock)
        case .convertSimulation(let id, let toSimulated):
            try convertSimulation(id: id, toSimulated: toSimulated, in: &state, now: clock)

        case .payInvoice(let cardID, let period, let accountID, let amount, let ignoreBalance):
            try payInvoice(
                cardID: cardID,
                period: period,
                accountID: accountID,
                amount: amount,
                ignoreBalance: ignoreBalance,
                in: &state,
                now: clock
            )
        case .deleteInvoice(let cardID, let period):
            try deleteInvoice(cardID: cardID, period: period, in: &state, now: clock)
        case .reconcileInvoices:
            try reconcileInvoices(in: &state, now: clock)
        }

        return state
    }
}

// MARK: - Accounts, cards, categories, projects

private extension FinanceEngine {
    func createAccount(_ account: Account, in state: inout FinancialSnapshot, now: Date) throws {
        try ensureNewID(account.id, entity: "Account", in: state)
        var account = account
        account.name = try requireName(account.name, entity: "Account")
        account.initialBalance = Money.roundCurrency(account.initialBalance)
        account.created = ObolDate.normalize(account.created ?? now)
        account.updated = now
        state.accounts.append(account)
    }

    func updateAccount(id: String, patch: AccountPatch, in state: inout FinancialSnapshot, now: Date) throws {
        guard let index = state.accounts.firstIndex(where: { $0.id == id }) else {
            throw FinanceError.notFound("Account", id: id)
        }
        var account = state.accounts[index]
        if let name = patch.name {
            account.name = try requireName(name, entity: "Account")
        }
        if let type = patch.type {
            account.type = type
        }
        if let balance = patch.initialBalance {
            account.initialBalance = Money.roundCurrency(balance)
        }
        account.updated = now
        state.accounts[index] = account
    }

    func deleteAccount(id: String, in state: inout FinancialSnapshot) throws {
        guard let index = state.accounts.firstIndex(where: { $0.id == id }) else {
            throw FinanceError.notFound("Account", id: id)
        }
        if state.transactions.contains(where: { $0.accountID == id || $0.destinationAccountID == id }) {
            throw FinanceError.referenced("Account", id: id, by: "Transaction")
        }
        if state.recurrences.contains(where: { $0.accountID == id }) {
            throw FinanceError.referenced("Account", id: id, by: "Recurrence")
        }
        state.accounts.remove(at: index)
    }

    func createCard(_ card: Card, in state: inout FinancialSnapshot, now: Date) throws {
        try ensureNewID(card.id, entity: "Card", in: state)
        var card = card
        card.name = try requireName(card.name, entity: "Card")
        try validateCardDays(closingDay: card.closingDay, dueDay: card.dueDay)
        guard card.limit >= 0 else {
            throw FinanceError.validation("Card limit cannot be negative.", entity: "Card", entityID: card.id)
        }
        card.limit = Money.roundCurrency(card.limit)
        card.created = ObolDate.normalize(card.created ?? now)
        card.updated = now
        state.cards.append(card)
    }

    func updateCard(id: String, patch: CardPatch, in state: inout FinancialSnapshot, now: Date) throws {
        guard let index = state.cards.firstIndex(where: { $0.id == id }) else {
            throw FinanceError.notFound("Card", id: id)
        }
        var card = state.cards[index]
        if let name = patch.name {
            card.name = try requireName(name, entity: "Card")
        }
        if let closingDay = patch.closingDay {
            card.closingDay = closingDay
        }
        if let dueDay = patch.dueDay {
            card.dueDay = dueDay
        }
        if let limit = patch.limit {
            guard limit >= 0 else {
                throw FinanceError.validation("Card limit cannot be negative.", entity: "Card", entityID: id)
            }
            card.limit = Money.roundCurrency(limit)
        }
        try validateCardDays(closingDay: card.closingDay, dueDay: card.dueDay)
        card.updated = now
        state.cards[index] = card
    }

    func deleteCard(id: String, in state: inout FinancialSnapshot) throws {
        guard let index = state.cards.firstIndex(where: { $0.id == id }) else {
            throw FinanceError.notFound("Card", id: id)
        }
        if state.invoices.contains(where: { $0.cardID == id }) {
            throw FinanceError.referenced("Card", id: id, by: "Invoice")
        }
        if state.transactions.contains(where: { $0.cardID == id }) {
            throw FinanceError.referenced("Card", id: id, by: "Transaction")
        }
        if state.recurrences.contains(where: { $0.cardID == id }) {
            throw FinanceError.referenced("Card", id: id, by: "Recurrence")
        }
        state.cards.remove(at: index)
    }

    func createCategory(_ category: Category, in state: inout FinancialSnapshot, now: Date) throws {
        try ensureNewID(category.id, entity: "Category", in: state)
        var category = category
        category.name = try requireName(category.name, entity: "Category")
        if let budget = category.monthlyBudget {
            guard budget >= 0 else {
                throw FinanceError.validation("Category budget cannot be negative.", entity: "Category", entityID: category.id)
            }
            category.monthlyBudget = Money.roundCurrency(budget)
        }
        category.created = ObolDate.normalize(category.created ?? now)
        category.updated = now
        state.categories.append(category)
    }

    func updateCategory(id: String, patch: CategoryPatch, in state: inout FinancialSnapshot, now: Date) throws {
        guard let index = state.categories.firstIndex(where: { $0.id == id }) else {
            throw FinanceError.notFound("Category", id: id)
        }
        var category = state.categories[index]
        if let name = patch.name {
            category.name = try requireName(name, entity: "Category")
        }
        if let type = patch.type {
            category.type = type
        }
        if patch.clearMonthlyBudget {
            category.monthlyBudget = nil
        } else if let budget = patch.monthlyBudget {
            guard budget >= 0 else {
                throw FinanceError.validation("Category budget cannot be negative.", entity: "Category", entityID: id)
            }
            category.monthlyBudget = Money.roundCurrency(budget)
        }
        category.updated = now
        state.categories[index] = category
    }

    func deleteCategory(id: String, in state: inout FinancialSnapshot) throws {
        guard let index = state.categories.firstIndex(where: { $0.id == id }) else {
            throw FinanceError.notFound("Category", id: id)
        }
        if state.transactions.contains(where: { $0.categoryID == id }) {
            throw FinanceError.referenced("Category", id: id, by: "Transaction")
        }
        if state.recurrences.contains(where: { $0.categoryID == id }) {
            throw FinanceError.referenced("Category", id: id, by: "Recurrence")
        }
        state.categories.remove(at: index)
    }

    func createProject(_ project: Project, in state: inout FinancialSnapshot, now: Date) throws {
        try ensureNewID(project.id, entity: "Project", in: state)
        var project = project
        project.name = try requireName(project.name, entity: "Project")
        guard project.totalValue >= 0 else {
            throw FinanceError.validation("Project total value cannot be negative.", entity: "Project", entityID: project.id)
        }
        project.totalValue = Money.roundCurrency(project.totalValue)
        project.status = .active
        project.created = ObolDate.normalize(project.created ?? now)
        project.updated = now
        state.projects.append(project)
    }

    func updateProject(id: String, patch: ProjectPatch, in state: inout FinancialSnapshot, now: Date) throws {
        guard let index = state.projects.firstIndex(where: { $0.id == id }) else {
            throw FinanceError.notFound("Project", id: id)
        }
        var project = state.projects[index]
        if let name = patch.name {
            project.name = try requireName(name, entity: "Project")
        }
        if let totalValue = patch.totalValue {
            guard totalValue >= 0 else {
                throw FinanceError.validation("Project total value cannot be negative.", entity: "Project", entityID: id)
            }
            project.totalValue = Money.roundCurrency(totalValue)
        }
        if let status = patch.status {
            project.status = status
        }
        project.updated = now
        state.projects[index] = project
    }

    func completeProject(id: String, in state: inout FinancialSnapshot, now: Date) throws {
        guard let index = state.projects.firstIndex(where: { $0.id == id }) else {
            throw FinanceError.notFound("Project", id: id)
        }
        var project = state.projects[index]
        project.status = .completed
        project.updated = now
        state.projects[index] = project
    }

    func deleteProject(id: String, in state: inout FinancialSnapshot) throws {
        guard let index = state.projects.firstIndex(where: { $0.id == id }) else {
            throw FinanceError.notFound("Project", id: id)
        }
        if state.transactions.contains(where: { $0.projectID == id }) {
            throw FinanceError.referenced("Project", id: id, by: "Transaction")
        }
        state.projects.remove(at: index)
    }

    func registerProjectPayment(
        projectID: String,
        amount: Decimal,
        description: String?,
        in state: inout FinancialSnapshot,
        now: Date
    ) throws {
        guard let project = state.project(id: projectID) else {
            throw FinanceError.notFound("Project", id: projectID)
        }
        let payment = Money.roundCurrency(amount)
        guard payment > 0 else {
            throw FinanceError.validation("Project payment must be greater than zero.", entity: "Project", entityID: projectID)
        }
        let title = try requireName(description ?? "Pagamento — \(project.name)", entity: "Transaction")
        let transaction = Transaction(
            id: newID(in: state, at: now),
            title: title,
            amount: payment,
            type: .income,
            status: .realized,
            expectedDate: now,
            realizedDate: now,
            isRecurring: false,
            isSilent: false,
            isSimulated: false,
            isScheduled: false,
            projectID: projectID,
            created: now,
            updated: now
        )
        state.transactions.append(transaction)
    }
}

// MARK: - Recurrences

private extension FinanceEngine {
    func createRecurrence(_ recurrence: Recurrence, in state: inout FinancialSnapshot, now: Date) throws {
        try ensureNewID(recurrence.id, entity: "Recurrence", in: state)
        var recurrence = recurrence
        recurrence.name = try requireName(recurrence.name, entity: "Recurrence")
        recurrence.amount = Money.roundCurrency(recurrence.amount)
        recurrence.accountID = nonEmpty(recurrence.accountID)
        recurrence.cardID = nonEmpty(recurrence.cardID)
        recurrence.categoryID = nonEmpty(recurrence.categoryID)
        recurrence.endDate = recurrence.endDate.map(ObolDate.normalize)
        if let total = recurrence.totalInstallments, total <= 0 {
            recurrence.totalInstallments = nil
        }
        recurrence.skippedPeriods = nilIfEmpty(normalizeSkippedPeriods(recurrence.skippedPeriods ?? []))
        recurrence.weekday = normalizedWeekday(recurrence)
        recurrence.status = .active
        recurrence.created = ObolDate.normalize(recurrence.created ?? now)
        recurrence.updated = now
        try validateRecurrence(recurrence, in: state)
        state.recurrences.append(recurrence)
    }

    func updateRecurrence(id: String, patch: RecurrencePatch, in state: inout FinancialSnapshot, now: Date) throws {
        guard let index = state.recurrences.firstIndex(where: { $0.id == id }) else {
            throw FinanceError.notFound("Recurrence", id: id)
        }
        var recurrence = state.recurrences[index]
        if let name = patch.name {
            recurrence.name = try requireName(name, entity: "Recurrence")
        }
        if let amount = patch.amount {
            recurrence.amount = Money.roundCurrency(amount)
        }
        if let payday = patch.payday {
            recurrence.payday = payday
        }
        if let type = patch.type {
            recurrence.type = type
        }
        if let status = patch.status {
            recurrence.status = status
        }
        if let field = patch.accountID {
            recurrence.accountID = nonEmpty(field.resolve(recurrence.accountID))
        }
        if let field = patch.cardID {
            recurrence.cardID = nonEmpty(field.resolve(recurrence.cardID))
        }
        if let field = patch.categoryID {
            recurrence.categoryID = nonEmpty(field.resolve(recurrence.categoryID))
        }
        if let field = patch.endDate {
            recurrence.endDate = field.resolve(recurrence.endDate).map(ObolDate.normalize)
        }
        if let field = patch.totalInstallments {
            if let total = field.resolve(recurrence.totalInstallments) {
                guard total > 0 else {
                    throw FinanceError.validation(
                        "Total installments must be positive or cleared.",
                        entity: "Recurrence",
                        entityID: id
                    )
                }
                recurrence.totalInstallments = total
            } else {
                recurrence.totalInstallments = nil
            }
        }
        if let skipped = patch.skippedPeriods {
            recurrence.skippedPeriods = nilIfEmpty(normalizeSkippedPeriods(skipped))
        }
        if let field = patch.frequency {
            recurrence.frequency = field.resolve(recurrence.frequency)
        }
        if let field = patch.weekday {
            recurrence.weekday = field.resolve(recurrence.weekday)
        }
        recurrence.weekday = normalizedWeekday(recurrence)
        try validateRecurrence(recurrence, in: state)
        recurrence.updated = now
        state.recurrences[index] = recurrence
    }

    func setRecurrenceStatus(
        id: String,
        status: RecurrenceStatus,
        in state: inout FinancialSnapshot,
        now: Date
    ) throws {
        guard let index = state.recurrences.firstIndex(where: { $0.id == id }) else {
            throw FinanceError.notFound("Recurrence", id: id)
        }
        var recurrence = state.recurrences[index]
        recurrence.status = status
        recurrence.updated = now
        state.recurrences[index] = recurrence
    }

    func processMonthlyRecurrences(in state: inout FinancialSnapshot, now: Date) throws {
        let monthStart = ObolDate.startOfMonth(now)
        let weekStart = ObolDate.startOfISOWeek(now)
        let ids = state.recurrences.filter { $0.status == .active }.map(\.id)
        for id in ids {
            // The current UTC period only: this month for monthly rows, this
            // ISO week for weekly rows. A cadence change takes effect here.
            let periodStart = state.recurrence(id: id)?.cadence == .weekly ? weekStart : monthStart
            _ = try generateOccurrence(
                recurrenceID: id,
                periodStart: periodStart,
                manual: false,
                in: &state,
                now: now
            )
        }
    }

    enum GenerationOutcome {
        case generated
        case skipped
        case ended
    }

    /// Materializes one occurrence of `recurrenceID`. `periodStart` is the UTC
    /// month for monthly rows or the Monday of the ISO week for weekly rows.
    func generateOccurrence(
        recurrenceID: String,
        periodStart: Date,
        manual: Bool,
        in state: inout FinancialSnapshot,
        now: Date
    ) throws -> GenerationOutcome {
        guard let index = state.recurrences.firstIndex(where: { $0.id == recurrenceID }) else {
            throw FinanceError.notFound("Recurrence", id: recurrenceID)
        }
        var recurrence = state.recurrences[index]

        if recurrence.status == .ended {
            if manual {
                throw FinanceError.invalidState(
                    "Recurrence \(recurrenceID) has ended.",
                    entity: "Recurrence",
                    entityID: recurrenceID
                )
            }
            return .skipped
        }
        if !manual && recurrence.status != .active {
            return .skipped
        }

        let weekly = recurrence.cadence == .weekly
        let occurrence: Date
        // Title suffix: the day key for weekly rows, `<M>/<year>` for monthly
        // rows, matching the monthly title format exactly.
        let periodTitle: String
        if weekly {
            guard let weekday = recurrence.weekday, (1...7).contains(weekday) else {
                throw FinanceError.validation(
                    "Weekly recurrence requires a weekday between 1 and 7.",
                    entity: "Recurrence",
                    entityID: recurrenceID
                )
            }
            occurrence = ObolDate.isoWeekOccurrence(periodStart, weekday: weekday)
            periodTitle = ObolDate.dayKey(occurrence)
        } else {
            let year = ObolDate.calendar.component(.year, from: periodStart)
            let month = ObolDate.calendar.component(.month, from: periodStart)
            occurrence = ObolDate.clampedDate(year: year, month: month, day: recurrence.payday)
            periodTitle = "\(month)/\(year)"
        }

        if let endDate = recurrence.endDate, occurrence > endDate {
            recurrence.status = .ended
            recurrence.updated = now
            state.recurrences[index] = recurrence
            return .ended
        }

        let period = weekly ? ObolDate.dayKey(occurrence) : ObolDate.monthKey(occurrence)

        if !manual, let skipped = recurrence.skippedPeriods, skipped.contains(period) {
            return .skipped
        }

        // Only the monthly cadence keys skips on the invoice month; a weekly
        // row is identified by its occurrence day alone.
        if !weekly, recurrence.cardID != nil {
            guard let cardID = recurrence.cardID, let card = state.card(id: cardID) else {
                throw FinanceError.notFound("Card", id: recurrence.cardID ?? "")
            }
            let dueDate = ObolDate.calculateCardDueDate(
                purchaseDate: occurrence,
                closingDay: card.closingDay,
                dueDay: card.dueDay
            )
            let invoicePeriod = ObolDate.monthKey(dueDate)
            if !manual,
               let skipped = recurrence.skippedPeriods,
               skipped.contains(invoicePeriod) {
                return .skipped
            }
        }

        let existingChildren = state.transactions.filter { $0.recurrenceID == recurrence.id }

        if let total = recurrence.totalInstallments, total > 0, existingChildren.count + 1 > total {
            recurrence.status = .ended
            recurrence.updated = now
            state.recurrences[index] = recurrence
            return .ended
        }

        let launched: Bool
        if weekly {
            launched = existingChildren.contains { transaction in
                ObolDate.dayKey(transaction.purchaseDate ?? transaction.expectedDate) == period
            }
        } else if recurrence.cardID != nil {
            launched = existingChildren.contains { transaction in
                let purchaseMonth = transaction.purchaseDate.map(ObolDate.monthKey)
                let expectedMonth = ObolDate.monthKey(transaction.expectedDate)
                return (purchaseMonth ?? expectedMonth) == period
            }
        } else {
            launched = existingChildren.contains { transaction in
                let purchaseMonth = transaction.purchaseDate.map(ObolDate.monthKey)
                let expectedMonth = ObolDate.monthKey(transaction.expectedDate)
                return purchaseMonth == period || expectedMonth == period
            }
        }

        if launched {
            if manual {
                throw FinanceError.conflict(
                    "A transaction already exists for \(period).",
                    entity: "Recurrence",
                    entityID: recurrenceID
                )
            }
            return .skipped
        }

        let title: String
        if let total = recurrence.totalInstallments, total > 0 {
            title = "\(recurrence.name) - Parcela \(existingChildren.count + 1)/\(total)"
        } else {
            title = "\(recurrence.name) - \(periodTitle)"
        }

        let draft = TransactionDraft(
            title: title,
            amount: recurrence.amount,
            type: recurrence.type == .income ? .income : .expense,
            status: .pending,
            expectedDate: occurrence,
            purchaseDate: occurrence,
            isRecurring: true,
            isSilent: false,
            isSimulated: false,
            isScheduled: false,
            accountID: recurrence.accountID,
            cardID: recurrence.cardID,
            categoryID: recurrence.categoryID,
            recurrenceID: recurrence.id
        )
        _ = try createTransaction(draft, in: &state, now: now)
        return .generated
    }
}

// MARK: - Transactions

private extension FinanceEngine {
    func createTransaction(
        _ draft: TransactionDraft,
        in state: inout FinancialSnapshot,
        now: Date
    ) throws -> String {
        let identifier: String
        if let requestedID = draft.id {
            try ensureNewID(requestedID, entity: "Transaction", in: state)
            identifier = requestedID
        } else {
            identifier = newID(in: state, at: now)
        }

        var transaction = Transaction(
            id: identifier,
            title: try requireName(draft.title, entity: "Transaction"),
            amount: Money.roundCurrency(draft.amount),
            type: draft.type,
            status: draft.status,
            expectedDate: ObolDate.normalize(draft.expectedDate),
            realizedDate: draft.realizedDate.map(ObolDate.normalize),
            purchaseDate: draft.purchaseDate.map(ObolDate.normalize),
            isRecurring: draft.isRecurring,
            isSilent: draft.isSilent,
            isSimulated: draft.isSimulated,
            isScheduled: draft.isScheduled,
            accountID: nonEmpty(draft.accountID),
            cardID: nonEmpty(draft.cardID),
            categoryID: nonEmpty(draft.categoryID),
            projectID: nonEmpty(draft.projectID),
            invoiceID: nil,
            recurrenceID: nonEmpty(draft.recurrenceID),
            destinationAccountID: nonEmpty(draft.destinationAccountID),
            created: now,
            updated: now
        )

        if transaction.type == .transfer {
            transaction.cardID = nil
            transaction.categoryID = nil
            transaction.purchaseDate = nil
            transaction.invoiceID = nil
        } else if transaction.destinationAccountID != nil {
            throw FinanceError.validation(
                "Only transfers may set destination_account_id.",
                entity: "Transaction",
                entityID: identifier
            )
        }

        if transaction.cardID != nil && transaction.accountID != nil {
            throw FinanceError.validation(
                "A card transaction cannot also use a bank account.",
                entity: "Transaction",
                entityID: identifier
            )
        }

        if transaction.status == .realized {
            transaction.isScheduled = false
            if transaction.realizedDate == nil {
                transaction.realizedDate = now
            }
        } else {
            transaction.realizedDate = nil
            transaction.isSilent = false
        }

        try validateTransaction(transaction, in: state)

        if let cardID = transaction.cardID {
            let card = try requireCard(cardID, in: state)
            let purchaseDate = transaction.purchaseDate ?? transaction.expectedDate
            transaction.purchaseDate = purchaseDate
            transaction.status = .pending
            transaction.realizedDate = nil
            transaction.isSilent = false

            if transaction.isSimulated == true {
                transaction.invoiceID = nil
                transaction.expectedDate = ObolDate.calculateCardDueDate(
                    purchaseDate: purchaseDate,
                    closingDay: card.closingDay,
                    dueDay: card.dueDay
                )
            } else {
                let invoice = try syncInvoice(
                    cardID: cardID,
                    purchaseDate: purchaseDate,
                    amount: transaction.amount,
                    type: transaction.type,
                    in: &state,
                    now: now
                )
                transaction.invoiceID = invoice.id
                transaction.expectedDate = invoice.dueDate
            }
        }

        if transaction.status == .realized
            && transaction.isSimulated != true
            && transaction.isSilent != true {
            try applyAccountEffects(transaction, reverse: false, in: &state, now: now)
        }

        transaction.created = now
        transaction.updated = now
        state.transactions.append(transaction)

        if let invoiceID = transaction.invoiceID {
            try refreshInvoiceStatus(invoiceID: invoiceID, in: &state, now: now)
        }
        return transaction.id
    }

    func updateTransaction(
        id: String,
        patch: TransactionPatch,
        in state: inout FinancialSnapshot,
        now: Date
    ) throws {
        guard let index = state.transactions.firstIndex(where: { $0.id == id }) else {
            throw FinanceError.notFound("Transaction", id: id)
        }
        let old = state.transactions[index]
        var transaction = old

        if let title = patch.title {
            transaction.title = try requireName(title, entity: "Transaction")
        }
        if let amount = patch.amount {
            transaction.amount = Money.roundCurrency(amount)
        }
        if let type = patch.type {
            transaction.type = type
        }
        if let status = patch.status {
            transaction.status = status
        }
        if let expectedDate = patch.expectedDate {
            transaction.expectedDate = ObolDate.normalize(expectedDate)
        }
        if let field = patch.realizedDate {
            transaction.realizedDate = field.resolve(old.realizedDate).map(ObolDate.normalize)
        }
        if let field = patch.purchaseDate {
            transaction.purchaseDate = field.resolve(old.purchaseDate).map(ObolDate.normalize)
        }
        if let value = patch.isRecurring {
            transaction.isRecurring = value
        }
        if let value = patch.isSilent {
            transaction.isSilent = value
        }
        if let value = patch.isSimulated {
            transaction.isSimulated = value
        }
        if let value = patch.isScheduled {
            transaction.isScheduled = value
        }
        if let field = patch.accountID {
            transaction.accountID = nonEmpty(field.resolve(old.accountID))
        }
        if let field = patch.cardID {
            transaction.cardID = nonEmpty(field.resolve(old.cardID))
        }
        if let field = patch.categoryID {
            transaction.categoryID = nonEmpty(field.resolve(old.categoryID))
        }
        if let field = patch.projectID {
            transaction.projectID = nonEmpty(field.resolve(old.projectID))
        }
        if let field = patch.recurrenceID {
            transaction.recurrenceID = nonEmpty(field.resolve(old.recurrenceID))
        }
        if let field = patch.destinationAccountID {
            transaction.destinationAccountID = nonEmpty(field.resolve(old.destinationAccountID))
        }

        // For card purchases the form's expected date is the purchase date.
        if old.cardID != nil,
           patch.purchaseDate == nil,
           let expectedDate = patch.expectedDate,
           transaction.cardID != nil {
            transaction.purchaseDate = ObolDate.normalize(expectedDate)
        }

        if transaction.type == .transfer {
            transaction.cardID = nil
            transaction.categoryID = nil
            transaction.purchaseDate = nil
        } else {
            transaction.destinationAccountID = nil
        }

        if transaction.cardID != nil {
            transaction.accountID = nil
            transaction.destinationAccountID = nil
            transaction.invoiceID = nil
        } else {
            transaction.invoiceID = nil
            if old.cardID != nil && patch.purchaseDate == nil && patch.expectedDate == nil {
                transaction.purchaseDate = nil
            }
        }

        if transaction.isSimulated == true {
            transaction.invoiceID = nil
        }

        if transaction.status == .realized {
            transaction.isScheduled = false
            if transaction.realizedDate == nil {
                transaction.realizedDate = now
            }
        } else {
            transaction.realizedDate = nil
            transaction.isSilent = false
        }

        try validateTransaction(transaction, in: state)

        let cardChanged = old.cardID != transaction.cardID
            || old.amount != transaction.amount
            || old.type != transaction.type
            || old.purchaseDate != transaction.purchaseDate

        if old.isSimulated != true {
            try applyAccountEffects(old, reverse: true, in: &state, now: now)
            try applyInvoiceEffect(old, reverse: true, in: &state, now: now)
        }

        if let cardID = transaction.cardID, transaction.isSimulated != true {
            let purchaseDate = transaction.purchaseDate ?? transaction.expectedDate
            transaction.purchaseDate = purchaseDate
            let invoice = try syncInvoice(
                cardID: cardID,
                purchaseDate: purchaseDate,
                amount: transaction.amount,
                type: transaction.type,
                in: &state,
                now: now
            )
            transaction.invoiceID = invoice.id
            transaction.expectedDate = invoice.dueDate
            if cardChanged {
                transaction.status = .pending
                transaction.realizedDate = nil
                transaction.isSilent = false
                transaction.isScheduled = false
            }
        } else if let cardID = transaction.cardID, transaction.isSimulated == true {
            let card = try requireCard(cardID, in: state)
            let purchaseDate = transaction.purchaseDate ?? transaction.expectedDate
            transaction.purchaseDate = purchaseDate
            transaction.invoiceID = nil
            transaction.expectedDate = ObolDate.calculateCardDueDate(
                purchaseDate: purchaseDate,
                closingDay: card.closingDay,
                dueDay: card.dueDay
            )
            transaction.status = .pending
            transaction.realizedDate = nil
            transaction.isSilent = false
        }

        if transaction.status == .realized
            && transaction.isSimulated != true
            && transaction.isSilent != true {
            try applyAccountEffects(transaction, reverse: false, in: &state, now: now)
        }

        transaction.updated = now
        state.transactions[index] = transaction

        if let oldInvoiceID = old.invoiceID {
            try refreshInvoiceStatus(invoiceID: oldInvoiceID, in: &state, now: now)
        }
        if let newInvoiceID = transaction.invoiceID, newInvoiceID != old.invoiceID {
            try refreshInvoiceStatus(invoiceID: newInvoiceID, in: &state, now: now)
        }
    }

    func realizeTransaction(
        id: String,
        updateBalance: Bool,
        in state: inout FinancialSnapshot,
        now: Date
    ) throws {
        guard let index = state.transactions.firstIndex(where: { $0.id == id }) else {
            throw FinanceError.notFound("Transaction", id: id)
        }
        var transaction = state.transactions[index]
        guard transaction.status != .realized else {
            throw FinanceError(
                code: .alreadyRealized,
                message: "Transaction \(id) is already realized.",
                entity: "Transaction",
                entityID: id
            )
        }
        guard transaction.isSimulated != true else {
            throw FinanceError.invalidState(
                "A simulated transaction must be converted before realization.",
                entity: "Transaction",
                entityID: id
            )
        }

        if updateBalance {
            var effective = transaction
            effective.status = .realized
            effective.realizedDate = now
            effective.isSilent = false
            try applyAccountEffects(effective, reverse: false, in: &state, now: now)
        }

        transaction.status = .realized
        transaction.realizedDate = now
        transaction.isScheduled = false
        transaction.isSilent = !updateBalance
        transaction.updated = now
        state.transactions[index] = transaction

        if let invoiceID = transaction.invoiceID {
            try refreshInvoiceStatus(invoiceID: invoiceID, in: &state, now: now)
        }
    }

    func deleteTransaction(id: String, in state: inout FinancialSnapshot, now: Date) throws {
        guard let index = state.transactions.firstIndex(where: { $0.id == id }) else {
            throw FinanceError.notFound("Transaction", id: id)
        }
        let transaction = state.transactions[index]

        try applyAccountEffects(transaction, reverse: true, in: &state, now: now)
        try applyInvoiceEffect(transaction, reverse: true, in: &state, now: now)

        if let recurrenceID = transaction.recurrenceID {
            let occurrence = transaction.purchaseDate ?? transaction.expectedDate
            var periods = Set<String>()
            if state.recurrence(id: recurrenceID)?.cadence == .weekly {
                periods.insert(ObolDate.dayKey(occurrence))
            } else {
                periods.insert(ObolDate.monthKey(occurrence))
                if let invoiceID = transaction.invoiceID, let invoice = state.invoice(id: invoiceID) {
                    periods.insert(invoice.period)
                }
            }
            try appendSkippedPeriods(periods, recurrenceID: recurrenceID, in: &state, now: now)
        }

        let invoiceID = transaction.invoiceID
        state.transactions.remove(at: index)

        if let invoiceID {
            try refreshInvoiceStatus(invoiceID: invoiceID, in: &state, now: now)
        }
    }

    func convertSimulation(
        id: String,
        toSimulated: Bool,
        in state: inout FinancialSnapshot,
        now: Date
    ) throws {
        guard let index = state.transactions.firstIndex(where: { $0.id == id }) else {
            throw FinanceError.notFound("Transaction", id: id)
        }
        var transaction = state.transactions[index]
        let currentlySimulated = transaction.isSimulated == true
        guard currentlySimulated != toSimulated else { return }

        if toSimulated {
            guard transaction.status == .pending else {
                throw FinanceError.invalidState(
                    "Only pending transactions can be converted to simulations.",
                    entity: "Transaction",
                    entityID: id
                )
            }
            let oldInvoiceID = transaction.invoiceID
            try applyInvoiceEffect(transaction, reverse: true, in: &state, now: now)
            transaction.isSimulated = true
            transaction.invoiceID = nil
            transaction.updated = now
            state.transactions[index] = transaction
            if let oldInvoiceID {
                try refreshInvoiceStatus(invoiceID: oldInvoiceID, in: &state, now: now)
            }
            return
        }

        transaction.isSimulated = false
        if let cardID = transaction.cardID {
            let purchaseDate = transaction.purchaseDate ?? transaction.expectedDate
            transaction.purchaseDate = purchaseDate
            let invoice = try syncInvoice(
                cardID: cardID,
                purchaseDate: purchaseDate,
                amount: transaction.amount,
                type: transaction.type,
                in: &state,
                now: now
            )
            transaction.invoiceID = invoice.id
            transaction.expectedDate = invoice.dueDate
            transaction.status = .pending
            transaction.realizedDate = nil
            transaction.isSilent = false
        } else if transaction.status == .realized && transaction.isSilent != true {
            try applyAccountEffects(transaction, reverse: false, in: &state, now: now)
        }

        try validateTransaction(transaction, in: state)
        transaction.updated = now
        state.transactions[index] = transaction

        if let invoiceID = transaction.invoiceID {
            try refreshInvoiceStatus(invoiceID: invoiceID, in: &state, now: now)
        }
    }
}

// MARK: - Invoices

private extension FinanceEngine {
    func syncInvoice(
        cardID: String,
        purchaseDate: Date,
        amount: Decimal,
        type: TransactionType,
        in state: inout FinancialSnapshot,
        now: Date
    ) throws -> Invoice {
        guard type != .transfer else {
            throw FinanceError.validation("A transfer cannot be charged to a card.", entity: "Transaction")
        }
        guard amount > 0 else {
            throw FinanceError.validation("Invoice amount must be greater than zero.", entity: "Invoice")
        }
        let card = try requireCard(cardID, in: state)
        let dueDate = ObolDate.calculateCardDueDate(
            purchaseDate: purchaseDate,
            closingDay: card.closingDay,
            dueDay: card.dueDay
        )
        let period = ObolDate.monthKey(dueDate)
        let delta: Decimal = type == .expense ? amount : -amount

        if let index = state.invoices.firstIndex(where: { $0.cardID == cardID && $0.period == period }) {
            var invoice = state.invoices[index]
            invoice.totalAmount = Money.roundCurrency(invoice.totalAmount + delta)
            invoice.dueDate = dueDate
            invoice.updated = now
            state.invoices[index] = invoice
            return invoice
        }

        let invoice = Invoice(
            id: newID(in: state, at: now),
            cardID: cardID,
            period: period,
            dueDate: dueDate,
            status: .open,
            totalAmount: Money.roundCurrency(delta),
            paidAmount: 0,
            created: now,
            updated: now
        )
        state.invoices.append(invoice)
        return invoice
    }

    func applyInvoiceEffect(
        _ transaction: Transaction,
        reverse: Bool,
        in state: inout FinancialSnapshot,
        now: Date
    ) throws {
        guard transaction.isSimulated != true, let invoiceID = transaction.invoiceID else { return }
        guard let index = state.invoices.firstIndex(where: { $0.id == invoiceID }) else {
            throw FinanceError.notFound("Invoice", id: invoiceID)
        }
        let delta: Decimal = transaction.type == .expense ? transaction.amount : -transaction.amount
        var invoice = state.invoices[index]
        invoice.totalAmount = Money.roundCurrency(invoice.totalAmount + (reverse ? -delta : delta))
        invoice.updated = now
        state.invoices[index] = invoice
    }

    func refreshInvoiceStatus(invoiceID: String, in state: inout FinancialSnapshot, now: Date) throws {
        guard let index = state.invoices.firstIndex(where: { $0.id == invoiceID }) else {
            throw FinanceError.notFound("Invoice", id: invoiceID)
        }
        var invoice = state.invoices[index]
        let card = try requireCard(invoice.cardID, in: state)
        let children = state.transactions.filter { $0.invoiceID == invoice.id }
        let closingDate = ObolDate.closingDate(
            dueDate: invoice.dueDate,
            closingDay: card.closingDay,
            dueDay: card.dueDay
        )

        if !children.isEmpty {
            if children.allSatisfy({ $0.status == .realized }) {
                invoice.status = .paid
            } else {
                invoice.status = now > closingDate ? .closed : .open
            }
        } else if invoice.status != .paid {
            invoice.status = now > closingDate ? .closed : .open
        }

        invoice.updated = now
        state.invoices[index] = invoice
    }

    func payInvoice(
        cardID: String,
        period: String,
        accountID: String?,
        amount: Decimal?,
        ignoreBalance: Bool,
        in state: inout FinancialSnapshot,
        now: Date
    ) throws {
        let card = try requireCard(cardID, in: state)
        guard let index = state.invoices.firstIndex(where: { $0.cardID == cardID && $0.period == period }) else {
            throw FinanceError.notFound("Invoice", id: "\(cardID)/\(period)")
        }
        var invoice = state.invoices[index]
        guard invoice.status != .paid else {
            throw FinanceError(
                code: .alreadyPaid,
                message: "Invoice \(period) is already paid.",
                entity: "Invoice",
                entityID: invoice.id
            )
        }

        let totalDue = Money.roundCurrency(invoice.totalAmount - (invoice.paidAmount ?? 0))

        if ignoreBalance {
            invoice.status = .paid
            invoice.updated = now
            state.invoices[index] = invoice
            try realizeInvoiceChildren(invoiceID: invoice.id, in: &state, now: now)
            return
        }

        guard let accountID = nonEmpty(accountID), let account = state.account(id: accountID) else {
            throw FinanceError.validation(
                "A bank account is required unless the payoff is silent.",
                entity: "Invoice",
                entityID: invoice.id
            )
        }
        guard totalDue > 0 else {
            throw FinanceError(
                code: .alreadyPaid,
                message: "Invoice \(period) has no remaining debt.",
                entity: "Invoice",
                entityID: invoice.id
            )
        }

        let requested = amount.map(Money.roundCurrency) ?? totalDue
        guard requested > 0 else {
            throw FinanceError.validation("The paid amount must be greater than zero.", entity: "Invoice", entityID: invoice.id)
        }
        guard requested <= totalDue + Money.cent else {
            throw FinanceError.validation(
                "The paid amount cannot exceed the remaining invoice debt.",
                entity: "Invoice",
                entityID: invoice.id
            )
        }
        let payment = min(requested, totalDue)

        try adjustAccountBalance(account.id, by: -payment, in: &state, now: now)

        let paymentTransaction = Transaction(
            id: newID(in: state, at: now),
            title: "Pagamento Fatura \(card.name) \(period)",
            amount: payment,
            type: .expense,
            status: .realized,
            expectedDate: now,
            realizedDate: now,
            isRecurring: false,
            isSilent: false,
            isSimulated: false,
            isScheduled: false,
            accountID: account.id,
            created: now,
            updated: now
        )
        state.transactions.append(paymentTransaction)

        let newPaidAmount = Money.roundCurrency((invoice.paidAmount ?? 0) + payment)
        invoice.paidAmount = newPaidAmount
        invoice.updated = now
        let remaining = Money.roundCurrency(invoice.totalAmount - newPaidAmount)
        if remaining <= Money.cent {
            invoice.status = .paid
        }
        state.invoices[index] = invoice

        if remaining <= Money.cent {
            try realizeInvoiceChildren(invoiceID: invoice.id, in: &state, now: now)
        }
        try refreshInvoiceStatus(invoiceID: invoice.id, in: &state, now: now)
    }

    func realizeInvoiceChildren(invoiceID: String, in state: inout FinancialSnapshot, now: Date) throws {
        for index in state.transactions.indices {
            guard state.transactions[index].invoiceID == invoiceID,
                  state.transactions[index].status == .pending else {
                continue
            }
            var transaction = state.transactions[index]
            transaction.status = .realized
            transaction.realizedDate = now
            transaction.isScheduled = false
            transaction.updated = now
            state.transactions[index] = transaction
        }
    }

    func deleteInvoice(
        cardID: String,
        period: String,
        in state: inout FinancialSnapshot,
        now: Date
    ) throws {
        guard let index = state.invoices.firstIndex(where: { $0.cardID == cardID && $0.period == period }) else {
            throw FinanceError.notFound("Invoice", id: "\(cardID)/\(period)")
        }
        let invoice = state.invoices[index]
        let children = state.transactions.filter { $0.invoiceID == invoice.id }

        for child in children {
            if let recurrenceID = child.recurrenceID {
                if state.recurrence(id: recurrenceID)?.cadence == .weekly {
                    let occurrence = child.purchaseDate ?? child.expectedDate
                    try appendSkippedPeriods(
                        [ObolDate.dayKey(occurrence)],
                        recurrenceID: recurrenceID,
                        in: &state,
                        now: now
                    )
                } else {
                    try appendSkippedPeriods([invoice.period], recurrenceID: recurrenceID, in: &state, now: now)
                }
            }
            try applyAccountEffects(child, reverse: true, in: &state, now: now)
        }

        state.transactions.removeAll { $0.invoiceID == invoice.id }
        state.invoices.remove(at: index)
    }

    func reconcileInvoices(in state: inout FinancialSnapshot, now: Date) throws {
        for index in state.transactions.indices {
            var transaction = state.transactions[index]
            guard let cardID = transaction.cardID,
                  transaction.invoiceID == nil,
                  transaction.isSimulated != true else {
                continue
            }
            let referenceDate = transaction.purchaseDate ?? transaction.expectedDate
            if transaction.purchaseDate == nil {
                transaction.purchaseDate = referenceDate
            }
            let invoice = try syncInvoice(
                cardID: cardID,
                purchaseDate: referenceDate,
                amount: transaction.amount,
                type: transaction.type,
                in: &state,
                now: now
            )
            transaction.invoiceID = invoice.id
            transaction.expectedDate = invoice.dueDate
            transaction.updated = now
            state.transactions[index] = transaction
        }

        let recalculatedInvoiceIDs = state.invoices.filter { $0.status != .paid }.map(\.id)
        for invoiceID in recalculatedInvoiceIDs {
            guard let index = state.invoices.firstIndex(where: { $0.id == invoiceID }) else { continue }
            let invoice = state.invoices[index]
            let children = state.transactions.filter { $0.invoiceID == invoice.id }
            let calculated = children.reduce(Decimal(0)) { total, transaction in
                if transaction.type == .expense {
                    return Money.roundCurrency(total + transaction.amount)
                }
                if transaction.type == .income {
                    return Money.roundCurrency(total - transaction.amount)
                }
                return total
            }
            let difference = invoice.totalAmount - calculated
            if difference > Money.cent || difference < -Money.cent {
                var updated = invoice
                updated.totalAmount = calculated
                updated.updated = now
                state.invoices[index] = updated
            }
        }

        let invoiceIDs = state.invoices.map(\.id)
        for invoiceID in invoiceIDs {
            try refreshInvoiceStatus(invoiceID: invoiceID, in: &state, now: now)
        }

        let cutoff = ObolDate.monthKey(
            ObolDate.addingMonths(-3, to: ObolDate.startOfDay(now))
        )
        for index in state.recurrences.indices where state.recurrences[index].status == .active {
            guard let periods = state.recurrences[index].skippedPeriods, !periods.isEmpty else {
                continue
            }
            let fresh = periods.filter { $0 >= cutoff }
            if fresh.count != periods.count {
                var recurrence = state.recurrences[index]
                recurrence.skippedPeriods = nilIfEmpty(fresh)
                recurrence.updated = now
                state.recurrences[index] = recurrence
            }
        }
    }
}

// MARK: - Shared helpers

private extension FinanceEngine {
    func ensureNewID(_ id: String, entity: String, in state: FinancialSnapshot) throws {
        guard EntityID.isValid(id) else {
            throw FinanceError.invalidIdentifier(entity, id: id)
        }
        guard !containsID(id, in: state) else {
            throw FinanceError.conflict(
                "\(entity) id \(id) already exists.",
                entity: entity,
                entityID: id
            )
        }
    }

    func containsID(_ id: String, in state: FinancialSnapshot) -> Bool {
        state.accounts.contains { $0.id == id }
            || state.cards.contains { $0.id == id }
            || state.categories.contains { $0.id == id }
            || state.invoices.contains { $0.id == id }
            || state.projects.contains { $0.id == id }
            || state.recurrences.contains { $0.id == id }
            || state.transactions.contains { $0.id == id }
    }

    func newID(in state: FinancialSnapshot, at now: Date) -> String {
        var id = EntityID.generate(at: now)
        while containsID(id, in: state) {
            id = EntityID.generate(at: now)
        }
        return id
    }

    func requireName(_ value: String, entity: String) throws -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw FinanceError.validation("\(entity) name cannot be empty.", entity: entity)
        }
        return trimmed
    }

    func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else { return nil }
        return value
    }

    func nilIfEmpty(_ values: [String]) -> [String]? {
        values.isEmpty ? nil : values
    }

    func normalizeSkippedPeriods(_ periods: [String]) -> [String] {
        Array(Set(periods.filter { !$0.isEmpty })).sorted()
    }

    /// Only a weekly recurrence keeps a weekday; every monthly row stores none.
    func normalizedWeekday(_ recurrence: Recurrence) -> Int? {
        recurrence.cadence == .weekly ? recurrence.weekday : nil
    }

    func validateCardDays(closingDay: Int, dueDay: Int) throws {
        guard (1...31).contains(closingDay) else {
            throw FinanceError.validation("Card closing day must be between 1 and 31.", entity: "Card")
        }
        guard (1...31).contains(dueDay) else {
            throw FinanceError.validation("Card due day must be between 1 and 31.", entity: "Card")
        }
    }

    func requireCard(_ id: String, in state: FinancialSnapshot) throws -> Card {
        guard let card = state.card(id: id) else {
            throw FinanceError.notFound("Card", id: id)
        }
        return card
    }

    func validateRecurrence(_ recurrence: Recurrence, in state: FinancialSnapshot) throws {
        guard !recurrence.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw FinanceError.validation("Recurrence name cannot be empty.", entity: "Recurrence", entityID: recurrence.id)
        }
        guard recurrence.amount > 0 else {
            throw FinanceError.validation("Recurrence amount must be greater than zero.", entity: "Recurrence", entityID: recurrence.id)
        }
        guard (1...31).contains(recurrence.payday) else {
            throw FinanceError.validation("Recurrence payday must be between 1 and 31.", entity: "Recurrence", entityID: recurrence.id)
        }
        if recurrence.cadence == .weekly {
            guard let weekday = recurrence.weekday, (1...7).contains(weekday) else {
                throw FinanceError.validation(
                    "Weekly recurrence requires a weekday between 1 and 7.",
                    entity: "Recurrence",
                    entityID: recurrence.id
                )
            }
        }
        if let total = recurrence.totalInstallments, total <= 0 {
            throw FinanceError.validation("Total installments must be positive.", entity: "Recurrence", entityID: recurrence.id)
        }
        if let accountID = recurrence.accountID, state.account(id: accountID) == nil {
            throw FinanceError.notFound("Account", id: accountID)
        }
        if let cardID = recurrence.cardID, state.card(id: cardID) == nil {
            throw FinanceError.notFound("Card", id: cardID)
        }
        if recurrence.accountID != nil && recurrence.cardID != nil {
            throw FinanceError.validation(
                "A recurrence cannot use both a bank account and a card.",
                entity: "Recurrence",
                entityID: recurrence.id
            )
        }
        if let categoryID = recurrence.categoryID, state.category(id: categoryID) == nil {
            throw FinanceError.notFound("Category", id: categoryID)
        }
    }

    func validateTransaction(_ transaction: Transaction, in state: FinancialSnapshot) throws {
        guard !transaction.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw FinanceError.validation("Transaction title cannot be empty.", entity: "Transaction", entityID: transaction.id)
        }
        guard transaction.amount > 0 else {
            throw FinanceError.validation("Transaction amount must be greater than zero.", entity: "Transaction", entityID: transaction.id)
        }

        if let accountID = transaction.accountID, state.account(id: accountID) == nil {
            throw FinanceError.notFound("Account", id: accountID)
        }
        if let destinationID = transaction.destinationAccountID, state.account(id: destinationID) == nil {
            throw FinanceError.notFound("Account", id: destinationID)
        }
        if let cardID = transaction.cardID, state.card(id: cardID) == nil {
            throw FinanceError.notFound("Card", id: cardID)
        }
        if let categoryID = transaction.categoryID, state.category(id: categoryID) == nil {
            throw FinanceError.notFound("Category", id: categoryID)
        }
        if let projectID = transaction.projectID, state.project(id: projectID) == nil {
            throw FinanceError.notFound("Project", id: projectID)
        }
        if let recurrenceID = transaction.recurrenceID {
            guard let recurrence = state.recurrence(id: recurrenceID) else {
                throw FinanceError.notFound("Recurrence", id: recurrenceID)
            }
            if recurrence.type.rawValue != transaction.type.rawValue {
                throw FinanceError.validation(
                    "Transaction type does not match recurrence type.",
                    entity: "Transaction",
                    entityID: transaction.id
                )
            }
        }

        if transaction.type == .transfer {
            guard let sourceID = transaction.accountID,
                  let destinationID = transaction.destinationAccountID else {
                throw FinanceError.validation(
                    "A transfer requires a source and a destination account.",
                    entity: "Transaction",
                    entityID: transaction.id
                )
            }
            guard sourceID != destinationID else {
                throw FinanceError.validation(
                    "A transfer cannot use the same account on both sides.",
                    entity: "Transaction",
                    entityID: transaction.id
                )
            }
            guard transaction.cardID == nil else {
                throw FinanceError.validation(
                    "A transfer cannot use a card.",
                    entity: "Transaction",
                    entityID: transaction.id
                )
            }
            guard transaction.invoiceID == nil else {
                throw FinanceError.validation(
                    "A transfer cannot belong to an invoice.",
                    entity: "Transaction",
                    entityID: transaction.id
                )
            }
        } else {
            guard transaction.destinationAccountID == nil else {
                throw FinanceError.validation(
                    "Only transfers may set destination_account_id.",
                    entity: "Transaction",
                    entityID: transaction.id
                )
            }
            if transaction.cardID != nil {
                guard transaction.accountID == nil else {
                    throw FinanceError.validation(
                        "A card transaction cannot also use a bank account.",
                        entity: "Transaction",
                        entityID: transaction.id
                    )
                }
            }
        }

        if let invoiceID = transaction.invoiceID {
            guard let cardID = transaction.cardID else {
                throw FinanceError.validation(
                    "An invoice can only be attached to a card transaction.",
                    entity: "Transaction",
                    entityID: transaction.id
                )
            }
            guard let invoice = state.invoice(id: invoiceID) else {
                throw FinanceError.notFound("Invoice", id: invoiceID)
            }
            guard invoice.cardID == cardID else {
                throw FinanceError.validation(
                    "Invoice does not belong to the transaction card.",
                    entity: "Transaction",
                    entityID: transaction.id
                )
            }
        }
    }

    func applyAccountEffects(
        _ transaction: Transaction,
        reverse: Bool,
        in state: inout FinancialSnapshot,
        now: Date
    ) throws {
        guard transaction.status == .realized,
              transaction.isSilent != true,
              transaction.isSimulated != true else {
            return
        }

        if transaction.type == .transfer {
            guard let sourceID = transaction.accountID,
                  let destinationID = transaction.destinationAccountID else {
                throw FinanceError.validation(
                    "A realized transfer is missing an account.",
                    entity: "Transaction",
                    entityID: transaction.id
                )
            }
            try adjustAccountBalance(sourceID, by: reverse ? transaction.amount : -transaction.amount, in: &state, now: now)
            try adjustAccountBalance(destinationID, by: reverse ? -transaction.amount : transaction.amount, in: &state, now: now)
        } else if let accountID = transaction.accountID {
            let delta: Decimal = transaction.type == .income ? transaction.amount : -transaction.amount
            try adjustAccountBalance(accountID, by: reverse ? -delta : delta, in: &state, now: now)
        }
    }

    func adjustAccountBalance(
        _ accountID: String,
        by delta: Decimal,
        in state: inout FinancialSnapshot,
        now: Date
    ) throws {
        guard let index = state.accounts.firstIndex(where: { $0.id == accountID }) else {
            throw FinanceError.notFound("Account", id: accountID)
        }
        var account = state.accounts[index]
        account.initialBalance = Money.roundCurrency(account.initialBalance + delta)
        account.updated = now
        state.accounts[index] = account
    }

    func appendSkippedPeriods(
        _ periods: Set<String>,
        recurrenceID: String,
        in state: inout FinancialSnapshot,
        now: Date
    ) throws {
        guard let index = state.recurrences.firstIndex(where: { $0.id == recurrenceID }) else {
            throw FinanceError.notFound("Recurrence", id: recurrenceID)
        }
        var recurrence = state.recurrences[index]
        var current = Set(recurrence.skippedPeriods ?? [])
        current.formUnion(periods)
        recurrence.skippedPeriods = nilIfEmpty(current.sorted())
        recurrence.updated = now
        state.recurrences[index] = recurrence
    }
}
