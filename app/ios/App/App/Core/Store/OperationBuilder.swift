import Foundation
import ObolCore

// MARK: - Planning values

public struct OperationPlanningContext: Sendable {
    public let stationId: String
    public let protocolVersion: Int
    public let clientCreatedAt: Date
    public let effectiveAt: Date
    /// Last observed server revision per entity. Only positive revisions are
    /// used; `0` means the entity was created locally and never accepted.
    public let observedServerRevisions: [EntityKey: Int]
    /// Unaccepted operations already targeting or writing each entity.
    public let pendingOperationIdsByEntity: [EntityKey: [String]]

    public init(
        stationId: String,
        protocolVersion: Int,
        clientCreatedAt: Date,
        effectiveAt: Date,
        observedServerRevisions: [EntityKey: Int],
        pendingOperationIdsByEntity: [EntityKey: [String]]
    ) {
        self.stationId = stationId
        self.protocolVersion = protocolVersion
        self.clientCreatedAt = clientCreatedAt
        self.effectiveAt = effectiveAt
        self.observedServerRevisions = observedServerRevisions
        self.pendingOperationIdsByEntity = pendingOperationIdsByEntity
    }
}

public struct PlannedOperation: Equatable, Sendable {
    public let opId: String
    public let type: OperationType
    public let entityType: EntityType
    public let entityId: String
    public let payload: JSONValue
    public let baseRevisions: [String: Int]
    public let dependsOn: [String]
    public let writeSet: [EntityKey]
    public let changedEntities: [EntityKey]
    public let beforeSnapshots: [EntitySnapshot]

    public init(
        opId: String,
        type: OperationType,
        entityType: EntityType,
        entityId: String,
        payload: JSONValue,
        baseRevisions: [String: Int],
        dependsOn: [String],
        writeSet: [EntityKey],
        changedEntities: [EntityKey],
        beforeSnapshots: [EntitySnapshot]
    ) {
        self.opId = opId
        self.type = type
        self.entityType = entityType
        self.entityId = entityId
        self.payload = payload
        self.baseRevisions = baseRevisions
        self.dependsOn = dependsOn
        self.writeSet = writeSet
        self.changedEntities = changedEntities
        self.beforeSnapshots = beforeSnapshots
    }
}

// MARK: - Builder

/// Maps a local `FinancialCommand` plus its before/after snapshots to immutable
/// server operations. The builder never predicts a server revision and never
/// invents an operation type outside the D016 allow-list.
public enum OperationBuilder {
    public static let supportedOperationTypes = OperationType.allCases

    public static func supports(_ command: FinancialCommand) -> Bool {
        switch command {
        case .updateAccount, .deleteAccount,
             .deleteCard,
             .updateCategory, .deleteCategory,
             .updateProject, .deleteProject,
             .reconcileInvoices:
            return false
        default:
            return true
        }
    }

    public static func name(of command: FinancialCommand) -> String {
        switch command {
        case .createAccount: return "createAccount"
        case .updateAccount: return "updateAccount"
        case .deleteAccount: return "deleteAccount"
        case .createCard: return "createCard"
        case .updateCard: return "updateCard"
        case .deleteCard: return "deleteCard"
        case .createCategory: return "createCategory"
        case .updateCategory: return "updateCategory"
        case .deleteCategory: return "deleteCategory"
        case .createProject: return "createProject"
        case .updateProject: return "updateProject"
        case .completeProject: return "completeProject"
        case .deleteProject: return "deleteProject"
        case .registerProjectPayment: return "registerProjectPayment"
        case .createRecurrence: return "createRecurrence"
        case .updateRecurrence: return "updateRecurrence"
        case .setRecurrenceStatus: return "setRecurrenceStatus"
        case .deleteRecurrence: return "deleteRecurrence"
        case .launchRecurrence: return "launchRecurrence"
        case .processMonthlyRecurrences: return "processMonthlyRecurrences"
        case .createTransaction: return "createTransaction"
        case .updateTransaction: return "updateTransaction"
        case .realizeTransaction: return "realizeTransaction"
        case .deleteTransaction: return "deleteTransaction"
        case .convertSimulation: return "convertSimulation"
        case .payInvoice: return "payInvoice"
        case .deleteInvoice: return "deleteInvoice"
        case .reconcileInvoices: return "reconcileInvoices"
        }
    }

    public static func changedEntities(
        before: FinancialSnapshot,
        after: FinancialSnapshot
    ) throws -> [EntityKey] {
        let beforeMap = try snapshotMap(before)
        let afterMap = try snapshotMap(after)
        let keys = Set(beforeMap.keys).union(afterMap.keys)
        return keys
            .filter { beforeMap[$0] != afterMap[$0] }
            .sorted { $0.description < $1.description }
    }

