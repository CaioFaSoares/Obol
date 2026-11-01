import SwiftUI
import Foundation
import ObolCore
import ObolNativeRuntime

// Shared transaction editor. Root presents this view for a stored id; it loads
// the actual record from the published snapshot, builds a partial
// TransactionPatch from the fields the user actually changed, and delegates
// every reversal and application rule to the ObolCore engine through
// AppState.apply.
//
// The view performs no network access, fabricates no draft for a missing row,
// and keeps the form intact when persistence fails.

public struct TransactionEditorView: View {
    public let transactionID: String

    public init(transactionID: String) {
        self.transactionID = transactionID
    }

    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    @State private var form: TransactionEditorForm?
    @State private var isWorking = false
    @State private var errorMessage: String?
    @State private var isDeleteDialogPresented = false

    private var stored: ObolCore.Transaction? {
        appState.snapshot.transaction(id: transactionID)
    }

    private var pendingConflict: ConflictRecord? {
        appState.conflicts.first {
            $0.entityType == .transaction
                && $0.entityId == transactionID
                && $0.resolution == .pending
        }
    }

    private var isBusy: Bool {
        isWorking || appState.isWorking
    }

    public var body: some View {
        NavigationStack {
            content
                .navigationTitle("Edit transaction")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") {
                            // Cancel never mutates and never persists.
                            dismiss()
                        }
                        .disabled(isWorking)
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            save()
                        }
                        .disabled(isBusy || form == nil || stored == nil)
                    }
                }
                .keyboardDoneToolbar()
        }
        .onAppear {
            loadFormIfNeeded()
        }
        .onChange(of: appState.snapshot) { _ in
            loadFormIfNeeded()
        }
        .onChange(of: transactionID) { _ in
            form = nil
            errorMessage = nil
            isDeleteDialogPresented = false
            loadFormIfNeeded()
        }
        .interactiveDismissDisabled(isWorking)
        .alert("Could not complete the change", isPresented: errorPresented) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
        .confirmationDialog(
            "Delete transaction",
            isPresented: $isDeleteDialogPresented,
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                delete()
            }
            .disabled(isBusy)

            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This record's balance and invoice effects are reversed. If a recurrence generated it, its month is recorded as skipped. Deletion cannot be undone.")
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if let current = stored {
            if let editForm = form {
                editorForm(editForm: editForm, stored: current)
            } else {
                loadingView
            }
        } else if appState.isLoading {
            loadingView
        } else {
            missingRecordView
        }
    }

    private var loadingView: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Loading record…")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Loading transaction")
    }

    private var missingRecordView: some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.title)
                .accessibilityHidden(true)
            Text("Transaction not found")
                .font(.headline)
            Text("This transaction no longer exists in the local store. It may have been deleted or replaced through sync, so there is nothing to edit.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button("Close") {
                dismiss()
            }
            .buttonStyle(.bordered)
            .frame(minHeight: 44)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func loadFormIfNeeded() {
        guard form == nil, let current = stored else { return }
        form = TransactionEditorForm(transaction: current)
    }

    // MARK: - Form

    private func editorForm(editForm: TransactionEditorForm, stored: ObolCore.Transaction) -> some View {
        List {
            if let conflict = pendingConflict {
                Section {
                    conflictBanner(conflict: conflict)
                }
            }

            if stored != editForm.original {
                Section {
                    changedRecordNotice
                }
            }

            if appState.isWorking {
                Section {
                    Label(
                        "Another operation is still running. Saving and deleting are unavailable until it finishes.",
                        systemImage: "arrow.triangle.2.circlepath"
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }

            Section("Current record") {
                statusSummary(stored: stored)
            }

            Section {
                titleField
                amountField(editForm: editForm)
                typeField
            } header: {
                Text("Details")
            } footer: {
                Text("Amounts are stored at two decimal places; the finance engine owns rounding.")
            }

            Section {
                sourceFields(editForm: editForm)
            } header: {
                Text("Source")
            } footer: {
                Text(sourceFooter(editForm: editForm))
            }

            Section {
                dateFields(editForm: editForm, stored: stored)
            } header: {
                Text("Dates")
            } footer: {
                Text(dateFooter(editForm: editForm))
            }

            if flagsVisible(editForm: editForm, stored: stored) {
                Section {
                    Toggle("Scheduled", isOn: scheduledBinding)
                        .frame(minHeight: 44)
                    Toggle("Simulation", isOn: simulatedBinding)
                        .frame(minHeight: 44)
                } header: {
                    Text("Flags")
                } footer: {
                    Text("Scheduled entries stay pending until you confirm them on their due date. Simulations never change real cash, invoices or project totals; convert a simulation before realizing it.")
                }
            }

            Section {
                deleteButton
            }
        }
        .listStyle(.insetGrouped)
        .scrollDismissesKeyboard(.interactively)
        .disabled(isWorking)
    }

    private var titleField: some View {
        TextField("Title", text: bind(\.title, fallback: ""))
            .textInputAutocapitalization(.sentences)
            .autocorrectionDisabled()
            .frame(minHeight: 44)
            .accessibilityLabel("Transaction title")
    }

    @ViewBuilder
    private func amountField(editForm: TransactionEditorForm) -> some View {
        let preview = TransactionEditorPatchBuilder.parseAmount(editForm.amountText)
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 6) {
                amountTextField
                amountPreview(preview)
            }
            .frame(minHeight: 44)
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                amountTextField
                amountPreview(preview)
            }
            .frame(minHeight: 44)
        }
    }

    private var amountTextField: some View {
        TextField("0.00", text: bind(\.amountText, fallback: ""))
            .keyboardType(.decimalPad)
            .monospacedDigit()
            .accessibilityLabel("Amount in Brazilian reais")
    }

    @ViewBuilder
    private func amountPreview(_ amount: Decimal?) -> some View {
        if let amount {
            Text(AppFormatting.currency(amount))
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("Rounded amount \(AppFormatting.currency(amount))")
        }
    }

    private var typeField: some View {
        Picker("Type", selection: typeBinding) {
            Text("Income").tag(ObolCore.TransactionType.income)
            Text("Expense").tag(ObolCore.TransactionType.expense)
            Text("Transfer").tag(ObolCore.TransactionType.transfer)
        }
        .frame(minHeight: 44)
        .accessibilityLabel("Transaction type")
    }

    @ViewBuilder
    private func sourceFields(editForm: TransactionEditorForm) -> some View {
        if editForm.type == .transfer {
            Picker("Source account", selection: transferSourceBinding) {
                Text("Select account").tag(Optional<String>.none)
                ForEach(sortedAccounts) { account in
                    Text(account.name).tag(Optional(account.id))
                }
            }
            .frame(minHeight: 44)

            Picker("Destination account", selection: bind(\.destinationID, fallback: Optional<String>.none)) {
                Text("Select a different account").tag(Optional<String>.none)
                ForEach(sortedAccounts.filter { $0.id != editForm.accountID }) { account in
                    Text(account.name).tag(Optional(account.id))
                }
            }
            .frame(minHeight: 44)
        } else {
            Picker("Source", selection: sourceKindBinding) {
                Text("Account").tag(TransactionEditorForm.SourceKind.account)
                Text("Card").tag(TransactionEditorForm.SourceKind.card)
            }
            .pickerStyle(.segmented)
            .frame(minHeight: 44)
            .accessibilityLabel("Transaction source")

            if editForm.sourceKind == .card {
                Picker("Source card", selection: bind(\.cardID, fallback: Optional<String>.none)) {
                    Text("Select card").tag(Optional<String>.none)
                    ForEach(sortedCards) { card in
                        Text(card.name).tag(Optional(card.id))
                    }
                }
                .frame(minHeight: 44)
            } else {
                Picker("Source account", selection: bind(\.accountID, fallback: Optional<String>.none)) {
                    Text("Unassigned").tag(Optional<String>.none)
                    ForEach(sortedAccounts) { account in
                        Text(account.name).tag(Optional(account.id))
                    }
                }
                .frame(minHeight: 44)
            }

            Picker("Category", selection: bind(\.categoryID, fallback: Optional<String>.none)) {
                Text("No category").tag(Optional<String>.none)
                ForEach(sortedCategories) { category in
                    Text(category.name).tag(Optional(category.id))
                }
            }
            .frame(minHeight: 44)

            Picker("Project", selection: bind(\.projectID, fallback: Optional<String>.none)) {
                Text("No project").tag(Optional<String>.none)
                ForEach(sortedProjects) { project in
                    Text(project.name).tag(Optional(project.id))
                }
            }
            .frame(minHeight: 44)
        }
    }

    @ViewBuilder
    private func dateFields(editForm: TransactionEditorForm, stored: ObolCore.Transaction) -> some View {
        if usesCardPurchase(editForm) {
            datePicker("Purchase date", selection: bind(\.purchaseDate, fallback: editForm.purchaseDate))
        } else {
            datePicker("Expected date", selection: bind(\.expectedDate, fallback: editForm.expectedDate))
        }

        if stored.status == .realized && editForm.original.status == .realized {
            datePicker("Realized on", selection: bind(\.realizedDate, fallback: editForm.realizedDate))
        }
    }

    private func datePicker(_ title: String, selection: Binding<Date>) -> some View {
        DatePicker(title, selection: selection, displayedComponents: [.date])
            .frame(minHeight: 44)
    }

    private func flagsVisible(editForm: TransactionEditorForm, stored: ObolCore.Transaction) -> Bool {
        editForm.original.status == .pending
            && stored.status == .pending
            && editForm.type != .transfer
    }

    private func statusSummary(stored: ObolCore.Transaction) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(statusText(stored: stored), systemImage: "info.circle")
            Text("Amount \(AppFormatting.currency(stored.amount))")
            if stored.cardID != nil {
                if let invoiceID = stored.invoiceID, let invoice = appState.snapshot.invoice(id: invoiceID) {
                    Text("Invoice \(invoice.period) due \(AppFormatting.day(invoice.dueDate))")
                } else if stored.isSimulated == true {
                    Text("Projected invoice due \(AppFormatting.day(stored.expectedDate))")
                } else {
                    Text("Invoice due \(AppFormatting.day(stored.expectedDate))")
                }
            }
            if stored.status == .realized, let realizedDate = stored.realizedDate {
                Text("Realized \(AppFormatting.day(realizedDate))")
            }
            if let created = stored.created {
                Text("Created \(AppFormatting.timestamp(created))")
            }
            if let updated = stored.updated {
                Text("Updated \(AppFormatting.timestamp(updated))")
            }
            Text(stored.id)
                .font(.system(.footnote, design: .monospaced))
                .textSelection(.enabled)
        }
        .font(.footnote)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
    }

    private var changedRecordNotice: some View {
        Label(
            "This transaction changed after you opened the editor. Only the fields you changed are saved; review the current record above.",
            systemImage: "arrow.triangle.2.circlepath"
        )
        .font(.footnote)
        .foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var deleteButton: some View {
        Button(role: .destructive) {
            isDeleteDialogPresented = true
        } label: {
            Label("Delete transaction", systemImage: "trash")
                .frame(maxWidth: .infinity, alignment: .center)
                .frame(minHeight: 44)
        }
        .disabled(isBusy)
    }

    private func statusText(stored: ObolCore.Transaction) -> String {
        var parts: [String] = [stored.status == .realized ? "Realized" : "Pending"]
        if stored.isSimulated == true { parts.append("simulation") }
        if stored.isScheduled == true { parts.append("scheduled") }
        if stored.isSilent == true { parts.append("silent") }
        if stored.invoiceID != nil { parts.append("invoiced") }
        if stored.recurrenceID != nil { parts.append("recurring") }
        return parts.joined(separator: " · ")
    }

    private func sourceFooter(editForm: TransactionEditorForm) -> String {
        if editForm.type == .transfer {
            return "Transfers move cash between two different accounts and never count as income or expense."
        }
        if editForm.sourceKind == .card {
            return "Card transactions affect cash only when their invoice is paid. The purchase date drives invoice routing."
        }
        return "Income and expenses without an account remain unassigned and still count in the aggregate cash forecast. Project totals count realized, non-simulated income only."
    }

    private func dateFooter(editForm: TransactionEditorForm) -> String {
        if usesCardPurchase(editForm) {
            return "The invoice due date is derived from this purchase date by the finance engine."
        }
        return "Financial dates use UTC. The expected date drives forecasts until the transaction is realized."
    }

    private func conflictBanner(conflict: ConflictRecord) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(.orange)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("Server conflict")
                    .font(.subheadline.weight(.semibold))
                Text(conflict.message)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Button("Open Settings") {
                appState.selectedTab = .settings
                dismiss()
            }
            .buttonStyle(.bordered)
            .frame(minHeight: 44)
        }
        .accessibilityElement(children: .contain)
    }

    // MARK: - Sorted option lists

    private var sortedAccounts: [ObolCore.Account] {
        appState.snapshot.accounts.sorted {
            let order = $0.name.localizedCaseInsensitiveCompare($1.name)
            return order == .orderedSame ? $0.id < $1.id : order == .orderedAscending
        }
    }

    private var sortedCards: [ObolCore.Card] {
        appState.snapshot.cards.sorted {
            let order = $0.name.localizedCaseInsensitiveCompare($1.name)
            return order == .orderedSame ? $0.id < $1.id : order == .orderedAscending
        }
    }

    private var sortedCategories: [ObolCore.Category] {
        appState.snapshot.categories.sorted {
            let order = $0.name.localizedCaseInsensitiveCompare($1.name)
            return order == .orderedSame ? $0.id < $1.id : order == .orderedAscending
        }
    }

    private var sortedProjects: [ObolCore.Project] {
        appState.snapshot.projects.sorted {
            let order = $0.name.localizedCaseInsensitiveCompare($1.name)
            return order == .orderedSame ? $0.id < $1.id : order == .orderedAscending
        }
    }

    // MARK: - Bindings

    private func bind<T>(
        _ keyPath: WritableKeyPath<TransactionEditorForm, T>,
        fallback: T
    ) -> Binding<T> {
        Binding(
            get: { form?[keyPath: keyPath] ?? fallback },
            set: { value in
                guard var current = form else { return }
                current[keyPath: keyPath] = value
                form = current
            }
        )
    }

    private var typeBinding: Binding<ObolCore.TransactionType> {
        Binding(
            get: { form?.type ?? .expense },
            set: { newType in
                guard var current = form, current.type != newType else { return }
                if newType == .transfer {
                    // The transfer date is the visible expected date. Carry
                    // the purchase date over so the visible day is stable.
                    if current.sourceKind == .card {
                        current.expectedDate = current.purchaseDate
                    }
                    current.scheduled = false
                    current.simulated = false
                }
                current.type = newType
                form = current
            }
        )
    }

    private var transferSourceBinding: Binding<String?> {
        Binding(
            get: { form?.accountID },
            set: { value in
                guard var current = form, current.accountID != value else { return }
                current.accountID = value
                if current.destinationID == value {
                    current.destinationID = nil
                }
                form = current
            }
        )
    }

    private var sourceKindBinding: Binding<TransactionEditorForm.SourceKind> {
        Binding(
            get: { form?.sourceKind ?? .account },
            set: { newKind in
                guard var current = form, current.sourceKind != newKind else { return }
                if newKind == .card {
                    // The date field changes from expected to purchase date;
                    // keep the day the user is looking at.
                    current.purchaseDate = current.expectedDate
                    current.accountID = nil
                } else {
                    current.expectedDate = current.purchaseDate
                    current.cardID = nil
                }
                current.sourceKind = newKind
                form = current
            }
        )
    }

    private var scheduledBinding: Binding<Bool> {
        Binding(
            get: { form?.scheduled ?? false },
            set: { value in
                guard var current = form, current.scheduled != value else { return }
                current.scheduled = value
                if value { current.simulated = false }
                form = current
            }
        )
    }

    private var simulatedBinding: Binding<Bool> {
        Binding(
            get: { form?.simulated ?? false },
            set: { value in
                guard var current = form, current.simulated != value else { return }
                current.simulated = value
                if value { current.scheduled = false }
                form = current
            }
        )
    }

    private func usesCardPurchase(_ editForm: TransactionEditorForm) -> Bool {
        editForm.type != .transfer
            && editForm.sourceKind == .card
            && editForm.cardID != nil
    }

    // MARK: - Save

    private func save() {
        guard !isBusy else { return }
        guard let editForm = form else {
            errorMessage = "The transaction is still loading."
            return
        }
        guard let current = stored else {
            errorMessage = "This transaction no longer exists in the local store."
            return
        }
        if let validationMessage = validate(editForm) {
            errorMessage = validationMessage
            return
        }
        guard let patch = TransactionEditorPatchBuilder.buildPatch(
            form: editForm,
            currentStatus: current.status
        ) else {
            // No field differs from the record the form was loaded from:
            // nothing is persisted.
            dismiss()
            return
        }

        isWorking = true
        errorMessage = nil
        Task { @MainActor in
            defer { isWorking = false }
            do {
                try await appState.apply(.updateTransaction(id: transactionID, patch: patch))
                dismiss()
            } catch {
                // The form keeps every edited value so the user can retry.
                errorMessage = Self.describe(error)
            }
        }
    }

    private func delete() {
        guard !isBusy else { return }
        guard stored != nil else {
            errorMessage = "This transaction no longer exists in the local store."
            return
        }
        isWorking = true
        errorMessage = nil
        Task { @MainActor in
            defer { isWorking = false }
            do {
                try await appState.apply(.deleteTransaction(id: transactionID))
                dismiss()
            } catch {
                errorMessage = Self.describe(error)
            }
        }
    }

    private func validate(_ editForm: TransactionEditorForm) -> String? {
        if editForm.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Enter a transaction title."
        }
        guard let amount = TransactionEditorPatchBuilder.parseAmount(editForm.amountText),
              !amount.isNaN,
              amount > 0,
              Money.roundCurrency(amount) > 0 else {
            return "Enter a valid amount greater than zero."
        }

        if editForm.type == .transfer {
            guard let source = editForm.accountID else {
                return "A transfer requires a source account."
            }
            guard let destination = editForm.destinationID else {
                return "A transfer requires a destination account."
            }
            guard source != destination else {
                return "A transfer cannot use the same account on both sides."
            }
            guard appState.snapshot.account(id: source) != nil else {
                return "The source account no longer exists."
            }
            guard appState.snapshot.account(id: destination) != nil else {
                return "The destination account no longer exists."
            }
            return nil
        }

        if editForm.sourceKind == .card {
            guard let cardID = editForm.cardID else {
                return "Select the card used for this transaction."
            }
            guard appState.snapshot.card(id: cardID) != nil else {
                return "The selected card no longer exists."
            }
        } else if let accountID = editForm.accountID {
            guard appState.snapshot.account(id: accountID) != nil else {
                return "The selected account no longer exists."
            }
        }

        if let categoryID = editForm.categoryID,
           appState.snapshot.category(id: categoryID) == nil {
            return "The selected category no longer exists."
        }
        if let projectID = editForm.projectID,
           appState.snapshot.project(id: projectID) == nil {
            return "The selected project no longer exists."
        }

        return nil
    }

    private var errorPresented: Binding<Bool> {
        Binding(
            get: { errorMessage != nil },
            set: { presented in
                if !presented { errorMessage = nil }
            }
        )
    }

    private static func describe(_ error: Error) -> String {
        if let financeError = error as? ObolCore.FinanceError {
            return financeError.message
        }
        return error.localizedDescription
    }
}

