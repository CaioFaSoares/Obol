import SwiftUI
import ObolCore
import ObolNativeRuntime

/// Recurrence list. Creation and every scheduling action live in
/// ``RecurrenceEditor``; this screen only routes and summarizes.
struct RecurrencesView: View {
    @EnvironmentObject private var appState: AppState

    @State private var showCreate = false
    @State private var editingRecurrence: Recurrence?
    @State private var refreshError: String?

    var body: some View {
        List {
            recurrenceSection
            if let message = refreshError {
                Section {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            if let message = appState.lastError {
                Section {
                    Label(message, systemImage: "exclamationmark.icloud")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .refreshable {
            do {
                try await appState.refresh()
                refreshError = nil
            } catch {
                refreshError = error.localizedDescription
            }
        }
        .sheet(isPresented: $showCreate) {
            RecurrenceEditor(recurrence: nil)
        }
        .sheet(item: $editingRecurrence) { recurrence in
            RecurrenceEditor(recurrence: recurrence)
        }
    }

    private var recurrences: [Recurrence] {
        appState.snapshot.recurrences.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
    }

    private var recurrenceSection: some View {
        Section {
            if recurrences.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("No recurrences yet")
                        .font(.headline)
                    Text("Create a recurrence to schedule a pending transaction every month or every week.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(recurrences) { recurrence in
                Button {
                    editingRecurrence = recurrence
                } label: {
                    RecurrenceRow(
                        recurrence: recurrence,
                        destination: destinationText(recurrence),
                        category: categoryText(recurrence)
                    )
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint(Text("Opens the recurrence editor"))
            }
            ManagementCreationButton(title: "New recurrence", systemImage: "plus.circle") {
                showCreate = true
            }
        } header: {
            Text("Recurrences")
        } footer: {
            Text("Recurrence dates are UTC. Monthly paydays clamp to the month length, so day 31 becomes day 28 in February; weekly occurrences use the ISO week and never clamp.")
        }
    }

    private func destinationText(_ recurrence: Recurrence) -> String {
        if let cardID = recurrence.cardID, let card = appState.snapshot.card(id: cardID) {
            return "Card \(card.name)"
        }
        if let accountID = recurrence.accountID, let account = appState.snapshot.account(id: accountID) {
            return "Account \(account.name)"
        }
        return "No account or card"
    }

    private func categoryText(_ recurrence: Recurrence) -> String? {
        guard let categoryID = recurrence.categoryID,
              let category = appState.snapshot.category(id: categoryID) else {
            return nil
        }
        return category.name
    }
}

/// One recurrence summary row. The status is always written out; the capsule
/// tint only supports the text.
private struct RecurrenceRow: View {
    let recurrence: Recurrence
    let destination: String
    let category: String?

    private var kindText: String {
        recurrence.type == .income ? "Income" : "Expense"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(recurrence.name)
                    .font(.headline)
                    .lineLimit(2)
                    .allowsTightening(true)
                Spacer(minLength: 12)
                Text(AppFormatting.currency(recurrence.amount))
                    .font(.subheadline)
                    .monospacedDigit()
                    .minimumScaleFactor(0.8)
                    .lineLimit(2)
            }
            HStack(spacing: 8) {
                Text(RecurrenceStatusLabel.title(for: recurrence.status))
                    .font(.caption2)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .overlay(
                        Capsule()
                            .strokeBorder(RecurrenceStatusLabel.tint(for: recurrence.status))
                    )
                Text(kindText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(destination)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(RecurrenceCadenceLabel.title(for: recurrence))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let category {
                Text("Budget category: \(category)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(accessibility))
    }

    private var accessibility: String {
        var parts = [
            recurrence.name,
            kindText,
            "Status \(RecurrenceStatusLabel.title(for: recurrence.status))",
            destination,
            AppFormatting.currency(recurrence.amount),
            RecurrenceCadenceLabel.title(for: recurrence)
        ]
        if let category { parts.append("Budget category \(category)") }
        return parts.joined(separator: ", ")
    }
}

/// English status text and tints shared by the recurrence screens.
enum RecurrenceStatusLabel {
    static func title(for status: RecurrenceStatus) -> String {
        switch status {
        case .active: return "Active"
        case .paused: return "Paused"
        case .ended: return "Ended"
        }
    }

    static func tint(for status: RecurrenceStatus) -> Color {
        switch status {
        case .active: return .green
        case .paused: return .orange
        case .ended: return .secondary
        }
    }
}

/// Cadence text shared by the recurrence screens. A row always states the
/// cadence next to the timing, never a bare day number.
enum RecurrenceCadenceLabel {
    static let weekdayNames = [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday"
    ]

    static func weekdayName(_ weekday: Int) -> String {
        guard (1...7).contains(weekday) else { return "No weekday" }
        return weekdayNames[weekday - 1]
    }

    static func title(for recurrence: Recurrence) -> String {
        switch recurrence.cadence {
        case .monthly:
            return "Monthly — day \(recurrence.payday)"
        case .weekly:
            guard let weekday = recurrence.weekday else { return "Weekly" }
            return "Weekly — \(weekdayName(weekday))"
        }
    }

    static func title(frequency: RecurrenceFrequency, payday: Int, weekday: Int) -> String {
        switch frequency {
        case .monthly:
            return "Monthly — day \(payday)"
        case .weekly:
            return "Weekly — \(weekdayName(weekday))"
        }
    }
}
