import SwiftUI
import Foundation
import ObolCore
import ObolNativeRuntime

// The ledger reads only the published AppState snapshot and routes every
// mutation through AppState.apply. Financial effects are never computed here:
// reversal and application belong to the ObolCore engine.
//
// `ObolCore.Transaction` is always qualified because `SwiftUI.Transaction` is
// also in scope in this module.

public struct LedgerView: View {
    public init() {}

    @EnvironmentObject private var appState: AppState
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    @State private var filters = LedgerFilters()
    @State private var derived = LedgerDerived.empty
    @State private var pageIndex = 0
    @State private var isFiltersExpanded = false
    @State private var pendingAction: LedgerPendingAction?
    @State private var isMutating = false
    @State private var errorMessage: String?
    @State private var exportFile: LedgerExportFile?

    /// Rows per page. Totals and the CSV export always cover the complete
    /// filtered set, never only the visible page.
    private static let pageSize = 20

    private var isBusy: Bool {
        isMutating || appState.isWorking
    }

    public var body: some View {
        NavigationStack {
            ledgerContent
                .navigationTitle("Ledger")
                .searchable(
                    text: $filters.search,
                    placement: .navigationBarDrawer(displayMode: .always),
                    prompt: "Search by title"
                )
                .toolbar {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button {
                            prepareExport()
                        } label: {
                            Label("Export CSV", systemImage: "square.and.arrow.up")
                        }
                        .accessibilityLabel("Export the filtered ledger as CSV")
                    }
                }
                .refreshable {
                    await refresh()
                }
        }
        .onAppear {
            rebuild()
        }
        .onChange(of: appState.snapshot) { _ in
            rebuild()
        }
        .onChange(of: filters) { _ in
            pageIndex = 0
            rebuild()
        }
        .alert("Ledger error", isPresented: errorPresented) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
        .confirmationDialog(
            pendingAction?.title ?? "",
            isPresented: actionDialogPresented,
            titleVisibility: .visible
        ) {
            actionDialogButtons
        } message: {
            Text(pendingAction?.message ?? "")
        }
        .sheet(item: $exportFile) { file in
            LedgerExportSheet(file: file)
        }
    }

    // MARK: - Layout

    @ViewBuilder
    private var ledgerContent: some View {
        if appState.isLoading && appState.snapshot.transactions.isEmpty {
            VStack(spacing: 12) {
                ProgressView()
                Text("Loading ledger…")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Loading ledger")
        } else {
            ledgerList
        }
    }

    private var ledgerList: some View {
        List {
            if !transactionConflicts.isEmpty {
                Section {
                    conflictBanner
                }
            }

            if appState.isWorking {
                Section {
                    Label(
                        "Another operation is still running. Ledger mutations are unavailable until it finishes.",
                        systemImage: "arrow.triangle.2.circlepath"
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }

            Section {
                summaryGrid
            } footer: {
                Text("Totals cover every transaction that matches the filters, not only this page. Transfers are excluded from income and expense.")
            }

            filtersSection

            Section("Transactions") {
                transactionRows
            }

            if !derived.rows.isEmpty {
                Section {
                    pagingControls
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    @ViewBuilder
    private var transactionRows: some View {
        if derived.rows.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text(emptyMessage)
                    .font(.body)
                    .foregroundStyle(.secondary)
                if filters.hasActiveRefinements {
                    Button("Clear filters") {
                        filters = LedgerFilters()
                    }
                    .frame(minHeight: 44)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            ForEach(pageRows) { row in
                LedgerRowView(
                    row: row,
                    onEdit: { appState.editTransaction(id: row.id) },
                    onRealize: { pendingAction = .realize(row) },
                    onSilentRealize: { pendingAction = .silentRealize(row) },
                    onConvert: { pendingAction = .convert(row) },
                    onDelete: { pendingAction = .delete(row) }
                )
            }
        }
    }

    private var emptyMessage: String {
        if filters.hasActiveRefinements {
            return "No transactions match the current filters."
        }
        return "No transactions yet."
    }

    private var summaryGrid: some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: 120), spacing: 10)],
            spacing: 10
        ) {
            SummaryTile(
                title: "Transactions",
                value: String(derived.summary.count),
                accessibility: "\(derived.summary.count) transactions in the filtered set"
            )
            SummaryTile(
                title: "Income",
                value: AppFormatting.currency(derived.summary.income),
                accessibility: "Filtered income \(AppFormatting.currency(derived.summary.income))"
            )
            SummaryTile(
                title: "Expense",
                value: AppFormatting.currency(derived.summary.expense),
                accessibility: "Filtered expense \(AppFormatting.currency(derived.summary.expense))"
            )
            SummaryTile(
                title: "Net",
                value: AppFormatting.currency(derived.summary.net),
                accessibility: "Filtered net \(AppFormatting.currency(derived.summary.net))"
            )
        }
    }

    private var conflictBanner: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(.orange)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("Server conflict on \(transactionConflicts.count) transaction\(transactionConflicts.count == 1 ? "" : "s")")
                    .font(.subheadline.weight(.semibold))
                Text("Review and resolve these records in Settings before they sync.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Button("Open Settings") {
                appState.selectedTab = .settings
            }
            .buttonStyle(.bordered)
            .frame(minHeight: 44)
        }
        .accessibilityElement(children: .contain)
    }

    // MARK: - Filters

    private var filtersSection: some View {
        Section {
            DisclosureGroup(isExpanded: $isFiltersExpanded) {
                filterControls
            } label: {
                HStack {
                    Label("Filters", systemImage: "line.3.horizontal.decrease.circle")
                    Spacer()
                    Text(filters.summaryText)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(minHeight: 44)
            }
        }
    }

    @ViewBuilder
    private var filterControls: some View {
        Picker("Status", selection: $filters.status) {
            ForEach(LedgerFilters.StatusFilter.allCases) { value in
                Text(value.label).tag(value)
            }
        }

        Picker("Type", selection: $filters.type) {
            ForEach(LedgerFilters.TypeFilter.allCases) { value in
                Text(value.label).tag(value)
            }
        }

        Picker("Simulations", selection: $filters.simulation) {
            ForEach(LedgerFilters.SimulationFilter.allCases) { value in
                Text(value.label).tag(value)
            }
        }

        Picker("Scheduled", selection: $filters.scheduled) {
            ForEach(LedgerFilters.ScheduledFilter.allCases) { value in
                Text(value.label).tag(value)
            }
        }

        Picker("Account", selection: $filters.accountID) {
            Text("All accounts").tag(Optional<String>.none)
            ForEach(appState.snapshot.accounts) { account in
                Text(account.name).tag(Optional(account.id))
            }
        }

        Picker("Card", selection: $filters.cardID) {
            Text("All cards").tag(Optional<String>.none)
            ForEach(appState.snapshot.cards) { card in
                Text(card.name).tag(Optional(card.id))
            }
        }

        Picker("Category", selection: $filters.categoryID) {
            Text("All categories").tag(Optional<String>.none)
            ForEach(appState.snapshot.categories) { category in
                Text(category.name).tag(Optional(category.id))
            }
        }

        Picker("Project", selection: $filters.projectID) {
            Text("All projects").tag(Optional<String>.none)
            ForEach(appState.snapshot.projects) { project in
                Text(project.name).tag(Optional(project.id))
            }
        }

        Toggle("Date range", isOn: $filters.dateRangeEnabled)
            .frame(minHeight: 44)

        if filters.dateRangeEnabled {
            datePicker("From", selection: $filters.dateFrom)
            datePicker("To", selection: $filters.dateTo)
            if filters.dateFrom > filters.dateTo {
                Text("The start date is after the end date, so no rows match.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }

        Picker("Sort by", selection: $filters.sortField) {
            ForEach(LedgerFilters.SortField.allCases) { value in
                Text(value.label).tag(value)
            }
        }

        Picker("Direction", selection: $filters.sortDescending) {
            Text("Descending").tag(true)
            Text("Ascending").tag(false)
        }

        Button(role: .destructive) {
            filters = LedgerFilters()
        } label: {
            Text("Clear filters")
                .frame(maxWidth: .infinity, alignment: .center)
                .frame(minHeight: 44)
        }
        .disabled(!filters.hasActiveRefinements)
    }

    private func datePicker(_ title: String, selection: Binding<Date>) -> some View {
        DatePicker(title, selection: selection, displayedComponents: [.date])
            .frame(minHeight: 44)
    }

    // MARK: - Paging

    @ViewBuilder
    private var pagingControls: some View {
        let pageCount = Self.pageCount(for: derived.rows.count)
        let current = activePageIndex
        let first = current * Self.pageSize + 1
        let last = min((current + 1) * Self.pageSize, derived.rows.count)

        VStack(spacing: 8) {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(spacing: 8) {
                    previousPageButton(current: current)
                    pagePositionText(current: current, pageCount: pageCount)
                    nextPageButton(current: current, pageCount: pageCount)
                }
            } else {
                HStack {
                    previousPageButton(current: current)
                    Spacer()
                    pagePositionText(current: current, pageCount: pageCount)
                    Spacer()
                    nextPageButton(current: current, pageCount: pageCount)
                }
            }
            Text("Showing \(first)–\(last) of \(derived.rows.count) filtered transactions")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .contain)
    }

    private func previousPageButton(current: Int) -> some View {
        Button {
            pageIndex = max(0, current - 1)
        } label: {
            Label("Previous", systemImage: "chevron.left")
        }
        .buttonStyle(.bordered)
        .disabled(current == 0)
        .frame(minHeight: 44)
    }

    private func nextPageButton(current: Int, pageCount: Int) -> some View {
        Button {
            pageIndex = min(pageCount - 1, current + 1)
        } label: {
            Label("Next", systemImage: "chevron.right")
        }
        .buttonStyle(.bordered)
        .disabled(current >= pageCount - 1)
        .frame(minHeight: 44)
    }

    private func pagePositionText(current: Int, pageCount: Int) -> some View {
        Text("Page \(current + 1) of \(pageCount)")
            .font(.footnote.weight(.semibold))
            .fixedSize(horizontal: false, vertical: true)
    }

    private var activePageIndex: Int {
        min(max(0, pageIndex), max(0, Self.pageCount(for: derived.rows.count) - 1))
    }

    private var pageRows: [LedgerRowModel] {
        let start = activePageIndex * Self.pageSize
        guard start < derived.rows.count else { return [] }
        return Array(derived.rows[start..<min(start + Self.pageSize, derived.rows.count)])
    }

    private static func pageCount(for rowCount: Int) -> Int {
        max(1, (rowCount + pageSize - 1) / pageSize)
    }

    // MARK: - State

    private var transactionConflicts: [ConflictRecord] {
        appState.conflicts.filter {
            $0.entityType == .transaction && $0.resolution == .pending
        }
    }

    private func rebuild() {
        derived = LedgerIndex.build(
            snapshot: appState.snapshot,
            filters: filters,
            now: Date()
        )
    }

    private func refresh() async {
        do {
            try await appState.refresh()
            errorMessage = nil
        } catch {
            errorMessage = Self.describe(error)
        }
        rebuild()
    }

    // MARK: - Mutations

    private func execute(_ command: ObolCore.FinancialCommand) {
        guard !isBusy else { return }
        isMutating = true
        errorMessage = nil
        Task { @MainActor in
            defer { isMutating = false }
            do {
                try await appState.apply(command)
            } catch {
                errorMessage = Self.describe(error)
            }
        }
    }

    @ViewBuilder
    private var actionDialogButtons: some View {
        Button(pendingAction?.confirmTitle ?? "Confirm", role: pendingAction?.role) {
            if let action = pendingAction {
                execute(action.command)
            }
            pendingAction = nil
        }
        .disabled(isBusy)

        Button("Cancel", role: .cancel) {
            pendingAction = nil
        }
    }

    private var actionDialogPresented: Binding<Bool> {
        Binding(
            get: { pendingAction != nil },
            set: { presented in
                if !presented { pendingAction = nil }
            }
        )
    }

    private var errorPresented: Binding<Bool> {
        Binding(
            get: { errorMessage != nil },
            set: { presented in
                if !presented { errorMessage = nil }
            }
        )
    }

    // MARK: - Export

    private func prepareExport() {
        errorMessage = nil
        let csv = LedgerExporter.csv(rows: derived.rows, snapshot: appState.snapshot)
        guard let url = LedgerExporter.writeTemporaryFile(csv) else {
            errorMessage = "The ledger export could not be written to a temporary file."
            return
        }
        exportFile = LedgerExportFile(url: url, rowCount: derived.rows.count)
    }

    private static func describe(_ error: Error) -> String {
        if let financeError = error as? ObolCore.FinanceError {
            return financeError.message
        }
        return error.localizedDescription
    }
}

// MARK: - Summary tile

private struct SummaryTile: View {
    let title: String
    let value: String
    let accessibility: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.title3.weight(.semibold))
                .monospacedDigit()
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.secondary.opacity(0.12))
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibility)
    }
}

