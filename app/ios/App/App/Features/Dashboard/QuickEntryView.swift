import Foundation
import SwiftUI
import ObolCore
import ObolNativeRuntime

/// Quick entry sheet: real income, expense and transfer, plus scheduled and
/// simulated variants. Every write goes through `AppState.apply`, which commits
/// to the local SQLite store before publishing the new snapshot. The sheet only
/// closes after that awaited write succeeds; on failure every field is kept.
public struct QuickEntryView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var kind: QuickEntryKind = .expense
    @State private var source: QuickEntrySource = .account
    @State private var amountText = ""
    @State private var title = ""
    @State private var date = Date()
    @State private var accountID = ""
    @State private var destinationAccountID = ""
    @State private var cardID = ""
    @State private var categoryID = ""
    @State private var projectID = ""
    @State private var isSimulated = false
    @State private var isScheduled = false
    @State private var isSubmitting = false
    @State private var errorMessage: String?

    @State private var accounts: [Account] = []
    @State private var liquidAccounts: [Account] = []
    @State private var cards: [Card] = []
    @State private var categories: [ObolCore.Category] = []
    @State private var projects: [Project] = []

    public init() {}

    public var body: some View {
        NavigationStack {
            Form {
                entrySection
                sourceSection
                detailsSection
                variantsSection
                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .accessibilityLabel(Text("Error: \(errorMessage)"))
                    }
                }
                submitSection
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Quick Entry")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSubmitting)
                }
            }
            .keyboardDoneToolbar()
            .interactiveDismissDisabled(isSubmitting)
            .onAppear { rebuildOptions() }
            .onChange(of: appState.snapshot) { _ in rebuildOptions() }
            .onChange(of: kind) { newValue in
                if newValue == .transfer {
                    isSimulated = false
                    isScheduled = false
                }
            }
            .onChange(of: isSimulated) { newValue in
                if newValue {
                    isScheduled = false
                    source = .account
                }
            }
            .onChange(of: isScheduled) { newValue in
                if newValue {
                    isSimulated = false
                    source = .account
                }
            }
        }
    }

    // MARK: Sections

    private var entrySection: some View {
        Section("Entry") {
            Picker("Type", selection: $kind) {
                ForEach(QuickEntryKind.allCases) { kind in
                    Text(kind.title).tag(kind)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityLabel(Text("Entry type"))

            HStack {
                Text("Amount")
                Spacer(minLength: 12)
                TextField("0.00", text: $amountText)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .monospacedDigit()
                    .accessibilityLabel(Text("Amount in Brazilian reais"))
            }

            TextField("Description", text: $title)
                .accessibilityLabel(Text("Description"))

            DatePicker(
                isScheduled ? "Due date" : "Date",
                selection: $date,
                displayedComponents: .date
            )
        }
    }

    @ViewBuilder
    private var sourceSection: some View {
        if kind == .transfer {
            Section {
                accountPicker(title: "From", selection: $accountID, pool: liquidAccounts)
                accountPicker(
                    title: "To",
                    selection: $destinationAccountID,
                    pool: liquidAccounts,
                    excluding: accountID
                )
            } header: {
                Text("Accounts")
            } footer: {
                Text("Transfers move cash between two different liquid accounts and never count as income or expense.")
            }
        } else if isScheduled || isSimulated {
            Section {
                accountPicker(title: "Account (optional)", selection: $accountID, pool: accounts)
            } header: {
                Text(isScheduled ? "Scheduled payment" : "Simulation")
            } footer: {
                Text(isScheduled
                    ? "Scheduled entries stay pending until you confirm them on their due date. They still count in the aggregate forecast."
                    : "Simulated entries never change real cash, invoices or project totals. They only affect the preview while simulations are on.")
            }
        } else {
            Section {
                Picker("Source", selection: $source) {
                    Text("Account").tag(QuickEntrySource.account)
                    Text("Card").tag(QuickEntrySource.card)
                }
                .pickerStyle(.segmented)
                .accessibilityLabel(Text("Payment source"))

                if source == .account {
                    accountPicker(title: "Account", selection: $accountID, pool: accounts)
                } else {
                    Picker("Card", selection: $cardID) {
                        Text("Select a card").tag("")
                        ForEach(cards) { card in
                            Text(card.name).tag(card.id)
                        }
                    }
                }
            } header: {
                Text("Source")
            } footer: {
                Text(source == .card
                    ? "Card purchases stay pending and are charged on the invoice due date, not on the purchase date."
                    : "Real income and expenses require the account they belong to.")
            }
        }
    }

    @ViewBuilder
    private var detailsSection: some View {
        Section {
            if kind != .transfer {
                Picker("Budget category", selection: $categoryID) {
                    Text("None").tag("")
                    ForEach(categories) { category in
                        Text(category.name).tag(category.id)
                    }
                }
            }
            if kind == .income {
                Picker("Project", selection: $projectID) {
                    Text("None").tag("")
                    ForEach(projects) { project in
                        Text(project.name).tag(project.id)
                    }
                }
            }
        } header: {
            Text("Details")
        } footer: {
            if kind == .income {
                Text("Project totals count realized, non-simulated income only.")
            } else if kind != .transfer {
                Text("Budget accrual includes pending and simulated entries, so the category is planning data.")
            }
        }
    }

    @ViewBuilder
    private var variantsSection: some View {
        if kind != .transfer {
            Section("Variants") {
                Toggle(isOn: $isSimulated) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Simulate")
                        Text("What-if only, until you explicitly convert it.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Toggle(isOn: $isScheduled) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Scheduled")
                        Text("An agenda obligation that needs manual confirmation.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    @MainActor
    private var submitSection: some View {
        Section {
            Button {
                Task { @MainActor in submit() }
            } label: {
                HStack(spacing: 8) {
                    Spacer()
                    if isSubmitting {
                        ProgressView()
                    }
                    Text(submitLabel)
                        .font(.headline)
                    Spacer()
                }
                .frame(minHeight: 44)
            }
            .disabled(isSubmitting || appState.isWorking)
            .accessibilityLabel(Text(submitLabel))
        } footer: {
            if appState.isWorking {
                Text("Another change is still saving.")
            }
        }
    }

    @ViewBuilder
    private func accountPicker(
        title: String,
        selection: Binding<String>,
        pool: [Account],
        excluding excludedID: String? = nil
    ) -> some View {
        Picker(title, selection: selection) {
            Text("Select an account").tag("")
            ForEach(pool.filter { $0.id != excludedID }) { account in
                Text(account.name).tag(account.id)
            }
        }
    }

    // MARK: Copy

    private var submitLabel: String {
        if isScheduled { return "Schedule entry" }
        if isSimulated { return "Create simulation" }
        switch kind {
        case .transfer: return "Transfer"
        case .income: return "Add income"
        case .expense: return "Add expense"
        }
    }

    // MARK: Options

    @MainActor
    private func rebuildOptions() {
        let snapshot = appState.snapshot
        accounts = snapshot.accounts.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        liquidAccounts = accounts.filter { $0.type != .investment }
        cards = snapshot.cards.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        categories = snapshot.categories.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        projects = snapshot.projects.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }

        if !accountID.isEmpty, !accounts.contains(where: { $0.id == accountID }) { accountID = "" }
        if !destinationAccountID.isEmpty, !accounts.contains(where: { $0.id == destinationAccountID }) {
            destinationAccountID = ""
        }
        if !cardID.isEmpty, !cards.contains(where: { $0.id == cardID }) { cardID = "" }
        if !categoryID.isEmpty, !categories.contains(where: { $0.id == categoryID }) { categoryID = "" }
        if !projectID.isEmpty, !projects.contains(where: { $0.id == projectID }) { projectID = "" }
    }

    // MARK: Submit

    @MainActor
    private func submit() {
        guard !isSubmitting, !appState.isWorking else { return }
        let draft: TransactionDraft
        do {
            draft = try makeDraft()
        } catch {
            errorMessage = error.localizedDescription
            return
        }
        errorMessage = nil
        isSubmitting = true
        Task { @MainActor in
            defer { isSubmitting = false }
            do {
                try await appState.apply(.createTransaction(draft), effectiveAt: Date())
                dismiss()
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func makeDraft() throws -> TransactionDraft {
        guard let amount = QuickEntryAmountParser.parse(amountText), amount > 0 else {
            throw QuickEntryValidationError(message: "Enter an amount greater than zero.")
        }
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else {
            throw QuickEntryValidationError(message: "Enter a description for this entry.")
        }

        let day = ObolDate.startOfDay(date)
        let today = ObolDate.startOfDay(Date())

        switch kind {
        case .transfer:
            guard !isSimulated, !isScheduled else {
                throw QuickEntryValidationError(message: "A transfer cannot be simulated or scheduled.")
            }
            guard !accountID.isEmpty else {
                throw QuickEntryValidationError(message: "Select the source account.")
            }
            guard !destinationAccountID.isEmpty else {
                throw QuickEntryValidationError(message: "Select the destination account.")
            }
            guard accountID != destinationAccountID else {
                throw QuickEntryValidationError(message: "The source and destination accounts must be different.")
            }
            guard let sourceAccount = accounts.first(where: { $0.id == accountID }),
                  sourceAccount.type != .investment,
                  let destinationAccount = accounts.first(where: { $0.id == destinationAccountID }),
                  destinationAccount.type != .investment else {
                throw QuickEntryValidationError(message: "Transfers run between liquid checking or savings accounts.")
            }
            guard day <= today else {
                throw QuickEntryValidationError(message: "A real transfer cannot be dated in the future.")
            }
            return TransactionDraft(
                title: trimmedTitle,
                amount: amount,
                type: .transfer,
                status: .realized,
                expectedDate: day,
                realizedDate: day,
                isSimulated: false,
                isScheduled: false,
                accountID: accountID,
                destinationAccountID: destinationAccountID
            )

        case .income, .expense:
            let type: TransactionType = kind == .income ? .income : .expense
            let selectedCategory = categoryID.isEmpty ? nil : categoryID
            let selectedProject = (type == .income && !projectID.isEmpty) ? projectID : nil
            let plannedAccount = accountID.isEmpty ? nil : accountID

            if isScheduled {
                return TransactionDraft(
                    title: trimmedTitle,
                    amount: amount,
                    type: type,
                    status: .pending,
                    expectedDate: day,
                    isSimulated: false,
                    isScheduled: true,
                    accountID: plannedAccount,
                    categoryID: selectedCategory,
                    projectID: selectedProject
                )
            }

            if isSimulated {
                return TransactionDraft(
                    title: trimmedTitle,
                    amount: amount,
                    type: type,
                    status: .pending,
                    expectedDate: day,
                    isSimulated: true,
                    isScheduled: false,
                    accountID: plannedAccount,
                    categoryID: selectedCategory,
                    projectID: selectedProject
                )
            }

            switch source {
            case .account:
                guard !accountID.isEmpty else {
                    throw QuickEntryValidationError(message: "Select the account for this entry.")
                }
                guard day <= today else {
                    throw QuickEntryValidationError(message: "A future-dated entry must be scheduled or simulated.")
                }
                return TransactionDraft(
                    title: trimmedTitle,
                    amount: amount,
                    type: type,
                    status: .realized,
                    expectedDate: day,
                    realizedDate: day,
                    isSimulated: false,
                    isScheduled: false,
                    accountID: accountID,
                    categoryID: selectedCategory,
                    projectID: selectedProject
                )
            case .card:
                guard !cardID.isEmpty else {
                    throw QuickEntryValidationError(message: "Select the card used for this purchase.")
                }
                return TransactionDraft(
                    title: trimmedTitle,
                    amount: amount,
                    type: type,
                    status: .pending,
                    expectedDate: day,
                    purchaseDate: day,
                    isSimulated: false,
                    isScheduled: false,
                    cardID: cardID,
                    categoryID: selectedCategory,
                    projectID: selectedProject
                )
            }
        }
    }
}

// MARK: - Local types

private enum QuickEntryKind: String, CaseIterable, Identifiable {
    case expense
    case income
    case transfer

    var id: String { rawValue }

    var title: String {
        switch self {
        case .expense: return "Expense"
        case .income: return "Income"
        case .transfer: return "Transfer"
        }
    }
}

private enum QuickEntrySource: String, CaseIterable, Identifiable {
    case account
    case card

    var id: String { rawValue }
}

private struct QuickEntryValidationError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Parses a money field without going through `Double`.
///
/// Both `1.234,56` and `1234.56` are accepted. A lone separator followed by
/// three digits is read as a grouping separator, because currency carries at
/// most two decimals. The parsed `Decimal` is handed to ObolCore, which owns
/// rounding and every other monetary rule.
private enum QuickEntryAmountParser {
    static func parse(_ raw: String) -> Decimal? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        var digits = ""
        for character in trimmed where character.isNumber || character == "." || character == "," {
            digits.append(character)
        }
        guard digits.contains(where: { $0.isNumber }) else { return nil }

        let commas = digits.filter { $0 == "," }.count
        let dots = digits.filter { $0 == "." }.count
        let normalized: String

        if commas > 0, dots > 0 {
            if let lastComma = digits.lastIndex(of: ","), let lastDot = digits.lastIndex(of: ".") {
                if lastComma > lastDot {
                    normalized = digits
                        .replacingOccurrences(of: ".", with: "")
                        .replacingOccurrences(of: ",", with: ".")
                } else {
                    normalized = digits.replacingOccurrences(of: ",", with: "")
                }
            } else {
                normalized = digits
            }
        } else if commas > 0 {
            normalized = singleSeparatorText(digits, separator: ",", count: commas)
        } else if dots > 0 {
            normalized = singleSeparatorText(digits, separator: ".", count: dots)
        } else {
            normalized = digits
        }

        guard let value = Decimal(string: normalized, locale: Locale(identifier: "en_US_POSIX")) else {
            return nil
        }
        return value
    }

    private static func singleSeparatorText(_ text: String, separator: Character, count: Int) -> String {
        guard count == 1, let index = text.firstIndex(of: separator) else {
            return text.replacingOccurrences(of: String(separator), with: "")
        }
        let fraction = text[text.index(after: index)...]
        if !fraction.isEmpty, fraction.count <= 2, fraction.allSatisfy({ $0.isNumber }) {
            return text.replacingOccurrences(of: String(separator), with: ".")
        }
        return text.replacingOccurrences(of: String(separator), with: "")
    }
}
