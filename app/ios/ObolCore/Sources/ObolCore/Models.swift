import Foundation

// MARK: - Enumerations

public enum AccountType: String, Codable, CaseIterable, Sendable {
    case checking
    case savings
    case investment
}

public enum CategoryType: String, Codable, CaseIterable, Sendable {
    case fixedBudget = "fixed_budget"
    case variable
}

public enum InvoiceStatus: String, Codable, CaseIterable, Sendable {
    case open = "OPEN"
    case closed = "CLOSED"
    case paid = "PAID"
}

public enum ProjectStatus: String, Codable, CaseIterable, Sendable {
    case active
    case completed
}

public enum RecurrenceType: String, Codable, CaseIterable, Sendable {
    case income
    case expense
}

public enum RecurrenceStatus: String, Codable, CaseIterable, Sendable {
    case active
    case paused
    case ended
}

/// Recurrence cadence. A recurrence without a stored frequency is monthly.
public enum RecurrenceFrequency: String, Codable, CaseIterable, Sendable {
    case monthly
    case weekly
}

public enum TransactionType: String, Codable, CaseIterable, Sendable {
    case income
    case expense
    case transfer
}

public enum TransactionStatus: String, Codable, CaseIterable, Sendable {
    case pending
    case realized
}

// MARK: - Canonical records

public struct Account: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var type: AccountType
    public var initialBalance: Decimal
    public var created: Date?
    public var updated: Date?

    public init(
        id: String = EntityID.generate(),
        name: String,
        type: AccountType,
        initialBalance: Decimal,
        created: Date? = nil,
        updated: Date? = nil
    ) {
        self.id = id
        self.name = name
        self.type = type
        self.initialBalance = initialBalance
        self.created = created
        self.updated = updated
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case name
        case type
        case initialBalance = "initial_balance"
        case created
        case updated
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        type = try container.decode(AccountType.self, forKey: .type)
        initialBalance = try container.decode(Decimal.self, forKey: .initialBalance)
        created = try ObolCoding.optionalDate(container, .created)
        updated = try ObolCoding.optionalDate(container, .updated)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(type, forKey: .type)
        try container.encode(initialBalance, forKey: .initialBalance)
        try ObolCoding.encodeDateIfPresent(created, &container, .created)
        try ObolCoding.encodeDateIfPresent(updated, &container, .updated)
    }
}

public struct Card: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var closingDay: Int
    public var dueDay: Int
    public var limit: Decimal
    public var created: Date?
    public var updated: Date?

    public init(
        id: String = EntityID.generate(),
        name: String,
        closingDay: Int,
        dueDay: Int,
        limit: Decimal,
        created: Date? = nil,
        updated: Date? = nil
    ) {
        self.id = id
        self.name = name
        self.closingDay = closingDay
        self.dueDay = dueDay
        self.limit = limit
        self.created = created
        self.updated = updated
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case name
        case closingDay = "closing_day"
        case dueDay = "due_day"
        case limit
        case created
        case updated
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        closingDay = try container.decode(Int.self, forKey: .closingDay)
        dueDay = try container.decode(Int.self, forKey: .dueDay)
        limit = try container.decode(Decimal.self, forKey: .limit)
        created = try ObolCoding.optionalDate(container, .created)
        updated = try ObolCoding.optionalDate(container, .updated)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(closingDay, forKey: .closingDay)
        try container.encode(dueDay, forKey: .dueDay)
        try container.encode(limit, forKey: .limit)
        try ObolCoding.encodeDateIfPresent(created, &container, .created)
        try ObolCoding.encodeDateIfPresent(updated, &container, .updated)
    }
}

public struct Category: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var type: CategoryType
    public var monthlyBudget: Decimal?
    public var created: Date?
    public var updated: Date?

    public init(
        id: String = EntityID.generate(),
        name: String,
        type: CategoryType,
        monthlyBudget: Decimal? = nil,
        created: Date? = nil,
        updated: Date? = nil
    ) {
        self.id = id
        self.name = name
        self.type = type
        self.monthlyBudget = monthlyBudget
        self.created = created
        self.updated = updated
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case name
        case type
        case monthlyBudget = "monthly_budget"
        case created
        case updated
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        type = try container.decode(CategoryType.self, forKey: .type)
        monthlyBudget = try container.decodeIfPresent(Decimal.self, forKey: .monthlyBudget)
        created = try ObolCoding.optionalDate(container, .created)
        updated = try ObolCoding.optionalDate(container, .updated)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(type, forKey: .type)
        try container.encodeIfPresent(monthlyBudget, forKey: .monthlyBudget)
        try ObolCoding.encodeDateIfPresent(created, &container, .created)
        try ObolCoding.encodeDateIfPresent(updated, &container, .updated)
    }
}