// MARK: - Row

private struct LedgerRowView: View {
    let row: LedgerRowModel
    let onEdit: () -> Void
    let onRealize: () -> Void
    let onSilentRealize: () -> Void
    let onConvert: () -> Void
    let onDelete: () -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    @ViewBuilder
    private var rowContent: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 6) {
                textBlock
                amountLabel
            }
        } else {
            HStack(alignment: .top, spacing: 10) {
                textBlock
                Spacer(minLength: 6)
                amountLabel
            }
        }
    }

    private var textBlock: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(row.title)
                .font(.headline)
                .lineLimit(3)

            Text(row.subtitle)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(3)

            HStack(alignment: .top, spacing: 4) {
                Text(row.dateText)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                if !row.badges.isEmpty {
                    BadgeFlow(spacing: 5) {
                        ForEach(row.badges, id: \.label) { badge in
                            LedgerBadgeView(badge: badge)
                        }
                    }
                }
            }
        }
    }

    private var amountLabel: some View {
        Text(row.amountText)
            .font(.subheadline.weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(row.amountTint)
            .multilineTextAlignment(dynamicTypeSize.isAccessibilitySize ? .leading : .trailing)
            .fixedSize(horizontal: false, vertical: true)
            .layoutPriority(1)
    }

    var body: some View {
        rowContent
            .frame(minHeight: 44)
            .contentShape(Rectangle())
            .onTapGesture {
                onEdit()
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(row.accessibilityLabel)
            .accessibilityHint("Opens the transaction editor")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction {
                onEdit()
            }
            .accessibilityActions {
                Button("Edit") { onEdit() }
                if row.canRealize {
                    Button("Realize") { onRealize() }
                    Button("Realize silently") { onSilentRealize() }
                }
                if row.canConvert {
                    Button("Convert to real") { onConvert() }
                }
                Button("Delete") { onDelete() }
            }
            .swipeActions(edge: .leading, allowsFullSwipe: false) {
                if row.canRealize {
                    Button {
                        onRealize()
                    } label: {
                        Label("Realize", systemImage: "checkmark.circle")
                    }
                    .tint(.green)

                    Button {
                        onSilentRealize()
                    } label: {
                        Label("Silent", systemImage: "speaker.slash")
                    }
                    .tint(.indigo)
                }
                if row.canConvert {
                    Button {
                        onConvert()
                    } label: {
                        Label("Convert", systemImage: "wand.and.stars")
                    }
                    .tint(.purple)
                }
            }
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button {
                    onDelete()
                } label: {
                    Label("Delete", systemImage: "trash")
                }
                .tint(.red)

                Button {
                    onEdit()
                } label: {
                    Label("Edit", systemImage: "square.and.pencil")
                }
                .tint(.blue)
            }
            .contextMenu {
                Button {
                    onEdit()
                } label: {
                    Label("Edit record", systemImage: "square.and.pencil")
                }
                if row.canRealize {
                    Button {
                        onRealize()
                    } label: {
                        Label("Realize", systemImage: "checkmark.circle")
                    }
                    Button {
                        onSilentRealize()
                    } label: {
                        Label("Silent realize", systemImage: "speaker.slash")
                    }
                }
                if row.canConvert {
                    Button {
                        onConvert()
                    } label: {
                        Label("Convert to real", systemImage: "wand.and.stars")
                    }
                }
                Button(role: .destructive) {
                    onDelete()
                } label: {
                    Label("Delete record", systemImage: "trash")
                }
            }
    }
}

