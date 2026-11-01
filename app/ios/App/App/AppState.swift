import Foundation
import SwiftUI
import UIKit
import ObolCore
import ObolNativeRuntime

/// The composition-root state object of the native Obol app.
///
/// Every feature receives this instance as `EnvironmentObject`. It publishes
/// the complete readable store view and the two writable navigation values,
/// and every mutation, synchronization, pairing, session, and maintenance
/// action goes through the real SQLite store or the real BFF client.
///
/// The class never stores amounts of its own, never stores a token or password
/// in a published value, and never invents a fallback financial model. The
/// ephemeral pairing credentials live only for the duration of one wizard run.
@MainActor
public final class AppState: ObservableObject {
    // MARK: - Published readable state (read-only to features)

    @Published public private(set) var snapshot: FinancialSnapshot
    @Published public private(set) var storeStatus: StoreStatus?
    @Published public private(set) var conflicts: [ConflictRecord]
    @Published public private(set) var outbox: [OutboxOperation]
    @Published public private(set) var syncPresentation: SyncPresentation
    @Published public private(set) var isLoading: Bool
    @Published public private(set) var isWorking: Bool
    @Published public private(set) var lastError: String?
    @Published public private(set) var currentServerURL: String?
    @Published public private(set) var isAuthenticated: Bool
    @Published public private(set) var pairingPreview: PairingPreview?

    // MARK: - Writable navigation state (the only writable contract)

    @Published public var selectedTab: AppTab = .dashboard
    @Published public var selectedCardID: String?

    // The app root owns these presentation flags; no feature writes them.
    @Published private(set) var isQuickEntryPresented = false
    @Published private(set) var editTransactionTargetID: String?

    // MARK: - Live Core objects

    private let database: ObolDatabase
    private let keychain: KeychainStore
    private let deviceLabel: String

    private var didStart = false
    private var autoSyncing = false
    private var pairingCommitInProgress = false
    private var pairingScan: PairingFlow.ScanReport?
    private var pairingSession: RemoteSession?
    private var lastSyncAt: Date?
    private var lastServerName: String?
    private var lastFlowOffline = false
    private var lastFlowAuthRequired = false
    private var lastFlowFailed = false

    /// Content digest of the last completed export, with `exportedAt`
    /// excluded. A destructive pairing confirmation re-reads the store and
    /// requires the same digest, so an intervening local or sync change
    /// invalidates the offer instead of discarding unseen data.
    private var exportFingerprint: String?

    // MARK: - Init

    public init(database: ObolDatabase, keychain: KeychainStore = KeychainStore()) {
        self.database = database
        self.keychain = keychain
        self.snapshot = .empty
        self.storeStatus = nil
        self.conflicts = []
        self.outbox = []
        self.syncPresentation = SyncPresentation(
            phase: .standalone,
            isPaired: false,
            pendingCount: 0,
            conflictCount: 0
        )
        self.isLoading = true
        self.isWorking = false
        self.lastError = nil
        self.currentServerURL = nil
        self.isAuthenticated = false
        self.pairingPreview = nil
        let name = UIDevice.current.name.trimmingCharacters(in: .whitespacesAndNewlines)
        self.deviceLabel = name.isEmpty ? "iOS device" : name
    }

    // MARK: - Lifecycle

    /// Publishes the local store view before any network attempt, then runs
    /// one standalone recurrence pass or one non-blocking synchronization
    /// cycle. Opening and reading the store never depend on a server, an
    /// account, or a valid token, and an automatic cycle never disables local
    /// finance controls.
    public func start() async {
        guard !didStart else { return }
        didStart = true
        isLoading = true
        do {
            try await reloadStore()
            isLoading = false
            await refreshPresentation()
        } catch {
            isLoading = false
            record(error)
            await refreshPresentation()
            return
        }

        let binding = try? await database.binding()
        if binding?.isPaired == true {
            await autoSynchronize()
        } else {
            await materializeUnpairedRecurrences()
            try? await reloadStore()
            await refreshPresentation()
        }
    }

    /// Re-reads and republishes the complete store view. Errors propagate so a
    /// pull-to-refresh surface can report the real cause.
    public func refresh() async throws {
        do {
            try await reloadStore()
            lastError = nil
            await refreshPresentation()
        } catch {
            record(error)
            throw error
        }
    }

    // MARK: - Financial commands

