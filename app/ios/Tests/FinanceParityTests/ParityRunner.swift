import Foundation
import ObolCore
import ObolNativeRuntime

enum FixtureRunner {
    static func run(file: FixtureFileID, caseID: String) async throws {
        let fixture = try FixtureLoader.load(file)
        let parityCase = try fixture.parityCase(id: caseID)
        try await run(parityCase)
    }

    static func run(_ parityCase: ParityCase) async throws {
        if parityCase.commands.contains(where: { $0.fault != nil }) {
            try await runThroughStore(parityCase)
        } else {
            try runPure(parityCase)
        }
    }

    private struct ExecutionState {
        var snapshot: FinancialSnapshot
        var captures: [String: String]
        var projections: [ProjectionActual]
    }

    private static func runPure(_ parityCase: ParityCase) throws {
        var state = ExecutionState(
            snapshot: parityCase.initial.snapshot,
            captures: [:],
            projections: []
        )
        var thrown: Error?

        for (index, command) in parityCase.commands.enumerated() {
            let path = "\(parityCase.id).commands[\(index)]"
            let resolved = try FixtureTokens.resolve(
                .object(command.object),
                captures: state.captures,
                path: path
            )
            guard case .object(let object) = resolved else {
                throw ParityFailure("\(path): command is not an object")
            }
            do {
                if command.kind.isProjection {
                    let projection = try computeProjection(
                        command.kind,
                        object: object,
                        snapshot: state.snapshot,
                        clock: parityCase.operationClock,
                        path: path
                    )
                    state.projections.append(projection)
                } else {
                    let before = state.snapshot
                    let financialCommand = try mapCommand(
                        command.kind,
                        object: object,
                        clock: parityCase.operationClock,
                        path: path
                    )
                    let after = try FinanceEngine().apply(
                        financialCommand,
                        to: before,
                        now: parityCase.operationClock
                    )
                    state.snapshot = after
                    try registerCaptures(
                        command.captures,
                        before: before,
                        after: after,
                        captures: &state.captures,
                        caseID: parityCase.id
                    )
                }
            } catch let failure as ParityFailure {
                throw failure
            } catch {
                thrown = error
                if index != parityCase.commands.count - 1 {
                    throw ParityFailure(
                        "case \(parityCase.id): command[\(index)] \(command.kind.rawValue) failed before the final command: \(error)"
                    )
                }
                break
            }
        }

        try finish(parityCase, state: state, thrown: thrown)
    }