    static func snapshotMap(_ snapshot: FinancialSnapshot) throws -> [EntityKey: JSONValue] {
        var map: [EntityKey: JSONValue] = [:]
        map.reserveCapacity(
            snapshot.accounts.count + snapshot.cards.count + snapshot.categories.count
                + snapshot.invoices.count + snapshot.projects.count
                + snapshot.recurrences.count + snapshot.transactions.count
        )
        for account in snapshot.accounts {
            map[EntityKey(entityType: .account, entityId: account.id)] = try ObolRecordCodec.jsonValue(account)
        }
        for card in snapshot.cards {
            map[EntityKey(entityType: .card, entityId: card.id)] = try ObolRecordCodec.jsonValue(card)
        }
        for category in snapshot.categories {
            map[EntityKey(entityType: .category, entityId: category.id)] = try ObolRecordCodec.jsonValue(category)
        }
        for invoice in snapshot.invoices {
            map[EntityKey(entityType: .invoice, entityId: invoice.id)] = try ObolRecordCodec.jsonValue(invoice)
        }
        for project in snapshot.projects {
            map[EntityKey(entityType: .project, entityId: project.id)] = try ObolRecordCodec.jsonValue(project)
        }
        for recurrence in snapshot.recurrences {
            map[EntityKey(entityType: .recurrence, entityId: recurrence.id)] = try ObolRecordCodec.jsonValue(recurrence)
        }
        for transaction in snapshot.transactions {
            map[EntityKey(entityType: .transaction, entityId: transaction.id)] = try ObolRecordCodec.jsonValue(transaction)
        }
        return map
    }

    public static func plan(
        command: FinancialCommand,
        before: FinancialSnapshot,
        after: FinancialSnapshot,
        context: OperationPlanningContext
    ) throws -> [PlannedOperation] {
        guard supports(command) else {
            throw StoreError.unsupportedCommand(name(of: command))
        }
        if case .processMonthlyRecurrences = command {
            return try planAutomaticRecurrences(before: before, after: after, context: context)
        }
        return try planSingleCommand(command, before: before, after: after, context: context)
    }
}

// MARK: - Single-command planning