private struct LedgerBadgeView: View {
    let badge: LedgerBadge

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: badge.symbol)
                .font(.caption2)
                .accessibilityHidden(true)
            Text(badge.label)
                .font(.caption2.weight(.medium))
                .lineLimit(1)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(Capsule().fill(badge.tint.opacity(0.18)))
        .foregroundStyle(badge.tint)
    }
}

/// Minimal wrapping row for badges so large Dynamic Type never clips them.
private struct BadgeFlow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var widest: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > maxWidth {
                y += rowHeight + spacing
                x = 0
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            widest = max(widest, x - spacing)
        }

        return CGSize(width: min(maxWidth, widest), height: y + rowHeight)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                y += rowHeight + spacing
                x = bounds.minX
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

// MARK: - Date conversion for pickers

/// Picker dates are local calendar days; financial dates are UTC days. The
/// conversion keeps the visible day identical on any device timezone, exactly
/// like the Cards and Management forms.
enum LedgerFormDates {
    static func utcDate(fromLocal date: Date) -> Date {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return ObolDate.clampedDate(
            year: parts.year ?? 1970,
            month: parts.month ?? 1,
            day: parts.day ?? 1
        )
    }

    static func localDate(forUTC date: Date) -> Date {
        let parts = ObolDate.calendar.dateComponents([.year, .month, .day], from: date)
        return Calendar.current.date(from: parts) ?? date
    }