// MARK: - Form state

struct TransactionEditorForm {
    enum SourceKind: Hashable {
        case account
        case card
    }

    let original: ObolCore.Transaction
    let initialExpectedDate: Date
    let initialPurchaseDate: Date
    let initialRealizedDate: Date

    var title: String
    var amountText: String
    var type: ObolCore.TransactionType
    var sourceKind: SourceKind
    var accountID: String?
    var cardID: String?
    var destinationID: String?
    var categoryID: String?
    var projectID: String?
    var scheduled: Bool
    var simulated: Bool
    var expectedDate: Date
    var purchaseDate: Date
    var realizedDate: Date

    init(transaction: ObolCore.Transaction) {
        original = transaction
        title = transaction.title
        amountText = TransactionEditorPatchBuilder.amountText(transaction.amount)
        type = transaction.type
        sourceKind = transaction.cardID == nil ? .account : .card
        accountID = transaction.accountID
        cardID = transaction.cardID
        destinationID = transaction.destinationAccountID
        categoryID = transaction.categoryID
        projectID = transaction.projectID
        scheduled = transaction.isScheduled == true
        simulated = transaction.isSimulated == true

        let expected = LedgerFormDates.localDate(forUTC: transaction.expectedDate)
        let purchaseBase = transaction.purchaseDate ?? transaction.expectedDate
        let purchase = LedgerFormDates.localDate(forUTC: purchaseBase)
        let realizedBase = transaction.realizedDate ?? transaction.expectedDate
        let realized = LedgerFormDates.localDate(forUTC: realizedBase)
        expectedDate = expected
        purchaseDate = purchase
        realizedDate = realized
        initialExpectedDate = expected
        initialPurchaseDate = purchase
        initialRealizedDate = realized
    }
}