public struct Invoice: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var cardID: String
    public var period: String
    public var dueDate: Date
    public var status: InvoiceStatus
    public var totalAmount: Decimal
    public var paidAmount: Decimal?
    public var created: Date?
    public var updated: Date?

    public init(
        id: String = EntityID.generate(),
        cardID: String,
        period: String,
        dueDate: Date,
        status: InvoiceStatus,
        totalAmount: Decimal,
        paidAmount: Decimal? = nil,
        created: Date? = nil,
        updated: Date? = nil
    ) {
        self.id = id
        self.cardID = cardID
        self.period = period
        self.dueDate = dueDate
        self.status = status
        self.totalAmount = totalAmount
        self.paidAmount = paidAmount
        self.created = created
        self.updated = updated
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case cardID = "card_id"
        case period
        case dueDate = "due_date"
        case status
        case totalAmount = "total_amount"
        case paidAmount = "paid_amount"
        case created
        case updated
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        cardID = try container.decode(String.self, forKey: .cardID)
        period = try container.decode(String.self, forKey: .period)
        dueDate = try ObolCoding.date(container, .dueDate)
        status = try container.decode(InvoiceStatus.self, forKey: .status)
        totalAmount = try container.decode(Decimal.self, forKey: .totalAmount)
        paidAmount = try container.decodeIfPresent(Decimal.self, forKey: .paidAmount)
        created = try ObolCoding.optionalDate(container, .created)
        updated = try ObolCoding.optionalDate(container, .updated)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(cardID, forKey: .cardID)
        try container.encode(period, forKey: .period)
        try ObolCoding.encodeDate(dueDate, &container, .dueDate)
        try container.encode(status, forKey: .status)
        try container.encode(totalAmount, forKey: .totalAmount)
        try container.encodeIfPresent(paidAmount, forKey: .paidAmount)
        try ObolCoding.encodeDateIfPresent(created, &container, .created)
        try ObolCoding.encodeDateIfPresent(updated, &container, .updated)
    }
}

public struct Project: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var totalValue: Decimal
    public var status: ProjectStatus
    public var created: Date?
    public var updated: Date?

    public init(
        id: String = EntityID.generate(),
        name: String,
        totalValue: Decimal,
        status: ProjectStatus = .active,
        created: Date? = nil,
        updated: Date? = nil
    ) {
        self.id = id
        self.name = name
        self.totalValue = totalValue
        self.status = status
        self.created = created
        self.updated = updated
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case name
        case totalValue = "total_value"
        case status
        case created
        case updated
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        totalValue = try container.decode(Decimal.self, forKey: .totalValue)
        status = try container.decode(ProjectStatus.self, forKey: .status)
        created = try ObolCoding.optionalDate(container, .created)
        updated = try ObolCoding.optionalDate(container, .updated)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(totalValue, forKey: .totalValue)
        try container.encode(status, forKey: .status)
        try ObolCoding.encodeDateIfPresent(created, &container, .created)
        try ObolCoding.encodeDateIfPresent(updated, &container, .updated)
    }
}

public struct Recurrence: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var amount: Decimal
    public var payday: Int
    public var type: RecurrenceType
    public var status: RecurrenceStatus
    public var accountID: String?
    public var cardID: String?
    public var categoryID: String?
    public var endDate: Date?
    public var totalInstallments: Int?
    public var skippedPeriods: [String]?
    public var frequency: RecurrenceFrequency?
    public var weekday: Int?
    public var created: Date?
    public var updated: Date?

    /// Absent, empty or unknown stored frequency means monthly.
    public var cadence: RecurrenceFrequency { frequency ?? .monthly }

    public init(
        id: String = EntityID.generate(),
        name: String,
        amount: Decimal,
        payday: Int,
        type: RecurrenceType,
        status: RecurrenceStatus = .active,
        accountID: String? = nil,
        cardID: String? = nil,
        categoryID: String? = nil,
        endDate: Date? = nil,
        totalInstallments: Int? = nil,
        skippedPeriods: [String]? = nil,
        frequency: RecurrenceFrequency? = nil,
        weekday: Int? = nil,
        created: Date? = nil,
        updated: Date? = nil
    ) {
        self.id = id
        self.name = name
        self.amount = amount
        self.payday = payday
        self.type = type
        self.status = status
        self.accountID = accountID
        self.cardID = cardID
        self.categoryID = categoryID
        self.endDate = endDate
        self.totalInstallments = totalInstallments
        self.skippedPeriods = skippedPeriods
        self.frequency = frequency
        self.weekday = weekday
        self.created = created
        self.updated = updated
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case name
        case amount
        case payday
        case type
        case status
        case accountID = "account_id"
        case cardID = "card_id"
        case categoryID = "category_id"
        case endDate = "end_date"
        case totalInstallments = "total_installments"
        case skippedPeriods = "skipped_periods"
        case frequency
        case weekday
        case created
        case updated
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        amount = try container.decode(Decimal.self, forKey: .amount)
        payday = try container.decode(Int.self, forKey: .payday)
        type = try container.decode(RecurrenceType.self, forKey: .type)
        status = try container.decode(RecurrenceStatus.self, forKey: .status)
        accountID = try ObolCoding.optionalIdentifier(container, .accountID)
        cardID = try ObolCoding.optionalIdentifier(container, .cardID)
        categoryID = try ObolCoding.optionalIdentifier(container, .categoryID)
        endDate = try ObolCoding.optionalDate(container, .endDate)
        totalInstallments = try ObolCoding.optionalInstallments(container, .totalInstallments)
        skippedPeriods = try container.decodeIfPresent([String].self, forKey: .skippedPeriods)
        frequency = try ObolCoding.optionalFrequency(container, .frequency)
        weekday = try ObolCoding.optionalWeekday(container, .weekday)
        created = try ObolCoding.optionalDate(container, .created)
        updated = try ObolCoding.optionalDate(container, .updated)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(amount, forKey: .amount)
        try container.encode(payday, forKey: .payday)
        try container.encode(type, forKey: .type)
        try container.encode(status, forKey: .status)
        try container.encodeIfPresent(accountID, forKey: .accountID)
        try container.encodeIfPresent(cardID, forKey: .cardID)
        try container.encodeIfPresent(categoryID, forKey: .categoryID)
        try ObolCoding.encodeDateIfPresent(endDate, &container, .endDate)
        try container.encodeIfPresent(totalInstallments, forKey: .totalInstallments)
        try container.encodeIfPresent(skippedPeriods, forKey: .skippedPeriods)
        try container.encodeIfPresent(frequency, forKey: .frequency)
        try container.encodeIfPresent(weekday, forKey: .weekday)
        try ObolCoding.encodeDateIfPresent(created, &container, .created)
        try ObolCoding.encodeDateIfPresent(updated, &container, .updated)
    }
}

