import Foundation
import SwiftUI
import ObolCore
import ObolNativeRuntime

/// Recurrence editor and controller. `nil` creates a new recurrence; a stored
/// recurrence opens the edit form plus the supported scheduling actions:
/// pause, resume, manual launch of the next period, and end.
///
/// The update path builds a `RecurrencePatch` that distinguishes an omitted
/// field (`nil`, unchanged) from an explicit `.clear`. References are always
/// chosen from the current snapshot and an item never carries both an account
/// and a card.
struct RecurrenceEditor: View {
    let original: Recurrence?

    private enum Destination: Hashable {
        case unassigned
        case account
        case card
    }

    private static let dayOptions = Array(1...31)

    init(recurrence: Recurrence?) {
        original = recurrence
        _name = State(initialValue: recurrence?.name ?? "")
        _amountText = State(initialValue: recurrence.map { NSDecimalNumber(decimal: $0.amount).stringValue } ?? "")
        _type = State(initialValue: recurrence?.type ?? .expense)
        _frequency = State(initialValue: recurrence?.cadence ?? .monthly)
        _weekday = State(initialValue: min(7, max(1, recurrence?.weekday ?? 1)))
        _payday = State(initialValue: min(31, max(1, recurrence?.payday ?? 1)))
        let destination: Destination
        if recurrence?.cardID != nil {
            destination = .card
        } else if recurrence?.accountID != nil {
            destination = .account
        } else {
            destination = .unassigned
        }
        _destination = State(initialValue: destination)
        _accountID = State(initialValue: recurrence?.accountID)
        _cardID = State(initialValue: recurrence?.cardID)
        _categoryID = State(initialValue: recurrence?.categoryID)
        _hasEndDate = State(initialValue: recurrence?.endDate != nil)
        _endDate = State(
            initialValue: recurrence?.endDate.map(ManagementFormDates.localDate(forUTCDay:)) ?? Date()
        )
        _hasInstallments = State(initialValue: recurrence?.totalInstallments != nil)
        _installmentText = State(
            initialValue: recurrence?.totalInstallments.map { String($0) } ?? ""
        )
    }

    private var editing: Bool { original != nil }

    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var name: String
    @State private var amountText: String
    @State private var type: RecurrenceType
    @State private var frequency: RecurrenceFrequency
    @State private var weekday: Int
    @State private var payday: Int
    @State private var destination: Destination
    @State private var accountID: String?
    @State private var cardID: String?
    @State private var categoryID: String?
    @State private var hasEndDate: Bool
    @State private var endDate: Date
    @State private var hasInstallments: Bool
    @State private var installmentText: String

