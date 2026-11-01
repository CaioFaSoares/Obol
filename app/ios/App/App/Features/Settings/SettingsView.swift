import SwiftUI
import UniformTypeIdentifiers
import ObolCore
import ObolNativeRuntime

/// Root settings surface for native 0.4.
///
/// The page reports only real state from `AppState`: the store binding, the
/// station identity, the current server, the queue and the conflicts. Local
/// use is always available; pairing, server sessions, maintenance and the
/// destructive server reset are explicit, online-only actions. Every failure
/// is shown here as a view-local row, so nothing is written to a view alias
/// and no root error slot is repurposed.
struct SettingsView: View {
    @EnvironmentObject private var appState: AppState

    @State private var showConnectionSheet = false
    @State private var showExport = false
    @State private var exportDocument: JSONExportDocument?
    @State private var isExportBusy = false
    @State private var sharePayload: SharePayload?
    @State private var shareCleanupURL: URL?

    @State private var sessions: [AuthSessionEntry]?
    @State private var isLoadingSessions = false
    @State private var revokingSessionID: String?

    @State private var isMaintenanceBusy = false
    @State private var confirmSignOut = false
    @State private var isSigningOut = false

    @State private var localError: String?
    @State private var localNotice: String?

    var body: some View {
        NavigationStack {
            List {
                connectionSection

                if appState.syncPresentation.isPaired {
                    sessionsSection
                    maintenanceSection
                }

                queueSection
                conflictSection
                exportSection
                accountSection
            }
            .navigationTitle("Settings")
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
            .task { await refreshFromStore() }
            .refreshable { await refreshFromStore() }
            .fileExporter(
                isPresented: $showExport,
                document: exportDocument,
                contentType: .json,
                defaultFilename: "obol-export-\(AppFormatting.day(Date()))"
            ) { result in
                exportDocument = nil
                switch result {
                case .success(let url):
                    localError = nil
                    localNotice = "Export saved as \(url.lastPathComponent)."
                case .failure(let error):
                    if isCancellationError(error) {
                        localNotice = "Export canceled. No file was written."
                    } else {
                        localError = "The export did not complete, so no export file was saved: \(error.localizedDescription)"
                    }
                }
            }
            .sheet(
                isPresented: $showConnectionSheet,
                onDismiss: { appState.cancelConnectionPreview() }
            ) {
                PairingSettingsSheet()
            }
            .sheet(item: $sharePayload, onDismiss: {
                if let url = shareCleanupURL {
                    try? FileManager.default.removeItem(at: url)
                }
                shareCleanupURL = nil
            }) { payload in
                ShareSheet(items: [payload.url])
            }
        }
    }

    // MARK: - Connection