public struct Transaction: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var amount: Decimal
    public var type: TransactionType
    public var status: TransactionStatus
    public var expectedDate: Date
    public var realizedDate: Date?
    public var purchaseDate: Date?
    public var isRecurring: Bool?
    public var isSilent: Bool?
    public var isSimulated: Bool?
    public var isScheduled: Bool?
    public var accountID: String?
    public var cardID: String?
    public var categoryID: String?
    public var projectID: String?
    public var invoiceID: String?
    public var recurrenceID: String?
    public var destinationAccountID: String?
    public var created: Date?
    public var updated: Date?

    public init(
        id: String = EntityID.generate(),
        title: String,
        amount: Decimal,
        type: TransactionType,
        status: TransactionStatus,
        expectedDate: Date,
        realizedDate: Date? = nil,
        purchaseDate: Date? = nil,
        isRecurring: Bool? = nil,
        isSilent: Bool? = nil,
        isSimulated: Bool? = nil,
        isScheduled: Bool? = nil,
        accountID: String? = nil,
        cardID: String? = nil,
        categoryID: String? = nil,
        projectID: String? = nil,
        invoiceID: String? = nil,
        recurrenceID: String? = nil,
        destinationAccountID: String? = nil,
        created: Date? = nil,
        updated: Date? = nil
    ) {
        self.id = id
        self.title = title
        self.amount = amount
        self.type = type
        self.status = status
        self.expectedDate = expectedDate
        self.realizedDate = realizedDate
        self.purchaseDate = purchaseDate
        self.isRecurring = isRecurring
        self.isSilent = isSilent
        self.isSimulated = isSimulated
        self.isScheduled = isScheduled
        self.accountID = accountID
        self.cardID = cardID
        self.categoryID = categoryID
        self.projectID = projectID
        self.invoiceID = invoiceID
        self.recurrenceID = recurrenceID
        self.destinationAccountID = destinationAccountID
        self.created = created
        self.updated = updated
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case title
        case amount
        case type
        case status
        case expectedDate = "expected_date"
        case realizedDate = "realized_date"
        case purchaseDate = "purchase_date"
        case isRecurring = "is_recurring"
        case isSilent = "is_silent"
        case isSimulated = "is_simulated"
        case isScheduled = "is_scheduled"
        case accountID = "account_id"
        case cardID = "card_id"
        case categoryID = "category_id"
        case projectID = "project_id"
        case invoiceID = "invoice_id"
        case recurrenceID = "recurrence_id"
        case destinationAccountID = "destination_account_id"
        case created
        case updated
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        amount = try container.decode(Decimal.self, forKey: .amount)
        type = try container.decode(TransactionType.self, forKey: .type)
        status = try container.decode(TransactionStatus.self, forKey: .status)
        expectedDate = try ObolCoding.date(container, .expectedDate)
        realizedDate = try ObolCoding.optionalDate(container, .realizedDate)
        purchaseDate = try ObolCoding.optionalDate(container, .purchaseDate)
        isRecurring = try container.decodeIfPresent(Bool.self, forKey: .isRecurring)
        isSilent = try container.decodeIfPresent(Bool.self, forKey: .isSilent)
        isSimulated = try container.decodeIfPresent(Bool.self, forKey: .isSimulated)
        isScheduled = try container.decodeIfPresent(Bool.self, forKey: .isScheduled)
        accountID = try ObolCoding.optionalIdentifier(container, .accountID)
        cardID = try ObolCoding.optionalIdentifier(container, .cardID)
        categoryID = try ObolCoding.optionalIdentifier(container, .categoryID)
        projectID = try ObolCoding.optionalIdentifier(container, .projectID)
        invoiceID = try ObolCoding.optionalIdentifier(container, .invoiceID)
        recurrenceID = try ObolCoding.optionalIdentifier(container, .recurrenceID)
        destinationAccountID = try ObolCoding.optionalIdentifier(container, .destinationAccountID)
        created = try ObolCoding.optionalDate(container, .created)
        updated = try ObolCoding.optionalDate(container, .updated)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(title, forKey: .title)
        try container.encode(amount, forKey: .amount)
        try container.encode(type, forKey: .type)
        try container.encode(status, forKey: .status)
        try ObolCoding.encodeDate(expectedDate, &container, .expectedDate)
        try ObolCoding.encodeDateIfPresent(realizedDate, &container, .realizedDate)
        try ObolCoding.encodeDateIfPresent(purchaseDate, &container, .purchaseDate)
        try container.encodeIfPresent(isRecurring, forKey: .isRecurring)
        try container.encodeIfPresent(isSilent, forKey: .isSilent)
        try container.encodeIfPresent(isSimulated, forKey: .isSimulated)
        try container.encodeIfPresent(isScheduled, forKey: .isScheduled)
        try container.encodeIfPresent(accountID, forKey: .accountID)
        try container.encodeIfPresent(cardID, forKey: .cardID)
        try container.encodeIfPresent(categoryID, forKey: .categoryID)
        try container.encodeIfPresent(projectID, forKey: .projectID)
        try container.encodeIfPresent(invoiceID, forKey: .invoiceID)
        try container.encodeIfPresent(recurrenceID, forKey: .recurrenceID)
        try container.encodeIfPresent(destinationAccountID, forKey: .destinationAccountID)
        try ObolCoding.encodeDateIfPresent(created, &container, .created)
        try ObolCoding.encodeDateIfPresent(updated, &container, .updated)
    }
}

