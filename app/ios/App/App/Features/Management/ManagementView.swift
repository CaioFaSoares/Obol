import Foundation
import SwiftUI
import ObolCore
import ObolNativeRuntime

/// Management surface: accounts and cards, recurrences, planned budgets, and
/// projects. Every screen is offline-first and every mutation is one
/// `AppState.apply` command over the supported operation set.
struct ManagementView: View {
    init() {}

    @EnvironmentObject private var appState: AppState

    private enum ManagementSection: String, CaseIterable, Identifiable {
        case financial
        case recurrences
        case budgets
        case projects

        var id: String { rawValue }

        var title: String {
            switch self {
            case .financial: return "Accounts"
            case .recurrences: return "Recurrences"
            case .budgets: return "Budgets"
            case .projects: return "Projects"
            }
        }
    }

    @State private var section: ManagementSection = .financial

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Section", selection: $section) {
                    ForEach(ManagementSection.allCases) { candidate in
                        Text(candidate.title).tag(candidate)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .padding(.vertical, 8)
                .accessibilityLabel(Text("Management sections"))

                if appState.isLoading {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Loading financial data…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal)
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(Text("Loading financial data"))
                }

                sectionContent
            }
            .navigationTitle("Management")
        }
    }

    @ViewBuilder
    private var sectionContent: some View {
        switch section {
        case .financial:
            AccountsView()
        case .recurrences:
            RecurrencesView()
        case .budgets:
            BudgetsView()
        case .projects:
            ProjectsView()
        }
    }
}

// MARK: - Shared Management presentation helpers

/// English display names for account types.
enum ManagementAccountTypeLabel {
    static func title(for type: AccountType) -> String {
        switch type {
        case .checking: return "Checking"
        case .savings: return "Savings"
        case .investment: return "Investment"
        }
    }
}

/// Decimal typing for Management forms. Values reach `AppState.apply`
/// unrounded; the canonical engine owns all money math.
enum ManagementMoney {
    /// Accepts plain decimals plus the two common grouped forms, `1.234,56`
    /// (comma decimal) and `1,234.56` (dot decimal). The value is not rounded
    /// here; the canonical engine owns currency rounding.
    static func parse(_ text: String) -> Decimal {
        var normalized = text
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: "\u{00A0}", with: "")
        guard !normalized.isEmpty else { return 0 }

        let lastComma = normalized.lastIndex(of: ",")
        let lastDot = normalized.lastIndex(of: ".")
        switch (lastComma, lastDot) {
        case let (comma?, dot?):
            if comma > dot {
                normalized = normalized.replacingOccurrences(of: ".", with: "")
                normalized = normalized.replacingOccurrences(of: ",", with: ".")
            } else {
                normalized = normalized.replacingOccurrences(of: ",", with: "")
            }
        case (.some, .none):
            normalized = normalized.replacingOccurrences(of: ",", with: ".")
        case (.none, let dot?):
            if normalized.filter({ $0 == "." }).count > 1 {
                let whole = normalized[..<dot].replacingOccurrences(of: ".", with: "")
                normalized = whole + String(normalized[dot...])
            }
        default:
            break
        }

        guard let value = Decimal(string: normalized, locale: Locale(identifier: "en_US_POSIX")) else {
            return 0
        }
        return value
    }
}

/// Money input row shared by Management forms: 44pt target, monospaced digits.
struct ManagementMoneyField: View {
    let title: String
    @Binding var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
            TextField(title, text: $text)
                .keyboardType(.decimalPad)
                .monospacedDigit()
                .frame(minHeight: 44)
                .accessibilityLabel(Text(title))
        }
    }
}

/// Standard 44pt creation button used across Management sections.
struct ManagementCreationButton: View {
    let title: String
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .frame(minHeight: 44)
        }
    }
}

/// One 44pt mutation row action inside a Form section.
struct ManagementMutationButton: View {
    let title: String
    let systemImage: String
    var destructive: Bool = false
    let action: () -> Void

    var body: some View {
        Button(role: destructive ? .destructive : nil, action: action) {
            Label(title, systemImage: systemImage)
                .frame(minHeight: 44)
        }
    }
}

/// Secondary hint row reused by Management sections for empty lists.
struct ManagementEmptyHintRow: View {
    let shown: Bool
    let message: String

    var body: some View {
        if shown {
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }
}

/// Picked calendar day to product UTC date conversion used by Management
/// forms. The product stores financial days in UTC.
enum ManagementFormDates {
    static func utcDay(fromLocal date: Date) -> Date {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return ObolDate.clampedDate(
            year: parts.year ?? 1970,
            month: parts.month ?? 1,
            day: parts.day ?? 1
        )
    }

    /// Maps a stored UTC day to the local midnight of the same visible day so
    /// pickers prefill with the day the user originally chose.
    static func localDate(forUTCDay date: Date) -> Date {
        let parts = ObolDate.calendar.dateComponents([.year, .month, .day], from: date)
        return Calendar.current.date(from: parts) ?? date
    }

    /// Cached UTC month label for a period key such as `2026-11`.
    private static let monthFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "MMM yyyy"
        return formatter
    }()

    static func monthLabel(_ period: String) -> String {
        let parts = period.split(separator: "-")
        guard parts.count == 2,
              let year = Int(parts[0]),
              let month = Int(parts[1]),
              (1...12).contains(month) else {
            return period
        }
        return monthFormatter.string(from: ObolDate.clampedDate(year: year, month: month, day: 1))
    }
}