    private var connectionSection: some View {
        Section {
            connectionStatusRow
            countsRow
            lastSyncRow
            bindingFacts

            Button {
                showConnectionSheet = true
            } label: {
                Label(connectionButtonTitle, systemImage: "network")
                    .frame(minHeight: 44, alignment: .leading)
            }
            .disabled(appState.isWorking)

            Button {
                Task { @MainActor in await appState.synchronize() }
            } label: {
                if isSyncing {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Syncing…")
                    }
                    .frame(minHeight: 44, alignment: .leading)
                } else {
                    Label("Sync now", systemImage: "arrow.triangle.2.circlepath")
                        .frame(minHeight: 44, alignment: .leading)
                }
            }
            .disabled(!appState.syncPresentation.isPaired || appState.isWorking)

            connectionGuidance
        } header: {
            Text("Sync & Connection")
        } footer: {
            Text("This device works fully offline. Pairing never merges data automatically, and no server account is required for local use.")
        }
    }

    private var connectionButtonTitle: String {
        guard appState.syncPresentation.isPaired else { return "Connect to a server…" }
        return appState.isAuthenticated
            ? "Server connection and switch server…"
            : "Sign in to the server…"
    }

    private var isSyncing: Bool {
        appState.isWorking || appState.syncPresentation.phase == .syncing
    }

    @ViewBuilder
    private var connectionStatusRow: some View {
        let presentation = appState.syncPresentation
        HStack(alignment: .top, spacing: 12) {
            phaseSymbol(presentation.phase)
            VStack(alignment: .leading, spacing: 4) {
                Text(phaseTitle(presentation.phase))
                    .font(.headline)
                if let detail = presentation.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(minHeight: 44, alignment: .top)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilitySummary(presentation))
    }

    @ViewBuilder
    private var countsRow: some View {
        let presentation = appState.syncPresentation
        VStack(alignment: .leading, spacing: 4) {
            Label("\(presentation.pendingCount) queued operation\(presentation.pendingCount == 1 ? "" : "s")", systemImage: "tray.full")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Label("\(presentation.conflictCount) conflict\(presentation.conflictCount == 1 ? "" : "s")", systemImage: "exclamationmark.triangle")
                .font(.subheadline)
                .foregroundStyle(presentation.conflictCount > 0 ? Color.orange : Color.secondary)
        }
        .frame(minHeight: 44, alignment: .leading)
    }

    @ViewBuilder
    private var lastSyncRow: some View {
        if let lastSyncAt = appState.syncPresentation.lastSyncAt {
            HStack {
                Text("Last successful sync")
                Spacer(minLength: 12)
                Text(verbatim: AppFormatting.timestamp(lastSyncAt))
                    .foregroundStyle(.secondary)
            }
            .font(.subheadline)
        } else if appState.syncPresentation.isPaired {
            NoticeText(message: "No complete sync cycle has finished on this device yet.")
        }
    }

    @ViewBuilder
    private var bindingFacts: some View {
        if let status = appState.storeStatus {
            let binding = status.binding
            SettingsFactRow(
                title: "Mode",
                value: binding.isPaired ? "Paired with a server" : "Standalone (local only)"
            )
            SettingsFactRow(
                title: "Current server",
                value: appState.currentServerURL ?? "None"
            )
            SettingsFactRow(
                title: "Server name",
                value: appState.syncPresentation.serverName ?? "Not reported yet"
            )
            SettingsFactRow(
                title: "Station identity",
                value: binding.stationId,
                monospaced: true
            )
            SettingsFactRow(
                title: "Server identity",
                value: binding.serverInstanceId ?? "Not established"
            )
            SettingsFactRow(
                title: "Data epoch",
                value: String(binding.dataEpoch)
            )
            if binding.stopReason != .none {
                SettingsFactRow(
                    title: "Binding state",
                    value: binding.stopDetail ?? binding.stopReason.rawValue,
                    warning: true
                )
            }
        } else {
            SettingsFactRow(title: "Store", value: "Not opened yet")
        }
    }

    @ViewBuilder
    private var connectionGuidance: some View {
        let presentation = appState.syncPresentation
        if presentation.phase == .authRequired {
            NoticeText(message: "The server rejected the stored session. Open the server connection, enter fresh credentials, and choose “Resume this device's station” to keep the local data and the queue.")
        } else if presentation.phase == .offline {
            NoticeText(message: "The last attempt could not reach the server. Local finance and the queue are unchanged; retry when the device is online.")
        } else if presentation.phase == .blocked {
            NoticeText(message: "Sync is stopped for this station until the binding state above is resolved explicitly.")
        } else if presentation.phase == .standalone {
            NoticeText(message: "Pair a server to send queued operations. Local work is never blocked by staying standalone.")
        }
    }

    // MARK: - Sessions

    private var sessionsSection: some View {
        Section {
            if !appState.isAuthenticated {
                NoticeText(message: "Sign in again from the server connection section to list or revoke server sessions.")
            } else if !isSessionOnline {
                NoticeText(message: "Session actions need a live server connection. They are online-only and are never queued for later.")
            } else {
                if isLoadingSessions && sessions == nil {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Loading sessions…")
                            .foregroundStyle(.secondary)
                    }
                }
                if let sessions {
                    if sessions.isEmpty {
                        Text("The server reported no active sessions.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(sessions) { session in
                            SessionRow(
                                session: session,
                                isBusy: isSessionBusy,
                                onRevoke: revokeSession
                            )
                        }
                    }
                }
                Button {
                    loadSessions()
                } label: {
                    Label(
                        sessions == nil ? "Load device sessions" : "Refresh session list",
                        systemImage: "arrow.clockwise"
                    )
                    .frame(minHeight: 44, alignment: .leading)
                }
                .disabled(isSessionBusy)
            }

            NavigationLink {
                PasswordResetView()
            } label: {
                Label("Request password reset…", systemImage: "key")
                    .frame(minHeight: 44, alignment: .leading)
            }
        } header: {
            Text("Device Sessions")
        } footer: {
            Text("Sessions exist on the server. Listing and revoking them is an online-only action; nothing is queued while the device is offline.")
        }
    }

    private var isSessionOnline: Bool {
        guard appState.syncPresentation.isPaired else { return false }
        switch appState.syncPresentation.phase {
        case .offline, .authRequired, .blocked:
            return false
        case .standalone, .syncing, .upToDate, .conflict, .error:
            return true
        }
    }

    private var isSessionBusy: Bool {
        appState.isWorking || isLoadingSessions || revokingSessionID != nil
    }

    private func loadSessions() {
        guard !isLoadingSessions else { return }
        isLoadingSessions = true
        localError = nil
        Task { @MainActor in
            defer { isLoadingSessions = false }
            await reloadSessions()
        }
    }

    private func reloadSessions() async {
        do {
            sessions = try await appState.sessions()
        } catch {
            localError = "The session list could not be loaded: \(error.localizedDescription)"
        }
    }

    private func revokeSession(_ session: AuthSessionEntry) {
        guard revokingSessionID == nil, !appState.isWorking else { return }
        revokingSessionID = session.id
        localError = nil
        localNotice = nil
        Task { @MainActor in
            defer { revokingSessionID = nil }
            do {
                try await appState.revokeSession(id: session.id)
                localNotice = "The session for “\(session.deviceLabel)” was revoked."
                await reloadSessions()
            } catch {
                localError = "The session could not be revoked: \(error.localizedDescription)"
            }
        }
    }

    // MARK: - Server maintenance

    private var maintenanceSection: some View {
        Section {
            if let reason = maintenanceBlockedReason {
                NoticeText(message: reason)
            } else {
                Button {
                    runMaintenance()
                } label: {
                    if isMaintenanceBusy {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text("Running server jobs…")
                        }
                        .frame(minHeight: 44, alignment: .leading)
                    } else {
                        Label("Run server maintenance", systemImage: "gearshape.2")
                            .frame(minHeight: 44, alignment: .leading)
                    }
                }
                .disabled(isMaintenanceBusy || appState.isWorking)

                NavigationLink {
                    ServerResetView()
                } label: {
                    Label("Reset server financial data…", systemImage: "trash")
                        .foregroundStyle(.red)
                        .frame(minHeight: 44, alignment: .leading)
                }
                .disabled(isMaintenanceBusy || appState.isWorking)
            }
        } header: {
            Text("Server Maintenance")
        } footer: {
            Text("Both actions run against the bound server and are never queued. The local ledger is never modified by them.")
        }
    }

    private var maintenanceBlockedReason: String? {
        guard appState.syncPresentation.isPaired else {
            return "Pair this device with a server first. Maintenance and reset are online-only actions."
        }
        switch appState.syncPresentation.phase {
        case .offline:
            return "The server is unreachable right now. Maintenance and reset are online-only and are never queued for a later sync."
        case .authRequired:
            return "A fresh server session is required. Sign in again from the server connection section."
        case .blocked:
            return "Sync is stopped for this station. Resolve the binding state before running server maintenance."
        case .standalone, .syncing, .upToDate, .conflict, .error:
            return nil
        }
    }

    private func runMaintenance() {
        guard !isMaintenanceBusy, !appState.isWorking else { return }
        isMaintenanceBusy = true
        localError = nil
        localNotice = nil
        Task { @MainActor in
            defer { isMaintenanceBusy = false }
            do {
                try await appState.runServerMaintenance()
                localNotice = "The recurrence and reconciliation jobs both completed on the server."
            } catch {
                localError = "Server maintenance failed: \(error.localizedDescription)"
            }
        }
    }

    // MARK: - Queue

    private var queueSection: some View {
        let outbox = appState.outbox
        return Section {
            if outbox.isEmpty {
                Text("No queued operations")
                    .foregroundStyle(.secondary)
            } else {
                NavigationLink {
                    OutboxQueueView()
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Open queue (\(outbox.count))")
                        Text(queueSummary(outbox))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(minHeight: 44, alignment: .leading)
                }
                rejectedSummary(outbox)
            }
        } header: {
            Text("Operations Queue")
        } footer: {
            Text("Queued operations replay in durable insertion order when paired. Pull applies only complete commit groups; nothing is dropped, merged or re-identified automatically.")
        }
    }

    private func queueSummary(_ outbox: [OutboxOperation]) -> String {
        var parts: [String] = []
        let ready = outbox.filter { $0.status == .queued && $0.blockedBy == nil }.count
        let blocked = outbox.filter { $0.status == .queued && $0.blockedBy != nil }.count
        let sending = outbox.filter { $0.status == .inFlight }.count
        let conflicted = outbox.filter { $0.status == .conflict }.count
        let rejected = outbox.filter { $0.status == .rejected }.count
        if ready > 0 { parts.append("\(ready) ready") }
        if blocked > 0 { parts.append("\(blocked) blocked") }
        if sending > 0 { parts.append("\(sending) sending") }
        if conflicted > 0 { parts.append("\(conflicted) in conflict") }
        if rejected > 0 { parts.append("\(rejected) rejected") }
        return parts.isEmpty ? "No pending operation" : parts.joined(separator: " · ")
    }

    @ViewBuilder
    private func rejectedSummary(_ outbox: [OutboxOperation]) -> some View {
        let rejected = outbox.filter { $0.status == .rejected }
        if !rejected.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Label("\(rejected.count) rejected by the server", systemImage: "xmark.octagon")
                    .font(.subheadline)
                    .foregroundStyle(.red)
                if let reason = rejected.compactMap(\.lastError).first(where: { !$0.isEmpty }) {
                    Text(reason)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Text("Open the queue to read the full server reason and acknowledge the rejection.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - Conflicts

    private var conflictSection: some View {
        let conflicts = appState.conflicts
        let operations = Set(conflicts.map(\.opId)).count
        return Section {
            if conflicts.isEmpty {
                Text("No conflicts")
                    .foregroundStyle(.secondary)
            } else {
                NavigationLink {
                    ConflictResolutionListView()
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Open conflicts (\(operations))")
                        Text("\(conflicts.count) conflicted entit\(conflicts.count == 1 ? "y" : "ies") need an explicit resolution.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(minHeight: 44, alignment: .leading)
                }
            }
        } header: {
            Text("Conflicts")
        } footer: {
            Text("There is no automatic last-writer-wins. Every conflict needs an explicit resolution and an explicit policy for its dependent operations.")
        }
    }

    // MARK: - Export

    private var exportSection: some View {
        Section {
            Button {
                prepareSavedExport()
            } label: {
                Label("Save export as JSON…", systemImage: "square.and.arrow.down")
                    .frame(minHeight: 44, alignment: .leading)
            }
            .disabled(isExportBusy || appState.isWorking)

            Button {
                prepareSharedExport()
            } label: {
                Label("Share export…", systemImage: "square.and.arrow.up.on.square")
                    .frame(minHeight: 44, alignment: .leading)
            }
            .disabled(isExportBusy || appState.isWorking)

            if isExportBusy {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Preparing the export…")
                        .foregroundStyle(.secondary)
                }
            }
        } header: {
            Text("Export")
        } footer: {
            Text("The export holds the local ledger snapshot, counts, binding metadata, pending operations and conflicts. It never contains passwords, session tokens or Keychain credentials. A completed export is also the evidence required before replacing local data with server data.")
        }
    }

    private func prepareSavedExport() {
        guard !isExportBusy, !appState.isWorking else { return }
        isExportBusy = true
        localError = nil
        localNotice = nil
        Task { @MainActor in
            defer { isExportBusy = false }
            do {
                let data = try await appState.exportSnapshot()
                exportDocument = JSONExportDocument(data: data)
                showExport = true
            } catch {
                exportDocument = nil
                localError = "The export could not be prepared: \(error.localizedDescription)"
            }
        }
    }

    private func prepareSharedExport() {
        guard !isExportBusy, !appState.isWorking else { return }
        isExportBusy = true
        localError = nil
        localNotice = nil
        Task { @MainActor in
            defer { isExportBusy = false }
            do {
                let data = try await appState.exportSnapshot()
                let url = FileManager.default.temporaryDirectory
                    .appendingPathComponent("obol-export-\(AppFormatting.day(Date())).json")
                try data.write(to: url, options: .atomic)
                shareCleanupURL = url
                sharePayload = SharePayload(url: url)
            } catch {
                localError = "The export could not be written for sharing: \(error.localizedDescription)"
            }
        }
    }

    // MARK: - Account

    private var accountSection: some View {
        Section {
            if appState.isAuthenticated {
                Button(role: .destructive) {
                    confirmSignOut = true
                } label: {
                    Label("Sign out", systemImage: "person.badge.minus")
                        .frame(minHeight: 44, alignment: .leading)
                }
                .disabled(isSigningOut || appState.isWorking)
                .confirmationDialog(
                    "Sign out of this server session?",
                    isPresented: $confirmSignOut,
                    titleVisibility: .visible
                ) {
                    Button("Sign out", role: .destructive) {
                        signOut()
                    }
                    Button("Cancel", role: .cancel) {}
                } message: {
                    Text("The credential stored for this server is removed from the device. Your ledger, queue, conflicts and station identity stay here.")
                }
            } else if appState.syncPresentation.isPaired {
                NoticeText(message: "No server session is stored on this device. Sign in from the server connection section to use sessions and server administration.")
            } else {
                NoticeText(message: "This device is not paired. A server account is never required for local use.")
            }

            if isSigningOut {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Signing out…")
                        .foregroundStyle(.secondary)
                }
            }
        } header: {
            Text("Account")
        }
    }

    private func signOut() {
        guard !isSigningOut else { return }
        isSigningOut = true
        localError = nil
        localNotice = nil
        Task { @MainActor in
            defer { isSigningOut = false }
            do {
                let result = try await appState.signOut()
                localNotice = signOutNotice(result)
            } catch {
                localError = "Sign-out did not complete: \(error.localizedDescription)"
            }
        }
    }

    private func signOutNotice(_ result: LogoutResult) -> String {
        if result.remoteRevoked && result.localCredentialRemoved {
            return "Signed out. The server session was revoked and the local credential was removed."
        }
        if result.localCredentialRemoved {
            return "Signed out on this device. The server could not be reached, so the remote session may still be listed under Device Sessions. The ledger, queue and station identity are unchanged."
        }
        if result.remoteRevoked {
            return "The server session was revoked, but the local credential could not be removed from the Keychain. Signing out again is required to finish."
        }
        return "Sign-out did not finish: the local credential is still stored and the server session was not revoked."
    }

    // MARK: - Refresh

    private func refreshFromStore() async {
        do {
            try await appState.refresh()
        } catch {
            localError = "The store view could not be refreshed: \(error.localizedDescription)"
        }
    }

    // MARK: - Presentation helpers

    @ViewBuilder
    private func phaseSymbol(_ phase: SyncPresentation.Phase) -> some View {
        switch phase {
        case .standalone:
            Image(systemName: "laptopcomputer")
                .imageScale(.large)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
        case .offline:
            Image(systemName: "wifi.slash")
                .imageScale(.large)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
        case .syncing:
            ProgressView()
                .accessibilityHidden(true)
        case .upToDate:
            Image(systemName: "checkmark.icloud")
                .imageScale(.large)
                .foregroundStyle(.green)
                .accessibilityHidden(true)
        case .authRequired:
            Image(systemName: "person.badge.key")
                .imageScale(.large)
                .foregroundStyle(.orange)
                .accessibilityHidden(true)
        case .conflict:
            Image(systemName: "exclamationmark.triangle")
                .imageScale(.large)
                .foregroundStyle(.orange)
                .accessibilityHidden(true)
        case .error:
            Image(systemName: "exclamationmark.icloud")
                .imageScale(.large)
                .foregroundStyle(.red)
                .accessibilityHidden(true)
        case .blocked:
            Image(systemName: "lock.icloud")
                .imageScale(.large)
                .foregroundStyle(.red)
                .accessibilityHidden(true)
        }
    }

    private func phaseTitle(_ phase: SyncPresentation.Phase) -> String {
        switch phase {
        case .standalone: return "Local only"
        case .offline: return "Offline"
        case .syncing: return "Syncing"
        case .upToDate: return "Up to date"
        case .authRequired: return "Sign-in required"
        case .conflict: return "Conflicts need a decision"
        case .error: return "Sync error"
        case .blocked: return "Sync blocked"
        }
    }

    private func accessibilitySummary(_ presentation: SyncPresentation) -> String {
        var parts = [phaseTitle(presentation.phase)]
        parts.append("\(presentation.pendingCount) queued operation\(presentation.pendingCount == 1 ? "" : "s")")
        if presentation.conflictCount > 0 {
            parts.append("\(presentation.conflictCount) conflicts")
        }
        if let serverName = presentation.serverName {
            parts.append("Server \(serverName)")
        }
        if let lastSyncAt = presentation.lastSyncAt {
            parts.append("Last sync \(AppFormatting.timestamp(lastSyncAt))")
        }
        if let detail = presentation.detail, !detail.isEmpty {
            parts.append(detail)
        }
        return parts.joined(separator: ", ")
    }
}

// MARK: - File-level helpers

/// `true` when the system exporter reported a user cancellation rather than a
/// write failure. Kept outside the view so the presentation completion can
/// call it without actor isolation concerns.
private func isCancellationError(_ error: Error) -> Bool {
    let nsError = error as NSError
    return nsError.domain == NSCocoaErrorDomain && nsError.code == NSUserCancelledError
}

// MARK: - Local values

private struct SharePayload: Identifiable {
    let id = UUID()
    let url: URL
}

/// One labelled store fact. Long identifiers wrap instead of truncating and
/// stay selectable, so a user can compare them with the server.
private struct SettingsFactRow: View {
    let title: String
    let value: String
    var monospaced = false
    var warning = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(verbatim: value)
                .font(monospaced ? .system(.footnote, design: .monospaced) : .footnote)
                .foregroundStyle(warning ? Color.orange : Color.primary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .frame(minHeight: 44, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("\(title): \(value)"))
    }
}