private extension OperationBuilder {
    static func planSingleCommand(
        _ command: FinancialCommand,
        before: FinancialSnapshot,
        after: FinancialSnapshot,
        context: OperationPlanningContext
    ) throws -> [PlannedOperation] {
        let beforeMap = try snapshotMap(before)
        let changed = try changedEntities(before: before, after: after)
        guard !changed.isEmpty else { return [] }

        switch command {
        case .createAccount(let account):
            guard let record = after.account(id: account.id) else {
                throw StoreError.noOperationMapping("createAccount")
            }
            return [
                try makePlanned(
                    type: .accountCreate,
                    entityId: record.id,
                    payload: accountPayload(record),
                    beforeKeys: changed,
                    changeKeys: changed,
                    writeCandidateKeys: changed,
                    context: context,
                    beforeMap: beforeMap,
                    prior: [],
                    excludeInvoiceBaseRevisions: false
                )
            ]

        case .updateAccount, .deleteAccount,
             .deleteCard,
             .updateCategory, .deleteCategory,
             .updateProject, .deleteProject:
            throw StoreError.unsupportedCommand(name(of: command))

        case .createCard(let card):
            guard let record = after.card(id: card.id) else {
                throw StoreError.noOperationMapping("createCard")
            }
            return [
                try makePlanned(
                    type: .cardCreate,
                    entityId: record.id,
                    payload: cardPayload(record),
                    beforeKeys: changed,
                    changeKeys: changed,
                    writeCandidateKeys: changed,
                    context: context,
                    beforeMap: beforeMap,
                    prior: [],
                    excludeInvoiceBaseRevisions: false
                )
            ]

        case .updateCard(let id, let patch):
            guard after.card(id: id) != nil else {
                throw StoreError.noOperationMapping("updateCard")
            }
            let payload = try cardUpdatePayload(patch)
            return [
                try makePlanned(
                    type: .cardUpdate,
                    entityId: id,
                    payload: payload,
                    beforeKeys: changed,
                    changeKeys: changed,
                    writeCandidateKeys: changed + [EntityKey(entityType: .card, entityId: id)],
                    context: context,
                    beforeMap: beforeMap,
                    prior: [],
                    excludeInvoiceBaseRevisions: false
                )
            ]

        case .createCategory(let category):
            guard let record = after.category(id: category.id) else {
                throw StoreError.noOperationMapping("createCategory")
            }
            return [
                try makePlanned(
                    type: .categoryCreate,
                    entityId: record.id,
                    payload: categoryPayload(record),
                    beforeKeys: changed,
                    changeKeys: changed,
                    writeCandidateKeys: changed,
                    context: context,
                    beforeMap: beforeMap,
                    prior: [],
                    excludeInvoiceBaseRevisions: false
                )
            ]

        case .createProject(let project):
            guard let record = after.project(id: project.id) else {
                throw StoreError.noOperationMapping("createProject")
            }
            return [
                try makePlanned(
                    type: .projectCreate,
                    entityId: record.id,
                    payload: projectPayload(record),
                    beforeKeys: changed,
                    changeKeys: changed,
                    writeCandidateKeys: changed,
                    context: context,
                    beforeMap: beforeMap,
                    prior: [],
                    excludeInvoiceBaseRevisions: false
                )
            ]

        case .completeProject(let id):
            guard after.project(id: id) != nil else {
                throw StoreError.noOperationMapping("completeProject")
            }
            return [
                try makePlanned(
                    type: .projectComplete,
                    entityId: id,
                    payload: .object([:]),
                    beforeKeys: changed,
                    changeKeys: changed,
                    writeCandidateKeys: changed + [EntityKey(entityType: .project, entityId: id)],
                    context: context,
                    beforeMap: beforeMap,
                    prior: [],
                    excludeInvoiceBaseRevisions: false
                )
            ]

        case .registerProjectPayment(let projectID, let amount, let description):
            return [
                try makePlanned(
                    type: .projectPayment,
                    entityId: projectID,
                    payload: projectPaymentPayload(
                        amount: Money.roundCurrency(amount),
                        description: description
                    ),
                    beforeKeys: changed,
                    changeKeys: changed,
                    writeCandidateKeys: changed + [EntityKey(entityType: .project, entityId: projectID)],
                    context: context,
                    beforeMap: beforeMap,
                    prior: [],
                    excludeInvoiceBaseRevisions: false
                )
            ]

        case .createRecurrence(let recurrence):
            guard let record = after.recurrence(id: recurrence.id) else {
                throw StoreError.noOperationMapping("createRecurrence")
            }
            return [
                try makePlanned(
                    type: .recurrenceCreate,
                    entityId: record.id,
                    payload: recurrencePayload(record),
                    beforeKeys: changed,
                    changeKeys: changed,
                    writeCandidateKeys: changed,
                    context: context,
                    beforeMap: beforeMap,
                    prior: [],
                    excludeInvoiceBaseRevisions: false
                )
            ]

        case .updateRecurrence(let id, let patch):
            guard let resulting = after.recurrence(id: id), let original = before.recurrence(id: id) else {
                throw StoreError.noOperationMapping("updateRecurrence")
            }
            let recurrenceKey = EntityKey(entityType: .recurrence, entityId: id)
            var operations: [PlannedOperation] = []
            if let payload = recurrenceUpdatePayload(patch) {
                operations.append(
                    try makePlanned(
                        type: .recurrenceUpdate,
                        entityId: id,
                        payload: payload,
                        beforeKeys: [recurrenceKey],
                        changeKeys: [recurrenceKey],
                        writeCandidateKeys: [recurrenceKey],
                        context: context,
                        beforeMap: beforeMap,
                        prior: operations,
                        excludeInvoiceBaseRevisions: false
                    )
                )
            }
            if original.status != resulting.status {
                var statusBeforeMap = beforeMap
                if !operations.isEmpty {
                    statusBeforeMap[recurrenceKey] = try snapshotMap(after)[recurrenceKey]
                }
                operations.append(
                    try makePlanned(
                        type: statusOperation(for: resulting.status),
                        entityId: id,
                        payload: statusPayload(for: resulting.status),
                        beforeKeys: [recurrenceKey],
                        changeKeys: [recurrenceKey],
                        writeCandidateKeys: [recurrenceKey],
                        context: context,
                        beforeMap: statusBeforeMap,
                        prior: operations,
                        excludeInvoiceBaseRevisions: false
                    )
                )
            }
            guard !operations.isEmpty else {
                throw StoreError.invalidArgument("recurrence.update has no fields")
            }
            return operations

        case .setRecurrenceStatus(let id, let status):
            guard after.recurrence(id: id) != nil else {
                throw StoreError.noOperationMapping("setRecurrenceStatus")
            }
            let key = EntityKey(entityType: .recurrence, entityId: id)
            return [
                try makePlanned(
                    type: statusOperation(for: status),
                    entityId: id,
                    payload: statusPayload(for: status),
                    beforeKeys: [key],
                    changeKeys: [key],
                    writeCandidateKeys: [key],
                    context: context,
                    beforeMap: beforeMap,
                    prior: [],
                    excludeInvoiceBaseRevisions: false
                )
            ]

        case .deleteRecurrence(let id):
            guard after.recurrence(id: id) != nil else {
                throw StoreError.noOperationMapping("deleteRecurrence")
            }
            let key = EntityKey(entityType: .recurrence, entityId: id)
            return [
                try makePlanned(
                    type: .recurrenceDelete,
                    entityId: id,
                    payload: .object([:]),
                    beforeKeys: [key],
                    changeKeys: [key],
                    writeCandidateKeys: [key],
                    context: context,
                    beforeMap: beforeMap,
                    prior: [],
                    excludeInvoiceBaseRevisions: false
                )
            ]

        case .launchRecurrence(let id):
            guard after.recurrence(id: id) != nil else {
                throw StoreError.noOperationMapping("launchRecurrence")
            }
            let key = EntityKey(entityType: .recurrence, entityId: id)
            return [
                try makePlanned(
                    type: .recurrenceLaunch,
                    entityId: id,
                    payload: .object([:]),
                    beforeKeys: changed,
                    changeKeys: changed,
                    writeCandidateKeys: changed + [key],
                    context: context,
                    beforeMap: beforeMap,
                    prior: [],
                    excludeInvoiceBaseRevisions: true
                )
            ]

        case .createTransaction(let draft):
            let identifier = try createdTransactionID(draft: draft, before: before, after: after)
            guard let transaction = after.transaction(id: identifier) else {
                throw StoreError.noOperationMapping("createTransaction")
            }
            let payload = try transactionCreatePayload(transaction, snapshot: after)
            let transactionKey = EntityKey(entityType: .transaction, entityId: identifier)
            return [
                try makePlanned(
                    type: .transactionCreate,
                    entityId: identifier,
                    payload: payload,
                    beforeKeys: changed,
                    changeKeys: changed,
                    writeCandidateKeys: changed + [transactionKey],
                    context: context,
                    beforeMap: beforeMap,
                    prior: [],
                    excludeInvoiceBaseRevisions: true
                )
            ]

        case .updateTransaction(let id, let patch):
            guard after.transaction(id: id) != nil else {
                throw StoreError.noOperationMapping("updateTransaction")
            }
            let payload = try transactionUpdatePayload(patch)
            let key = EntityKey(entityType: .transaction, entityId: id)
            return [
                try makePlanned(
                    type: .transactionUpdate,
                    entityId: id,
                    payload: payload,
                    beforeKeys: changed,
                    changeKeys: changed,
                    writeCandidateKeys: changed + [key],
                    context: context,
                    beforeMap: beforeMap,
                    prior: [],
                    excludeInvoiceBaseRevisions: false
                )
            ]

        case .realizeTransaction(let id, let updateBalance):
            guard after.transaction(id: id) != nil else {
                throw StoreError.noOperationMapping("realizeTransaction")
            }
            let key = EntityKey(entityType: .transaction, entityId: id)
            return [
                try makePlanned(
                    type: .transactionRealize,
                    entityId: id,
                    payload: .object(["update_balance": .bool(updateBalance)]),
                    beforeKeys: changed,
                    changeKeys: changed,
                    writeCandidateKeys: changed + [key],
                    context: context,
                    beforeMap: beforeMap,
                    prior: [],
                    excludeInvoiceBaseRevisions: false
                )
            ]

        case .deleteTransaction(let id):
            guard before.transaction(id: id) != nil else {
                throw StoreError.noOperationMapping("deleteTransaction")
            }
            let key = EntityKey(entityType: .transaction, entityId: id)
            return [
                try makePlanned(
                    type: .transactionDelete,
                    entityId: id,
                    payload: .object([:]),
                    beforeKeys: changed,
                    changeKeys: changed,
                    writeCandidateKeys: changed + [key],
                    context: context,
                    beforeMap: beforeMap,
                    prior: [],
                    excludeInvoiceBaseRevisions: false
                )
            ]

        case .convertSimulation(let id, let toSimulated):
            guard after.transaction(id: id) != nil else {
                throw StoreError.noOperationMapping("convertSimulation")
            }
            let key = EntityKey(entityType: .transaction, entityId: id)
            return [
                try makePlanned(
                    type: .transactionUpdate,
                    entityId: id,
                    payload: .object(["is_simulated": .bool(toSimulated)]),
                    beforeKeys: changed,
                    changeKeys: changed,
                    writeCandidateKeys: changed + [key],
                    context: context,
                    beforeMap: beforeMap,
                    prior: [],
                    excludeInvoiceBaseRevisions: false
                )
            ]

        case .payInvoice(let cardID, let period, let accountID, let amount, let ignoreBalance):
            guard let invoice = before.invoice(cardID: cardID, period: period)
                ?? after.invoice(cardID: cardID, period: period) else {
                throw StoreError.noOperationMapping("payInvoice")
            }
            var paymentAmount: Decimal?
            if !ignoreBalance, let requested = amount {
                let createdPayment = after.transactions
                    .filter { before.transaction(id: $0.id) == nil }
                    .first { transaction in
                        transaction.type == .expense
                            && transaction.status == .realized
                            && transaction.accountID == accountID
                    }
                paymentAmount = createdPayment?.amount ?? Money.roundCurrency(requested)
            }
            let key = EntityKey(entityType: .invoice, entityId: invoice.id)
            return [
                try makePlanned(
                    type: .invoicePay,
                    entityId: invoice.id,
                    payload: invoicePayPayload(
                        period: period,
                        accountID: accountID,
                        amount: paymentAmount,
                        ignoreBalance: ignoreBalance
                    ),
                    beforeKeys: changed,
                    changeKeys: changed,
                    writeCandidateKeys: changed + [key],
                    context: context,
                    beforeMap: beforeMap,
                    prior: [],
                    excludeInvoiceBaseRevisions: false
                )
            ]

        case .deleteInvoice(let cardID, let period):
            guard let invoice = before.invoice(cardID: cardID, period: period) else {
                throw StoreError.noOperationMapping("deleteInvoice")
            }
            let key = EntityKey(entityType: .invoice, entityId: invoice.id)
            return [
                try makePlanned(
                    type: .invoiceDelete,
                    entityId: invoice.id,
                    payload: .object([
                        "card_id": .string(cardID),
                        "period": .string(period)
                    ]),
                    beforeKeys: changed,
                    changeKeys: changed,
                    writeCandidateKeys: changed + [key],
                    context: context,
                    beforeMap: beforeMap,
                    prior: [],
                    excludeInvoiceBaseRevisions: false
                )
            ]

        case .processMonthlyRecurrences, .reconcileInvoices:
            throw StoreError.unsupportedCommand(name(of: command))
        }
    }

