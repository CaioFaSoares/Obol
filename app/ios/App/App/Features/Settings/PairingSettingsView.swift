import SwiftUI
import UIKit
import UniformTypeIdentifiers
import ObolCore
import ObolNativeRuntime

/// Explicit server connection and pairing sheet.
///
/// Flow: enter fresh endpoint and credentials → preview (`AppState` performs a
/// real, non-persisting login and handshake) → choose one of the actions the
/// preview actually reports. An already-paired connection stays active until a
/// choice is confirmed; canceling leaves the binding, local data and queue
/// untouched. Replacement of local data requires the typed `REPLACE` word and
/// a completed file export; the root re-reads the store and rejects a digest
/// that changed since the export. Every failure stays in this sheet.
struct PairingSettingsSheet: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var serverAddress = ""
    @State private var email = ""
    @State private var password = ""
    @State private var showCredentialForm = false

    @State private var typedReplace = ""
    @State private var pendingDestructiveAction: PairingAction?
    @State private var pendingDestructiveConfirmation = ""
    @State private var exportDocument: JSONExportDocument?
    @State private var showFileExporter = false

    @State private var isPreviewing = false
    @State private var isConfirming = false
    @State private var isExporting = false
    @State private var isDisconnecting = false
    @State private var confirmDisconnect = false

    @State private var localError: String?
    @State private var localNotice: String?

    var body: some View {
        NavigationStack {
            List {
                currentConnectionSection
                credentialSection
                previewSection
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Server connection")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if localError != nil || localNotice != nil {
                    FeedbackInset(
                        error: localError,
                        notice: localNotice,
                        onDismissError: { self.localError = nil },
                        onDismissNotice: { self.localNotice = nil }
                    )
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(appState.pairingPreview == nil ? "Done" : "Cancel preview") { close() }
                        .disabled(isSheetBusy)
                }
            }
            .keyboardDoneToolbar()
            .onAppear { prefillForReauthentication() }
            .fileExporter(
                isPresented: $showFileExporter,
                document: exportDocument,
                contentType: .json,
                defaultFilename: "obol-export-before-replace-\(AppFormatting.day(Date()))"
            ) { result in
                handleExportCompletion(result)
            }
            .confirmationDialog(
                "Disconnect from the server?",
                isPresented: $confirmDisconnect,
                titleVisibility: .visible
            ) {
                Button("Disconnect", role: .destructive) { disconnect() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The binding is removed. Your ledger, queued operations, conflicts and station identity stay on this device.")
            }
        }
        .interactiveDismissDisabled(isSheetBusy)
    }

    // MARK: - Sections

    private var currentConnectionSection: some View {
        Section {
            if appState.syncPresentation.isPaired {
                if let name = appState.syncPresentation.serverName {
                    Text(name)
                        .font(.headline)
                }
                Text(verbatim: appState.currentServerURL ?? "No server address recorded")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)

                NoticeText(message: "The current connection stays active until you confirm a new choice. Canceling this sheet changes nothing.")

                Button(role: .destructive) {
                    confirmDisconnect = true
                } label: {
                    if isDisconnecting {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text("Disconnecting…")
                        }
                        .frame(minHeight: 44, alignment: .leading)
                    } else {
                        Label(
                            "Disconnect from server",
                            systemImage: "antenna.radiowaves.left.and.right.slash"
                        )
                        .frame(minHeight: 44, alignment: .leading)
                    }
                }
                .disabled(isBusy)
            } else {
                NoticeText(message: "This device is standalone. Everything works locally; pairing with a server is optional.")
            }
        } header: {
            Text("Current connection")
        }
    }

    @ViewBuilder
    private var credentialSection: some View {
        Section {
            if showsRevealButton {
                Button {
                    showCredentialForm = true
                } label: {
                    Label(
                        "Use fresh credentials for another server or this one…",
                        systemImage: "arrow.triangle.2.circlepath.circle"
                    )
                    .frame(minHeight: 44, alignment: .leading)
                }
                .disabled(isBusy)
            } else {
                TextField("Server address (https://…)", text: $serverAddress)
                    .accessibilityLabel(Text("Server address (https://…)"))
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
                    .disabled(fieldsDisabled)
                TextField("Email", text: $email)
                    .accessibilityLabel(Text("Email"))
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled(true)
                    .disabled(fieldsDisabled)
                SecureField("Password", text: $password)
                    .accessibilityLabel(Text("Password"))
                    .disabled(fieldsDisabled)

                Button {
                    preview()
                } label: {
                    if isPreviewing {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text("Checking the server…")
                        }
                        .frame(minHeight: 44, alignment: .leading)
                    } else {
                        Label("Preview connection", systemImage: "dot.radiowaves.left.and.right")
                            .frame(minHeight: 44, alignment: .leading)
                    }
                }
                .disabled(!canPreview)
            }
        } header: {
            Text("Server credentials")
        } footer: {
            Text("Credentials are used for one preview only and are never stored in the app database, an export or a log. A server token is written to the Keychain only after you confirm a choice.")
        }
    }

    @ViewBuilder
    private var previewSection: some View {
        if let preview = appState.pairingPreview {
            Section {
                PairingPreviewCard(
                    preview: preview,
                    isBusy: isBusy,
                    typedReplace: $typedReplace,
                    onChoice: choose,
                    onCancelPreview: cancelPreview
                )
            } header: {
                Text("Decision")
            } footer: {
                Text("Only the actions reported for this preview are offered. Nothing is applied until you choose one explicitly.")
            }
        }
    }

    // MARK: - Form state

    private var isBusy: Bool {
        isSheetBusy || appState.isWorking
    }

    /// Only this sheet's own in-flight work blocks closing it. A background
    /// sync elsewhere in the app must never trap the user in this screen.
    private var isSheetBusy: Bool {
        isPreviewing || isConfirming || isExporting || isDisconnecting
    }

    private var fieldsDisabled: Bool {
        isBusy || appState.pairingPreview != nil
    }

    private var showsRevealButton: Bool {
        appState.syncPresentation.isPaired
            && appState.isAuthenticated
            && appState.pairingPreview == nil
            && !showCredentialForm
    }

    private var canPreview: Bool {
        !isBusy
            && appState.pairingPreview == nil
            && !serverAddress.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !password.isEmpty
    }

    // MARK: - Preview

    /// A fresh session is needed on a new origin, so a re-authentication flow
    /// only prefills the already recorded address. The password is never
    /// prefilled from anywhere.
    private func prefillForReauthentication() {
        guard serverAddress.isEmpty else { return }
        guard appState.syncPresentation.phase == .authRequired,
              let current = appState.currentServerURL else { return }
        serverAddress = current
    }

    private func preview() {
        guard canPreview else { return }
        localError = nil
        localNotice = nil
        isPreviewing = true
        Task { @MainActor in
            defer { isPreviewing = false }
            do {
                try await appState.previewConnection(
                    serverAddress: serverAddress.trimmingCharacters(in: .whitespacesAndNewlines),
                    email: email.trimmingCharacters(in: .whitespacesAndNewlines),
                    password: password
                )
                password = ""
                localNotice = "Preview ready. The allowed actions are listed below."
            } catch {
                // Endpoint, email and password stay in the form for a retry.
                localError = error.localizedDescription
            }
        }
    }

    // MARK: - Decision

    /// Receives the typed value from the preview card. Non-destructive
    /// actions pass the empty string; only the destructive replacement path
    /// carries the user's `REPLACE` word.
    private func choose(_ action: PairingAction, confirmation: String) {
        guard let preview = appState.pairingPreview else {
            localError = "No connection preview is active. Preview the server again before choosing."
            return
        }
        guard !isBusy else { return }
        if action.isDestructive && preview.hasLocalData {
            guard confirmation == "REPLACE" else {
                localError = "Type REPLACE exactly to replace this device's local data."
                return
            }
            beginExportThenReplace(action, confirmation: confirmation)
            return
        }
        confirm(action, confirmation: "", exportCompleted: false)
    }

    private func beginExportThenReplace(_ action: PairingAction, confirmation: String) {
        guard !isExporting else { return }
        localError = nil
        localNotice = nil
        isExporting = true
        Task { @MainActor in
            defer { isExporting = false }
            do {
                let data = try await appState.exportSnapshot()
                pendingDestructiveAction = action
                pendingDestructiveConfirmation = confirmation
                exportDocument = JSONExportDocument(data: data)
                showFileExporter = true
            } catch {
                localError = "The export could not be prepared, so this device was not replaced: \(error.localizedDescription)"
            }
        }
    }

    /// The replacement is only requested after the system exporter reports a
    /// completed write. A canceled or failed save leaves the store untouched.
    private func handleExportCompletion(_ result: Result<URL, Error>) {
        exportDocument = nil
        switch result {
        case .success:
            guard let action = pendingDestructiveAction else {
                localError = "The export completed, but the pending replacement decision was lost. Start the connection decision again."
                clearDestructiveState()
                return
            }
            let confirmation = pendingDestructiveConfirmation
            pendingDestructiveAction = nil
            pendingDestructiveConfirmation = ""
            confirm(action, confirmation: confirmation, exportCompleted: true)
        case .failure(let error):
            pendingDestructiveAction = nil
            pendingDestructiveConfirmation = ""
            if isCancellationError(error) {
                localNotice = "Export canceled. This device was not replaced."
            } else {
                localError = "The export did not complete, so this device was not replaced: \(error.localizedDescription)"
            }
        }
    }

    private func confirm(_ action: PairingAction, confirmation: String, exportCompleted: Bool) {
        guard !isConfirming else { return }
        localError = nil
        localNotice = nil
        isConfirming = true
        Task { @MainActor in
            defer { isConfirming = false }
            do {
                try await appState.confirmConnection(
                    choice: action,
                    confirmation: confirmation,
                    exportCompleted: exportCompleted
                )
                password = ""
                clearDestructiveState()
                if action == .stayLocal {
                    localNotice = "Stayed standalone. The preview session was discarded and nothing was saved."
                } else {
                    dismiss()
                }
            } catch {
                // The store is unchanged on failure, so the decision remains
                // available; entered values are kept for the retry.
                localError = error.localizedDescription
            }
        }
    }

    private func cancelPreview() {
        appState.cancelConnectionPreview()
        password = ""
        clearDestructiveState()
        localError = nil
        localNotice = "Preview canceled. Any existing connection and all local data are unchanged."
    }

    // MARK: - Disconnect and dismissal

    private func disconnect() {
        guard !isDisconnecting else { return }
        localError = nil
        localNotice = nil
        isDisconnecting = true
        Task { @MainActor in
            defer { isDisconnecting = false }
            do {
                try await appState.disconnect()
                appState.cancelConnectionPreview()
                showCredentialForm = false
                clearDestructiveState()
                localNotice = "Disconnected. The ledger, queued operations, conflicts and station identity were preserved."
            } catch {
                localError = "The disconnect did not complete: \(error.localizedDescription)"
            }
        }
    }

    private func close() {
        appState.cancelConnectionPreview()
        password = ""
        clearDestructiveState()
        dismiss()
    }

    private func clearDestructiveState() {
        typedReplace = ""
        pendingDestructiveAction = nil
        pendingDestructiveConfirmation = ""
        exportDocument = nil
    }
}