// MARK: - Snapshot

public struct FinancialSnapshot: Codable, Equatable, Sendable {
    public var accounts: [Account]
    public var cards: [Card]
    public var categories: [Category]
    public var invoices: [Invoice]
    public var projects: [Project]
    public var recurrences: [Recurrence]
    public var transactions: [Transaction]

    public init(
        accounts: [Account] = [],
        cards: [Card] = [],
        categories: [Category] = [],
        invoices: [Invoice] = [],
        projects: [Project] = [],
        recurrences: [Recurrence] = [],
        transactions: [Transaction] = []
    ) {
        self.accounts = accounts
        self.cards = cards
        self.categories = categories
        self.invoices = invoices
        self.projects = projects
        self.recurrences = recurrences
        self.transactions = transactions
    }

    public static let empty = FinancialSnapshot()

    public func account(id: String) -> Account? { accounts.first { $0.id == id } }
    public func card(id: String) -> Card? { cards.first { $0.id == id } }
    public func category(id: String) -> Category? { categories.first { $0.id == id } }
    public func invoice(id: String) -> Invoice? { invoices.first { $0.id == id } }
    public func project(id: String) -> Project? { projects.first { $0.id == id } }
    public func recurrence(id: String) -> Recurrence? { recurrences.first { $0.id == id } }
    public func transaction(id: String) -> Transaction? { transactions.first { $0.id == id } }

    public func invoice(cardID: String, period: String) -> Invoice? {
        invoices.first { $0.cardID == cardID && $0.period == period }
    }
}

// MARK: - Command payloads

public enum PatchField<Value: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
    case unchanged
    case set(Value)
    case clear

    public func resolve(_ current: Value?) -> Value? {
        switch self {
        case .unchanged:
            return current
        case .set(let value):
            return value
        case .clear:
            return nil
        }
    }

    public var isChanged: Bool {
        switch self {
        case .unchanged:
            return false
        case .set, .clear:
            return true
        }
    }
}

public struct AccountPatch: Codable, Equatable, Sendable {
    public var name: String?
    public var type: AccountType?
    public var initialBalance: Decimal?

    public init(name: String? = nil, type: AccountType? = nil, initialBalance: Decimal? = nil) {
        self.name = name
        self.type = type
        self.initialBalance = initialBalance
    }
}

public struct CardPatch: Codable, Equatable, Sendable {
    public var name: String?
    public var closingDay: Int?
    public var dueDay: Int?
    public var limit: Decimal?

    public init(name: String? = nil, closingDay: Int? = nil, dueDay: Int? = nil, limit: Decimal? = nil) {
        self.name = name
        self.closingDay = closingDay
        self.dueDay = dueDay
        self.limit = limit
    }
}

public struct CategoryPatch: Codable, Equatable, Sendable {
    public var name: String?
    public var type: CategoryType?
    public var monthlyBudget: Decimal?
    public var clearMonthlyBudget: Bool

    public init(
        name: String? = nil,
        type: CategoryType? = nil,
        monthlyBudget: Decimal? = nil,
        clearMonthlyBudget: Bool = false
    ) {
        self.name = name
        self.type = type
        self.monthlyBudget = monthlyBudget
        self.clearMonthlyBudget = clearMonthlyBudget
    }
}

public struct ProjectPatch: Codable, Equatable, Sendable {
    public var name: String?
    public var totalValue: Decimal?
    public var status: ProjectStatus?

    public init(name: String? = nil, totalValue: Decimal? = nil, status: ProjectStatus? = nil) {
        self.name = name
        self.totalValue = totalValue
        self.status = status
    }
}