    static func planAutomaticRecurrences(
        before: FinancialSnapshot,
        after: FinancialSnapshot,
        context: OperationPlanningContext
    ) throws -> [PlannedOperation] {
        let beforeMap = try snapshotMap(before)
        var operations: [PlannedOperation] = []

        let newTransactions = after.transactions
            .filter { before.transaction(id: $0.id) == nil }
            .sorted { $0.id < $1.id }

        for transaction in newTransactions {
            let payload = try transactionCreatePayload(transaction, snapshot: after)
            let transactionKey = EntityKey(entityType: .transaction, entityId: transaction.id)
            var keys: [EntityKey] = [transactionKey]
            if let invoiceID = transaction.invoiceID {
                keys.append(EntityKey(entityType: .invoice, entityId: invoiceID))
            }
            var candidates: [EntityKey] = [transactionKey]
            if transaction.status == .realized,
               transaction.isSilent != true,
               transaction.isSimulated != true {
                if let accountID = transaction.accountID {
                    candidates.append(EntityKey(entityType: .account, entityId: accountID))
                }
                if let destinationID = transaction.destinationAccountID {
                    candidates.append(EntityKey(entityType: .account, entityId: destinationID))
                }
            }
            operations.append(
                try makePlanned(
                    type: .transactionCreate,
                    entityId: transaction.id,
                    payload: payload,
                    beforeKeys: keys,
                    changeKeys: keys,
                    writeCandidateKeys: candidates,
                    context: context,
                    beforeMap: beforeMap,
                    prior: operations,
                    excludeInvoiceBaseRevisions: true
                )
            )
        }

        let changedRecurrences = after.recurrences
            .filter { recurrence in
                guard let original = before.recurrence(id: recurrence.id) else { return false }
                return original != recurrence
            }
            .sorted { $0.id < $1.id }

        for recurrence in changedRecurrences {
            let key = EntityKey(entityType: .recurrence, entityId: recurrence.id)
            operations.append(
                try makePlanned(
                    type: statusOperation(for: recurrence.status),
                    entityId: recurrence.id,
                    payload: statusPayload(for: recurrence.status),
                    beforeKeys: [key],
                    changeKeys: [key],
                    writeCandidateKeys: [key],
                    context: context,
                    beforeMap: beforeMap,
                    prior: operations,
                    excludeInvoiceBaseRevisions: false
                )
            )
        }

        return operations
    }