    static func dayKey(_ localDate: Date) -> String {
        ObolDate.dayKey(utcDate(fromLocal: localDate))
    }
}

// MARK: - Filters

/// Pure filter state. Every stored field participates in equality, so the view
/// rebuilds its derived rows exactly once per meaningful filter change.
struct LedgerFilters: Equatable {
    enum StatusFilter: String, CaseIterable, Identifiable {
        case all
        case realized
        case pending

        var id: String { rawValue }

        var label: String {
            switch self {
            case .all: return "All statuses"
            case .realized: return "Realized"
            case .pending: return "Pending"
            }
        }
    }

    enum TypeFilter: String, CaseIterable, Identifiable {
        case all
        case income
        case expense
        case transfer

        var id: String { rawValue }

        var label: String {
            switch self {
            case .all: return "All types"
            case .income: return "Income"
            case .expense: return "Expense"
            case .transfer: return "Transfer"
            }
        }
    }

    enum SimulationFilter: String, CaseIterable, Identifiable {
        case realOnly
        case simulatedOnly
        case all

        var id: String { rawValue }

        var label: String {
            switch self {
            case .realOnly: return "Real only"
            case .simulatedOnly: return "Simulations only"
            case .all: return "Real and simulations"
            }
        }
    }

    enum ScheduledFilter: String, CaseIterable, Identifiable {
        case all
        case scheduledOnly
        case unscheduledOnly