    private static func runThroughStore(_ parityCase: ParityCase) async throws {
        try await StoreTestSupport.withStore { context in
            try await StoreTestSupport.seed(
                context,
                snapshot: parityCase.initial.snapshot,
                now: parityCase.operationClock
            )
            let seeded = try await context.store.loadFinancialSnapshot()
            try ParitySnapshots.compareSnapshots(
                caseID: "\(parityCase.id) store seed",
                expected: parityCase.initial.normalized,
                actual: ParitySnapshots.canonicalSnapshot(seeded)
            )

            var state = ExecutionState(
                snapshot: seeded,
                captures: [:],
                projections: []
            )
            var thrown: Error?

            for (index, command) in parityCase.commands.enumerated() {
                let path = "\(parityCase.id).commands[\(index)]"
                let resolved = try FixtureTokens.resolve(
                    .object(command.object),
                    captures: state.captures,
                    path: path
                )
                guard case .object(let object) = resolved else {
                    throw ParityFailure("\(path): command is not an object")
                }

                do {
                    if command.kind.isProjection {
                        let projection = try computeProjection(
                            command.kind,
                            object: object,
                            snapshot: state.snapshot,
                            clock: parityCase.operationClock,
                            path: path
                        )
                        state.projections.append(projection)
                        continue
                    }

                    let before = try await context.store.loadFinancialSnapshot()
                    let beforeOperations = try await context.store.pendingOperations()
                    let financialCommand = try mapCommand(
                        command.kind,
                        object: object,
                        clock: parityCase.operationClock,
                        path: path
                    )

                    guard let fault = command.fault else {
                        _ = try await context.store.apply(
                            financialCommand,
                            effectiveAt: parityCase.operationClock
                        )
                        let after = try await context.store.loadFinancialSnapshot()
                        state.snapshot = after
                        try registerCaptures(
                            command.captures,
                            before: before,
                            after: after,
                            captures: &state.captures,
                            caseID: parityCase.id
                        )
                        continue
                    }

                    let recordID = try resolvedFaultRecordID(
                        fault.recordID,
                        captures: state.captures,
                        path: "\(path).fault.on_write.record_id"
                    )
                    let trigger = try ParityFaultTrigger(
                        databasePath: context.databaseURL.path
                    )
                    do {
                        try trigger.install(
                            collection: fault.collection,
                            recordID: recordID,
                            operation: fault.operation
                        )
                    } catch {
                        trigger.close()
                        throw error
                    }

                    var faultError: Error?
                    do {
                        _ = try await context.store.apply(
                            financialCommand,
                            effectiveAt: parityCase.operationClock
                        )
                    } catch {
                        faultError = error
                    }
                    do {
                        try trigger.removeAll()
                    } catch {
                        trigger.close()
                        throw error
                    }
                    trigger.close()

                    guard let faultError else {
                        throw ParityFailure(
                            "case \(parityCase.id): injected storage fault on \(fault.collection.rawValue) did not fire"
                        )
                    }

                    let after = try await context.store.loadFinancialSnapshot()
                    let afterOperations = try await context.store.pendingOperations()
                    guard afterOperations == beforeOperations else {
                        throw ParityFailure(
                            "case \(parityCase.id): faulted command changed the outbox (\(beforeOperations.count) -> \(afterOperations.count) operations)"
                        )
                    }
                    state.snapshot = after
                    thrown = faultError
                    if index != parityCase.commands.count - 1 {
                        throw ParityFailure(
                            "case \(parityCase.id): faulted command was not the final command"
                        )
                    }
                    break
                } catch let failure as ParityFailure {
                    throw failure
                } catch {
                    thrown = error
                    if index != parityCase.commands.count - 1 {
                        throw ParityFailure(
                            "case \(parityCase.id): command[\(index)] \(command.kind.rawValue) failed before the final command: \(error)"
                        )
                    }
                    break
                }
            }

            try finish(parityCase, state: state, thrown: thrown)
        }
    }

    private static func finish(
        _ parityCase: ParityCase,
        state: ExecutionState,
        thrown: Error?
    ) throws {
        if let expectedError = parityCase.expectedError {
            guard let thrown else {
                throw ParityFailure(
                    "case \(parityCase.id): expected \(expectedError.code) but every command succeeded"
                )
            }
            try assertExpectedError(
                caseID: parityCase.id,
                expected: expectedError,
                thrown: thrown,
                captures: state.captures
            )
        } else if let thrown {
            throw ParityFailure("case \(parityCase.id): unexpected error: \(thrown)")
        }

        if let rawSnapshot = parityCase.expectedSnapshot {
            let resolved = try FixtureTokens.resolve(
                rawSnapshot,
                captures: state.captures,
                path: "\(parityCase.id).expect.snapshot"
            )
            let expected = try ParitySnapshots.normalizedSnapshot(
                resolved,
                path: "\(parityCase.id).expect.snapshot",
                allowGeneratedTitle: true
            )
            try ParitySnapshots.compareSnapshots(
                caseID: parityCase.id,
                expected: expected,
                actual: ParitySnapshots.canonicalSnapshot(state.snapshot)
            )
        }

        if let expectedProjections = parityCase.expectedProjections {
            try ParityProjections.compare(
                caseID: parityCase.id,
                expected: expectedProjections,
                actual: state.projections,
                captures: state.captures
            )
        }
    }

    private static func computeProjection(
        _ kind: CommandKind,
        object: [String: JSONValue],
        snapshot: FinancialSnapshot,
        clock: Date,
        path: String
    ) throws -> ProjectionActual {
        switch kind {
        case .forecastGenerate:
            let start = try FixtureDates.parseDay(
                object["start_date"] ?? .null,
                path: "\(path).start_date"
            )
            let end = try FixtureDates.parseDay(
                object["end_date"] ?? .null,
                path: "\(path).end_date"
            )
            let includeSimulations = try FixtureJSON.bool(
                object["include_simulations"] ?? .null,
                path: "\(path).include_simulations"
            )
            let options = ForecastOptions(
                startDate: start,
                endDate: end,
                includeSimulations: includeSimulations
            )
            let result = try ForecastEngine().forecast(
                snapshot,
                options: options,
                now: clock
            )
            return .forecast(options: options, result: result)

        case .budgetSummaries:
            let rows = ForecastEngine().budgetSummaries(snapshot, at: clock)
            return .budgets(at: clock, rows: rows)

        case .projectSummaries:
            return .projects(rows: ForecastEngine().projectSummaries(snapshot))

        case .invoiceSummaries:
            let cardID = try FixtureJSON.string(
                object["card_id"] ?? .null,
                path: "\(path).card_id"
            )
            let rows = try ForecastEngine().cardInvoiceSummaries(
                snapshot,
                cardID: cardID,
                now: clock
            )
            return .invoiceTimeline(cardID: cardID, rows: rows)

        default:
            throw ParityFailure("\(path): \(kind.rawValue) is not a projection command")
        }
    }