    static func makePlanned(
        type: OperationType,
        entityId: String,
        payload: JSONValue,
        beforeKeys: [EntityKey],
        changeKeys: [EntityKey],
        writeCandidateKeys: [EntityKey],
        context: OperationPlanningContext,
        beforeMap: [EntityKey: JSONValue],
        prior: [PlannedOperation],
        excludeInvoiceBaseRevisions: Bool
    ) throws -> PlannedOperation {
        let target = EntityKey(entityType: type.entityType, entityId: entityId)
        let writeSet = uniqueKeys(writeCandidateKeys).filter { key in
            guard beforeMap[key] != nil else { return false }
            if excludeInvoiceBaseRevisions && key.entityType == .invoice { return false }
            return true
        }

        var baseRevisions: [String: Int] = [:]
        for key in writeSet {
            if let revision = context.observedServerRevisions[key], revision > 0 {
                baseRevisions[key.description] = revision
            }
        }

        var dependencyIDs = Set<String>()
        for key in uniqueKeys(writeSet + uniqueKeys(changeKeys) + [target]) {
            for operationID in context.pendingOperationIdsByEntity[key] ?? [] {
                dependencyIDs.insert(operationID)
            }
        }
        for operation in prior {
            let sharesWrite = operation.writeSet.contains { writeSet.contains($0) }
            let sameTarget = operation.entityType == target.entityType && operation.entityId == target.entityId
            let sharesChanged = operation.changedEntities.contains {
                changeKeys.contains($0)
            }
            if sharesWrite || sameTarget || sharesChanged {
                dependencyIDs.insert(operation.opId)
            }
        }

        var generatedID = SyncIdentifier.uuidv7(at: context.clientCreatedAt)
        let knownIDs = Set(prior.map(\.opId))
        while knownIDs.contains(generatedID) {
            generatedID = SyncIdentifier.uuidv7(at: context.clientCreatedAt)
        }

        let snapshots = uniqueKeys(beforeKeys)
            .sorted { $0.description < $1.description }
            .map { EntitySnapshot(key: $0, record: beforeMap[$0]) }

        return PlannedOperation(
            opId: generatedID,
            type: type,
            entityType: type.entityType,
            entityId: entityId,
            payload: payload,
            baseRevisions: baseRevisions,
            dependsOn: dependencyIDs.sorted(),
            writeSet: writeSet.sorted { $0.description < $1.description },
            changedEntities: uniqueKeys(changeKeys).sorted { $0.description < $1.description },
            beforeSnapshots: snapshots
        )
    }