        var id: String { rawValue }

        var label: String {
            switch self {
            case .all: return "Any"
            case .scheduledOnly: return "Scheduled only"
            case .unscheduledOnly: return "Not scheduled"
            }
        }
    }

    enum SortField: String, CaseIterable, Identifiable {
        case expectedDate
        case realizedDate
        case amount
        case created

        var id: String { rawValue }

        var label: String {
            switch self {
            case .expectedDate: return "Expected date"
            case .realizedDate: return "Realized date"
            case .amount: return "Amount"
            case .created: return "Created"
            }
        }
    }

    var search = ""
    var status: StatusFilter = .all
    var type: TypeFilter = .all
    var simulation: SimulationFilter = .realOnly
    var scheduled: ScheduledFilter = .all

    var dateRangeEnabled = false
    var dateFrom = LedgerFormDates.localDate(forUTC: ObolDate.startOfMonth(Date()))
    var dateTo = LedgerFormDates.localDate(forUTC: ObolDate.startOfDay(Date()))

    var accountID: String?
    var cardID: String?
    var categoryID: String?
    var projectID: String?

    var sortField: SortField = .expectedDate
    var sortDescending = true

    var hasActiveRefinements: Bool {
        activeRefinementCount > 0
    }

    var activeRefinementCount: Int {
        var count = 0
        if !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { count += 1 }
        if status != .all { count += 1 }
        if type != .all { count += 1 }
        if simulation != .realOnly { count += 1 }
        if scheduled != .all { count += 1 }
        if dateRangeEnabled { count += 1 }
        if accountID != nil { count += 1 }
        if cardID != nil { count += 1 }
        if categoryID != nil { count += 1 }
        if projectID != nil { count += 1 }
        return count
    }

    var summaryText: String {
        let count = activeRefinementCount
        if count == 0 { return "All transactions" }
        return count == 1 ? "1 filter active" : "\(count) filters active"
    }
}

// MARK: - Derived ledger rows

struct LedgerBadge {
    let label: String
    let symbol: String
    let tint: Color
}

struct LedgerRowModel: Identifiable {
    let id: String
    let transaction: ObolCore.Transaction
    let title: String
    let subtitle: String
    let badges: [LedgerBadge]
    let dateText: String
    let amountText: String
    let amountTint: Color
    let accessibilityLabel: String
    let canRealize: Bool
    let canConvert: Bool
}