    private static func mapCommand(
        _ kind: CommandKind,
        object: [String: JSONValue],
        clock: Date,
        path: String
    ) throws -> FinancialCommand {
        switch kind {
        case .accountCreate:
            let generatedID = EntityID.generate(at: clock)
            let snapshot = try singleRecordSnapshot(
                collection: .accounts,
                record: object["record"] ?? .null,
                id: generatedID,
                path: "\(path).record"
            )
            guard let account = snapshot.accounts.first else {
                throw ParityFailure("\(path).record: account was not built")
            }
            return .createAccount(account)

        case .transactionCreate:
            let generatedID = EntityID.generate(at: clock)
            let snapshot = try singleRecordSnapshot(
                collection: .transactions,
                record: object["record"] ?? .null,
                id: generatedID,
                path: "\(path).record"
            )
            guard let transaction = snapshot.transactions.first else {
                throw ParityFailure("\(path).record: transaction was not built")
            }
            let draft = TransactionDraft(
                id: nil,
                title: transaction.title,
                amount: transaction.amount,
                type: transaction.type,
                status: transaction.status,
                expectedDate: transaction.expectedDate,
                realizedDate: transaction.realizedDate,
                purchaseDate: transaction.purchaseDate,
                isRecurring: transaction.isRecurring,
                isSilent: transaction.isSilent,
                isSimulated: transaction.isSimulated,
                isScheduled: transaction.isScheduled,
                accountID: transaction.accountID,
                cardID: transaction.cardID,
                categoryID: transaction.categoryID,
                projectID: transaction.projectID,
                recurrenceID: transaction.recurrenceID,
                destinationAccountID: transaction.destinationAccountID
            )
            return .createTransaction(draft)

        case .transactionUpdate:
            return .updateTransaction(
                id: try text(object, "id", path: path),
                patch: try transactionPatch(
                    object["patch"] ?? .null,
                    path: "\(path).patch"
                )
            )

        case .transactionRealize:
            return .realizeTransaction(
                id: try text(object, "id", path: path),
                updateBalance: try FixtureJSON.bool(
                    object["update_balance"] ?? .null,
                    path: "\(path).update_balance"
                )
            )

        case .transactionDelete:
            return .deleteTransaction(id: try text(object, "id", path: path))

        case .transactionSetSimulated:
            return .convertSimulation(
                id: try text(object, "id", path: path),
                toSimulated: try FixtureJSON.bool(
                    object["is_simulated"] ?? .null,
                    path: "\(path).is_simulated"
                )
            )

        case .invoicePay:
            let amount: Decimal?
            if let rawAmount = object["amount_paid"], !FixtureJSON.isNull(rawAmount) {
                amount = try FixtureMoney.parse(rawAmount, path: "\(path).amount_paid")
            } else {
                amount = nil
            }
            return .payInvoice(
                cardID: try text(object, "card_id", path: path),
                period: try text(object, "period", path: path),
                accountID: try optionalText(object, "account_id", path: path),
                amount: amount,
                ignoreBalance: try FixtureJSON.bool(
                    object["ignore_balance"] ?? .null,
                    path: "\(path).ignore_balance"
                )
            )

        case .invoiceDelete:
            return .deleteInvoice(
                cardID: try text(object, "card_id", path: path),
                period: try text(object, "period", path: path)
            )

        case .recurrenceCreate:
            let generatedID = EntityID.generate(at: clock)
            let snapshot = try singleRecordSnapshot(
                collection: .recurrences,
                record: object["record"] ?? .null,
                id: generatedID,
                path: "\(path).record"
            )
            guard let recurrence = snapshot.recurrences.first else {
                throw ParityFailure("\(path).record: recurrence was not built")
            }
            return .createRecurrence(recurrence)

        case .recurrenceSetStatus:
            let rawStatus = try text(object, "status", path: "\(path).status")
            guard let status = RecurrenceStatus(rawValue: rawStatus) else {
                throw ParityFailure("\(path).status: unknown recurrence status '\(rawStatus)'")
            }
            return .setRecurrenceStatus(
                id: try text(object, "id", path: path),
                status: status
            )

        case .recurrenceLaunch:
            return .launchRecurrence(id: try text(object, "id", path: path))

        case .recurrenceProcessMonth:
            return .processMonthlyRecurrences

        case .projectPayment:
            return .registerProjectPayment(
                projectID: try text(object, "project_id", path: path),
                amount: try FixtureMoney.parse(
                    object["amount"] ?? .null,
                    path: "\(path).amount"
                ),
                description: try optionalText(object, "description", path: path)
            )

        case .projectComplete:
            return .completeProject(id: try text(object, "id", path: path))

        case .invoiceSummaries, .forecastGenerate, .budgetSummaries, .projectSummaries:
            throw ParityFailure("\(path): \(kind.rawValue) is a projection command")
        }
    }

