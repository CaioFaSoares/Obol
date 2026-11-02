import Foundation
import SwiftUI
import UIKit
import ObolNativeRuntime

/// Native entry point of Obol 0.4.
///
/// The shell opens the durable SQLite store behind the Keychain station
/// identity before any feature is shown. A keychain or store failure never
/// creates a second identity, never deletes finance data, and never falls back
/// to an in-memory model: it presents the honest failure with a retry.
@main
struct ObolApp: App {
    @StateObject private var root = RootModel()

    var body: some Scene {
        WindowGroup {
            RootContentView(model: root)
        }
    }
}

/// Owns the opened store for the process lifetime and exposes either the real
/// AppState or the startup failure that prevented it.
@MainActor
final class RootModel: ObservableObject {
    @Published private(set) var state: AppState?
    @Published private(set) var startupError: String?

    init() {
        open()
    }

    func retry() {
        guard state == nil else { return }
        open()
    }

    private func open() {
        do {
            let keychain = KeychainStore()
            guard let stationIdentifier = try keychain.stationIdentifier(),
                  !stationIdentifier.isEmpty else {
                throw RootError.missingStationIdentifier
            }
            let database = try ObolDatabase(stationId: stationIdentifier)
            state = AppState(database: database, keychain: keychain)
            startupError = nil
        } catch {
            state = nil
            let message: String
            if let localized = error as? LocalizedError,
               let description = localized.errorDescription {
                message = description
            } else {
                message = String(describing: error)
            }
            startupError = """
            \(message)

            Obol left the existing local database untouched and did not create a new station identity.
            """
        }
    }

    private enum RootError: Error, LocalizedError {
        case missingStationIdentifier

        var errorDescription: String? {
            "The durable station identifier is unavailable in the Keychain."
        }
    }
}

/// Chooses between the real feature tree and the non-destructive startup
/// failure surface.
struct RootContentView: View {
    @ObservedObject var model: RootModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if let state = model.state {
                AppRootView()
                    .environmentObject(state)
                    .task {
                        await state.start()
                    }
                    .onChange(of: scenePhase) { phase in
                        if phase == .active {
                            Task { @MainActor in
                                await state.sceneBecameActive()
                            }
                        }
                    }
            } else {
                StartupFailureView(message: model.startupError ?? "The local store could not be opened.") {
                    model.retry()
                }
            }
        }
    }
}

/// The five-tab native composition with the global quick-entry sheet, the
/// transaction editor sheet, and an honest sync banner. There is no WebView,
/// no placeholder view, and no feature defined here.
struct AppRootView: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        ZStack {
            if state.isLoading {
                LoadingStartupView()
            } else {
                TabView(selection: $state.selectedTab) {
                    DashboardView()
                        .tabItem {
                            Label(AppTab.dashboard.title, systemImage: "house.fill")
                        }
                        .tag(AppTab.dashboard)

                    LedgerView()
                        .tabItem {
                            Label(AppTab.ledger.title, systemImage: "list.bullet.rectangle.portrait.fill")
                        }
                        .tag(AppTab.ledger)

                    CardsView()
                        .tabItem {
                            Label(AppTab.cards.title, systemImage: "creditcard.fill")
                        }
                        .tag(AppTab.cards)

                    ManagementView()
                        .tabItem {
                            Label(AppTab.management.title, systemImage: "square.grid.2x2.fill")
                        }
                        .tag(AppTab.management)

                    SettingsView()
                        .tabItem {
                            Label(AppTab.settings.title, systemImage: "gearshape.fill")
                        }
                        .tag(AppTab.settings)
                }
                .safeAreaInset(edge: .top, spacing: 0) {
                    SyncBanner()
                        .environmentObject(state)
                }
            }
        }
        .sheet(isPresented: quickEntryPresented) {
            QuickEntryView()
                .environmentObject(state)
        }
        .sheet(item: transactionEditorTarget) { target in
            TransactionEditorView(transactionID: target.id)
                .environmentObject(state)
        }
    }

    private var quickEntryPresented: Binding<Bool> {
        Binding<Bool>(
            get: { state.isQuickEntryPresented },
            set: { presented in
                if !presented {
                    state.dismissQuickEntry()
                }
            }
        )
    }

    private var transactionEditorTarget: Binding<TransactionTarget?> {
        Binding<TransactionTarget?>(
            get: {
                state.editTransactionTargetID.map(TransactionTarget.init(id:))
            },
            set: { value in
                if value == nil {
                    state.closeTransactionEditor()
                }
            }
        )
    }
}