public struct RecurrencePatch: Codable, Equatable, Sendable {
    public var name: String?
    public var amount: Decimal?
    public var payday: Int?
    public var type: RecurrenceType?
    public var status: RecurrenceStatus?
    public var accountID: PatchField<String>?
    public var cardID: PatchField<String>?
    public var categoryID: PatchField<String>?
    public var endDate: PatchField<Date>?
    public var totalInstallments: PatchField<Int>?
    public var skippedPeriods: [String]?
    public var frequency: PatchField<RecurrenceFrequency>?
    public var weekday: PatchField<Int>?

    public init(
        name: String? = nil,
        amount: Decimal? = nil,
        payday: Int? = nil,
        type: RecurrenceType? = nil,
        status: RecurrenceStatus? = nil,
        accountID: PatchField<String>? = nil,
        cardID: PatchField<String>? = nil,
        categoryID: PatchField<String>? = nil,
        endDate: PatchField<Date>? = nil,
        totalInstallments: PatchField<Int>? = nil,
        skippedPeriods: [String]? = nil,
        frequency: PatchField<RecurrenceFrequency>? = nil,
        weekday: PatchField<Int>? = nil
    ) {
        self.name = name
        self.amount = amount
        self.payday = payday
        self.type = type
        self.status = status
        self.accountID = accountID
        self.cardID = cardID
        self.categoryID = categoryID
        self.endDate = endDate
        self.totalInstallments = totalInstallments
        self.skippedPeriods = skippedPeriods
        self.frequency = frequency
        self.weekday = weekday
    }
}

public struct TransactionDraft: Codable, Equatable, Sendable {
    public var id: String?
    public var title: String
    public var amount: Decimal
    public var type: TransactionType
    public var status: TransactionStatus
    public var expectedDate: Date
    public var realizedDate: Date?
    public var purchaseDate: Date?
    public var isRecurring: Bool?
    public var isSilent: Bool?
    public var isSimulated: Bool?
    public var isScheduled: Bool?
    public var accountID: String?
    public var cardID: String?
    public var categoryID: String?
    public var projectID: String?
    public var recurrenceID: String?
    public var destinationAccountID: String?

    public init(
        id: String? = nil,
        title: String,
        amount: Decimal,
        type: TransactionType,
        status: TransactionStatus,
        expectedDate: Date,
        realizedDate: Date? = nil,
        purchaseDate: Date? = nil,
        isRecurring: Bool? = nil,
        isSilent: Bool? = nil,
        isSimulated: Bool? = nil,
        isScheduled: Bool? = nil,
        accountID: String? = nil,
        cardID: String? = nil,
        categoryID: String? = nil,
        projectID: String? = nil,
        recurrenceID: String? = nil,
        destinationAccountID: String? = nil
    ) {
        self.id = id
        self.title = title
        self.amount = amount
        self.type = type
        self.status = status
        self.expectedDate = expectedDate
        self.realizedDate = realizedDate
        self.purchaseDate = purchaseDate
        self.isRecurring = isRecurring
        self.isSilent = isSilent
        self.isSimulated = isSimulated
        self.isScheduled = isScheduled
        self.accountID = accountID
        self.cardID = cardID
        self.categoryID = categoryID
        self.projectID = projectID
        self.recurrenceID = recurrenceID
        self.destinationAccountID = destinationAccountID
    }
}

public struct TransactionPatch: Codable, Equatable, Sendable {
    public var title: String?
    public var amount: Decimal?
    public var type: TransactionType?
    public var status: TransactionStatus?
    public var expectedDate: Date?
    public var realizedDate: PatchField<Date>?
    public var purchaseDate: PatchField<Date>?
    public var isRecurring: Bool?
    public var isSilent: Bool?
    public var isSimulated: Bool?
    public var isScheduled: Bool?
    public var accountID: PatchField<String>?
    public var cardID: PatchField<String>?
    public var categoryID: PatchField<String>?
    public var projectID: PatchField<String>?
    public var recurrenceID: PatchField<String>?
    public var destinationAccountID: PatchField<String>?

    public init(
        title: String? = nil,
        amount: Decimal? = nil,
        type: TransactionType? = nil,
        status: TransactionStatus? = nil,
        expectedDate: Date? = nil,
        realizedDate: PatchField<Date>? = nil,
        purchaseDate: PatchField<Date>? = nil,
        isRecurring: Bool? = nil,
        isSilent: Bool? = nil,
        isSimulated: Bool? = nil,
        isScheduled: Bool? = nil,
        accountID: PatchField<String>? = nil,
        cardID: PatchField<String>? = nil,
        categoryID: PatchField<String>? = nil,
        projectID: PatchField<String>? = nil,
        recurrenceID: PatchField<String>? = nil,
        destinationAccountID: PatchField<String>? = nil
    ) {
        self.title = title
        self.amount = amount
        self.type = type
        self.status = status
        self.expectedDate = expectedDate
        self.realizedDate = realizedDate
        self.purchaseDate = purchaseDate
        self.isRecurring = isRecurring
        self.isSilent = isSilent
        self.isSimulated = isSimulated
        self.isScheduled = isScheduled
        self.accountID = accountID
        self.cardID = cardID
        self.categoryID = categoryID
        self.projectID = projectID
        self.recurrenceID = recurrenceID
        self.destinationAccountID = destinationAccountID
    }
}

