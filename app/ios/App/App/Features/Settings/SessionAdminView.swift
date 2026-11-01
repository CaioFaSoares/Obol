import SwiftUI
import UIKit
import ObolCore
import ObolNativeRuntime

/// One server session row. Revocation is explicit and reports the server
/// failure truthfully; nothing about sessions is queued for later.
struct SessionRow: View {
    let session: AuthSessionEntry
    let isBusy: Bool
    let onRevoke: (AuthSessionEntry) -> Void

    @State private var confirmRevoke = false

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "laptopcomputer")
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.deviceLabel)
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
                if let createdAt = session.createdAt {
                    Text(verbatim: "Created \(AppFormatting.timestamp(createdAt))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Creation time not reported")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            Button("Revoke", role: .destructive) {
                confirmRevoke = true
            }
            .buttonStyle(.bordered)
            .frame(minHeight: 44)
            .disabled(isBusy)
            .accessibilityLabel(Text("Revoke the session for \(session.deviceLabel)"))
            .confirmationDialog(
                "Revoke this session?",
                isPresented: $confirmRevoke,
                titleVisibility: .visible
            ) {
                Button("Revoke session", role: .destructive) {
                    onRevoke(session)
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("“\(session.deviceLabel)” stops being able to use the server. If this is this device's own session, the next sync needs fresh credentials. Local data on this device is not affected.")
            }
        }
        .frame(minHeight: 44, alignment: .top)
    }
}

// MARK: - Password reset

/// Password reset request through the real BFF route. The request needs a
/// bound deployment origin but no stored session, so it is offered whenever
/// the device is paired. Failures are shown here and never queued.
struct PasswordResetView: View {
    @EnvironmentObject private var appState: AppState

    @State private var email = ""
    @State private var isRequesting = false
    @State private var localError: String?
    @State private var localNotice: String?

    var body: some View {
        Form {
            if let localError {
                Section {
                    ErrorNotice(message: localError) {
                        self.localError = nil
                    }
                }
            }
            if let localNotice {
                Section {
                    NoticeText(message: localNotice)
                }
            }

            Section {
                TextField("Account email", text: $email)
                    .accessibilityLabel(Text("Account email"))
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
                    .disabled(isRequesting)
                Button {
                    requestReset()
                } label: {
                    if isRequesting {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text("Requesting…")
                        }
                        .frame(minHeight: 44, alignment: .leading)
                    } else {
                        Label("Request password reset", systemImage: "paperplane")
                            .frame(minHeight: 44, alignment: .leading)
                    }
                }
                .disabled(!canRequest)
            } header: {
                Text("Account email")
            } footer: {
                Text("The server sends its hosted reset instructions to this address when the account exists. Nothing about your password is stored on this device.")
            }
        }
        .scrollDismissesKeyboard(.immediately)
        .navigationTitle("Password reset")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var canRequest: Bool {
        !isRequesting
            && !appState.isWorking
            && !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func requestReset() {
        guard canRequest else { return }
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        isRequesting = true
        localError = nil
        localNotice = nil
        Task { @MainActor in
            defer { isRequesting = false }
            do {
                try await appState.requestPasswordReset(email: address)
                email = ""
                localNotice = "The reset request for \(address) was accepted by the server."
            } catch {
                // The entered address stays for a retry.
                localError = "The reset request could not be sent: \(error.localizedDescription)"
            }
        }
    }
}

// MARK: - Server reset

/// Destructive server reset through `POST /api/admin/reset`.
///
/// The exact `LIMPAR` token is required here as well as server-side. The
/// screen states what the server erases and that this device's ledger is not
/// touched; the epoch change surfaces on the next sync as an explicit
/// recovery state instead of being guessed.
struct ServerResetView: View {
    @EnvironmentObject private var appState: AppState

    @State private var typedConfirmation = ""
    @State private var isResetting = false
    @State private var hasCompleted = false
    @State private var localError: String?

    var body: some View {
        Form {
            Section {
                Text("Transactions, invoices, recurrences, cards, accounts, categories and projects are deleted on the server, together with the sync journal, entity versions, accepted operation receipts and snapshot-import receipts.")
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
                Text("The owner account, sessions, server identity and protocol settings are preserved. The server data epoch advances and the journal restarts at sequence zero.")
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
            } header: {
                Text("What the reset erases")
            }

            if hasCompleted {
                Section {
                    NoticeText(message: "The server confirmed the reset. This device's local ledger, queue and station identity are unchanged; the next sync reports the changed epoch and stops for an explicit decision.")
                }
            } else {
                Section {
                    if let localError {
                        ErrorNotice(message: localError) {
                            self.localError = nil
                        }
                    }
                    TextField("Type LIMPAR to confirm", text: $typedConfirmation)
                        .accessibilityLabel(Text("Type LIMPAR to confirm"))
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled(true)
                        .disabled(isResetting)
                    Button(role: .destructive) {
                        resetServer()
                    } label: {
                        if isResetting {
                            HStack(spacing: 8) {
                                ProgressView()
                                Text("Erasing server data…")
                            }
                            .frame(minHeight: 44, alignment: .leading)
                        } else {
                            Label("Erase server financial data", systemImage: "trash")
                                .frame(minHeight: 44, alignment: .leading)
                        }
                    }
                    .disabled(!canReset)
                } header: {
                    Text("Confirmation")
                } footer: {
                    Text("This action cannot be undone. Only the typed word LIMPAR enables it, and nothing is queued while the server is unreachable.")
                }
            }
        }
        .scrollDismissesKeyboard(.immediately)
        .navigationTitle("Server data reset")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var canReset: Bool {
        !isResetting
            && !appState.isWorking
            && typedConfirmation
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .uppercased() == "LIMPAR"
    }

    private func resetServer() {
        guard canReset else { return }
        isResetting = true
        localError = nil
        Task { @MainActor in
            defer { isResetting = false }
            do {
                try await appState.resetServerData(confirmation: typedConfirmation)
                typedConfirmation = ""
                hasCompleted = true
            } catch {
                // The typed token stays so the user can read the server
                // reason and decide whether to try again.
                localError = "The server reset failed: \(error.localizedDescription)"
            }
        }
    }
}