    @State private var isSubmitting = false
    @State private var isMutating = false
    @State private var confirmEnd = false
    @State private var infoText: String?
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                formSection
                destinationSection
                schedulingSection
                if let message = infoText {
                    Section {
                        Label(message, systemImage: "info.circle")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                if let message = errorText {
                    Section {
                        Label(message, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
                if editing {
                    statusSection
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(editing ? "Edit recurrence" : "New recurrence")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(editing ? "Close" : "Cancel") { dismiss() }
                        .disabled(isSubmitting || isMutating)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(editing ? "Save changes" : "Create") {
                        Task { await submit() }
                    }
                    .disabled(submitDisabled || isSubmitting || isMutating)
                }
            }
            .keyboardDoneToolbar()
            .confirmationDialog(
                "End this recurrence?",
                isPresented: $confirmEnd,
                titleVisibility: .visible
            ) {
                Button("End recurrence", role: .destructive) {
                    Task { await endRecurrence() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The recurrence stops generating months. Transactions it already generated stay in place.")
            }
            .onChange(of: destination) { next in
                switch next {
                case .unassigned:
                    accountID = nil
                    cardID = nil
                case .account:
                    cardID = nil
                case .card:
                    accountID = nil
                }
            }
        }
        .interactiveDismissDisabled(isSubmitting || isMutating)
    }

    // MARK: - Live store state

    /// Current stored recurrence, when editing. Status actions always use this
    /// copy so they match what the store actually holds.
    private var liveRecurrence: Recurrence? {
        guard let original else { return nil }
        return appState.snapshot.recurrence(id: original.id)
    }

    private var amount: Decimal {
        ManagementMoney.parse(amountText)
    }

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var parsedInstallments: Int? {
        guard hasInstallments else { return nil }
        let trimmed = installmentText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let value = Int(trimmed), value > 0 else { return nil }
        return value
    }

    private var effectiveAccountID: String? {
        destination == .account ? accountID : nil
    }

    private var effectiveCardID: String? {
        destination == .card ? cardID : nil
    }

    private var effectiveEndDate: Date? {
        hasEndDate ? ManagementFormDates.utcDay(fromLocal: endDate) : nil
    }

    /// Only a weekly recurrence carries a weekday; monthly rows store none.
    private var effectiveWeekday: Int? {
        frequency == .weekly ? weekday : nil
    }

    private var submitDisabled: Bool {
        if trimmedName.isEmpty { return true }
        if amount <= 0 { return true }
        if hasInstallments && parsedInstallments == nil { return true }
        switch destination {
        case .unassigned:
            return false
        case .account:
            return accountID == nil || appState.snapshot.account(id: accountID ?? "") == nil
        case .card:
            return cardID == nil || appState.snapshot.card(id: cardID ?? "") == nil
        }
    }

    private var accounts: [Account] {
        appState.snapshot.accounts.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    private var cards: [Card] {
        appState.snapshot.cards.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    private var categories: [ObolCore.Category] {
        appState.snapshot.categories.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    // MARK: - Sections

    private var formSection: some View {
        Section {
            TextField("Name", text: $name)
                .accessibilityLabel(Text("Name"))
                .frame(minHeight: 44)
                .disabled(isBusy)
            ManagementMoneyField(title: "Amount", text: $amountText)
                .disabled(isBusy)
            Picker("Type", selection: $type) {
                Text("Expense").tag(RecurrenceType.expense)
                Text("Income").tag(RecurrenceType.income)
            }
            .disabled(isBusy)
        } header: {
            Text("Recurrence")
        } footer: {
            Text("Amounts are exact; the engine stores every amount with two decimal places.")
        }
    }

    private var destinationSection: some View {
        Section {
            Picker("Charged to", selection: $destination) {
                Text("No account or card").tag(Destination.unassigned)
                Text("Bank account").tag(Destination.account)
                Text("Card").tag(Destination.card)
            }
            .disabled(isBusy)

            if destination == .account {
                Picker("Bank account", selection: $accountID) {
                    Text("Select an account").tag(Optional<String>.none)
                    ForEach(accounts) { account in
                        Text(account.name).tag(Optional(account.id))
                    }
                }
                .disabled(isBusy)
            }
            if destination == .card {
                Picker("Card", selection: $cardID) {
                    Text("Select a card").tag(Optional<String>.none)
                    ForEach(cards) { card in
                        Text(card.name).tag(Optional(card.id))
                    }
                }
                .disabled(isBusy)
            }

            Picker("Budget category", selection: $categoryID) {
                Text("No category").tag(Optional<String>.none)
                ForEach(categories) { category in
                    Text(category.name).tag(Optional(category.id))
                }
            }
            .disabled(isBusy)
        } header: {
            Text("Destination")
        } footer: {
            Text("A recurrence uses either a bank account or a card, never both. With neither, the pending occurrence still affects the aggregate cash forecast.")
        }
    }

    private var schedulingSection: some View {
        Section {
            Picker("Cadence", selection: $frequency) {
                Text("Monthly").tag(RecurrenceFrequency.monthly)
                Text("Weekly").tag(RecurrenceFrequency.weekly)
            }
            .disabled(isBusy)

            if frequency == .weekly {
                Picker("Weekday", selection: $weekday) {
                    ForEach(1...7, id: \.self) { day in
                        Text(RecurrenceCadenceLabel.weekdayName(day)).tag(day)
                    }
                }
                .disabled(isBusy)
            } else {
                Picker("Day of month", selection: $payday) {
                    ForEach(Self.dayOptions, id: \.self) { day in
                        Text("\(day)").tag(day)
                    }
                }
                .disabled(isBusy)
            }

            LabeledContent("Occurrence") {
                Text(RecurrenceCadenceLabel.title(
                    frequency: frequency,
                    payday: payday,
                    weekday: weekday
                ))
            }

            Toggle("End date", isOn: $hasEndDate)
                .disabled(isBusy)
            if hasEndDate {
                DatePicker("End date", selection: $endDate, displayedComponents: [.date])
                    .disabled(isBusy)
            }

            Toggle("Limit installments", isOn: $hasInstallments)
                .disabled(isBusy)
            if hasInstallments {
                TextField("Total installments", text: $installmentText)
                    .accessibilityLabel(Text("Total installments"))
                    .keyboardType(.numberPad)
                    .monospacedDigit()
                    .frame(minHeight: 44)
                    .disabled(isBusy)
                Text("Enter a positive number of installments, or turn the limit off for an open recurrence.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Schedule")
        } footer: {
            Text(schedulingFooter)
        }
    }

    private var schedulingFooter: String {
        var parts: [String] = []
        switch frequency {
        case .monthly:
            parts.append("Monthly occurrences use the UTC day you pick and clamp to the month length. Occurrences after the end date or past the installment limit end the recurrence.")
        case .weekly:
            parts.append("Weekly occurrences use the UTC ISO week, Monday to Sunday. The date is exact and never clamps, and installments count weekly occurrences. Occurrences after the end date or past the installment limit end the recurrence.")
        }
        if cadenceChanged {
            parts.append("Changing the cadence applies from now on. Transactions already generated stay in place, and switching to weekly can add weekly transactions in the current month.")
        }
        return parts.joined(separator: " ")
    }

    /// True when a stored recurrence would change cadence with the current form.
    private var cadenceChanged: Bool {
        guard let original else { return false }
        return original.cadence != frequency
    }

    // MARK: - Status actions

    @ViewBuilder
    private var statusSection: some View {
        if let recurrence = liveRecurrence {
            Section {
                LabeledContent("Status") {
                    Text(RecurrenceStatusLabel.title(for: recurrence.status))
                }
                if recurrence.status == .active {
                    ManagementMutationButton(title: "Pause", systemImage: "pause") {
                        Task { await setStatus(.paused) }
                    }
                    .disabled(isBusy)
                } else if recurrence.status == .paused {
                    ManagementMutationButton(title: "Resume", systemImage: "play") {
                        Task { await setStatus(.active) }
                    }
                    .disabled(isBusy)
                }
                if recurrence.status != .ended {
                    ManagementMutationButton(
                        title: recurrence.cadence == .weekly ? "Launch next week" : "Launch next month",
                        systemImage: "bolt.badge.clock"
                    ) {
                        Task { await launch(recurrence) }
                    }
                    .disabled(isBusy)
                    ManagementMutationButton(
                        title: "End recurrence",
                        systemImage: "octagon",
                        destructive: true
                    ) {
                        confirmEnd = true
                    }
                    .disabled(isBusy)
                }
            } footer: {
                if recurrence.status == .ended {
                    Text("Ended recurrences stay listed and cannot be launched manually.")
                } else if recurrence.cadence == .weekly {
                    Text("Launching creates the pending transaction for the next ISO week. If that week already has its occurrence, the attempt fails with the store's own message.")
                } else {
                    Text("Launching creates the pending transaction for the next month. If that month already exists, the attempt fails with the store's own message.")
                }
            }
        } else {
            Section {
                Label(
                    "This recurrence no longer exists in the store.",
                    systemImage: "questionmark.folder"
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
        }
    }

    private var isBusy: Bool {
        isSubmitting || isMutating
    }

    // MARK: - Mutations

    private func submit() async {
        guard !isSubmitting, !isMutating, !submitDisabled else { return }
        infoText = nil
        if editing {
            await saveChanges()
        } else {
            await create()
        }
    }

    private func create() async {
        isSubmitting = true
        errorText = nil
        defer { isSubmitting = false }

        let recurrence = Recurrence(
            name: trimmedName,
            amount: amount,
            payday: payday,
            type: type,
            status: .active,
            accountID: effectiveAccountID,
            cardID: effectiveCardID,
            categoryID: categoryID,
            endDate: effectiveEndDate,
            totalInstallments: parsedInstallments,
            frequency: frequency,
            weekday: effectiveWeekday
        )
        do {
            try await appState.apply(.createRecurrence(recurrence))
            dismiss()
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func saveChanges() async {
        guard let live = liveRecurrence else {
            errorText = "This recurrence no longer exists. Close this screen and start again."
            return
        }

        // Compare against the record the form was opened with, so only fields
        // the user actually edited are sent and unrelated remote changes are
        // never overwritten.
        let base = original ?? live
        let patch = buildPatch(against: base)
        guard !patchIsEmpty(patch) else {
            infoText = "No changes to save."
            return
        }

        isSubmitting = true
        errorText = nil
        defer { isSubmitting = false }

        do {
            try await appState.apply(.updateRecurrence(id: live.id, patch: patch))
            dismiss()
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func buildPatch(against recurrence: Recurrence) -> RecurrencePatch {
        var patch = RecurrencePatch()
        if trimmedName != recurrence.name { patch.name = trimmedName }
        if amount != recurrence.amount { patch.amount = amount }
        if payday != recurrence.payday { patch.payday = payday }
        if type != recurrence.type { patch.type = type }
        if frequency != recurrence.cadence { patch.frequency = .set(frequency) }

        patch.accountID = fieldPatch(new: effectiveAccountID, current: recurrence.accountID)
        patch.cardID = fieldPatch(new: effectiveCardID, current: recurrence.cardID)
        patch.categoryID = fieldPatch(new: categoryID, current: recurrence.categoryID)
        patch.endDate = dayPatch(new: effectiveEndDate, current: recurrence.endDate)
        patch.totalInstallments = installmentsPatch(new: parsedInstallments, current: recurrence.totalInstallments)
        // A monthly row stores no weekday, so leaving the cadence clears it.
        if effectiveWeekday != recurrence.weekday {
            patch.weekday = effectiveWeekday.map { .set($0) } ?? .clear
        }
        return patch
    }

    private func patchIsEmpty(_ patch: RecurrencePatch) -> Bool {
        patch.name == nil
            && patch.amount == nil
            && patch.payday == nil
            && patch.type == nil
            && patch.status == nil
            && patch.accountID == nil
            && patch.cardID == nil
            && patch.categoryID == nil
            && patch.endDate == nil
            && patch.totalInstallments == nil
            && patch.skippedPeriods == nil
            && patch.frequency == nil
            && patch.weekday == nil
    }

    /// Omitted when unchanged; `.set` or `.clear` only for a genuine change.
    private func fieldPatch<Value>(new: Value?, current: Value?) -> PatchField<Value>?
    where Value: Codable & Equatable & Sendable {
        guard new != current else { return nil }
        if let new { return .set(new) }
        return .clear
    }

    /// End dates are business days, so the comparison uses the UTC day key.
    private func dayPatch(new: Date?, current: Date?) -> PatchField<Date>? {
        guard new.map(ObolDate.dayKey) != current.map(ObolDate.dayKey) else { return nil }
        if let new { return .set(new) }
        return .clear
    }

    private func installmentsPatch(new: Int?, current: Int?) -> PatchField<Int>? {
        fieldPatch(new: new, current: current)
    }

    private func setStatus(_ status: RecurrenceStatus) async {
        guard !isBusy, let live = liveRecurrence else { return }
        isMutating = true
        errorText = nil
        infoText = nil
        defer { isMutating = false }
        do {
            try await appState.apply(.setRecurrenceStatus(id: live.id, status: status))
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func endRecurrence() async {
        guard !isBusy else { return }
        await setStatus(.ended)
    }

    /// Manual launch of the next period: the next UTC month for a monthly row,
    /// the occurrence of the next UTC ISO week for a weekly row. The reported
    /// result is derived from the store after the command.
    private func launch(_ recurrence: Recurrence) async {
        guard !isBusy else { return }
        isMutating = true
        errorText = nil
        infoText = nil
        defer { isMutating = false }

        let weekly = recurrence.cadence == .weekly
        let targetKey: String
        if weekly, let weekday = recurrence.weekday {
            let nextWeek = ObolDate.addingDays(7, to: ObolDate.startOfISOWeek(Date()))
            targetKey = ObolDate.weeklyOccurrenceKey(nextWeek, weekday: weekday)
        } else if weekly {
            errorText = "This recurrence has no weekday, so it cannot be launched."
            return
        } else {
            let targetMonth = ObolDate.addingMonths(1, to: ObolDate.startOfMonth(Date()))
            targetKey = ObolDate.monthKey(targetMonth)
        }
        let targetLabel = weekly ? targetKey : ManagementFormDates.monthLabel(targetKey)

        do {
            try await appState.apply(.launchRecurrence(id: recurrence.id))
        } catch {
            errorText = error.localizedDescription
            return
        }

        let created = appState.snapshot.transactions.contains { transaction in
            guard transaction.recurrenceID == recurrence.id else { return false }
            let occurrenceDate = transaction.purchaseDate ?? transaction.expectedDate
            let key = weekly
                ? ObolDate.dayKey(occurrenceDate)
                : ObolDate.monthKey(occurrenceDate)
            return key == targetKey
        }
        if created {
            infoText = "Created the pending transaction for \(targetLabel)."
        } else if appState.snapshot.recurrence(id: recurrence.id)?.status == .ended {
            infoText = "No new \(weekly ? "week" : "month") was generated: the schedule is complete or past its end date, so the recurrence is now ended."
        } else {
            infoText = "No new \(weekly ? "week" : "month") was generated for \(targetLabel)."
        }
    }
}