    static func uniqueKeys(_ keys: [EntityKey]) -> [EntityKey] {
        Array(Set(keys))
    }

    static func createdTransactionID(
        draft: TransactionDraft,
        before: FinancialSnapshot,
        after: FinancialSnapshot
    ) throws -> String {
        if let requested = draft.id, after.transaction(id: requested) != nil {
            return requested
        }
        let created = after.transactions.filter { before.transaction(id: $0.id) == nil }
        guard created.count == 1, let transaction = created.first else {
            throw StoreError.noOperationMapping("createTransaction")
        }
        return transaction.id
    }

    static func statusOperation(for status: RecurrenceStatus) -> OperationType {
        status == .ended ? .recurrenceDelete : .recurrenceToggleStatus
    }

    static func statusPayload(for status: RecurrenceStatus) -> JSONValue {
        switch status {
        case .ended:
            return .object([:])
        case .active, .paused:
            return .object(["status": .string(status.rawValue)])
        }
    }
}

// MARK: - DTO payloads

private extension OperationBuilder {
    static func accountPayload(_ account: Account) -> JSONValue {
        .object([
            "name": .string(account.name),
            "type": .string(account.type.rawValue),
            "initial_balance": .number(account.initialBalance)
        ])
    }

    static func cardPayload(_ card: Card) -> JSONValue {
        .object([
            "name": .string(card.name),
            "closing_day": .number(Decimal(card.closingDay)),
            "due_day": .number(Decimal(card.dueDay)),
            "limit": .number(card.limit)
        ])
    }

    static func cardUpdatePayload(_ patch: CardPatch) throws -> JSONValue {
        var object: [String: JSONValue] = [:]
        if let name = patch.name { object["name"] = .string(name) }
        if let closingDay = patch.closingDay { object["closing_day"] = .number(Decimal(closingDay)) }
        if let dueDay = patch.dueDay { object["due_day"] = .number(Decimal(dueDay)) }
        if let limit = patch.limit { object["limit"] = .number(Money.roundCurrency(limit)) }
        guard !object.isEmpty else {
            throw StoreError.invalidArgument("card.update has no fields")
        }
        return .object(object)
    }

