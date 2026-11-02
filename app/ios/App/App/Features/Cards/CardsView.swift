import SwiftUI
import ObolCore
import ObolNativeRuntime

/// Cards surface for one selected card: the stored plus projected invoice
/// timeline, card purchase entry, invoice detail, payment, and invoice
/// maintenance.
///
/// The view holds no financial state. Every row and amount comes from
/// `ForecastEngine.cardInvoiceSummaries` through ``CardsModel``; every mutation
/// is one `AppState.apply` command. Failed attempts keep their form open.
struct CardsView: View {
    init() {}

    @EnvironmentObject private var appState: AppState

    @State private var purchaseCard: Card?
    @State private var refreshError: String?

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Cards")
                .toolbar {
                    if selectedCard != nil {
                        ToolbarItem(placement: .primaryAction) {
                            Button {
                                purchaseCard = selectedCard
                            } label: {
                                Label("Record card purchase", systemImage: "plus")
                            }
                            .accessibilityLabel("Record a card purchase on the selected card")
                        }
                    }
                }
                .sheet(item: $purchaseCard) { card in
                    NewCardPurchaseSheet(card: card)
                }
                .refreshable { await reload() }
        }
        .onAppear(perform: normalizeSelection)
        .onChange(of: appState.snapshot.cards) { _ in normalizeSelection() }
    }

    // MARK: - Selection

    private var sortedCards: [Card] {
        appState.snapshot.cards.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    /// The selected card, falling back to the first stored card when the
    /// selection is empty or points at a card that no longer exists.
    private var selectedCard: Card? {
        if let id = appState.selectedCardID,
           let card = appState.snapshot.cards.first(where: { $0.id == id }) {
            return card
        }
        return sortedCards.first
    }

    private var selectionBinding: Binding<String?> {
        Binding(
            get: { selectedCard?.id },
            set: { appState.selectedCardID = $0 }
        )
    }

    /// Keeps the root selection valid without touching any other root state.
    private func normalizeSelection() {
        guard let resolved = selectedCard?.id else { return }
        if appState.selectedCardID != resolved {
            appState.selectedCardID = resolved
        }
    }

    // MARK: - Content

    @ViewBuilder
    private var content: some View {
        if appState.snapshot.cards.isEmpty {
            emptyState
        } else {
            cardsList
        }
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "creditcard")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text("No cards yet")
                .font(.headline)
            Text("Create a card in Management to start tracking invoices.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button {
                appState.selectedTab = .management
            } label: {
                Label("Open Management", systemImage: "slider.horizontal.3")
                    .frame(minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .accessibilityHint("Opens the Management tab to create a card")
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var cardsList: some View {
        // One product projection per render; the timeline and the debt summary
        // share the same value.
        let outcome = timelineOutcome
        return List {
            Section {
                Picker("Card", selection: selectionBinding) {
                    ForEach(sortedCards) { card in
                        Text(card.name).tag(Optional(card.id))
                    }
                }
            } header: {
                Text("Card")
            }

            summarySection(outcome)
            timelineSection(outcome)

            Section {
                Label(
                    "Rows marked Projected preview active card recurrences. They are not stored, cannot be paid, and add no charge until that invoice exists.",
                    systemImage: "eye"
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
            }

            if let message = refreshError {
                localErrorSection(message)
            }
            if let message = appState.lastError {
                Section {
                    Label(message, systemImage: "exclamationmark.icloud")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func summarySection(_ outcome: TimelineOutcome) -> some View {
        let debt = CardsModel.currentDebt(of: outcome.summaries)
        return Section {
            LabeledContent {
                Text(AppFormatting.currency(debt)).cardMoneyText()
            } label: {
                Text("Current debt")
            }
        } header: {
            Text(selectedCard?.name ?? "Card")
        } footer: {
            Text("Current debt counts stored, unpaid invoices only. The projected preview is excluded until it becomes a real invoice.")
        }
    }

    /// One product projection call per render, computed in a pure helper so no
    /// state changes while the body is evaluated.
    private struct TimelineOutcome {
        let summaries: [CardInvoiceSummary]
        let error: String?
    }

    private var timelineOutcome: TimelineOutcome {
        guard let card = selectedCard else {
            return TimelineOutcome(summaries: [], error: nil)
        }
        do {
            return TimelineOutcome(
                summaries: try CardsModel.invoiceSummaries(
                    snapshot: appState.snapshot,
                    cardID: card.id
                ),
                error: nil
            )
        } catch {
            return TimelineOutcome(summaries: [], error: error.localizedDescription)
        }
    }

    @ViewBuilder
    private func timelineSection(_ outcome: TimelineOutcome) -> some View {
        if let message = outcome.error {
            localErrorSection(message)
        } else {
            Section {
                InvoiceTimeline(
                    summaries: CardsModel.orderedTimeline(outcome.summaries),
                    card: selectedCard
                )
            } header: {
                Text("Invoices")
            }
        }
    }

    private func localErrorSection(_ message: String) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Label(message, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.red)
                Button {
                    Task { await reload() }
                } label: {
                    Label("Retry", systemImage: "arrow.clockwise")
                        .frame(minHeight: 44)
                }
            }
        }
    }

    private func reload() async {
        do {
            try await appState.refresh()
            refreshError = nil
        } catch {
            refreshError = error.localizedDescription
        }
    }
}