    private static func singleRecordSnapshot(
        collection: ParityCollection,
        record: JSONValue,
        id: String,
        path: String
    ) throws -> FinancialSnapshot {
        guard case .object(var object) = record else {
            throw ParityFailure("\(path): expected an object")
        }
        if collection == .recurrences,
           object["status"] == nil || FixtureJSON.isNull(object["status"]) {
            object["status"] = .string(RecurrenceStatus.active.rawValue)
        }
        object["id"] = .string(id)
        let normalized = try ParitySnapshots.normalizedRecord(
            collection,
            value: .object(object),
            path: path,
            allowGeneratedTitle: false
        )
        return try ParitySnapshots.buildSnapshot([
            collection: [normalized.id: normalized]
        ])
    }

    private static func transactionPatch(
        _ value: JSONValue,
        path: String
    ) throws -> TransactionPatch {
        let object = try FixtureJSON.object(
            value,
            path: path,
            allowed: [
                "title", "amount", "type", "status", "expected_date",
                "realized_date", "purchase_date", "is_recurring", "is_silent",
                "is_simulated", "is_scheduled", "account_id", "card_id",
                "category_id", "project_id", "recurrence_id",
                "destination_account_id"
            ],
            required: []
        )
        var patch = TransactionPatch()

        if let raw = object["title"] {
            patch.title = try FixtureJSON.string(raw, path: "\(path).title")
        }
        if let raw = object["amount"] {
            patch.amount = try FixtureMoney.parse(raw, path: "\(path).amount")
        }
        if let raw = object["type"] {
            let value = try FixtureJSON.string(raw, path: "\(path).type")
            guard let type = TransactionType(rawValue: value) else {
                throw ParityFailure("\(path).type: unknown transaction type '\(value)'")
            }
            patch.type = type
        }
        if let raw = object["status"] {
            let value = try FixtureJSON.string(raw, path: "\(path).status")
            guard let status = TransactionStatus(rawValue: value) else {
                throw ParityFailure("\(path).status: unknown transaction status '\(value)'")
            }
            patch.status = status
        }
        if let raw = object["expected_date"] {
            patch.expectedDate = try FixtureDates.parseInstant(
                raw,
                path: "\(path).expected_date"
            )
        }
        if let raw = object["realized_date"] {
            patch.realizedDate = try patchField(raw, path: "\(path).realized_date") {
                try FixtureDates.parseInstant($0, path: "\(path).realized_date")
            }
        }
        if let raw = object["purchase_date"] {
            patch.purchaseDate = try patchField(raw, path: "\(path).purchase_date") {
                try FixtureDates.parseInstant($0, path: "\(path).purchase_date")
            }
        }
        if let raw = object["is_recurring"] {
            patch.isRecurring = try FixtureJSON.bool(raw, path: "\(path).is_recurring")
        }
        if let raw = object["is_silent"] {
            patch.isSilent = try FixtureJSON.bool(raw, path: "\(path).is_silent")
        }
        if let raw = object["is_simulated"] {
            patch.isSimulated = try FixtureJSON.bool(raw, path: "\(path).is_simulated")
        }
        if let raw = object["is_scheduled"] {
            patch.isScheduled = try FixtureJSON.bool(raw, path: "\(path).is_scheduled")
        }
        if let raw = object["account_id"] {
            patch.accountID = try patchTextField(raw, path: "\(path).account_id")
        }
        if let raw = object["card_id"] {
            patch.cardID = try patchTextField(raw, path: "\(path).card_id")
        }
        if let raw = object["category_id"] {
            patch.categoryID = try patchTextField(raw, path: "\(path).category_id")
        }
        if let raw = object["project_id"] {
            patch.projectID = try patchTextField(raw, path: "\(path).project_id")
        }
        if let raw = object["recurrence_id"] {
            patch.recurrenceID = try patchTextField(raw, path: "\(path).recurrence_id")
        }
        if let raw = object["destination_account_id"] {
            patch.destinationAccountID = try patchTextField(
                raw,
                path: "\(path).destination_account_id"
            )
        }
        return patch
    }