struct LedgerSummary: Equatable {
    var count = 0
    var income = Decimal(0)
    var expense = Decimal(0)
    var net = Decimal(0)
}

struct LedgerDerived {
    let rows: [LedgerRowModel]
    let summary: LedgerSummary

    static let empty = LedgerDerived(rows: [], summary: LedgerSummary())
}

enum LedgerIndex {
    /// Builds the filtered, sorted read model once per snapshot or filter
    /// change. Row labels, amounts and dates are measured here so rendering
    /// and paging never re-sort or re-format.
    static func build(
        snapshot: ObolCore.FinancialSnapshot,
        filters: LedgerFilters,
        now: Date
    ) -> LedgerDerived {
        var accountNames: [String: String] = [:]
        accountNames.reserveCapacity(snapshot.accounts.count)
        for account in snapshot.accounts { accountNames[account.id] = account.name }
        var cardNames: [String: String] = [:]
        cardNames.reserveCapacity(snapshot.cards.count)
        for card in snapshot.cards { cardNames[card.id] = card.name }
        var categoryNames: [String: String] = [:]
        categoryNames.reserveCapacity(snapshot.categories.count)
        for category in snapshot.categories { categoryNames[category.id] = category.name }
        var projectNames: [String: String] = [:]
        projectNames.reserveCapacity(snapshot.projects.count)
        for project in snapshot.projects { projectNames[project.id] = project.name }
        var invoicePeriods: [String: String] = [:]
        invoicePeriods.reserveCapacity(snapshot.invoices.count)
        for invoice in snapshot.invoices { invoicePeriods[invoice.id] = invoice.period }

        let searchTerm = filters.search.trimmingCharacters(in: .whitespacesAndNewlines)
        let usesRealizedDate = filters.status == .realized
        let fromKey = filters.dateRangeEnabled ? LedgerFormDates.dayKey(filters.dateFrom) : nil
        let toKey = filters.dateRangeEnabled ? LedgerFormDates.dayKey(filters.dateTo) : nil
        let todayKey = ObolDate.dayKey(now)

        var rows: [LedgerRowModel] = []
        rows.reserveCapacity(snapshot.transactions.count)
        var summary = LedgerSummary()

        for transaction in snapshot.transactions {
            if !searchTerm.isEmpty,
               transaction.title.range(
                   of: searchTerm,
                   options: [.caseInsensitive, .diacriticInsensitive]
               ) == nil {
                continue
            }

            switch filters.status {
            case .all:
                break
            case .realized:
                guard transaction.status == .realized else { continue }
            case .pending:
                guard transaction.status == .pending else { continue }
            }

            switch filters.type {
            case .all:
                break
            case .income:
                guard transaction.type == .income else { continue }
            case .expense:
                guard transaction.type == .expense else { continue }
            case .transfer:
                guard transaction.type == .transfer else { continue }
            }

            switch filters.simulation {
            case .realOnly:
                guard transaction.isSimulated != true else { continue }
            case .simulatedOnly:
                guard transaction.isSimulated == true else { continue }
            case .all:
                break
            }

            switch filters.scheduled {
            case .all:
                break
            case .scheduledOnly:
                guard transaction.isScheduled == true else { continue }
            case .unscheduledOnly:
                guard transaction.isScheduled != true else { continue }
            }

            if let accountID = filters.accountID,
               transaction.accountID != accountID,
               transaction.destinationAccountID != accountID {
                continue
            }
            if let cardID = filters.cardID, transaction.cardID != cardID {
                continue
            }
            if let categoryID = filters.categoryID, transaction.categoryID != categoryID {
                continue
            }
            if let projectID = filters.projectID, transaction.projectID != projectID {
                continue
            }

            let filterDate = usesRealizedDate
                ? (transaction.realizedDate ?? transaction.expectedDate)
                : transaction.expectedDate
            if let fromKey, let toKey {
                let key = ObolDate.dayKey(filterDate)
                guard key >= fromKey, key <= toKey else { continue }
            }

            summary.count += 1
            switch transaction.type {
            case .income:
                summary.income = Money.sum(summary.income, transaction.amount)
            case .expense:
                summary.expense = Money.sum(summary.expense, transaction.amount)
            case .transfer:
                break
            }

            rows.append(
                makeRow(
                    transaction: transaction,
                    accountNames: accountNames,
                    cardNames: cardNames,
                    categoryNames: categoryNames,
                    projectNames: projectNames,
                    invoicePeriods: invoicePeriods,
                    usesRealizedDate: usesRealizedDate,
                    todayKey: todayKey
                )
            )
        }

        summary.net = Money.sub(summary.income, summary.expense)

        rows.sort { lhs, rhs in
            let order = compare(lhs, rhs, by: filters.sortField)
            if order == .orderedSame {
                return filters.sortDescending ? lhs.id > rhs.id : lhs.id < rhs.id
            }
            return filters.sortDescending ? order == .orderedDescending : order == .orderedAscending
        }

        return LedgerDerived(rows: rows, summary: summary)
    }