/// Identifiable wrapper so `.sheet(item:)` follows the selected transaction.
private struct TransactionTarget: Identifiable, Equatable {
    let id: String
}

/// Honest first-launch surface shown only while the opened store publishes
/// its first complete view.
private struct LoadingStartupView: View {
    var body: some View {
        VStack(spacing: 16) {
            ProgressView()
                .controlSize(.large)
            Text("Opening your local ledger")
                .font(.headline)
            Text("No account or network connection is required.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Obol is opening the local ledger")
    }
}

/// Failure surface for a keychain or store open failure. It never offers a
/// new identity or a destructive reset; only a retry of the same open.
private struct StartupFailureView: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "exclamationmark.lock.fill")
                .font(.system(size: 44))
                .foregroundStyle(.orange)
                .accessibilityHidden(true)
            Text("Obol could not open the local store")
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button("Try Again", action: retry)
                .buttonStyle(.borderedProminent)
                .frame(minHeight: 44)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .systemBackground))
        .accessibilityElement(children: .contain)
    }
}

/// Compact, text-and-icon synchronization state. It appears only when there is
/// something honest to act on, never covers the tab bar, and never claims that
/// pending work is up to date.
private struct SyncBanner: View {
    @EnvironmentObject private var state: AppState

    var body: some View {
        let presentation = state.syncPresentation
        if shouldShow(presentation.phase) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: symbol(for: presentation.phase))
                    .foregroundStyle(tint(for: presentation.phase))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title(for: presentation.phase))
                        .font(.footnote.weight(.semibold))
                    Text(detail(for: presentation))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 4)
                action(for: presentation.phase)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .frame(minHeight: 44)
            .background(.bar)
            .overlay(alignment: .bottom) {
                Divider()
            }
            .accessibilityElement(children: .contain)
        }
    }

    private func shouldShow(_ phase: SyncPresentation.Phase) -> Bool {
        switch phase {
        case .standalone, .upToDate:
            return false
        case .offline, .syncing, .authRequired, .conflict, .error, .blocked:
            return true
        }
    }

    private func symbol(for phase: SyncPresentation.Phase) -> String {
        switch phase {
        case .standalone: return "internaldrive"
        case .offline: return "wifi.slash"
        case .syncing: return "arrow.triangle.2.circlepath"
        case .upToDate: return "checkmark.seal"
        case .authRequired: return "person.badge.key"
        case .conflict: return "exclamationmark.bubble"
        case .error: return "exclamationmark.triangle"
        case .blocked: return "lock.slash"
        }
    }

    private func tint(for phase: SyncPresentation.Phase) -> Color {
        switch phase {
        case .upToDate: return .green
        case .authRequired, .conflict, .error, .blocked: return .orange
        case .standalone, .offline, .syncing: return .secondary
        }
    }

    private func title(for phase: SyncPresentation.Phase) -> String {
        switch phase {
        case .standalone: return "Local only"
        case .offline: return "Offline"
        case .syncing: return "Synchronizing"
        case .upToDate: return "Up to date"
        case .authRequired: return "Sign-in required"
        case .conflict: return "Conflicts need a decision"
        case .error: return "Sync failed"
        case .blocked: return "Recovery needed"
        }
    }

    private func detail(for presentation: SyncPresentation) -> String {
        var parts: [String] = []
        if presentation.pendingCount > 0 {
            parts.append("\(presentation.pendingCount) pending")
        }
        if presentation.conflictCount > 0 {
            parts.append("\(presentation.conflictCount) conflicted")
        }
        if let detail = presentation.detail, !detail.isEmpty {
            parts.append(detail)
        }
        return parts.isEmpty ? "No further detail is available." : parts.joined(separator: " · ")
    }

    @ViewBuilder
    private func action(for phase: SyncPresentation.Phase) -> some View {
        switch phase {
        case .syncing:
            ProgressView()
                .accessibilityLabel("Synchronizing")
        case .offline, .error:
            Button("Retry") {
                Task { await state.synchronize() }
            }
            .buttonStyle(.bordered)
            .frame(minHeight: 44)
            .accessibilityLabel("Retry synchronization")
        case .authRequired, .conflict, .blocked:
            Button("Open Settings") {
                state.selectedTab = .settings
            }
            .buttonStyle(.bordered)
            .frame(minHeight: 44)
            .accessibilityLabel("Open synchronization settings")
        case .standalone, .upToDate:
            EmptyView()
        }
    }
}