// MARK: - Patch builder

enum TransactionEditorPatchBuilder {
    private static let posixLocale = Locale(identifier: "en_US_POSIX")

    /// Parses a money field without going through `Double`.
    ///
    /// A single separator is read as the decimal separator, matching the web
    /// ledger editor. With both separators, the last one is decimal and the
    /// other is grouping. Repeated grouping separators are accepted; the
    /// parsed value is handed to ObolCore, which owns rounding.
    static func parseAmount(_ text: String) -> Decimal? {
        var cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        cleaned = cleaned.replacingOccurrences(of: " ", with: "")
        cleaned = cleaned.replacingOccurrences(of: "\u{00A0}", with: "")
        guard !cleaned.isEmpty else { return nil }
        guard !cleaned.contains(".."),
              !cleaned.contains(",,"),
              !cleaned.contains(".,"),
              !cleaned.contains(",.") else {
            return nil
        }

        let allowed = CharacterSet(charactersIn: "0123456789,.")
        guard cleaned.unicodeScalars.allSatisfy({ allowed.contains($0) }) else {
            return nil
        }

        let commas = cleaned.filter { $0 == "," }.count
        let dots = cleaned.filter { $0 == "." }.count
        let normalized: String

        if commas > 0 && dots > 0 {
            if let lastComma = cleaned.lastIndex(of: ","),
               let lastDot = cleaned.lastIndex(of: ".") {
                if lastComma > lastDot {
                    let whole = String(cleaned[..<lastComma])
                        .replacingOccurrences(of: ".", with: "")
                        .replacingOccurrences(of: ",", with: "")
                    let fraction = String(cleaned[cleaned.index(after: lastComma)...])
                    normalized = whole + "." + fraction
                } else {
                    let whole = String(cleaned[..<lastDot])
                        .replacingOccurrences(of: ",", with: "")
                        .replacingOccurrences(of: ".", with: "")
                    let fraction = String(cleaned[cleaned.index(after: lastDot)...])
                    normalized = whole + "." + fraction
                }
            } else {
                return nil
            }
        } else if commas > 0 {
            if commas == 1 {
                normalized = cleaned.replacingOccurrences(of: ",", with: ".")
            } else if let lastComma = cleaned.lastIndex(of: ",") {
                let fraction = String(cleaned[cleaned.index(after: lastComma)...])
                if !fraction.isEmpty && fraction.count <= 2 {
                    let whole = String(cleaned[..<lastComma]).replacingOccurrences(of: ",", with: "")
                    normalized = whole + "." + fraction
                } else {
                    normalized = cleaned.replacingOccurrences(of: ",", with: "")
                }
            } else {
                return nil
            }
        } else if dots > 0 {
            if dots == 1 {
                normalized = cleaned
            } else if let lastDot = cleaned.lastIndex(of: ".") {
                let fraction = String(cleaned[cleaned.index(after: lastDot)...])
                if !fraction.isEmpty && fraction.count <= 2 {
                    let whole = String(cleaned[..<lastDot]).replacingOccurrences(of: ".", with: "")
                    normalized = whole + "." + fraction
                } else {
                    normalized = cleaned.replacingOccurrences(of: ".", with: "")
                }
            } else {
                return nil
            }
        } else {
            normalized = cleaned
        }

        guard !normalized.isEmpty, normalized != ".", normalized != "," else {
            return nil
        }
        guard let value = Decimal(string: normalized, locale: posixLocale), !value.isNaN else {
            return nil
        }
        return value
    }