    private static func compare(
        _ lhs: LedgerRowModel,
        _ rhs: LedgerRowModel,
        by field: LedgerFilters.SortField
    ) -> ComparisonResult {
        switch field {
        case .expectedDate:
            return compareValues(lhs.transaction.expectedDate, rhs.transaction.expectedDate)
        case .realizedDate:
            return compareValues(
                lhs.transaction.realizedDate ?? .distantPast,
                rhs.transaction.realizedDate ?? .distantPast
            )
        case .amount:
            return compareValues(lhs.transaction.amount, rhs.transaction.amount)
        case .created:
            return compareValues(
                lhs.transaction.created ?? .distantPast,
                rhs.transaction.created ?? .distantPast
            )
        }
    }

    private static func compareValues<T: Comparable>(_ lhs: T, _ rhs: T) -> ComparisonResult {
        if lhs == rhs { return .orderedSame }
        return lhs < rhs ? .orderedAscending : .orderedDescending
    }

    private static func makeRow(
        transaction: ObolCore.Transaction,
        accountNames: [String: String],
        cardNames: [String: String],
        categoryNames: [String: String],
        projectNames: [String: String],
        invoicePeriods: [String: String],
        usesRealizedDate: Bool,
        todayKey: String
    ) -> LedgerRowModel {
        let entityLabel: String
        switch transaction.type {
        case .transfer:
            let source = transaction.accountID.flatMap { accountNames[$0] } ?? "Unknown account"
            let destination = transaction.destinationAccountID.flatMap { accountNames[$0] } ?? "Unknown account"
            entityLabel = "\(source) \u{2192} \(destination)"
        case .income, .expense:
            if let cardID = transaction.cardID {
                entityLabel = cardNames[cardID] ?? "Card"
            } else if let accountID = transaction.accountID {
                entityLabel = accountNames[accountID] ?? "Account"
            } else {
                entityLabel = "Unassigned"
            }
        }

        var subtitleParts: [String] = [entityLabel]
        if let categoryID = transaction.categoryID, let category = categoryNames[categoryID] {
            subtitleParts.append(category)
        }
        if let projectID = transaction.projectID, let project = projectNames[projectID] {
            subtitleParts.append("Project \(project)")
        }
        if let invoiceID = transaction.invoiceID {
            if let period = invoicePeriods[invoiceID] {
                subtitleParts.append("Invoice \(period)")
            } else {
                subtitleParts.append("Invoiced")
            }
        }
        if transaction.recurrenceID != nil {
            subtitleParts.append("Recurring")
        }
        let subtitle = subtitleParts.joined(separator: " · ")

        var badges: [LedgerBadge] = []
        switch transaction.status {
        case .realized:
            badges.append(LedgerBadge(label: "Realized", symbol: "checkmark.circle.fill", tint: .green))
        case .pending:
            badges.append(LedgerBadge(label: "Pending", symbol: "circle.dashed", tint: .orange))
        }
        if transaction.isSilent == true {
            badges.append(LedgerBadge(label: "Silent", symbol: "speaker.slash.fill", tint: .gray))
        }
        if transaction.isSimulated == true {
            badges.append(LedgerBadge(label: "Simulated", symbol: "wand.and.stars", tint: .purple))
        }
        if transaction.isScheduled == true {
            badges.append(LedgerBadge(label: "Scheduled", symbol: "calendar", tint: .blue))
        }

        let displayDate: Date
        if usesRealizedDate {
            displayDate = transaction.realizedDate ?? transaction.expectedDate
        } else {
            displayDate = transaction.expectedDate
        }
        let dateText = AppFormatting.day(displayDate)

        let amountText: String
        let amountTint: Color
        switch transaction.type {
        case .income:
            amountText = "+\(AppFormatting.currency(transaction.amount))"
            amountTint = .green
        case .expense:
            amountText = "-\(AppFormatting.currency(transaction.amount))"
            amountTint = .red
        case .transfer:
            amountText = AppFormatting.currency(transaction.amount)
            amountTint = .secondary
        }

        // Card purchases affect cash only through invoice payment, so the
        // ledger never offers a direct realize action for them.
        let isFutureScheduled = transaction.isScheduled == true
            && ObolDate.dayKey(transaction.expectedDate) > todayKey
        let canRealize = transaction.status == .pending
            && transaction.isSimulated != true
            && transaction.cardID == nil
            && !isFutureScheduled
        let canConvert = transaction.isSimulated == true

        let typeLabel: String
        switch transaction.type {
        case .income: typeLabel = "Income"
        case .expense: typeLabel = "Expense"
        case .transfer: typeLabel = "Transfer"
        }

        var accessibilityParts: [String] = [
            transaction.title,
            typeLabel,
            dateText,
            amountText,
            subtitle
        ]
        accessibilityParts.append(contentsOf: badges.map(\.label))

        return LedgerRowModel(
            id: transaction.id,
            transaction: transaction,
            title: transaction.title,
            subtitle: subtitle,
            badges: badges,
            dateText: dateText,
            amountText: amountText,
            amountTint: amountTint,
            accessibilityLabel: accessibilityParts.joined(separator: ", "),
            canRealize: canRealize,
            canConvert: canConvert
        )
    }
}