    /// Applies one financial command with its real business time. The SQLite
    /// commit and the matching outbox intent finish before the published
    /// snapshot changes; no network call is awaited. On failure the caller's
    /// form keeps every field and the readable cause is rethrown.
    public func apply(_ command: FinancialCommand, effectiveAt: Date = Date()) async throws {
        guard !pairingCommitInProgress else { throw StateError.operationInProgress }
        do {
            let result = try await database.apply(command, effectiveAt: effectiveAt)
            snapshot = result.snapshot
            try await reloadMetadata()
            lastError = nil
            await refreshPresentation()
        } catch {
            record(error)
            throw error
        }
    }

    /// Standalone-only monthly generation. The store records the generated
    /// facts and their intents atomically and refuses this command while the
    /// store is paired, so a paired device never queues a local cron write.
    private func materializeUnpairedRecurrences() async {
        do {
            _ = try await database.apply(.processMonthlyRecurrences, effectiveAt: Date())
        } catch StoreError.pairedAutomaticRecurrenceDisabled {
            return
        } catch {
            record(error)
        }
    }

    // MARK: - Root presentation actions

    public func openQuickEntry() {
        isQuickEntryPresented = true
    }

    func dismissQuickEntry() {
        isQuickEntryPresented = false
    }

    public func editTransaction(id: String) {
        selectedTab = .ledger
        editTransactionTargetID = id
    }

    public func showCard(id: String) {
        selectedCardID = id
        selectedTab = .cards
    }

    func closeTransactionEditor() {
        editTransactionTargetID = nil
    }

    // MARK: - Synchronization

    /// Runs one user-initiated bounded foreground cycle: handshake, complete
    /// commit pulls, dependency-ordered pushes, and a final pull. Network
    /// failures, rejected sessions, conflicts, and typed stops are published
    /// honestly; local finance and the outbox stay intact and no unbounded
    /// retry loop starts.
    public func synchronize() async {
        guard !isWorking, !autoSyncing else { return }
        isWorking = true
        await runCycle()
        isWorking = false
        await refreshPresentation()
    }

    /// Automatic launch/foreground cycle. It publishes the same honest phase
    /// but never sets `isWorking`, so local finance controls stay enabled
    /// while the server is contacted; an expired session therefore never
    /// becomes a network wall in front of the local ledger.
    private func autoSynchronize() async {
        guard !isWorking, !autoSyncing else { return }
        let binding = try? await database.binding()
        guard binding?.isPaired == true else { return }
        autoSyncing = true
        await runCycle()
        autoSyncing = false
        await refreshPresentation()
    }

    private func runCycle() async {
        lastFlowOffline = false
        lastFlowAuthRequired = false
        lastFlowFailed = false
        await refreshPresentation()

        do {
            let binding = try await database.binding()
            guard binding.isPaired else { return }
            let report = try await SyncEngine.foregroundCycle(
                database: database,
                deviceLabel: deviceLabel,
                progress: { [weak self] update in
                    Task { @MainActor in
                        self?.publishProgress(update)
                    }
                }
            )
            lastSyncAt = report.finishedAt
            lastServerName = report.handshake.serverName
            lastError = nil
            try await reloadStore()
        } catch {
            if Self.isCancellation(error) { return }
            classifyFlow(error)
            record(error)
            try? await reloadStore()
        }
    }