public enum FinancialCommand: Equatable, Sendable {
    case createAccount(Account)
    case updateAccount(id: String, patch: AccountPatch)
    case deleteAccount(id: String)

    case createCard(Card)
    case updateCard(id: String, patch: CardPatch)
    case deleteCard(id: String)

    case createCategory(Category)
    case updateCategory(id: String, patch: CategoryPatch)
    case deleteCategory(id: String)

    case createProject(Project)
    case updateProject(id: String, patch: ProjectPatch)
    case completeProject(id: String)
    case deleteProject(id: String)
    case registerProjectPayment(projectID: String, amount: Decimal, description: String?)

    case createRecurrence(Recurrence)
    case updateRecurrence(id: String, patch: RecurrencePatch)
    case setRecurrenceStatus(id: String, status: RecurrenceStatus)
    case deleteRecurrence(id: String)
    case launchRecurrence(id: String)
    case processMonthlyRecurrences

    case createTransaction(TransactionDraft)
    case updateTransaction(id: String, patch: TransactionPatch)
    case realizeTransaction(id: String, updateBalance: Bool)
    case deleteTransaction(id: String)
    case convertSimulation(id: String, toSimulated: Bool)

    case payInvoice(cardID: String, period: String, accountID: String?, amount: Decimal?, ignoreBalance: Bool)
    case deleteInvoice(cardID: String, period: String)
    case reconcileInvoices
}

// MARK: - Errors

public struct FinanceError: Error, Equatable, Sendable, LocalizedError {
    public enum Code: String, Codable, Sendable {
        case validation
        case notFound
        case conflict
        case referenced
        case alreadyRealized
        case alreadyPaid
        case invalidIdentifier
        case invalidState
        case corruptData
        case unsupportedSchema
        case writeFailed
    }

    public let code: Code
    public let message: String
    public let entity: String?
    public let entityID: String?

    public init(code: Code, message: String, entity: String? = nil, entityID: String? = nil) {
        self.code = code
        self.message = message
        self.entity = entity
        self.entityID = entityID
    }

    public var errorDescription: String? { message }

    public static func validation(_ message: String, entity: String? = nil, entityID: String? = nil) -> FinanceError {
        FinanceError(code: .validation, message: message, entity: entity, entityID: entityID)
    }

    public static func notFound(_ entity: String, id: String) -> FinanceError {
        FinanceError(code: .notFound, message: "\(entity) \(id) was not found.", entity: entity, entityID: id)
    }

    public static func conflict(_ message: String, entity: String? = nil, entityID: String? = nil) -> FinanceError {
        FinanceError(code: .conflict, message: message, entity: entity, entityID: entityID)
    }

    public static func invalidState(_ message: String, entity: String? = nil, entityID: String? = nil) -> FinanceError {
        FinanceError(code: .invalidState, message: message, entity: entity, entityID: entityID)
    }

    public static func referenced(_ entity: String, id: String, by: String) -> FinanceError {
        FinanceError(
            code: .referenced,
            message: "\(entity) \(id) is referenced by \(by) and cannot be deleted.",
            entity: entity,
            entityID: id
        )
    }

    public static func invalidIdentifier(_ entity: String, id: String) -> FinanceError {
        FinanceError(
            code: .invalidIdentifier,
            message: "\(entity) id '\(id)' is not a 15-character lowercase alphanumeric PocketBase id.",
            entity: entity,
            entityID: id
        )
    }
}

// MARK: - Identifier, money, and UTC date primitives

public enum EntityID {
    public static let length = 15

    private static let alphabet = Array("0123456789abcdefghijklmnopqrstuvwxyz")

    /// Time-ordered 15-character lowercase alphanumeric id derived from the UUIDv7
    /// millisecond timestamp plus cryptographic randomness.
    public static func generate(at date: Date = Date()) -> String {
        let milliseconds = UInt64(max(0, date.timeIntervalSince1970 * 1000))
        var timePart = String(milliseconds, radix: 36)
        if timePart.count > 9 {
            timePart = String(timePart.suffix(9))
        } else if timePart.count < 9 {
            timePart = String(repeating: "0", count: 9 - timePart.count) + timePart
        }

        var random = SystemRandomNumberGenerator()
        var suffix = ""
        suffix.reserveCapacity(6)
        for _ in 0..<6 {
            let index = Int.random(in: 0..<alphabet.count, using: &random)
            suffix.append(alphabet[index])
        }
        return timePart + suffix
    }

    public static func isValid(_ id: String) -> Bool {
        guard id.count == length else { return false }
        return id.unicodeScalars.allSatisfy { scalar in
            (scalar.value >= 48 && scalar.value <= 57) || (scalar.value >= 97 && scalar.value <= 122)
        }
    }
}

public enum Money {
    public static let cent = Decimal(1) / 100

