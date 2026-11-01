import Foundation
import SwiftUI
import ObolCore
import ObolNativeRuntime

/// Day sheet shared by the trajectory chart and the projected calendar.
///
/// The balance comes from the same `ForecastEngine` pass that produces the
/// events, so the numbers and the rows cannot disagree. A date outside the
/// reconstruction window is reported explicitly; no balance is invented.
public struct DayDetailView: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss
    @AppStorage(DashboardPreferences.simulationsKey) private var includeSimulations = false
    @AppStorage(DashboardPreferences.horizonKey) private var horizonDays = 30

    @State private var derived: DayDetailDerived?
    @State private var errorMessage: String?
    @State private var actionNotice: String?
    @State private var busyTransactionIDs: Set<String> = []

    private let date: Date

    public init(date: Date) {
        self.date = date
    }

    public var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    notices
                    if let derived {
                        summarySection(derived)
                        if derived.inRange {
                            eventsSection(derived)
                            cardActivitySection(derived)
                            silentSection(derived)
                        } else {
                            storedSection(derived)
                        }
                    } else if appState.isLoading {
                        DashboardCard {
                            HStack(spacing: 12) {
                                ProgressView()
                                Text("Loading the local snapshot…")
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, minHeight: 72)
                        }
                    } else if errorMessage == nil {
                        DashboardCard {
                            DashboardEmptyState(
                                title: "No data for this day",
                                message: "Add an entry or an invoice to see this day's cash events.",
                                systemImage: "calendar"
                            )
                        }
                    }
                }
                .padding(16)
            }
            .navigationTitle(AppFormatting.day(date))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { @MainActor in recompute() }
            .onChange(of: appState.snapshot) { _ in recompute() }
            .onChange(of: horizonDays) { _ in recompute() }
            .onChange(of: includeSimulations) { _ in recompute() }
        }
    }

    // MARK: Notices

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

        if let errorMessage {
            DashboardStatusBanner(
                title: "Could not build this day",
                message: errorMessage,
                systemImage: "exclamationmark.triangle.fill",
                tint: .red,
                retry: { Task { @MainActor in recompute() } }
            )
        }
    }

    // MARK: Summary

    @ViewBuilder
    private func summarySection(_ derived: DayDetailDerived) -> some View {
        if let day = derived.day {
            let isPast = derived.targetDate < derived.today
            let balanceLabel = isPast ? "End-of-day cash (reconstructed)" : "End-of-day projected cash"
            let note = isPast
                ? "Liquid accounts only. Past days are rebuilt from realized, non-silent movements; pending items are never applied to a past day."
                : "Liquid accounts only. This projection includes pending obligations and card invoices that settle on this day."
            DashboardCard {
                VStack(alignment: .leading, spacing: 10) {
                    Text(balanceLabel)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(AppFormatting.currency(day.balance))
                        .font(.title2.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(day.balance < 0 ? .red : .green)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityLabel(Text("\(balanceLabel) \(AppFormatting.currency(day.balance))"))

                    HStack(alignment: .top, spacing: 20) {
                        metric(title: "Income", amount: day.income, tint: .green)
                        metric(title: "Expenses", amount: day.expense, tint: .red)
                    }

                    Text(note)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    if derived.isToday, derived.overdueEventCount > 0 {
                        Text("\(derived.overdueEventCount) overdue \(derived.overdueEventCount == 1 ? "item is" : "items are") projected on today instead of its original date.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        } else {
            DashboardCard {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Outside projection range")
                        .font(.headline)
                        .accessibilityAddTraits(.isHeader)
                    Text("This date is outside the loaded projection (\(AppFormatting.day(derived.rangeStart)) to \(AppFormatting.day(derived.rangeEnd))). No balance is shown for it.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func metric(title: String, amount: Decimal, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(AppFormatting.currency(amount))
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(tint)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    // MARK: Events

    @MainActor
    @ViewBuilder
    private func eventsSection(_ derived: DayDetailDerived) -> some View {
        DashboardCard(
            title: "Cash events",
            subtitle: derived.events.isEmpty
                ? nil
                : "\(derived.events.count) \(derived.events.count == 1 ? "item" : "items") on this day"
        ) {
            if derived.events.isEmpty {
                DashboardEmptyState(
                    title: "Nothing settles here",
                    message: "No realized, pending, invoice or recurrence cash event lands on this day.",
                    systemImage: "circle.dashed"
                )
            } else {
                VStack(spacing: 8) {
                    ForEach(derived.events) { row in
                        DayDetailEventRowView(
                            row: row,
                            today: derived.today,
                            isBusy: appState.isWorking || isBusy(row.transaction),
                            onEdit: {
                                Task { @MainActor in
                                    if let transaction = row.transaction {
                                        appState.editTransaction(id: transaction.id)
                                    }
                                }
                            },
                            onRealize: { updateBalance in
                                Task { @MainActor in
                                    if let transaction = row.transaction {
                                        performRealize(transaction, updateBalance: updateBalance)
                                    }
                                }
                            },
                            onConvertSimulation: {
                                Task { @MainActor in
                                    if let transaction = row.transaction {
                                        performConvertSimulation(transaction)
                                    }
                                }
                            },
                            onOpenCard: row.card.map { card in
                                { Task { @MainActor in appState.showCard(id: card.id) } }
                            }
                        )
                        if row.id != derived.events.last?.id {
                            Divider()
                        }
                    }
                }
            }
        }
    }

    @MainActor
    @ViewBuilder
    private func cardActivitySection(_ derived: DayDetailDerived) -> some View {
        if !derived.cardActivity.isEmpty {
            DashboardCard(
                title: "Card purchases",
                subtitle: "Card purchases move cash only on the invoice due date."
            ) {
                VStack(spacing: 8) {
                    ForEach(derived.cardActivity) { transaction in
                        DashboardTransactionRow(
                            transaction: transaction,
                            today: derived.today,
                            detailLine: derived.detailLine(for: transaction),
                            isBusy: appState.isWorking || busyTransactionIDs.contains(transaction.id),
                            onEdit: {
                                Task { @MainActor in appState.editTransaction(id: transaction.id) }
                            },
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
                    }
                }
            }
        }
    }

    @MainActor
    @ViewBuilder
    private func silentSection(_ derived: DayDetailDerived) -> some View {
        if !derived.silentRealizations.isEmpty {
            DashboardCard(
                title: "Silent realizations",
                subtitle: "The balance was already adjusted manually, so these rows moved no cash."
            ) {
                VStack(spacing: 8) {
                    ForEach(derived.silentRealizations) { transaction in
                        DashboardTransactionRow(
                            transaction: transaction,
                            today: derived.today,
                            detailLine: derived.detailLine(for: transaction),
                            isBusy: appState.isWorking || busyTransactionIDs.contains(transaction.id),
                            onEdit: {
                                Task { @MainActor in appState.editTransaction(id: transaction.id) }
                            },
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
                    }
                }
            }
        }
    }

    @MainActor
    @ViewBuilder
    private func storedSection(_ derived: DayDetailDerived) -> some View {
        DashboardCard(
            title: "Stored records",
            subtitle: "Entries stored on this date. No projection balance is shown outside the loaded range."
        ) {
            if derived.storedRecords.isEmpty {
                DashboardEmptyState(
                    title: "No stored records",
                    message: "Nothing is stored with a date on this day.",
                    systemImage: "tray"
                )
            } else {
                VStack(spacing: 8) {
                    ForEach(derived.storedRecords) { transaction in
                        DashboardTransactionRow(
                            transaction: transaction,
                            today: derived.today,
                            detailLine: derived.detailLine(for: transaction),
                            isBusy: appState.isWorking || busyTransactionIDs.contains(transaction.id),
                            onEdit: {
                                Task { @MainActor in appState.editTransaction(id: transaction.id) }
                            },
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
                    }
                }
            }
        }
    }

    // MARK: State and actions

    private func isBusy(_ transaction: ObolCore.Transaction?) -> Bool {
        guard let transaction else { return false }
        return busyTransactionIDs.contains(transaction.id)
    }

    private func cardOpenAction(for transaction: ObolCore.Transaction) -> (() -> Void)? {
        guard let cardID = transaction.cardID else { return nil }
        return { Task { @MainActor in appState.showCard(id: cardID) } }
    }

    @MainActor
    private func recompute() {
        do {
            let built = try DayDetailDerived.build(
                snapshot: appState.snapshot,
                horizonDays: horizonDays,
                includeSimulations: includeSimulations,
                date: date,
                now: Date()
            )
            derived = built
            errorMessage = nil
        } catch {
            // Keep the previously rendered day; only the error surface changes.
            errorMessage = error.localizedDescription
        }
    }

    @MainActor
    private func performRealize(_ transaction: ObolCore.Transaction, updateBalance: Bool) {
        guard !busyTransactionIDs.contains(transaction.id), !appState.isWorking else { return }
        busyTransactionIDs.insert(transaction.id)
        errorMessage = nil
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
                errorMessage = error.localizedDescription
            }
        }
    }

    @MainActor
    private func performConvertSimulation(_ transaction: ObolCore.Transaction) {
        guard !busyTransactionIDs.contains(transaction.id), !appState.isWorking else { return }
        busyTransactionIDs.insert(transaction.id)
        errorMessage = nil
        Task { @MainActor in
            defer { busyTransactionIDs.remove(transaction.id) }
            do {
                try await appState.apply(
                    .convertSimulation(id: transaction.id, toSimulated: false),
                    effectiveAt: Date()
                )
                actionNotice = "Converted \"\(transaction.title)\" to a real entry. Review it before realizing."
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    @MainActor
    private func performDelete(_ transaction: ObolCore.Transaction) {
        guard !busyTransactionIDs.contains(transaction.id), !appState.isWorking else { return }
        busyTransactionIDs.insert(transaction.id)
        errorMessage = nil
        Task { @MainActor in
            defer { busyTransactionIDs.remove(transaction.id) }
            do {
                try await appState.apply(
                    .deleteTransaction(id: transaction.id),
                    effectiveAt: Date()
                )
                actionNotice = "Deleted \"\(transaction.title)\"."
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

/// Event row with the same badge and action vocabulary as the dashboard rows.
struct DayDetailEventRowView: View {
    let row: DayDetailRow
    let today: Date
    let isBusy: Bool
    let onEdit: () -> Void
    let onRealize: (Bool) -> Void
    let onConvertSimulation: () -> Void
    let onOpenCard: (() -> Void)?

    private var badges: [DashboardBadgeModel] {
        DashboardBadgeModel.badges(for: row.kind, transaction: row.transaction)
    }

    private var canRealize: Bool {
        guard let transaction = row.transaction else { return false }
        return DashboardEligibility.canRealize(transaction, today: today)
    }

    private var hasActions: Bool {
        row.transaction != nil || onOpenCard != nil
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(row.event.title)
                    .font(.body)
                    .lineLimit(2)
                Text(row.detailLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                DashboardFlowLayout(spacing: 6) {
                    ForEach(badges) { badge in
                        DashboardBadge(text: badge.text, tint: badge.tint)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(accessibilityText))

            VStack(alignment: .trailing, spacing: 4) {
                Text(DashboardMoney.signed(row.event.amount))
                    .font(.callout.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(DashboardMoney.eventTint(row.event))
                    .multilineTextAlignment(.trailing)
                    .fixedSize(horizontal: false, vertical: true)
                    .layoutPriority(1)
                    .accessibilityHidden(true)

                if hasActions {
                    actionsMenu
                }
            }
        }
        .frame(minHeight: 44)
        .padding(.vertical, 4)
    }

    private var actionsMenu: some View {
        Menu {
            if canRealize {
                Button {
                    onRealize(true)
                } label: {
                    Label("Realize & add to balance", systemImage: "plus.circle")
                }
                Button {
                    onRealize(false)
                } label: {
                    Label("Already in balance (silent)", systemImage: "equal.circle")
                }
            } else if row.transaction?.isSimulated == true {
                Button {
                    onConvertSimulation()
                } label: {
                    Label("Convert to real entry", systemImage: "arrow.triangle.2.circlepath")
                }
            } else if row.transaction?.status == .pending, row.transaction?.isScheduled == true {
                let date = row.transaction?.expectedDate ?? today
                Button("Scheduled for \(AppFormatting.day(date))") {}
                    .disabled(true)
            }

            if let onOpenCard {
                Button(action: onOpenCard) {
                    Label("Open card", systemImage: "creditcard")
                }
            }

            if row.transaction != nil {
                Button(action: onEdit) {
                    Label("Edit", systemImage: "pencil")
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.title3)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .disabled(isBusy)
        .accessibilityLabel(Text("Actions for \(row.event.title)"))
    }

    private var accessibilityText: String {
        var parts: [String] = [
            row.event.title,
            DashboardMoney.signed(row.event.amount),
            row.detailLine
        ]
        let badgeText = badges.map(\.text).joined(separator: ", ")
        if !badgeText.isEmpty { parts.append(badgeText) }
        return parts.joined(separator: ". ")
    }
}
