import SwiftUI
import ObolCore
import ObolNativeRuntime

/// Account creation. Account editing and deletion are not in the supported
/// store operation set, so this form only creates.
struct CreateAccountView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var type: AccountType = .checking
    @State private var balanceText = ""
    @State private var isSubmitting = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                        .accessibilityLabel(Text("Name"))
                        .frame(minHeight: 44)
                        .disabled(isSubmitting)
                    Picker("Type", selection: $type) {
                        ForEach(AccountType.allCases, id: \.self) { candidate in
                            Text(ManagementAccountTypeLabel.title(for: candidate)).tag(candidate)
                        }
                    }
                    .disabled(isSubmitting)
                    ManagementMoneyField(title: "Starting balance", text: $balanceText)
                        .disabled(isSubmitting)
                } header: {
                    Text("Account")
                } footer: {
                    Text("The starting balance is the money already in the account before Obol tracks it. Liquid cash uses accounts other than investment ones.")
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
            .navigationTitle("New account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
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

    private var submitDisabled: Bool {
        trimmedName.isEmpty
    }

    private func submit() async {
        guard !isSubmitting, !submitDisabled else { return }
        isSubmitting = true
        errorText = nil
        defer { isSubmitting = false }

        let account = Account(
            name: trimmedName,
            type: type,
            initialBalance: ManagementMoney.parse(balanceText)
        )

        do {
            try await appState.apply(.createAccount(account))
            dismiss()
        } catch {
            errorText = error.localizedDescription
        }
    }
}
