import Foundation
import SwiftUI
import ObolCore

/// Cards feature helpers: the canonical invoice projection call, stable
/// identities for virtual rows, display labels, money input parsing and cached
/// formatters.
///
/// This enum never computes invoice debt, status, or projected lines. Every
/// amount and every `PROJECTED` row comes from
/// `ForecastEngine.cardInvoiceSummaries`; the only arithmetic here is a sum of
/// already-computed per-invoice remaining debt.
enum CardsModel {
    // MARK: - Canonical projection

    /// The product invoice timeline for one card, including the virtual
    /// next-period `PROJECTED` row and any projected recurrence lines.
    static func invoiceSummaries(
        snapshot: FinancialSnapshot,
        cardID: String,
        now: Date = Date()
    ) throws -> [CardInvoiceSummary] {
        try ForecastEngine().cardInvoiceSummaries(snapshot, cardID: cardID, now: now)
    }

    /// Current debt across the stored, still unpaid invoices of the selected
    /// card. The projected preview row is excluded because nothing is stored
    /// for it yet; its amount stays visible in the timeline row itself.
    static func currentDebt(of summaries: [CardInvoiceSummary]) -> Decimal {
        var total = Decimal(0)
        for summary in summaries {
            guard summary.id != nil, summary.status != .paid else { continue }
            total = Money.sum(total, summary.totalAmount)
        }
        return total
    }

    /// Card rows are ordered oldest period first so the timeline reads forward
    /// and the projected next period sits last. Values are never re-derived.
    static func orderedTimeline(_ summaries: [CardInvoiceSummary]) -> [CardInvoiceSummary] {
        summaries.sorted {
            if $0.period != $1.period { return $0.period < $1.period }
            return ($0.id ?? "") < ($1.id ?? "")
        }
    }

    // MARK: - Stable identities

    /// Stored invoice id, or a card-plus-period identity for the virtual row.
    /// Index positions are never used as identity.
    static func invoiceIdentity(of summary: CardInvoiceSummary) -> String {
        if let id = summary.id { return id }
        return "projected:\(summary.cardID):\(summary.period)"
    }

    /// Stored transaction id, or recurrence plus occurrence day for a projected
    /// line. `expectedDate` of a projected line is its purchase date, and a
    /// weekly recurrence projects one line per occurrence inside the period.
    static func lineIdentity(of line: CardInvoiceLine) -> String {
        if let id = line.id { return id }
        return "projected-line:\(line.recurrenceID ?? "none"):\(ObolDate.dayKey(line.expectedDate))"
    }

    // MARK: - Lookup maps

    static func recurrenceNames(snapshot: FinancialSnapshot) -> [String: String] {
        var names: [String: String] = [:]
        names.reserveCapacity(snapshot.recurrences.count)
        for recurrence in snapshot.recurrences {
            names[recurrence.id] = recurrence.name
        }
        return names
    }

    /// Title for a line: the stored title, the weekly projection title, the
    /// recurrence name for a monthly projected line, or an explicit fallback for
    /// a recurrence that no longer exists.
    static func lineTitle(_ line: CardInvoiceLine, recurrenceNames: [String: String]) -> String {
        if let title = line.title, !title.isEmpty { return title }
        if let recurrenceID = line.recurrenceID, let name = recurrenceNames[recurrenceID] {
            return name
        }
        return "Projected occurrence"
    }

    // MARK: - Labels

    /// UTC-anchored month label for an invoice period such as `2026-11`.
    private static let periodFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "MMM yyyy"
        return formatter
    }()

    static func periodLabel(_ period: String) -> String {
        let parts = period.split(separator: "-")
        guard parts.count == 2,
              let year = Int(parts[0]),
              let month = Int(parts[1]),
              (1...12).contains(month) else {
            return period
        }
        return periodFormatter.string(from: ObolDate.clampedDate(year: year, month: month, day: 1))
    }

    static func statusText(for status: InvoiceProjectionStatus) -> String {
        switch status {
        case .open: return "Open"
        case .closed: return "Closed"
        case .paid: return "Paid"
        case .projected: return "Projected"
        }
    }

    /// Tint supports the always-present status text; state is never conveyed by
    /// color alone.
    static func statusTint(for status: InvoiceProjectionStatus) -> Color {
        switch status {
        case .open: return .secondary
        case .closed: return .orange
        case .paid: return .green
        case .projected: return .blue
        }
    }

    // MARK: - Dates

    /// Product UTC date for the same visible local day the user picked, so the
    /// displayed day does not shift with the device timezone.
    static func utcDay(fromLocal date: Date) -> Date {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return ObolDate.clampedDate(
            year: parts.year ?? 1970,
            month: parts.month ?? 1,
            day: parts.day ?? 1
        )
    }
}

// MARK: - Money input

/// Decimal input shared by the Cards sheets. Values reach `AppState.apply`
/// unrounded; the canonical engine owns the money math.
enum CardMoney {
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

// MARK: - Text helpers

extension Text {
    /// Money text never truncates: digits are monospaced, scale down slightly
    /// at extreme widths and wrap instead of clipping.
    func cardMoneyText() -> some View {
        monospacedDigit()
            .minimumScaleFactor(0.8)
            .lineLimit(2)
    }
}

extension CardInvoiceLineStatus {
    /// English badge text; the status is always spelled out.
    var badgeTitle: String {
        switch self {
        case .pending: return "Pending"
        case .realized: return "Realized"
        case .projected: return "Projected"
        }
    }
}