// MARK: - Pending row action

private enum LedgerPendingAction: Identifiable {
    case realize(LedgerRowModel)
    case silentRealize(LedgerRowModel)
    case convert(LedgerRowModel)
    case delete(LedgerRowModel)

    var row: LedgerRowModel {
        switch self {
        case .realize(let row), .silentRealize(let row), .convert(let row), .delete(let row):
            return row
        }
    }

    var id: String {
        let tag: String
        switch self {
        case .realize: tag = "realize"
        case .silentRealize: tag = "silent"
        case .convert: tag = "convert"
        case .delete: tag = "delete"
        }
        return "\(tag)-\(row.id)"
    }

    var title: String {
        switch self {
        case .realize: return "Realize transaction"
        case .silentRealize: return "Silent realize"
        case .convert: return "Convert simulation"
        case .delete: return "Delete transaction"
        }
    }

    var message: String {
        switch self {
        case .realize:
            if row.transaction.type == .transfer {
                return "\"\(row.title)\" becomes realized and moves \(row.amountText) between the two accounts."
            }
            if row.transaction.cardID != nil {
                return "\"\(row.title)\" marks the card purchase realized. Cash moves only when the card invoice is paid."
            }
            if row.transaction.accountID != nil {
                return "\"\(row.title)\" becomes realized and applies \(row.amountText) to the affected account balance."
            }
            return "\"\(row.title)\" becomes realized without changing an account balance because no account is assigned."
        case .silentRealize:
            return "\"\(row.title)\" is marked realized without changing any account balance. Use this only when the balance was already adjusted manually."
        case .convert:
            return "\"\(row.title)\" becomes a real record. Its account and card routing apply from then on."
        case .delete:
            var text = "\"\(row.title)\" is removed and its balance and invoice effects are reversed. Deletion cannot be undone."
            if row.transaction.recurrenceID != nil {
                text += " Its generated month is also recorded as skipped for the recurrence."
            }
            return text
        }
    }

    var confirmTitle: String {
        switch self {
        case .realize: return "Realize"
        case .silentRealize: return "Realize silently"
        case .convert: return "Convert to real"
        case .delete: return "Delete"
        }
    }

    var role: ButtonRole? {
        if case .delete = self { return .destructive }
        return nil
    }

    var command: ObolCore.FinancialCommand {
        switch self {
        case .realize:
            return .realizeTransaction(id: row.id, updateBalance: true)
        case .silentRealize:
            return .realizeTransaction(id: row.id, updateBalance: false)
        case .convert:
            return .convertSimulation(id: row.id, toSimulated: false)
        case .delete:
            return .deleteTransaction(id: row.id)
        }
    }
}
