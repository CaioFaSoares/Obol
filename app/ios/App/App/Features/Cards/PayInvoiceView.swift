import Foundation
import SwiftUI
import ObolCore
import ObolNativeRuntime

/// Payment sheet for one stored invoice. Three real commands are offered:
/// a full payment into a bank account, a partial payment, and a silent payoff
/// with no account debit.
///
/// The remaining debt and invoice state are re-read from the canonical
/// projection, so a stale presentation cannot pay more than what exists.
/// Failed submissions keep the sheet open with the entered values.
struct PayInvoiceView: View {
    let card: Card
    let summary: CardInvoiceSummary

    init(card: Card, summary: CardInvoiceSummary) {
        self.card = card
        self.summary = summary
    }

    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    private enum Mode: Hashable {
        case full
        case partial
        case silent
    }

    @State private var mode: Mode = .full
    @State private var accountID: String?
    @State private var amountText = ""
    @State private var isSubmitting = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                debtSection
                if let live = liveInvoice {
                    if live.status == .paid || live.totalAmount <= 0 {
                        settledSection
                    } else {
                        modeSection
                        if mode == .silent {
                            silentSection
                        } else {
                            accountSection
                        }
                    }
                } else {
                    missingSection
                }
                if let message = errorText {
                    Section {
                        Label(message, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }
            .scrollDismissesKeyboard(.immediately)
            .navigationTitle("Pay invoice")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if payable {
                        Button("Pay") {
                            Task { await submit() }
                        }
                        .disabled(submitDisabled || isSubmitting)
                    }
                }
            }
            .keyboardDoneToolbar()
        }
        .interactiveDismissDisabled(isSubmitting)
    }

    // MARK: - Live state

    /// Current stored row for this invoice, or `nil` when it was deleted.
    /// Projected rows are never payable.
    private var liveInvoice: CardInvoiceSummary? {
        guard summary.id != nil,
              let summaries = try? CardsModel.invoiceSummaries(
                snapshot: appState.snapshot,
                cardID: card.id
              ) else {
            return nil
        }
        return summaries.first { $0.id == summary.id }
    }

    private var remainingDebt: Decimal {
        liveInvoice?.totalAmount ?? 0
    }

    private var accounts: [Account] {
        appState.snapshot.accounts.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    private var parsedAmount: Decimal {
        CardMoney.parse(amountText)
    }

    private var payable: Bool {
        guard let live = liveInvoice else { return false }
        return live.status != .paid && live.totalAmount > 0
    }

    private var submitDisabled: Bool {
        guard payable else { return true }
        switch mode {
        case .full:
            return accountID == nil
        case .partial:
            return accountID == nil || parsedAmount <= 0 || parsedAmount > remainingDebt
        case .silent:
            return false
        }
    }

    // MARK: - Sections

    private var debtSection: some View {
        Section {
            LabeledContent("Remaining debt") {
                Text(AppFormatting.currency(remainingDebt)).cardMoneyText()
            }
            LabeledContent("Due date") {
                Text(AppFormatting.day((liveInvoice ?? summary).dueDate))
            }
        } footer: {
            Text("A full payment realizes the pending charges. A partial payment records the amount paid and keeps the invoice open. A silent payoff marks the invoice paid without debiting any account.")
        }
    }

    private var settledSection: some View {
        Section {
            Label(
                "This invoice is marked paid, so no payment can be recorded. A silent payoff keeps the recorded paid amount unchanged, so the stored remaining value can be above zero.",
                systemImage: "checkmark.circle"
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
    }

    private var missingSection: some View {
        Section {
            Label(
                "This invoice no longer exists. Close this sheet and refresh the card timeline.",
                systemImage: "questionmark.folder"
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
    }

    private var modeSection: some View {
        Section("Payment type") {
            Picker("Payment type", selection: $mode) {
                Text("Pay in full").tag(Mode.full)
                Text("Partial payment").tag(Mode.partial)
                Text("Silent payoff").tag(Mode.silent)
            }
            .pickerStyle(.inline)
            .labelsHidden()
            .disabled(isSubmitting)

            if mode == .partial {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Amount")
                    TextField("Amount", text: $amountText)
                        .accessibilityLabel(Text("Amount"))
                        .keyboardType(.decimalPad)
                        .monospacedDigit()
                        .frame(minHeight: 44)
                        .disabled(isSubmitting)
                    Text("Up to \(AppFormatting.currency(remainingDebt)).")
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(parsedAmount > remainingDebt ? Color.red : Color.secondary)
                }
            }
        }
    }

    private var accountSection: some View {
        Section {
            Picker("Bank account", selection: $accountID) {
                Text("Select an account").tag(Optional<String>.none)
                ForEach(accounts) { account in
                    Text(account.name).tag(Optional(account.id))
                }
            }
            .disabled(isSubmitting)
        } header: {
            Text("Account")
        } footer: {
            Text(accounts.isEmpty
                ? "No account exists yet. Create one in Management, or use a silent payoff."
                : "The amount is debited from this account when the invoice is paid.")
        }
    }

    private var silentSection: some View {
        Section {
            Label(
                "No account is debited. Use a silent payoff when the money was already handled outside Obol.",
                systemImage: "moon.zzz"
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
    }

    // MARK: - Mutation

    private func submit() async {
        guard !isSubmitting, submitDisabled == false, let live = liveInvoice else { return }
        guard live.status != .paid, live.totalAmount > 0 else {
            errorText = "This invoice has no remaining debt."
            return
        }
        isSubmitting = true
        errorText = nil

        let command: FinancialCommand
        switch mode {
        case .full:
            guard let accountID else {
                errorText = "Select the bank account that pays this invoice."
                isSubmitting = false
                return
            }
            command = .payInvoice(
                cardID: card.id,
                period: summary.period,
                accountID: accountID,
                amount: nil,
                ignoreBalance: false
            )
        case .partial:
            guard let accountID else {
                errorText = "Select the bank account that pays this invoice."
                isSubmitting = false
                return
            }
            guard parsedAmount > 0 else {
                errorText = "Enter an amount greater than zero."
                isSubmitting = false
                return
            }
            guard parsedAmount <= live.totalAmount else {
                errorText = "The amount cannot exceed the remaining debt of \(AppFormatting.currency(live.totalAmount))."
                isSubmitting = false
                return
            }
            command = .payInvoice(
                cardID: card.id,
                period: summary.period,
                accountID: accountID,
                amount: parsedAmount,
                ignoreBalance: false
            )
        case .silent:
            command = .payInvoice(
                cardID: card.id,
                period: summary.period,
                accountID: nil,
                amount: nil,
                ignoreBalance: true
            )
        }

        do {
            try await appState.apply(command)
            dismiss()
        } catch {
            // The sheet stays open and every entered value is retained.
            errorText = error.localizedDescription
        }
        isSubmitting = false
    }
}