    private static func patchField<T: Codable & Equatable & Sendable>(
        _ value: JSONValue,
        path: String,
        parse: (JSONValue) throws -> T
    ) throws -> PatchField<T> {
        if FixtureJSON.isNull(value) {
            return .clear
        }
        return .set(try parse(value))
    }

    private static func patchTextField(
        _ value: JSONValue,
        path: String
    ) throws -> PatchField<String> {
        if FixtureJSON.isNull(value) {
            return .clear
        }
        return .set(try FixtureJSON.string(value, path: path))
    }

    private static func text(
        _ object: [String: JSONValue],
        _ key: String,
        path: String
    ) throws -> String {
        try FixtureJSON.string(object[key] ?? .null, path: "\(path).\(key)")
    }

    private static func optionalText(
        _ object: [String: JSONValue],
        _ key: String,
        path: String
    ) throws -> String? {
        guard let value = object[key], !FixtureJSON.isNull(value) else { return nil }
        return try FixtureJSON.string(value, path: "\(path).\(key)")
    }

    private static func resolvedFaultRecordID(
        _ raw: String?,
        captures: [String: String],
        path: String
    ) throws -> String? {
        guard let raw else { return nil }
        guard let name = FixtureTokens.name(in: raw) else { return raw }
        guard let identifier = captures[name] else {
            throw ParityFailure("\(path): unresolved capture reference '\(raw)'")
        }
        return identifier
    }

    private static func registerCaptures(
        _ specs: [String: CaptureSpec],
        before: FinancialSnapshot,
        after: FinancialSnapshot,
        captures: inout [String: String],
        caseID: String
    ) throws {
        guard !specs.isEmpty else { return }
        let beforeSnapshot = ParitySnapshots.canonicalSnapshot(before)
        let afterSnapshot = ParitySnapshots.canonicalSnapshot(after)
        let names = specs.keys.sorted()

        var resolvedWhere: [String: [String: JSONValue]] = [:]
        for name in names {
            guard let spec = specs[name] else { continue }
            let value = try FixtureTokens.resolve(
                .object(spec.whereFields),
                captures: captures,
                path: "\(caseID).capture.\(name).where"
            )
            guard case .object(let object) = value else {
                throw ParityFailure("\(caseID).capture.\(name).where: not an object")
            }
            resolvedWhere[name] = object
        }

        for name in names {
            guard let spec = specs[name] else { continue }
            guard captures[name] == nil else {
                throw ParityFailure("case \(caseID): capture name '\(name)' is already defined")
            }
            let beforeRecords = beforeSnapshot[spec.collection] ?? [:]
            let afterRecords = afterSnapshot[spec.collection] ?? [:]
            let candidates = afterRecords.values.filter { !beforeRecords.keys.contains($0.id) }
            var matches: [NormalizedRecord] = []
            for record in candidates {
                if try recordMatches(
                    record,
                    collection: spec.collection,
                    whereFields: resolvedWhere[name] ?? [:],
                    path: "\(caseID).capture.\(name).where"
                ) {
                    matches.append(record)
                }
            }
            guard matches.count == 1 else {
                throw ParityFailure(
                    "case \(caseID): capture '\(name)' matched \(matches.count) records created by the command in \(spec.collection.rawValue); exactly one is required"
                )
            }
            captures[name] = matches[0].id
        }
    }

