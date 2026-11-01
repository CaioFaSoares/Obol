import Foundation
import SwiftUI
import ObolCore
import ObolNativeRuntime

/// Operational dashboard for native 0.4.
///
/// Every number comes from the published local snapshot through `ObolCore`'s
/// `ForecastEngine`: no network call, no duplicated finance rules. The
/// snapshot-derived state is rebuilt once per snapshot or setting change, never
/// per row or per layout pass.
public struct DashboardView: View {
    @EnvironmentObject private var appState: AppState
    @AppStorage(DashboardPreferences.simulationsKey) private var includeSimulations = false
    @AppStorage(DashboardPreferences.horizonKey) private var horizonDays = 30

    @State private var derived: DashboardDerived?
    @State private var forecastError: String?
    @State private var localError: String?
    @State private var actionNotice: String?
    @State private var listTab: DashboardListTab = .realized
    @State private var pageCounts: [DashboardListTab: Int] = [:]
    @State private var selectedDayKey: String?
    @State private var daySelection: DashboardDaySelection?
    @State private var busyTransactionIDs: Set<String> = []

    public init() {}

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    notices
                    if let derived = derived {
                        balanceSection(derived)
                        quickEntryButton
                        trajectorySection(derived)
                        calendarSection(derived)
                        invoicesSection(derived)
                        activitySection(derived)
                    } else {
                        placeholderSection
                    }
                }
                .padding(16)
            }
            .navigationTitle("Dashboard")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        appState.openQuickEntry()
                    } label: {
                        Label("New entry", systemImage: "plus")
                    }
                }
            }
            .refreshable { await refreshAll() }
            .task { @MainActor in
                normalizeHorizon()
                recompute()
            }
            .onChange(of: appState.snapshot) { _ in recompute() }
            .onChange(of: horizonDays) { _ in recompute() }
            .onChange(of: includeSimulations) { _ in recompute() }
            .sheet(item: $daySelection) { selection in
                DayDetailView(date: selection.date)
                    .environmentObject(appState)
            }
        }
    }

    // MARK: Status

    @ViewBuilder
    private var notices: some View {
        if let actionNotice {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .accessibilityHidden(true)
                Text(actionNotice)
                    .font(.footnote)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Button {
                    self.actionNotice = nil
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel(Text("Dismiss notification"))
            }
            .padding(12)
            .background(Color.green.opacity(0.10), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }

        if let localError {
            DashboardStatusBanner(
                title: "Could not refresh",
                message: localError,
                systemImage: "exclamationmark.triangle.fill",
                tint: .red,
                retry: { Task { @MainActor in await refreshAll() } }
            )
        }

        if let forecastError {
            DashboardStatusBanner(
                title: "Forecast unavailable",
                message: forecastError,
                systemImage: "exclamationmark.triangle.fill",
                tint: .red,
                retry: { Task { @MainActor in await refreshAll() } }
            )
        }
    }

    @MainActor
    @ViewBuilder
    private var placeholderSection: some View {
        if appState.isLoading {
            DashboardCard {
                HStack(spacing: 12) {
                    ProgressView()
                    Text("Loading your local snapshot…")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 72)
            }
        } else if isEmptySnapshot {
            DashboardCard {
                DashboardEmptyState(
                    title: "No accounts yet",
                    message: "Add a checking or savings account in Management. The dashboard only shows balances it can derive from your accounts, entries and invoices.",
                    systemImage: "tray"
                )
            }
        } else if forecastError != nil {
            // The error banner above owns the explanation and the retry action.
            EmptyView()
        } else {
            DashboardCard {
                HStack(spacing: 12) {
                    ProgressView()
                    Text("Building the projection…")
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 72)
            }
        }
    }

    // MARK: Balance and settings

    @ViewBuilder
    private func balanceSection(_ derived: DashboardDerived) -> some View {
        DashboardCard {
            VStack(alignment: .leading, spacing: 14) {
                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 150), spacing: 12, alignment: .top)],
                    alignment: .leading,
                    spacing: 12
                ) {
                    DashboardMetricCard(
                        title: "Available cash (today)",
                        subtitle: "Actual non-investment account balances",
                        amount: derived.result.currentAvailableCash,
                        tint: .primary
                    )
                    DashboardMetricCard(
                        title: "Projection (+\(derived.horizonDays) days)",
                        subtitle: "End-of-day cash on \(AppFormatting.day(derived.result.endDate))",
                        amount: derived.result.endBalance,
                        tint: derived.result.endBalance < 0 ? .red : .green
                    )
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("Horizon")
                        .font(.subheadline.weight(.semibold))
                    Picker("Forecast horizon", selection: $horizonDays) {
                        ForEach(DashboardDerived.horizonChoices, id: \.self) { days in
                            Text("\(days) days").tag(days)
                        }
                    }
                    .pickerStyle(.segmented)
                    .controlSize(.large)
                    .accessibilityLabel(Text("Forecast horizon in days"))
                }

                Toggle(isOn: $includeSimulations) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Include simulations")
                            .font(.subheadline)
                        Text("What-if entries change this preview only, never real cash.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .tint(.indigo)

                if let explanation = derived.todayExplanation {
                    Text(explanation)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityLabel(Text("Balance explanation. \(explanation)"))
                }

                if let negativeDate = derived.result.firstNegativeDate {
                    Label(
                        "Projected cash turns negative on \(AppFormatting.day(negativeDate)).",
                        systemImage: "exclamationmark.triangle.fill"
                    )
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var quickEntryButton: some View {
        Button {
            Task { @MainActor in appState.openQuickEntry() }
        } label: {
            Label("New entry", systemImage: "plus.circle.fill")
                .font(.headline)
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.borderedProminent)
        .accessibilityHint(Text("Creates an income, expense or transfer entry."))
    }

    // MARK: Trajectory

    @ViewBuilder
    private func trajectorySection(_ derived: DashboardDerived) -> some View {
        DashboardCard(
            title: "Trajectory",
            subtitle: "End-of-day projected cash through \(AppFormatting.day(derived.result.endDate))"
        ) {
            if derived.result.timeline.isEmpty {
                DashboardEmptyState(
                    title: "No projection data",
                    message: "The forecast returned no days for this horizon.",
                    systemImage: "chart.xyaxis.line"
                )
            } else {
                DashboardTrajectoryChart(
                    days: derived.result.timeline,
                    dayIndex: derived.dayIndex,
                    selectedKey: selectedDayKey,
                    lowerBound: derived.chartLowerBound,
                    upperBound: derived.chartUpperBound,
                    summary: derived.chartSummary,
                    onSelect: select
                )
                Text(derived.chartSummary)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: Calendar

    private func calendarSection(_ derived: DashboardDerived) -> some View {
        DashboardCard(
            title: "Projected calendar",
            subtitle: "Select a day to see its cash events. Muted days fall outside the loaded projection."
        ) {
            DashboardCalendarView(
                days: derived.result.timeline,
                dayIndex: derived.dayIndex,
                todayKey: derived.todayKey,
                selectedKey: selectedDayKey,
                firstMonth: derived.firstMonth,
                lastMonth: derived.lastMonth,
                onSelect: select
            )
        }
    }

    // MARK: Invoices

    @ViewBuilder
    private func invoicesSection(_ derived: DashboardDerived) -> some View {
        DashboardCard(
            title: "Upcoming invoices",
            subtitle: "Card debt is charged on the due date, never on the purchase date."
        ) {
            if derived.invoicesInHorizon.isEmpty {
                DashboardEmptyState(
                    title: "No unpaid invoices",
                    message: "Every invoice due within \(derived.horizonDays) days is settled.",
                    systemImage: "checkmark.seal"
                )
            } else {
                VStack(spacing: 8) {
                    ForEach(derived.invoicesInHorizon, id: \.id) { invoice in
                        DashboardInvoiceRow(invoice: invoice) {
                            Task { @MainActor in appState.showCard(id: invoice.cardID) }
                        }
                    }
                }
            }
            if derived.laterInvoiceCount > 0 {
                Text("\(derived.laterInvoiceCount) more \(derived.laterInvoiceCount == 1 ? "invoice is" : "invoices are") due after \(AppFormatting.day(derived.result.endDate)).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: Activity lists

    @MainActor
    @ViewBuilder
    private func activitySection(_ derived: DashboardDerived) -> some View {
        DashboardCard(
            title: "Activity",
            subtitle: "Card purchases live under their invoice, not in these lists."
        ) {
            VStack(alignment: .leading, spacing: 12) {
                Picker("Activity list", selection: $listTab) {
                    ForEach(DashboardListTab.allCases) { tab in
                        Text(tab.title).tag(tab)
                    }
                }
                .pickerStyle(.segmented)
                .controlSize(.large)
                .accessibilityLabel(Text("Activity list"))

                listContent(derived)
            }
        }
    }

    @MainActor
    @ViewBuilder
    private func listContent(_ derived: DashboardDerived) -> some View {
        switch listTab {
        case .realized:
            transactionList(derived.realizedTransactions, derived: derived, tab: .realized) {
                DashboardEmptyState(
                    title: "No realized entries",
                    message: "Realized income, expenses and transfers appear here.",
                    systemImage: "clock.arrow.circlepath"
                )
            }
        case .pending:
            transactionList(derived.pendingTransactions, derived: derived, tab: .pending) {
                DashboardEmptyState(
                    title: "No pending entries",
                    message: "Upcoming bills, scheduled items and pending income appear here.",
                    systemImage: "hourglass"
                )
            }
        case .simulated:
            if includeSimulations {
                transactionList(derived.simulatedTransactions, derived: derived, tab: .simulated) {
                    DashboardEmptyState(
                        title: "No simulations",
                        message: "Simulated entries stay out of real cash until you explicitly convert one.",
                        systemImage: "wand.and.stars"
                    )
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    DashboardEmptyState(
                        title: "Simulations are off",
                        message: "Turn on simulations to preview what-if entries. Real cash is never affected.",
                        systemImage: "wand.and.stars"
                    )
                    Button("Enable simulations") {
                        includeSimulations = true
                    }
                    .frame(minHeight: 44)
                    .accessibilityHint(Text("Shows simulated entries in the projection and in this list."))
                }
            }
        }
    }

    @MainActor
    @ViewBuilder
    private func transactionList<Empty: View>(
        _ transactions: [ObolCore.Transaction],
        derived: DashboardDerived,
        tab: DashboardListTab,
        @ViewBuilder empty: () -> Empty
    ) -> some View {
        let limit = pageCount(for: tab)
        let rows = Array(transactions.prefix(limit))

        VStack(alignment: .leading, spacing: 0) {
            if rows.isEmpty {
                empty()
            } else {
                ForEach(rows) { transaction in
                    DashboardTransactionRow(
                        transaction: transaction,
                        today: derived.today,
                        detailLine: derived.detailLine(for: transaction),
                        isBusy: appState.isWorking || busyTransactionIDs.contains(transaction.id),
                        onEdit: { Task { @MainActor in appState.editTransaction(id: transaction.id) } },
                        onRealize: { updateBalance in
                            Task { @MainActor in
                                performRealize(transaction, updateBalance: updateBalance)
                            }
                        },
                        onConvertSimulation: {
                            Task { @MainActor in performConvertSimulation(transaction) }
                        },
                        onDelete: {
                            Task { @MainActor in performDelete(transaction) }
                        },
                        onOpenCard: cardOpenAction(for: transaction)
                    )
                    if transaction.id != rows.last?.id {
                        Divider()
                    }
                }

                if transactions.count > limit {
                    Button {
                        loadMore(tab)
                    } label: {
                        Text("Load more (\(transactions.count - limit) remaining)")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityHint(Text("Shows another 15 entries."))
                }
            }
        }
    }

    private func pageCount(for tab: DashboardListTab) -> Int {
        max(15, pageCounts[tab] ?? 15)
    }

    private func loadMore(_ tab: DashboardListTab) {
        pageCounts[tab] = pageCount(for: tab) + 15
    }

    // MARK: State

    @MainActor
    private var isEmptySnapshot: Bool {
        let snapshot = appState.snapshot
        return snapshot.accounts.isEmpty
            && snapshot.transactions.isEmpty
            && snapshot.invoices.isEmpty
            && snapshot.recurrences.isEmpty
    }

    private func normalizeHorizon() {
        if !DashboardDerived.horizonChoices.contains(horizonDays) {
            horizonDays = 30
        }
    }

    @MainActor
    private func recompute() {
        guard !isEmptySnapshot else {
            derived = nil
            forecastError = nil
            return
        }
        do {
            let built = try DashboardDerived.build(
                snapshot: appState.snapshot,
                horizonDays: horizonDays,
                includeSimulations: includeSimulations,
                now: Date()
            )
            derived = built
            forecastError = nil
            if let selectedDayKey, built.dayIndex[selectedDayKey] == nil {
                self.selectedDayKey = nil
            }
        } catch {
            // Keep the last valid values visible; the banner explains the failure.
            forecastError = error.localizedDescription
        }
    }

    @MainActor
    private func refreshAll() async {
        do {
            try await appState.refresh()
            localError = nil
        } catch {
            localError = error.localizedDescription
        }
        recompute()
    }

    private func select(_ day: ForecastDay) {
        selectedDayKey = day.dashboardKey
        daySelection = DashboardDaySelection(date: day.date)
    }

    // MARK: Actions

    private func cardOpenAction(for transaction: ObolCore.Transaction) -> (() -> Void)? {
        guard let cardID = transaction.cardID else { return nil }
        return { Task { @MainActor in appState.showCard(id: cardID) } }
    }

    @MainActor
    private func performRealize(_ transaction: ObolCore.Transaction, updateBalance: Bool) {
        guard !busyTransactionIDs.contains(transaction.id), !appState.isWorking else { return }
        busyTransactionIDs.insert(transaction.id)
        localError = nil
        Task { @MainActor in
            defer { busyTransactionIDs.remove(transaction.id) }
            do {
                try await appState.apply(
                    .realizeTransaction(id: transaction.id, updateBalance: updateBalance),
                    effectiveAt: Date()
                )
                actionNotice = updateBalance
                    ? "Realized \"\(transaction.title)\" and added it to the balance."
                    : "Realized \"\(transaction.title)\" silently. No balance changed."
            } catch {
                localError = error.localizedDescription
            }
        }
    }

    @MainActor
    private func performConvertSimulation(_ transaction: ObolCore.Transaction) {
        guard !busyTransactionIDs.contains(transaction.id), !appState.isWorking else { return }
        busyTransactionIDs.insert(transaction.id)
        localError = nil
        Task { @MainActor in
            defer { busyTransactionIDs.remove(transaction.id) }
            do {
                try await appState.apply(
                    .convertSimulation(id: transaction.id, toSimulated: false),
                    effectiveAt: Date()
                )
                actionNotice = "Converted \"\(transaction.title)\" to a real entry. Review it before realizing."
            } catch {
                localError = error.localizedDescription
            }
        }
    }

    @MainActor
    private func performDelete(_ transaction: ObolCore.Transaction) {
        guard !busyTransactionIDs.contains(transaction.id), !appState.isWorking else { return }
        busyTransactionIDs.insert(transaction.id)
        localError = nil
        Task { @MainActor in
            defer { busyTransactionIDs.remove(transaction.id) }
            do {
                try await appState.apply(
                    .deleteTransaction(id: transaction.id),
                    effectiveAt: Date()
                )
                actionNotice = "Deleted \"\(transaction.title)\"."
            } catch {
                localError = error.localizedDescription
            }
        }
    }
}
