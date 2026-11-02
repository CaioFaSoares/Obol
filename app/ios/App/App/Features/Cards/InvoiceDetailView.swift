import SwiftUI
import ObolCore
import ObolNativeRuntime

/// Detail for one invoice of the projection: status, amounts, stored and
/// projected charge lines, the payment entry point, and invoice maintenance.
///
/// The presented `summary` is only the routing key. Live amounts, status and
/// lines are re-read from `ForecastEngine.cardInvoiceSummaries` on every
/// render, so a payment or deletion updates this screen immediately.
struct InvoiceDetailView: View {
    let summary: CardInvoiceSummary
    let card: Card?

    init(summary: CardInvoiceSummary, card: Card?) {
        self.summary = summary
        self.card = card
    }

    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var showPaySheet = false
    @State private var confirmInvoiceDelete = false
    @State private var pendingCharge: ChargeEntry?
    @State private var isMutating = false
    @State private var errorText: String?

    var body: some View {
        List {
            if let live = liveSummary {
                totalsSection(live)
                chargesSection(live)
                if live.isProjected {
                    projectedNoticeSection
                } else {
                    maintenanceSection(live)
                }
            } else {
                missingInvoiceSection
            }
            if let message = errorText {
                Section {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
        }
        .navigationTitle(navigationTitle)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showPaySheet) {
            if let card, let live = liveSummary {
                PayInvoiceView(card: card, summary: live)
            }
        }
        .confirmationDialog(
            "Delete this invoice?",
            isPresented: $confirmInvoiceDelete,
            titleVisibility: .visible
        ) {
            Button("Delete invoice", role: .destructive) {
                Task { await deleteInvoice() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Stored charges are removed and their financial effects are reversed. Recurring charges mark the invoice period as skipped so the recurrence is not regenerated. Payments already made stay in the ledger.")
        }
        .confirmationDialog(
            "Delete this charge?",
            isPresented: chargeDeletionBinding,
            titleVisibility: .visible
        ) {
            Button("Delete charge", role: .destructive) {
                if let charge = pendingCharge {
                    Task { await deleteCharge(charge) }
                }
            }
            Button("Cancel", role: .cancel) {
                pendingCharge = nil
            }
        } message: {
            Text("The charge is removed and its financial effect is reversed. A recurring charge also marks the occurrence as skipped so it is not regenerated.")
        }
    }

    private var chargeDeletionBinding: Binding<Bool> {
        Binding(
            get: { pendingCharge != nil },
            set: { presented in
                if !presented { pendingCharge = nil }
            }
        )
    }

    private var navigationTitle: String {
        let label = CardsModel.periodLabel(summary.period)
        return (liveSummary ?? summary).isProjected ? "\(label) · Projected" : label
    }

    // MARK: - Live projection lookup

    /// Current row for the same stored invoice or projected period. `nil`
    /// after the invoice was deleted or the selected card changed.
    private var liveSummary: CardInvoiceSummary? {
        guard let cardID = card?.id,
              let summaries = try? CardsModel.invoiceSummaries(
                snapshot: appState.snapshot,
                cardID: cardID
              ) else {
            return nil
        }
        if let id = summary.id {
            return summaries.first { $0.id == id }
        }
        // A projected navigation row may have become a stored invoice (for
        // example after a sync). The same card and period is the same invoice.
        return summaries.first { $0.period == summary.period }
    }

    // MARK: - Sections

    private func totalsSection(_ live: CardInvoiceSummary) -> some View {
        Section {
            LabeledContent("Status") {
                HStack(spacing: 6) {
                    Text(CardsModel.statusText(for: live.status))
                        .font(.caption)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .overlay(
                            Capsule()
                                .strokeBorder(CardsModel.statusTint(for: live.status))
                        )
                }
            }
            LabeledContent("Due date") {
                Text(AppFormatting.day(live.dueDate))
            }
            LabeledContent(live.isProjected ? "Projected debt" : "Debt") {
                Text(AppFormatting.currency(live.totalAmount)).cardMoneyText()
            }
            LabeledContent("Paid") {
                Text(AppFormatting.currency(live.paidAmount)).cardMoneyText()
            }
            LabeledContent("Gross spent") {
                Text(AppFormatting.currency(live.totalSpent)).cardMoneyText()
            }
        } header: {
            Text("Invoice")
        } footer: {
            if live.isProjected {
                Text("This row is a preview; no invoice is stored for this period yet.")
            } else if live.status == .paid {
                Text("Debt is the stored remaining amount. A silent payoff marks the invoice paid without changing the recorded paid amount.")
            } else {
                Text("Debt is the remaining amount of this invoice. Gross spent is the sum of its charge lines.")
            }
        }
    }

    fileprivate struct ChargeEntry: Identifiable {
        let id: String
        let line: CardInvoiceLine
        let title: String
    }

    private func chargeEntries(_ live: CardInvoiceSummary) -> [ChargeEntry] {
        let names = CardsModel.recurrenceNames(snapshot: appState.snapshot)
        return live.transactions.map {
            ChargeEntry(
                id: CardsModel.lineIdentity(of: $0),
                line: $0,
                title: CardsModel.lineTitle($0, recurrenceNames: names)
            )
        }
    }

    @ViewBuilder
    private func chargesSection(_ live: CardInvoiceSummary) -> some View {
        Section {
            ForEach(chargeEntries(live)) { entry in
                if entry.line.id != nil && !live.isProjected {
                    ChargeRow(entry: entry)
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                pendingCharge = entry
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                            Button {
                                if let id = entry.line.id {
                                    appState.editTransaction(id: id)
                                }
                            } label: {
                                Label("Edit", systemImage: "pencil")
                            }
                        }
                } else {
                    ChargeRow(entry: entry)
                }
            }
            if live.transactions.isEmpty {
                Text("No charges recorded for this invoice yet.")
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("Charges")
        } footer: {
            Text(live.isProjected
                ? "Projected lines come from active card recurrences. They cannot be paid, edited or deleted."
                : "Swipe a stored charge to edit or delete it. Projected lines are not stored and stay read-only.")
        }
    }

    private var projectedNoticeSection: some View {
        Section {
            Label(
                "Projected preview. Nothing is stored for this period, so it cannot be paid or deleted. Its charges appear when the recurrence runs.",
                systemImage: "eye"
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
    }

    private func maintenanceSection(_ live: CardInvoiceSummary) -> some View {
        Section {
            if live.status != .paid && live.totalAmount > 0 {
                Button {
                    showPaySheet = true
                } label: {
                    Label("Pay invoice", systemImage: "banknote")
                        .frame(minHeight: 44)
                }
                .disabled(isMutating)
            }

            Button(role: .destructive) {
                confirmInvoiceDelete = true
            } label: {
                Label("Delete invoice", systemImage: "trash")
                    .frame(minHeight: 44)
            }
            .disabled(isMutating)
        } footer: {
            if live.status == .paid {
                Text("This invoice is already paid.")
            } else if live.totalAmount <= 0 {
                Text("This invoice has no remaining debt to pay.")
            } else {
                Text("A payment debits one bank account. A silent payoff, with no account debit, is also available in the payment sheet.")
            }
        }
    }

    private var missingInvoiceSection: some View {
        Section {
            Label(
                "This invoice no longer exists. It was deleted or the card selection changed.",
                systemImage: "questionmark.folder"
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
    }

    // MARK: - Mutations

    private func deleteCharge(_ entry: ChargeEntry) async {
        guard !isMutating, let id = entry.line.id else { return }
        isMutating = true
        errorText = nil
        defer {
            isMutating = false
            pendingCharge = nil
        }
        do {
            try await appState.apply(.deleteTransaction(id: id))
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func deleteInvoice() async {
        guard !isMutating else { return }
        guard let card, summary.id != nil else {
            errorText = "A projected invoice cannot be deleted because nothing is stored yet."
            return
        }
        isMutating = true
        errorText = nil
        defer { isMutating = false }
        do {
            try await appState.apply(.deleteInvoice(cardID: card.id, period: summary.period))
            dismiss()
        } catch {
            errorText = error.localizedDescription
        }
    }
}

/// One charge line: stored rows and projected recurrences share the layout; the
/// projected row states its kind explicitly and exposes no actions.
private struct ChargeRow: View {
    let entry: InvoiceDetailView.ChargeEntry

    private var line: CardInvoiceLine { entry.line }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 3) {
                Text(entry.title)
                    .lineLimit(2)
                    .allowsTightening(true)
                Text(dateText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(line.status.badgeTitle)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 12)
            Text(AppFormatting.currency(line.amount))
                .font(.subheadline)
                .cardMoneyText()
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("\(entry.title), \(line.status.badgeTitle), \(AppFormatting.currency(line.amount)), \(dateText)"))
    }

    private var dateText: String {
        let date = line.purchaseDate ?? line.expectedDate
        return line.isProjected
            ? "Expected purchase \(AppFormatting.day(date))"
            : "Purchase \(AppFormatting.day(date))"
    }
}