    /// Plain two-decimal input text, independent of locale.
    static func amountText(_ value: Decimal) -> String {
        LedgerDecimalText.plain(value)
    }

    /// Builds a partial patch from the fields the user actually changed.
    ///
    /// The comparison baseline is the record the form was loaded from, not the
    /// current snapshot. Omitted fields therefore preserve whatever the store
    /// holds now, and an explicit `.clear` is emitted only for a field the
    /// user genuinely removed. Returns nil when nothing changed.
    static func buildPatch(
        form: TransactionEditorForm,
        currentStatus: ObolCore.TransactionStatus
    ) -> ObolCore.TransactionPatch? {
        let original = form.original
        var patch = ObolCore.TransactionPatch()

        let trimmedTitle = form.title.trimmingCharacters(in: .whitespacesAndNewlines)
        if form.title != original.title, trimmedTitle != original.title {
            patch.title = trimmedTitle
        }
        let initialAmountText = TransactionEditorPatchBuilder.amountText(original.amount)
        if form.amountText != initialAmountText,
           let amount = parseAmount(form.amountText),
           amount != original.amount {
            patch.amount = amount
        }
        if form.type != original.type {
            patch.type = form.type
        }

        let isTransfer = form.type == .transfer
        if isTransfer {
            patch.accountID = changed(form.accountID, original.accountID)
            patch.destinationAccountID = changed(form.destinationID, original.destinationAccountID)
            if original.type != .transfer {
                // The record is becoming a transfer: card, category, project
                // and purchase-only date no longer apply.
                patch.cardID = clearIfPresent(original.cardID)
                patch.categoryID = clearIfPresent(original.categoryID)
                patch.projectID = clearIfPresent(original.projectID)
                patch.purchaseDate = clearDateIfPresent(original.purchaseDate)
            }
            if original.cardID != nil || dateChanged(form.expectedDate, form.initialExpectedDate) {
                patch.expectedDate = LedgerFormDates.utcDate(fromLocal: form.expectedDate)
            }
        } else if form.sourceKind == .card {
            patch.cardID = changed(form.cardID, original.cardID)
            if original.cardID == nil || original.type == .transfer {
                // The record is becoming a card transaction: a bank account
                // and a destination account no longer apply.
                patch.accountID = clearIfPresent(original.accountID)
                patch.destinationAccountID = clearIfPresent(original.destinationAccountID)
            }
            patch.categoryID = changed(form.categoryID, original.categoryID)
            patch.projectID = changed(form.projectID, original.projectID)
            if original.cardID == nil || dateChanged(form.purchaseDate, form.initialPurchaseDate) {
                patch.purchaseDate = .set(LedgerFormDates.utcDate(fromLocal: form.purchaseDate))
            }
        } else {
            patch.accountID = changed(form.accountID, original.accountID)
            if original.cardID != nil || original.type == .transfer {
                // The record is leaving a card or transfer origin: those
                // source-specific references no longer apply.
                patch.cardID = clearIfPresent(original.cardID)
                patch.destinationAccountID = clearIfPresent(original.destinationAccountID)
            }
            patch.categoryID = changed(form.categoryID, original.categoryID)
            patch.projectID = changed(form.projectID, original.projectID)
            if original.cardID != nil || dateChanged(form.expectedDate, form.initialExpectedDate) {
                patch.expectedDate = LedgerFormDates.utcDate(fromLocal: form.expectedDate)
            }
            if original.cardID != nil || original.type == .transfer {
                patch.purchaseDate = clearDateIfPresent(original.purchaseDate)
            }
        }

        if isTransfer {
            if original.type != .transfer {
                if original.isScheduled == true { patch.isScheduled = false }
                if original.isSimulated == true { patch.isSimulated = false }
            }
        } else if original.status == .pending && currentStatus == .pending {
            if form.scheduled != (original.isScheduled == true) {
                patch.isScheduled = form.scheduled
            }
            if form.simulated != (original.isSimulated == true) {
                patch.isSimulated = form.simulated
            }
        }

        if original.status == .realized && currentStatus == .realized {
            if dateChanged(form.realizedDate, form.initialRealizedDate) {
                patch.realizedDate = .set(LedgerFormDates.utcDate(fromLocal: form.realizedDate))
            }
        }

        return patch == ObolCore.TransactionPatch() ? nil : patch
    }

    private static func changed(_ newValue: String?, _ oldValue: String?) -> PatchField<String>? {
        guard newValue != oldValue else { return nil }
        if let newValue {
            return .set(newValue)
        }
        return .clear
    }

    private static func clearIfPresent(_ value: String?) -> PatchField<String>? {
        value == nil ? nil : .clear
    }

    private static func clearDateIfPresent(_ value: Date?) -> PatchField<Date>? {
        value == nil ? nil : .clear
    }

    private static func dateChanged(_ localDate: Date, _ initialLocalDate: Date) -> Bool {
        LedgerFormDates.dayKey(localDate) != LedgerFormDates.dayKey(initialLocalDate)
    }
}