/// `true` when the exporter reported a user cancellation. Kept at file scope so
/// the presentation completion can call it outside actor isolation.
private func isCancellationError(_ error: Error) -> Bool {
    let nsError = error as NSError
    return nsError.domain == NSCocoaErrorDomain && nsError.code == NSUserCancelledError
}

// MARK: - Preview card

/// The preview facts and the action list derived by the root pairing matrix.
/// Destructive replacement expands inline (never as a nested sheet) so the
/// single export presentation cannot race a dismissed sheet.
private struct PairingPreviewCard: View {
    let preview: PairingPreview
    let isBusy: Bool
    @Binding var typedReplace: String
    let onChoice: (PairingAction, String) -> Void
    let onCancelPreview: () -> Void

    @State private var destructiveAction: PairingAction?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            counts
            warnings
            actionList
            if let action = destructiveAction {
                replacementPanel(for: action)
            }
            Button("Cancel preview", role: .cancel) {
                destructiveAction = nil
                onCancelPreview()
            }
            .buttonStyle(.borderless)
            .frame(minHeight: 44, alignment: .leading)
            .disabled(isBusy)
        }
        .padding(.vertical, 4)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(preview.serverName)
                .font(.headline)
            Text(verbatim: preview.serverAddress)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }

    private var counts: some View {
        VStack(alignment: .leading, spacing: 4) {
            previewFact("Server data", preview.hasServerData ? "Has financial data" : "Empty")
            previewFact("Local records", String(preview.localEntityCount))
            previewFact("Local queued operations", String(preview.localOperationCount))
            previewFact("Previously paired", preview.isRePairing ? "Yes, a binding is stored" : "No")
        }
    }

    private func previewFact(_ title: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
            Spacer(minLength: 12)
            Text(verbatim: value)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("\(title): \(value)"))
    }

    @ViewBuilder
    private var warnings: some View {
        if !preview.warnings.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(preview.warnings.enumerated()), id: \.offset) { _, warning in
                    Label {
                        Text(warning)
                            .fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle")
                            .accessibilityHidden(true)
                    }
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
            }
        }
    }

    private var actionList: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(preview.actions, id: \.id) { action in
                Button {
                    start(action)
                } label: {
                    HStack(spacing: 8) {
                        Text(action.label)
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.forward")
                            .accessibilityHidden(true)
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                }
                .buttonStyle(.bordered)
                .disabled(isBusy || destructiveAction != nil)
            }
        }
    }

    /// Non-destructive choices always pass the empty confirmation string; only
    /// the destructive replacement path carries the typed `REPLACE` word.
    private func start(_ action: PairingAction) {
        if action.isDestructive && preview.hasLocalData {
            typedReplace = ""
            destructiveAction = action
        } else {
            onChoice(action, "")
        }
    }

    private func replacementPanel(for action: PairingAction) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(action.label)
                .font(.headline)
            Text("This replaces the financial rows, queued operations, receipts and binding on this device with the server's data. It cannot be undone; only your exported copy remains.")
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
            TextField("Type REPLACE to confirm", text: $typedReplace)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled(true)
                .frame(minHeight: 44, alignment: .leading)
                .accessibilityLabel(Text("Replacement confirmation: type REPLACE"))
                .disabled(isBusy)
            Button(role: .destructive) {
                let typed = typedReplace
                destructiveAction = nil
                onChoice(action, typed)
            } label: {
                Label("Export and replace local data", systemImage: "square.and.arrow.down.on.square")
                    .frame(minHeight: 44, alignment: .leading)
            }
            .buttonStyle(.bordered)
            .disabled(isBusy || typedReplace != "REPLACE")
            Button("Keep my local data", role: .cancel) {
                destructiveAction = nil
                typedReplace = ""
            }
            .buttonStyle(.borderless)
            .frame(minHeight: 44, alignment: .leading)
            .disabled(isBusy)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(SettingsSurface.raised)
        )
    }
}
