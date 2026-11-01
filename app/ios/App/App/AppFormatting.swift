import Foundation
import ObolCore

/// Shared root formatting for every native feature.
///
/// Money always goes through `ObolCore.Money`; this type never re-implements
/// the canonical rounding rule. Dates are financial UTC dates so a ledger day
/// never shifts with the device time zone. Formatters are created once and
/// reused, never per row.
public enum AppFormatting {
    private static let utcTimeZone = TimeZone(secondsFromGMT: 0)!
    private static let englishLocale = Locale(identifier: "en_US")
    private static let gregorianCalendar = Calendar(identifier: .gregorian)

    // MARK: - Currency

    private static let currencyFormatter: NumberFormatter = {
        let formatter = NumberFormatter()
        formatter.locale = englishLocale
        formatter.numberStyle = .currency
        formatter.currencyCode = "BRL"
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = 2
        formatter.usesGroupingSeparator = true
        // The product already rounded the exact decimal toward positive
        // infinity; half-up here only prevents a second, different tie rule.
        formatter.roundingMode = .halfUp
        return formatter
    }()

    /// Real BRL currency with English grouping, exactly two decimals.
    public static func currency(_ amount: Decimal) -> String {
        let normalized = NSDecimalNumber(decimal: Money.roundCurrency(amount))
        return currencyFormatter.string(from: normalized) ?? normalized.stringValue
    }

    // MARK: - Dates

    private static let longDateStyle = Date.FormatStyle(
        date: .long,
        time: .omitted,
        locale: englishLocale,
        calendar: gregorianCalendar,
        timeZone: utcTimeZone
    )

    private static let timestampStyle = Date.FormatStyle(
        date: .abbreviated,
        time: .shortened,
        locale: englishLocale,
        calendar: gregorianCalendar,
        timeZone: utcTimeZone
    )

    /// Full English UTC date, for example "October 31, 2026".
    public static func date(_ date: Date) -> String {
        date.formatted(longDateStyle)
    }

    /// UTC date-only key used by financial queries, for example "2026-10-31".
    public static func day(_ date: Date) -> String {
        ObolDate.dayKey(date)
    }

    /// UTC audit timestamp for journal rows, for example "Oct 31, 2026 at 9:02 PM".
    public static func timestamp(_ date: Date) -> String {
        date.formatted(timestampStyle)
    }
}