    /// JavaScript `Math.round(value * 100) / 100` semantics for exact decimal
    /// halves: round toward positive infinity on a tie, then divide by 100.
    public static func roundCurrency(_ value: Decimal) -> Decimal {
        var scaled = value * 100
        scaled += Decimal(0.5)
        var rounded = Decimal()
        NSDecimalRound(&rounded, &scaled, 0, .down)
        return rounded / 100
    }

    public static func sum(_ a: Decimal, _ b: Decimal) -> Decimal {
        roundCurrency(a + b)
    }

    public static func sub(_ a: Decimal, _ b: Decimal) -> Decimal {
        roundCurrency(a - b)
    }

    public static func mul(_ a: Decimal, _ b: Decimal) -> Decimal {
        roundCurrency(a * b)
    }
}

public enum ObolDate {
    public static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        calendar.locale = Locale(identifier: "en_US_POSIX")
        return calendar
    }()

    /// Truncates to millisecond precision so a JSON save/load round trip is exact.
    public static func normalize(_ date: Date) -> Date {
        let milliseconds = (date.timeIntervalSince1970 * 1000).rounded(.down)
        return Date(timeIntervalSince1970: milliseconds / 1000)
    }

    public static func startOfDay(_ date: Date) -> Date {
        calendar.startOfDay(for: date)
    }

    public static func dayKey(_ date: Date) -> String {
        let components = calendar.dateComponents([.year, .month, .day], from: date)
        return String(
            format: "%04d-%02d-%02d",
            components.year ?? 1970,
            components.month ?? 1,
            components.day ?? 1
        )
    }

    public static func monthKey(_ date: Date) -> String {
        let components = calendar.dateComponents([.year, .month], from: date)
        return String(
            format: "%04d-%02d",
            components.year ?? 1970,
            components.month ?? 1
        )
    }

    public static func parse(_ string: String) -> Date? {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        var candidate = trimmed
        if candidate.count > 10 {
            let spaceIndex = candidate.index(candidate.startIndex, offsetBy: 10)
            if candidate[spaceIndex] == " " {
                candidate.replaceSubrange(spaceIndex..<candidate.index(after: spaceIndex), with: "T")
            }
        }

        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: candidate) {
            return normalize(date)
        }

        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: candidate) {
            return normalize(date)
        }

        let formats = [
            "yyyy-MM-dd'T'HH:mm:ss.SSSXXXXX",
            "yyyy-MM-dd'T'HH:mm:ssXXXXX",
            "yyyy-MM-dd'T'HH:mm:ss",
            "yyyy-MM-dd HH:mm:ss.SSS",
            "yyyy-MM-dd HH:mm:ss",
            "yyyy-MM-dd"
        ]
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.calendar = Calendar(identifier: .gregorian)
        for format in formats {
            formatter.dateFormat = format
            if let date = formatter.date(from: candidate) {
                return normalize(date)
            }
        }
        return nil
    }

    public static func string(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: normalize(date))
    }

    public static func startOfMonth(_ date: Date) -> Date {
        let components = calendar.dateComponents([.year, .month], from: date)
        return startOfMonth(year: components.year ?? 1970, month: components.month ?? 1)
    }

    public static func startOfMonth(year: Int, month: Int) -> Date {
        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = 1
        return calendar.date(from: components) ?? Date(timeIntervalSince1970: 0)
    }

    public static func lastDayOfMonth(year: Int, month: Int) -> Int {
        let start = startOfMonth(year: year, month: month)
        return calendar.range(of: .day, in: .month, for: start)?.count ?? 30
    }

    public static func clampedDate(year: Int, month: Int, day: Int) -> Date {
        let lastDay = lastDayOfMonth(year: year, month: month)
        let safeDay = max(1, min(day, lastDay))
        let start = startOfMonth(year: year, month: month)
        return calendar.date(byAdding: .day, value: safeDay - 1, to: start) ?? start
    }

    public static func addingMonths(_ months: Int, to date: Date) -> Date {
        let start = startOfMonth(date)
        return calendar.date(byAdding: .month, value: months, to: start) ?? start
    }

    public static func addingDays(_ days: Int, to date: Date) -> Date {
        calendar.date(byAdding: .day, value: days, to: date) ?? date
    }

    /// ISO weekday of a UTC instant: Monday is 1 and Sunday is 7.
    public static func isoWeekday(_ date: Date) -> Int {
        let weekday = calendar.component(.weekday, from: date) // Sunday is 1
        return (weekday + 5) % 7 + 1
    }

    /// UTC midnight of the Monday of the week that contains `date`.
    public static func startOfISOWeek(_ date: Date) -> Date {
        let dayStart = calendar.startOfDay(for: date)
        return calendar.date(byAdding: .day, value: 1 - isoWeekday(dayStart), to: dayStart) ?? dayStart
    }

    /// UTC midnight of `weekday` (1...7, Monday first) inside the ISO week that
    /// contains `date`. Weekly occurrences are exact: no clamping exists.
    public static func isoWeekOccurrence(_ date: Date, weekday: Int) -> Date {
        addingDays(weekday - 1, to: startOfISOWeek(date))
    }

    /// `YYYY-MM-DD` occurrence key of a weekly recurrence.
    public static func weeklyOccurrenceKey(_ date: Date, weekday: Int) -> String {
        dayKey(isoWeekOccurrence(date, weekday: weekday))
    }

    /// Mirrors `calculateCardDueDate` from the server: a purchase on or after the
    /// closing day goes to the next invoice, and a due day before the closing day
    /// also advances one month. Day overflow rolls into the following month.
    public static func calculateCardDueDate(purchaseDate: Date, closingDay: Int, dueDay: Int) -> Date {
        let purchaseDay = calendar.component(.day, from: purchaseDate)
        var monthOffset = 0
        if purchaseDay >= closingDay { monthOffset += 1 }
        if dueDay < closingDay { monthOffset += 1 }

        let year = calendar.component(.year, from: purchaseDate)
        let month = calendar.component(.month, from: purchaseDate)
        let base = startOfMonth(year: year, month: month)
        let dueMonth = calendar.date(byAdding: .month, value: monthOffset, to: base) ?? base
        return calendar.date(byAdding: .day, value: dueDay - 1, to: dueMonth) ?? dueMonth
    }

    public static func closingDate(dueDate: Date, closingDay: Int, dueDay: Int) -> Date {
        let year = calendar.component(.year, from: dueDate)
        let month = calendar.component(.month, from: dueDate)
        var closingMonth = startOfMonth(year: year, month: month)
        if closingDay > dueDay {
            closingMonth = calendar.date(byAdding: .month, value: -1, to: closingMonth) ?? closingMonth
        }
        let dayStart = calendar.date(byAdding: .day, value: closingDay - 1, to: closingMonth) ?? closingMonth
        return calendar.date(byAdding: .second, value: 86_399, to: dayStart) ?? dayStart
    }

    public static func invoicePeriod(dueDate: Date) -> String {
        monthKey(dueDate)
    }
}