    static func categoryPayload(_ category: ObolCore.Category) -> JSONValue {
        var object: [String: JSONValue] = [
            "name": .string(category.name),
            "type": .string(category.type.rawValue)
        ]
        if let budget = category.monthlyBudget {
            object["monthly_budget"] = .number(budget)
        }
        return .object(object)
    }

    static func projectPayload(_ project: Project) -> JSONValue {
        .object([
            "name": .string(project.name),
            "total_value": .number(project.totalValue)
        ])
    }

    static func projectPaymentPayload(amount: Decimal, description: String?) -> JSONValue {
        var object: [String: JSONValue] = ["amount": .number(amount)]
        if let description {
            object["description"] = .string(description)
        }
        return .object(object)
    }

    static func recurrencePayload(_ recurrence: Recurrence) -> JSONValue {
        var object: [String: JSONValue] = [
            "name": .string(recurrence.name),
            "amount": .number(recurrence.amount),
            "payday": .number(Decimal(recurrence.payday)),
            "type": .string(recurrence.type.rawValue),
            "frequency": .string(recurrence.cadence.rawValue)
        ]
        if recurrence.cadence == .weekly, let weekday = recurrence.weekday {
            object["weekday"] = .number(Decimal(weekday))
        }
        if let accountID = recurrence.accountID { object["account_id"] = .string(accountID) }
        if let cardID = recurrence.cardID { object["card_id"] = .string(cardID) }
        if let categoryID = recurrence.categoryID { object["category_id"] = .string(categoryID) }
        if let endDate = recurrence.endDate { object["end_date"] = .string(ObolDate.string(endDate)) }
        if let total = recurrence.totalInstallments {
            object["total_installments"] = .number(Decimal(total))
        }
        if let skipped = recurrence.skippedPeriods {
            object["skipped_periods"] = .array(skipped.map { .string($0) })
        }
        return .object(object)
    }

    static func recurrenceUpdatePayload(_ patch: RecurrencePatch) -> JSONValue? {
        var object: [String: JSONValue] = [:]
        if let name = patch.name { object["name"] = .string(name) }
        if let amount = patch.amount { object["amount"] = .number(Money.roundCurrency(amount)) }
        if let payday = patch.payday { object["payday"] = .number(Decimal(payday)) }
        if let type = patch.type { object["type"] = .string(type.rawValue) }
        apply(patch.accountID, key: "account_id", to: &object) { .string($0) }
        apply(patch.cardID, key: "card_id", to: &object) { .string($0) }
        apply(patch.categoryID, key: "category_id", to: &object) { .string($0) }
        apply(patch.endDate, key: "end_date", to: &object) { .string(ObolDate.string($0)) }
        apply(patch.totalInstallments, key: "total_installments", to: &object) { .number(Decimal($0)) }
        apply(patch.frequency, key: "frequency", to: &object) { .string($0.rawValue) }
        apply(patch.weekday, key: "weekday", to: &object) { .number(Decimal($0)) }
        if let skipped = patch.skippedPeriods {
            object["skipped_periods"] = .array(skipped.map { .string($0) })
        }
        return object.isEmpty ? nil : .object(object)
    }

