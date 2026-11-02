import SwiftUI
import ObolCore
import ObolNativeRuntime

/// Invoice rows for the selected card. Each row shows one product
/// `CardInvoiceSummary` and links to its detail surface. The virtual
/// `PROJECTED` row is labelled as a preview and is never treated as stored.
struct InvoiceTimeline: View {
    let summaries: [CardInvoiceSummary]
    let card: Card?

    private struct Entry: Identifiable {
        let id: String
        let summary: CardInvoiceSummary
    }

    private var entries: [Entry] {
        summaries.map { Entry(id: CardsModel.invoiceIdentity(of: $0), summary: $0) }
    }

    @ViewBuilder
    var body: some View {
        if summaries.isEmpty {
            emptyState
        } else {
            ForEach(entries) { entry in
                row(entry.summary)
            }
        }
    }

    private func row(_ summary: CardInvoiceSummary) -> some View {
        NavigationLink {
            InvoiceDetailView(summary: summary, card: card)
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text(CardsModel.periodLabel(summary.period))
                        .font(.headline)
                        .lineLimit(2)
                        .allowsTightening(true)
                    Spacer(minLength: 12)
                    Text(AppFormatting.currency(summary.totalAmount))
                        .font(.headline)
                        .cardMoneyText()
                }
                HStack(alignment: .firstTextBaseline) {
                    Text(CardsModel.statusText(for: summary.status))
                        .font(.caption)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .overlay(
                            Capsule()
                                .strokeBorder(CardsModel.statusTint(for: summary.status))
                        )
                    Spacer(minLength: 12)
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("Due \(AppFormatting.day(summary.dueDate))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text("Spent \(AppFormatting.currency(summary.totalSpent))")
                            .font(.caption)
                            .cardMoneyText()
                            .foregroundStyle(.secondary)
                    }
                }
                if summary.isProjected {
                    Label("Projection preview", systemImage: "eye")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .frame(minHeight: 44)
            .padding(.vertical, 4)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(Text(accessibilityText(summary)))
            .accessibilityHint(Text(summary.isProjected
                ? "Projected preview; nothing is stored for this invoice."
                : "Opens the invoice detail."))
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "doc.text")
                .font(.title2)
                .foregroundStyle(.secondary)
            Text("No invoices for this card yet")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text("Record a purchase to start the first invoice.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .accessibilityElement(children: .combine)
    }

    private func accessibilityText(_ summary: CardInvoiceSummary) -> String {
        let status = summary.isProjected
            ? "Projected preview"
            : "\(CardsModel.statusText(for: summary.status)), due \(AppFormatting.day(summary.dueDate))"
        return "\(CardsModel.periodLabel(summary.period)). \(status). Debt \(AppFormatting.currency(summary.totalAmount)). Spent \(AppFormatting.currency(summary.totalSpent))."
    }
}