// MARK: - Coding helpers

private enum ObolCoding {
    static func date<K: CodingKey>(_ container: KeyedDecodingContainer<K>, _ key: K) throws -> Date {
        let string = try container.decode(String.self, forKey: key)
        guard let date = ObolDate.parse(string) else {
            throw DecodingError.dataCorruptedError(
                forKey: key,
                in: container,
                debugDescription: "Invalid ISO-8601 date: \(string)"
            )
        }
        return date
    }

    /// PocketBase serializes an unset optional date as exactly `""`; only that value normalizes to nil.
    /// Anything else stays strict: whitespace-only or nonempty malformed strings throw, and so do
    /// required dates (`date`).
    static func optionalDate<K: CodingKey>(_ container: KeyedDecodingContainer<K>, _ key: K) throws -> Date? {
        guard let string = try container.decodeIfPresent(String.self, forKey: key) else {
            return nil
        }
        if string.isEmpty {
            return nil
        }
        guard let date = ObolDate.parse(string) else {
            throw DecodingError.dataCorruptedError(
                forKey: key,
                in: container,
                debugDescription: "Invalid ISO-8601 date: \(string)"
            )
        }
        return date
    }

    /// PocketBase serializes an unset optional relation as `""`.
    static func optionalIdentifier<K: CodingKey>(
        _ container: KeyedDecodingContainer<K>,
        _ key: K
    ) throws -> String? {
        guard let value = try container.decodeIfPresent(String.self, forKey: key) else {
            return nil
        }
        return value.isEmpty ? nil : value
    }

    /// PocketBase stores an unlimited recurrence as `0`; other values reach validation unchanged.
    static func optionalInstallments<K: CodingKey>(
        _ container: KeyedDecodingContainer<K>,
        _ key: K
    ) throws -> Int? {
        guard let value = try container.decodeIfPresent(Int.self, forKey: key) else {
            return nil
        }
        return value == 0 ? nil : value
    }

    /// An absent, empty or unknown stored cadence reads as monthly, so the
    /// caller never has to decide what an unrecognized value means.
    static func optionalFrequency<K: CodingKey>(
        _ container: KeyedDecodingContainer<K>,
        _ key: K
    ) throws -> RecurrenceFrequency? {
        guard let raw = try container.decodeIfPresent(String.self, forKey: key) else {
            return nil
        }
        return RecurrenceFrequency(rawValue: raw)
    }

    /// `0` is the stored blank weekday; other values reach validation unchanged.
    static func optionalWeekday<K: CodingKey>(
        _ container: KeyedDecodingContainer<K>,
        _ key: K
    ) throws -> Int? {
        guard let value = try container.decodeIfPresent(Int.self, forKey: key) else {
            return nil
        }
        return value == 0 ? nil : value
    }

    static func encodeDate<K: CodingKey>(
        _ date: Date,
        _ container: inout KeyedEncodingContainer<K>,
        _ key: K
    ) throws {
        try container.encode(ObolDate.string(date), forKey: key)
    }

    static func encodeDateIfPresent<K: CodingKey>(
        _ date: Date?,
        _ container: inout KeyedEncodingContainer<K>,
        _ key: K
    ) throws {
        guard let date else { return }
        try container.encode(ObolDate.string(date), forKey: key)
    }
}