    private static func recordMatches(
        _ record: NormalizedRecord,
        collection: ParityCollection,
        whereFields: [String: JSONValue],
        path: String
    ) throws -> Bool {
        for key in whereFields.keys.sorted() {
            let raw = whereFields[key] ?? .null
            if key == "id" {
                let expected = try FixtureJSON.string(raw, path: "\(path).id")
                if record.id != expected { return false }
                continue
            }
            guard let kind = collection.kind(for: key) else {
                throw ParityFailure("\(path).\(key): unknown field")
            }
            let expected = try whereValue(
                kind,
                value: raw,
                path: "\(path).\(key)"
            )
            let actual = record.fields[key] ?? .null
            if !ParitySnapshots.valuesMatch(expected, actual) {
                return false
            }
        }
        return true
    }

    private static func whereValue(
        _ kind: CanonicalFieldKind,
        value: JSONValue,
        path: String
    ) throws -> CanonicalValue {
        switch kind {
        case .text:
            return .text(try FixtureJSON.string(value, path: path))
        case .money:
            return .money(try FixtureMoney.parse(value, path: path))
        case .integer:
            return .integer(try FixtureInteger.parse(value, path: path))
        case .boolean:
            return .boolean(try FixtureJSON.bool(value, path: path))
        case .instant:
            let string = try FixtureJSON.string(value, path: path)
            if string.isEmpty { return .null }
            return .instant(try FixtureDates.parseInstant(string, path: path))
        case .relation:
            let string = try FixtureJSON.string(value, path: path)
            return string.isEmpty ? .null : .text(string)
        case .periods:
            let array = try FixtureJSON.array(value, path: path)
            let periods = try array.enumerated().map { index, element in
                try FixtureJSON.string(element, path: "\(path)[\(index)]")
            }
            return .periods(Array(Set(periods)).sorted())
        }
    }

    private static func assertExpectedError(
        caseID: String,
        expected: ExpectedError,
        thrown: Error,
        captures: [String: String]
    ) throws {
        guard let actualCode = canonicalErrorCode(thrown) else {
            throw ParityFailure(
                "case \(caseID): expected \(expected.code), received unrecognized error \(thrown)"
            )
        }
        guard actualCode == expected.code else {
            throw ParityFailure(
                "case \(caseID): expected error code \(expected.code), actual \(actualCode)"
            )
        }

        let financeError = thrown as? FinanceError
        if let expectedEntity = expected.entity {
            guard financeError?.entity == expectedEntity else {
                throw ParityFailure(
                    "case \(caseID): expected error entity '\(expectedEntity)', actual '\(financeError?.entity ?? "nil")'"
                )
            }
        }
        if let expectedID = expected.entityID {
            let resolved: String
            if let name = FixtureTokens.name(in: expectedID) {
                guard let identifier = captures[name] else {
                    throw ParityFailure(
                        "case \(caseID): unresolved capture reference '\(expectedID)' in error entity_id"
                    )
                }
                resolved = identifier
            } else {
                resolved = expectedID
            }
            guard financeError?.entityID == resolved else {
                throw ParityFailure(
                    "case \(caseID): expected error entity_id '\(resolved)', actual '\(financeError?.entityID ?? "nil")'"
                )
            }
        }
    }

    private static func canonicalErrorCode(_ error: Error) -> String? {
        if let financeError = error as? FinanceError {
            switch financeError.code {
            case .validation: return "validation"
            case .notFound: return "not_found"
            case .conflict: return "conflict"
            case .referenced: return "referenced"
            case .alreadyRealized: return "already_realized"
            case .alreadyPaid: return "already_paid"
            case .invalidIdentifier: return "invalid_identifier"
            case .invalidState: return "invalid_state"
            case .writeFailed: return "storage_failure"
            case .corruptData, .unsupportedSchema: return "storage_failure"
            }
        }
        if let storeError = error as? StoreError {
            switch storeError {
            case .sqlite, .openFailed, .corruptDatabase, .migrationFailed,
                 .notOpen, .invalidDirectory, .backupExclusionFailed,
                 .protectionFailed, .unsupportedSchemaVersion:
                return "storage_failure"
            case .invalidArgument, .invalidImport, .invalidServerEntity, .corruptRecord:
                return "validation"
            case .unsupportedCommand, .unsupportedOperation, .noOperationMapping,
                 .operationNotFound, .identifierRemapAmbiguous,
                 .conflictingAcknowledgement, .immutableOperationConflict,
                 .stationIdentityMismatch, .pendingOperationsPresent,
                 .snapshotImportPending,
                 .syncStopped, .pairedAutomaticRecurrenceDisabled:
                return "invalid_state"
            }
        }
        return nil
    }
}
