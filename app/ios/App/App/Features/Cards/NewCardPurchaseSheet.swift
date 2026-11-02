import Foundation
import SwiftUI
import ObolCore
import ObolNativeRuntime

/// Sheet for recording one card purchase. The purchase date is the only date
/// input: the canonical engine routes the charge into the invoice for that
/// purchase and derives the due date from the card's closing and due days.
struct NewCardPurchaseSheet: View {
    let card: Card

    init(card: Card) {
        self.card = card
    }

    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var title = ""
    @State private var amountText = ""
    @State private var purchaseDate = Date()
    @State private var categoryID: String?
    @State private var isSubmitting = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                purchaseSection
                routingSection
                if let message = errorText {
                    Section {
                        Label(message, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }
            .scrollDismissesKeyboard(.immediately)
            .navigationTitle("Card purchase")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Record") {
                        Task { await submit() }
                    }
                    .disabled(submitDisabled || isSubmitting)
                }
            }
            .keyboardDoneToolbar()
        }
        .interactiveDismissDisabled(isSubmitting)
    }

    // MARK: - Derived state

    private var amount: Decimal {
        CardMoney.parse(amountText)
    }

    private var trimmedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var submitDisabled: Bool {
        trimmedTitle.isEmpty || amount <= 0
    }

    private var categories: [ObolCore.Category] {
        appState.snapshot.categories.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    /// Product UTC day for the picked local calendar day.
    private var purchaseDay: Date {
        CardsModel.utcDay(fromLocal: purchaseDate)
    }

    /// Product routing preview computed with the canonical card rule. It is a
    /// label only; the engine performs the real routing on submit.
    private var expectedDueDay: Date {
        ObolDate.calculateCardDueDate(
            purchaseDate: purchaseDay,
            closingDay: card.closingDay,
            dueDay: card.dueDay
        )
    }

    // MARK: - Sections

    private var purchaseSection: some View {
        Section {
            TextField("Description", text: $title)
                .accessibilityLabel(Text("Description"))
                .frame(minHeight: 44)
                .disabled(isSubmitting)
            VStack(alignment: .leading, spacing: 6) {
                Text("Amount")
                TextField("Amount", text: $amountText)
                    .accessibilityLabel(Text("Amount"))
                    .keyboardType(.decimalPad)
                    .monospacedDigit()
                    .frame(minHeight: 44)
                    .disabled(isSubmitting)
            }
            DatePicker(
                "Purchase date",
                selection: $purchaseDate,
                displayedComponents: [.date]
            )
            .disabled(isSubmitting)
        } footer: {
            Text("The charge stays pending on this card and affects cash only when its invoice falls due.")
        }
    }

    private var routingSection: some View {
        Section {
            Picker("Budget category", selection: $categoryID) {
                Text("No category").tag(Optional<String>.none)
                ForEach(categories) { category in
                    Text(category.name).tag(Optional(category.id))
                }
            }
            .disabled(isSubmitting)

            LabeledContent("Invoice routing") {
                Text("\(AppFormatting.day(purchaseDay)) → \(CardsModel.periodLabel(ObolDate.invoicePeriod(dueDate: expectedDueDay)))")
                    .cardMoneyText()
            }
        } header: {
            Text("Routing")
        } footer: {
            Text("A purchase on or after day \(card.closingDay) goes to the next invoice. The due day is \(card.dueDay).")
        }
    }

    // MARK: - Mutation

    private func submit() async {
        guard !isSubmitting else { return }
        guard !submitDisabled else { return }
        isSubmitting = true
        errorText = nil
        defer { isSubmitting = false }

        let day = purchaseDay
        let draft = TransactionDraft(
            title: trimmedTitle,
            amount: amount,
            type: .expense,
            status: .pending,
            expectedDate: day,
            purchaseDate: day,
            isRecurring: false,
            isSilent: false,
            isSimulated: false,
            isScheduled: false,
            accountID: nil,
            cardID: card.id,
            categoryID: categoryID
        )

        do {
            try await appState.apply(.createTransaction(draft))
            dismiss()
        } catch {
            // The sheet stays open with every entered value retained.
            errorText = error.localizedDescription
        }
    }
}
