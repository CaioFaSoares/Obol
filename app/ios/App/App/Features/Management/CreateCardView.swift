import Foundation
import SwiftUI
import ObolCore
import ObolNativeRuntime

/// Card creation and update. `card.update` is in the supported operation set,
/// so one form serves both: pass `nil` to create, or the card to edit. Only
/// genuinely changed fields are sent; an unchanged form writes nothing.
struct CreateCardView: View {
    private static let dayOptions = Array(1...31)

    let original: Card?

    init(card: Card?) {
        original = card
        _name = State(initialValue: card?.name ?? "")
        _closingDay = State(initialValue: min(31, max(1, card?.closingDay ?? 1)))
        _dueDay = State(initialValue: min(31, max(1, card?.dueDay ?? 5)))
        _limitText = State(initialValue: card.map { NSDecimalNumber(decimal: $0.limit).stringValue } ?? "")
    }

    private var editing: Bool { original != nil }

    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var name: String
    @State private var closingDay: Int
    @State private var dueDay: Int
    @State private var limitText: String
    @State private var isSubmitting = false
    @State private var infoText: String?
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                        .accessibilityLabel(Text("Name"))
                        .frame(minHeight: 44)
                        .disabled(isSubmitting)
                    Picker("Closing day", selection: $closingDay) {
                        ForEach(Self.dayOptions, id: \.self) { day in
                            Text("\(day)").tag(day)
                        }
                    }
                    .disabled(isSubmitting)
                    Picker("Due day", selection: $dueDay) {
                        ForEach(Self.dayOptions, id: \.self) { day in
                            Text("\(day)").tag(day)
                        }
                    }
                    .disabled(isSubmitting)
                    ManagementMoneyField(title: "Limit", text: $limitText)
                        .disabled(isSubmitting)
                } header: {
                    Text(editing ? "Edit card" : "New card")
                } footer: {
                    Text("A purchase on or after the closing day goes to the next invoice. A due day before the closing day adds one further month.")
                }
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
            }
            .scrollDismissesKeyboard(.immediately)
            .navigationTitle(editing ? "Edit card" : "New card")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(editing ? "Close" : "Cancel") { dismiss() }
                        .disabled(isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(editing ? "Save" : "Create") {
                        Task { await submit() }
                    }
                    .disabled(submitDisabled || isSubmitting)
                }
            }
            .keyboardDoneToolbar()
        }
        .interactiveDismissDisabled(isSubmitting)
    }

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var limit: Decimal {
        ManagementMoney.parse(limitText)
    }

    private var submitDisabled: Bool {
        trimmedName.isEmpty
    }

    // MARK: - Mutation

    private func submit() async {
        guard !isSubmitting, !submitDisabled else { return }
        if let original {
            await save(original)
        } else {
            await create()
        }
    }

    private func create() async {
        isSubmitting = true
        errorText = nil
        infoText = nil
        defer { isSubmitting = false }

        let card = Card(
            name: trimmedName,
            closingDay: closingDay,
            dueDay: dueDay,
            limit: limit
        )
        do {
            try await appState.apply(.createCard(card))
            dismiss()
        } catch {
            errorText = error.localizedDescription
        }
    }

    private func save(_ card: Card) async {
        let patch = CardPatch(
            name: trimmedName != card.name ? trimmedName : nil,
            closingDay: closingDay != card.closingDay ? closingDay : nil,
            dueDay: dueDay != card.dueDay ? dueDay : nil,
            limit: limit != card.limit ? limit : nil
        )
        guard patch.name != nil || patch.closingDay != nil || patch.dueDay != nil || patch.limit != nil else {
            infoText = "No changes to save."
            return
        }

        isSubmitting = true
        errorText = nil
        infoText = nil
        defer { isSubmitting = false }

        do {
            try await appState.apply(.updateCard(id: card.id, patch: patch))
            dismiss()
        } catch {
            errorText = error.localizedDescription
        }
    }
}