    static func transactionCreatePayload(
        _ transaction: Transaction,
        snapshot: FinancialSnapshot
    ) throws -> JSONValue {
        if let recurrenceID = transaction.recurrenceID {
            guard transaction.isRecurring == true else {
                throw StoreError.invalidArgument(
                    "transaction.create recurrence_id requires is_recurring=true"
                )
            }
            guard let recurrence = snapshot.recurrence(id: recurrenceID) else {
                throw StoreError.invalidArgument(
                    "transaction.create references missing recurrence \(recurrenceID)"
                )
            }
            guard recurrence.type.rawValue == transaction.type.rawValue else {
                throw StoreError.invalidArgument(
                    "transaction.create type does not match recurrence \(recurrenceID)"
                )
            }
            let occurrence = transaction.purchaseDate ?? transaction.expectedDate
            let matchesOccurrence: Bool
            switch recurrence.cadence {
            case .weekly:
                guard let weekday = recurrence.weekday, (1...7).contains(weekday) else {
                    throw StoreError.invalidArgument(
                        "recurrence \(recurrenceID) requires a weekday between 1 and 7."
                    )
                }
                matchesOccurrence = ObolDate.dayKey(
                    ObolDate.isoWeekOccurrence(occurrence, weekday: weekday)
                ) == ObolDate.dayKey(occurrence)
            case .monthly:
                let year = ObolDate.calendar.component(.year, from: occurrence)
                let month = ObolDate.calendar.component(.month, from: occurrence)
                let expected = ObolDate.clampedDate(
                    year: year,
                    month: month,
                    day: recurrence.payday
                )
                matchesOccurrence = ObolDate.dayKey(expected) == ObolDate.dayKey(occurrence)
            }
            guard matchesOccurrence else {
                throw StoreError.invalidArgument(
                    "transaction.create occurrence date does not match recurrence \(recurrenceID)."
                )
            }
        }

        let expectedDate: Date
        if transaction.cardID != nil {
            expectedDate = transaction.purchaseDate ?? transaction.expectedDate
        } else {
            expectedDate = transaction.expectedDate
        }

        var object: [String: JSONValue] = [
            "title": .string(transaction.title),
            "amount": .number(transaction.amount),
            "type": .string(transaction.type.rawValue),
            "status": .string(transaction.status.rawValue),
            "expected_date": .string(ObolDate.string(expectedDate))
        ]
        if let realizedDate = transaction.realizedDate {
            object["realized_date"] = .string(ObolDate.string(realizedDate))
        }
        if let purchaseDate = transaction.purchaseDate {
            object["purchase_date"] = .string(ObolDate.string(purchaseDate))
        }
        if let recurring = transaction.isRecurring { object["is_recurring"] = .bool(recurring) }
        if let silent = transaction.isSilent { object["is_silent"] = .bool(silent) }
        if let simulated = transaction.isSimulated { object["is_simulated"] = .bool(simulated) }
        if let scheduled = transaction.isScheduled { object["is_scheduled"] = .bool(scheduled) }
        if let accountID = transaction.accountID { object["account_id"] = .string(accountID) }
        if let cardID = transaction.cardID { object["card_id"] = .string(cardID) }
        if let categoryID = transaction.categoryID { object["category_id"] = .string(categoryID) }
        if let projectID = transaction.projectID { object["project_id"] = .string(projectID) }
        if let recurrenceID = transaction.recurrenceID {
            object["recurrence_id"] = .string(recurrenceID)
        }
        if let destinationID = transaction.destinationAccountID {
            object["destination_account_id"] = .string(destinationID)
        }
        // invoice_id is deliberately absent: the server recomputes invoice routing.
        return .object(object)
    }

    static func transactionUpdatePayload(_ patch: TransactionPatch) throws -> JSONValue {
        var object: [String: JSONValue] = [:]
        if let title = patch.title { object["title"] = .string(title) }
        if let amount = patch.amount { object["amount"] = .number(Money.roundCurrency(amount)) }
        if let type = patch.type { object["type"] = .string(type.rawValue) }
        if let status = patch.status { object["status"] = .string(status.rawValue) }
        if let expectedDate = patch.expectedDate {
            object["expected_date"] = .string(ObolDate.string(expectedDate))
        }
        apply(patch.realizedDate, key: "realized_date", to: &object) { .string(ObolDate.string($0)) }
        apply(patch.purchaseDate, key: "purchase_date", to: &object) { .string(ObolDate.string($0)) }
        if let recurring = patch.isRecurring { object["is_recurring"] = .bool(recurring) }
        if let silent = patch.isSilent { object["is_silent"] = .bool(silent) }
        if let simulated = patch.isSimulated { object["is_simulated"] = .bool(simulated) }
        if let scheduled = patch.isScheduled { object["is_scheduled"] = .bool(scheduled) }
        apply(patch.accountID, key: "account_id", to: &object) { .string($0) }
        apply(patch.cardID, key: "card_id", to: &object) { .string($0) }
        apply(patch.categoryID, key: "category_id", to: &object) { .string($0) }
        apply(patch.projectID, key: "project_id", to: &object) { .string($0) }
        apply(patch.recurrenceID, key: "recurrence_id", to: &object) { .string($0) }
        apply(patch.destinationAccountID, key: "destination_account_id", to: &object) { .string($0) }
        guard !object.isEmpty else {
            throw StoreError.invalidArgument("transaction.update has no fields")
        }
        return .object(object)
    }

    static func invoicePayPayload(
        period: String,
        accountID: String?,
        amount: Decimal?,
        ignoreBalance: Bool
    ) -> JSONValue {
        var object: [String: JSONValue] = [
            "period": .string(period),
            "ignore_balance": .bool(ignoreBalance)
        ]
        if let accountID {
            object["account_id"] = .string(accountID)
        }
        if let amount {
            object["amount_paid"] = .number(amount)
        }
        return .object(object)
    }

    static func apply<T>(
        _ field: PatchField<T>?,
        key: String,
        to object: inout [String: JSONValue],
        encode: (T) -> JSONValue
    ) where T: Codable & Equatable & Sendable {
        guard let field else { return }
        switch field {
        case .unchanged:
            return
        case .set(let value):
            object[key] = encode(value)
        case .clear:
            object[key] = .null
        }
    }
}