    private static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if let apiError = error as? APIError, apiError == .cancelled { return true }
        return false
    }

    private func publishProgress(_ update: SyncEngine.CycleProgress) {
        guard isWorking || autoSyncing else { return }
        syncPresentation = SyncPresentation(
            phase: .syncing,
            isPaired: true,
            pendingCount: unresolvedOperations.count,
            conflictCount: conflicts.count,
            lastSyncAt: lastSyncAt,
            detail: update.detail,
            serverName: lastServerName
        )
    }

    // MARK: - Export

    /// Serializes the complete local store (ledger, binding, outbox, stored
    /// conflicts) for the export offer of a destructive replacement, and
    /// records a content digest excluding the export timestamp.
    public func exportSnapshot() async throws -> Data {
        do {
            let data = try await database.exportJSON()
            guard let fingerprint = Self.contentFingerprint(of: data) else {
                exportFingerprint = nil
                throw StateError.exportVerificationFailed
            }
            exportFingerprint = fingerprint
            lastError = nil
            return data
        } catch {
            exportFingerprint = nil
            record(error)
            throw error
        }
    }

    private static func contentFingerprint(of data: Data) -> String? {
        guard let value = try? JSONValue(parsing: data),
              var object = value.objectValue else {
            return nil
        }
        object.removeValue(forKey: "exportedAt")
        let canonical = CanonicalJSON.string(.object(object))
        return SyncHashing.sha256(Data(canonical.utf8))
    }

    // MARK: - Pairing preview

    /// Performs a live, non-persisting login and handshake, derives the
    /// allowed actions from the pairing matrix, and publishes the preview.
    /// The ephemeral session is only kept in memory for a later confirmation.
    @discardableResult
    public func previewConnection(
        serverAddress: String,
        email: String,
        password: String
    ) async throws -> PairingPreview {
        guard !isWorking, !autoSyncing else { throw StateError.operationInProgress }
        isWorking = true
        defer { isWorking = false }

        pairingScan = nil
        pairingSession = nil
        pairingPreview = nil

        do {
            let facts = try await database.legacyProfileFacts()
            let binding = try await database.binding()
            let scanResult = try await PairingFlow.previewScan(
                serverAddress: serverAddress,
                stationId: binding.stationId,
                email: email,
                password: password,
                deviceLabel: deviceLabel
            )
            let scan = scanResult.report
            let preview = Self.makePairingPreview(
                scan: scan,
                binding: binding,
                legacyRows: facts.legacyRows,
                localEntityCount: facts.entityCount,
                localOperationCount: facts.pendingCount,
                receiptCount: facts.receiptCount
            )
            pairingScan = scan
            pairingSession = scanResult.session
            pairingPreview = preview
            lastError = nil
            return preview
        } catch {
            pairingScan = nil
            pairingSession = nil
            pairingPreview = nil
            record(error)
            throw error
        }
    }

    /// Executes an already confirmed choice. The root and the Core flow both
    /// validate the matrix; a destructive replacement additionally requires
    /// the exact `REPLACE` token, a completed export offer, and an unchanged
    /// export digest. No merge is ever automatic.
    public func confirmConnection(
        choice: PairingAction,
        confirmation: String,
        exportCompleted: Bool
    ) async throws {
        guard !isWorking, !autoSyncing else { throw StateError.operationInProgress }
        guard let scan = pairingScan,
              let session = pairingSession,
              let preview = pairingPreview else {
            throw StateError.connectionDecisionUnavailable
        }
        guard preview.actions.contains(choice) else {
            throw StateError.unsupportedPairingAction(choice.rawValue)
        }

        if choice.isDestructive && preview.hasLocalData {
            guard confirmation.trimmingCharacters(in: .whitespacesAndNewlines) == "REPLACE" else {
                throw StateError.replaceConfirmationRequired
            }
            guard exportCompleted else {
                throw StateError.exportCompletionRequired
            }
            guard let exportedFingerprint = exportFingerprint else {
                throw StateError.exportCompletionRequired
            }
            let currentData: Data
            do {
                currentData = try await database.exportJSON()
            } catch {
                record(error)
                throw error
            }
            guard let currentFingerprint = Self.contentFingerprint(of: currentData),
                  currentFingerprint == exportedFingerprint else {
                exportFingerprint = nil
                throw StateError.exportStale
            }
        }

        isWorking = true
        pairingCommitInProgress = true
        defer {
            isWorking = false
            pairingCommitInProgress = false
        }

        let binding: SyncBinding
        do {
            binding = try await database.binding()
        } catch {
            record(error)
            throw error
        }

        do {
            let outcome = try await PairingFlow.confirm(
                choice: Self.flowChoice(for: choice),
                scan: scan,
                session: session,
                stationId: binding.stationId,
                database: database,
                deviceLabel: deviceLabel,
                replaceConfirmation: confirmation,
                exportCompleted: exportCompleted,
                progress: { [weak self] update in
                    Task { @MainActor in
                        self?.publishProgress(update)
                    }
                }
            )
            if outcome != .stayedLocal {
                lastSyncAt = Date()
                lastServerName = scan.handshake.serverName
            }
            clearPairingSession()
            if choice.isDestructive {
                exportFingerprint = nil
            }
            lastFlowOffline = false
            lastFlowAuthRequired = false
            lastFlowFailed = false
            lastError = nil
            do {
                try await reloadStore()
            } catch {
                record(error)
            }
            isWorking = false
            await refreshPresentation()
        } catch {
            // A failed confirmation may already have remapped identifiers or
            // cleared a discarded baseline. The ephemeral credentials are
            // dropped and a fresh scan is required; local data is never
            // silently repaired.
            clearPairingSession()
            record(error)
            try? await reloadStore()
            isWorking = false
            await refreshPresentation()
            throw error
        }
    }

    public func cancelConnectionPreview() {
        clearPairingSession()
    }

    private func clearPairingSession() {
        pairingScan = nil
        pairingSession = nil
        pairingPreview = nil
    }

    private static func flowChoice(for action: PairingAction) -> PairingFlow.PairingChoice {
        switch action {
        case .resume: return .resume
        case .useServerData: return .useServerData
        case .importLocalData: return .importLocalData
        case .seedEmptyServer: return .seedEmptyServer
        case .stayLocal: return .stayLocal
        }
    }

    private static func makePairingPreview(
        scan: PairingFlow.ScanReport,
        binding: SyncBinding,
        legacyRows: Bool,
        localEntityCount: Int,
        localOperationCount: Int,
        receiptCount: Int
    ) -> PairingPreview {
        let storedInstance = binding.serverInstanceId.flatMap { $0.isEmpty ? nil : $0 }
        let hasServerHistory = binding.isPaired || storedInstance != nil || receiptCount > 0
        let identityMatches = binding.isPaired
            && storedInstance == scan.handshake.serverInstanceId
            && binding.ownerFingerprint == scan.handshake.ownerFingerprint
        let epochMatches = binding.dataEpoch == scan.handshake.dataEpoch
        let serverHasData = scan.handshake.hasFinancialData

        var actions: [PairingAction] = []
        var warnings: [String] = []

        if binding.isPaired {
            warnings.append(
                "This store is bound to a station. A same-instance server URL move keeps the station; a different server identity never receives the queued outbox."
            )
            let canResume = identityMatches && epochMatches && binding.stopReason == .none
            if canResume {
                actions.append(.resume)
                warnings.append(
                    "Resume keeps this station and its frozen queue. Replacing with the server data discards local financial data and requires a completed export when local data exists."
                )
            } else {
                if !identityMatches {
                    warnings.append(
                        "The scanned server identity differs from the stored binding (endpoint or owner mismatch). The pending queue cannot be replayed there."
                    )
                }
                if binding.isPaired && !epochMatches {
                    warnings.append(
                        "The server data epoch changed for this binding. Journal history cannot be compared, so only an explicit replacement continues."
                    )
                }
                if binding.stopReason != .none {
                    let detail = binding.stopDetail ?? "no detail"
                    warnings.append(
                        "Synchronization is stopped (\(binding.stopReason.rawValue)): \(detail). Use the server data or stay local; no automatic repair runs."
                    )
                }
            }
            actions.append(.useServerData)
            actions.append(.stayLocal)
        } else if hasServerHistory {
            warnings.append(
                "This station has previous server history. A different deployment never receives its queued or frozen history; export first if you need a copy, then use the server data or stay standalone."
            )
            actions.append(.useServerData)
            actions.append(.stayLocal)
        } else if serverHasData {
            if legacyRows {
                warnings.append(
                    "This log-free profile imports as a complete settled snapshot with fresh identifiers and every reference rewritten, including paid and partial invoices. It never merges existing server identifiers or replays a partial outbox."
                )
                actions.append(.importLocalData)
                actions.append(.useServerData)
            } else if localEntityCount > 0 || localOperationCount > 0 {
                warnings.append(
                    "Import transfers this device's complete settled snapshot — all seven collections, including paid and partial invoices — with fresh identifiers and rewritten references, then pulls the server baseline. It never reconstructs history from a partial outbox or merges server identifiers."
                )
                actions.append(.importLocalData)
                actions.append(.useServerData)
            } else {
                actions.append(.useServerData)
            }
            actions.append(.stayLocal)
        } else {
            if legacyRows {
                warnings.append(
                    "Seeding copies this log-free legacy profile into the empty server as one bounded atomic commit (10,000 rows / 10 MiB)."
                )
                actions.append(.seedEmptyServer)
                actions.append(.stayLocal)
            } else if localOperationCount > 0 {
                warnings.append(
                    "Import transfers this device's complete settled snapshot with fresh identifiers and rewritten references as one frozen request, preserving paid and partial invoices; later local changes synchronize normally."
                )
                actions.append(.importLocalData)
                actions.append(.stayLocal)
            } else {
                actions.append(.useServerData)
                actions.append(.stayLocal)
            }
        }

        return PairingPreview(
            serverName: scan.handshake.serverName,
            serverAddress: scan.origin.storageKey,
            hasServerData: serverHasData,
            localEntityCount: localEntityCount,
            localOperationCount: localOperationCount,
            isRePairing: hasServerHistory,
            actions: actions,
            warnings: warnings
        )
    }

    // MARK: - Disconnect and sign-out

    /// Unpairs while the ledger, outbox queue, conflicts, cursor, receipts and
    /// station identity stay in the local store.
    public func disconnect() async throws {
        guard !isWorking, !autoSyncing else { throw StateError.operationInProgress }
        isWorking = true
        defer { isWorking = false }
        do {
            try await database.disconnectPairingImmediately()
            lastSyncAt = nil
            lastServerName = nil
            lastFlowOffline = false
            lastFlowAuthRequired = false
            lastFlowFailed = false
            lastError = nil
            try await reloadStore()
            isWorking = false
            await refreshPresentation()
        } catch {
            record(error)
            throw error
        }
    }

    /// Explicit local sign-out. The local credential is removed even when the
    /// remote revocation fails, and the returned value reports the remote
    /// result honestly. Finance, outbox, conflicts, and station identity stay.
    public func signOut() async throws -> LogoutResult {
        guard !isWorking, !autoSyncing else { throw StateError.operationInProgress }
        isWorking = true
        defer { isWorking = false }
        let binding = try await database.binding()
        guard binding.isPaired,
              let serverURL = binding.serverURL,
              !serverURL.isEmpty else {
            throw StateError.notPairedForSession
        }
        let client = try SyncEngine.makeClient(serverURL: serverURL)
        let auth = AuthAPI(client: client)
        do {
            let result = try await auth.logoutPersisted()
            finishSignOut()
            lastError = nil
            isWorking = false
            await refreshPresentation()
            return result
        } catch {
            let removalError: Error?
            let removed: Bool
            do {
                removed = try auth.logoutLocallyOnly()
                removalError = nil
            } catch let localError {
                removed = false
                removalError = localError
            }
            finishSignOut()
            isWorking = false
            await refreshPresentation()
            if let removalError {
                record(removalError)
                throw removalError
            }
            record(error)
            return LogoutResult(remoteRevoked: false, localCredentialRemoved: removed)
        }
    }

    private func finishSignOut() {
        lastFlowOffline = false
        lastFlowAuthRequired = false
        lastFlowFailed = false
    }

    // MARK: - Conflicts and rejections

    public func resolveConflict(
        opId: String,
        resolution: ConflictResolution,
        dependents: DependentStrategy
    ) async throws {
        guard !isWorking, !autoSyncing else { throw StateError.operationInProgress }
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await database.resolveConflict(
                opId: opId,
                resolution: resolution,
                dependentStrategy: dependents
            )
            lastError = nil
            try await reloadStore()
            isWorking = false
            await refreshPresentation()
        } catch {
            record(error)
            throw error
        }
    }

    public func acknowledgeRejected(
        opId: String,
        dependents: DependentStrategy
    ) async throws {
        guard !isWorking, !autoSyncing else { throw StateError.operationInProgress }
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await database.acknowledgeRejectedOperation(
                opId: opId,
                dependentStrategy: dependents
            )
            lastError = nil
            try await reloadStore()
            isWorking = false
            await refreshPresentation()
        } catch {
            record(error)
            throw error
        }
    }

    // MARK: - Sessions and account maintenance

    public func sessions() async throws -> [AuthSessionEntry] {
        do {
            let client = try await boundClient()
            let session = try await SyncEngine.ensureSession(client: client)
            return try await AuthAPI(client: client).listSessions(session)
        } catch {
            record(error)
            throw error
        }
    }

    public func revokeSession(id: String) async throws {
        do {
            let client = try await boundClient()
            let session = try await SyncEngine.ensureSession(client: client)
            _ = try await AuthAPI(client: client).revokeSession(id: id, using: session)
        } catch {
            record(error)
            throw error
        }
    }

    public func requestPasswordReset(email: String) async throws {
        do {
            let client = try await boundClient()
            _ = try await AuthAPI(client: client).requestPasswordReset(email: email)
        } catch {
            record(error)
            throw error
        }
    }

    /// Runs the server scheduler through the actual BFF job routes. The
    /// server, not this device, is the only financial writer here.
    public func runServerMaintenance() async throws {
        do {
            let client = try await boundClient()
            let session = try await SyncEngine.ensureSession(client: client)
            struct JobBody: Encodable {}
            try await client.postWithoutResponse(
                "/api/jobs/recurrence",
                body: JobBody(),
                bearerToken: session.token
            )
            try await client.postWithoutResponse(
                "/api/jobs/reconcile",
                body: JobBody(),
                bearerToken: session.token
            )
        } catch {
            record(error)
            throw error
        }
    }

    /// Destructive server maintenance through `POST /api/admin/reset`. The
    /// `LIMPAR` protocol token is enforced here and by the server. Local data
    /// is never erased by this call; the next handshake surfaces the epoch
    /// change as a typed stop.
    public func resetServerData(confirmation: String) async throws {
        let typed = confirmation.trimmingCharacters(in: .whitespacesAndNewlines)
        guard typed.uppercased() == "LIMPAR" else {
            throw StateError.resetConfirmationRequired
        }
        guard !isWorking, !autoSyncing else { throw StateError.operationInProgress }
        do {
            let client = try await boundClient()
            let session = try await SyncEngine.ensureSession(client: client)
            struct ResetBody: Encodable { let confirm: String }
            try await client.postWithoutResponse(
                "/api/admin/reset",
                body: ResetBody(confirm: typed),
                bearerToken: session.token
            )
        } catch {
            record(error)
            throw error
        }
    }

    private func boundClient() async throws -> BFFClient {
        let binding = try await database.binding()
        guard binding.isPaired,
              let serverURL = binding.serverURL,
              !serverURL.isEmpty else {
            throw StateError.notPairedForSession
        }
        return try SyncEngine.makeClient(serverURL: serverURL)
    }

    // MARK: - Scene coordination (root only)

    func sceneBecameActive() async {
        guard didStart else { return }
        let binding = try? await database.binding()
        if binding?.isPaired == true {
            await autoSynchronize()
        } else {
            await materializeUnpairedRecurrences()
            try? await reloadStore()
            await refreshPresentation()
        }
    }

    // MARK: - Store publication

    private var unresolvedOperations: [OutboxOperation] {
        outbox.filter { !$0.status.isTerminal }
    }

    private func reloadStore() async throws {
        let status = try await database.storeStatus()
        let value = try await database.loadFinancialSnapshot()
        let conflictRows = try await database.conflicts()
        let pending = try await database.pendingOperations()
        snapshot = value
        storeStatus = status
        conflicts = conflictRows
        outbox = pending
    }

    private func reloadMetadata() async throws {
        let status = try await database.storeStatus()
        let conflictRows = try await database.conflicts()
        let pending = try await database.pendingOperations()
        storeStatus = status
        conflicts = conflictRows
        outbox = pending
    }

    private func refreshPresentation() async {
        let binding = try? await database.binding()
        currentServerURL = binding?.serverURL
        let authenticated = authenticationState(for: binding)
        isAuthenticated = authenticated
        syncPresentation = presentation(for: binding, authenticated: authenticated)
    }

    private func authenticationState(for binding: SyncBinding?) -> Bool {
        guard let binding,
              binding.isPaired,
              !lastFlowAuthRequired,
              let serverURL = binding.serverURL,
              !serverURL.isEmpty,
              let origin = try? SyncEngine.origin(fromServerURL: serverURL) else {
            return false
        }
        do {
            return try keychain.readSessionSecret(for: origin) != nil
        } catch {
            return false
        }
    }

    private func presentation(
        for binding: SyncBinding?,
        authenticated: Bool
    ) -> SyncPresentation {
        let paired = binding?.isPaired ?? false
        let pending = unresolvedOperations
        let conflictCount = conflicts.count
        let queueDetail: String? = pending.isEmpty
            ? nil
            : "\(pending.count) operation\(pending.count == 1 ? "" : "s") waiting."

        var phase: SyncPresentation.Phase
        var detail: String?

        if !paired {
            if conflictCount > 0 {
                phase = .conflict
                detail = "\(conflictCount) conflicted operation\(conflictCount == 1 ? "" : "s") need a decision."
            } else {
                phase = .standalone
                if pending.isEmpty {
                    detail = "Every financial change stays on this device."
                } else {
                    detail = "\(pending.count) local operation\(pending.count == 1 ? "" : "s") saved for a future pairing."
                }
            }
        } else if let reason = binding?.stopReason, reason != .none {
            phase = .blocked
            detail = binding?.stopDetail ?? "Synchronization is stopped (\(reason.rawValue))."
        } else if isWorking || autoSyncing {
            phase = .syncing
            detail = "Synchronizing with the server."
        } else if conflictCount > 0 {
            phase = .conflict
            detail = "\(conflictCount) conflicted operation\(conflictCount == 1 ? "" : "s") need a decision."
        } else if !authenticated {
            phase = .authRequired
            detail = "Sign in again to synchronize. Local finance remains available."
        } else if lastFlowOffline {
            phase = .offline
            detail = queueDetail ?? "No server connection; local finance remains available."
        } else if lastFlowFailed {
            phase = .error
            detail = queueDetail ?? "The last synchronization failed; retry when ready."
        } else if pending.contains(where: { $0.blockedBy != nil }) {
            phase = .blocked
            let blocked = pending.filter { $0.blockedBy != nil }.count
            detail = "\(blocked) dependent operation\(blocked == 1 ? "" : "s") blocked for explicit resolution."
        } else if !pending.isEmpty {
            phase = .error
            detail = "\(pending.count) operation\(pending.count == 1 ? "" : "s") queued; run Synchronize to upload."
        } else {
            phase = .upToDate
            detail = lastSyncAt == nil
                ? "Connected; no local operation is waiting."
                : "All local operations are synchronized."
        }

        return SyncPresentation(
            phase: phase,
            isPaired: paired,
            pendingCount: pending.count,
            conflictCount: conflictCount,
            lastSyncAt: lastSyncAt,
            detail: detail,
            serverName: lastServerName
        )
    }

    // MARK: - Error classification

    private func classifyFlow(_ error: Error) {
        if error is URLError {
            lastFlowOffline = true
            return
        }
        if let engine = error as? SyncEngine.EngineError {
            switch engine {
            case .missingStoredCredential, .sessionExpired:
                lastFlowAuthRequired = true
            case .offline, .transport:
                lastFlowOffline = true
            case .notPaired, .missingServerURL, .syncStopped,
                 .pullBudgetExhausted, .pushBudgetExhausted:
                lastFlowFailed = true
            }
            return
        }
        if let apiError = error as? APIError {
            if apiError.isAuthenticationFailure {
                lastFlowAuthRequired = true
            } else if case .transport = apiError {
                lastFlowOffline = true
            } else {
                lastFlowFailed = true
            }
            return
        }
        lastFlowFailed = true
    }

    private func record(_ error: Error) {
        lastError = Self.describe(error)
    }

    private static func describe(_ error: Error) -> String {
        if let localized = error as? LocalizedError,
           let description = localized.errorDescription {
            return description
        }
        return String(describing: error)
    }

    // MARK: - Root validation errors

    public enum StateError: Error, Equatable, Sendable, LocalizedError {
        case operationInProgress
        case connectionDecisionUnavailable
        case unsupportedPairingAction(String)
        case replaceConfirmationRequired
        case exportCompletionRequired
        case exportVerificationFailed
        case exportStale
        case resetConfirmationRequired
        case notPairedForSession

        public var errorDescription: String? {
            switch self {
            case .operationInProgress:
                return "Another synchronization or connection action is still running."
            case .connectionDecisionUnavailable:
                return "No connection preview is active. Scan the server again before confirming."
            case .unsupportedPairingAction(let action):
                return "The action '\(action)' is not offered by the current pairing preview."
            case .replaceConfirmationRequired:
                return "Type REPLACE to confirm replacing the local financial data."
            case .exportCompletionRequired:
                return "Complete a successful export before replacing the local data."
            case .exportVerificationFailed:
                return "The exported snapshot could not be re-read to verify that the local data did not change."
            case .exportStale:
                return "The ledger, outbox, conflicts, or binding changed after the export. Export again before replacing this device."
            case .resetConfirmationRequired:
                return "The server reset requires the exact confirmation token LIMPAR."
            case .notPairedForSession:
                return "Bind this device to a server first; the action needs a deployment origin."
            }
        }
    }
}
