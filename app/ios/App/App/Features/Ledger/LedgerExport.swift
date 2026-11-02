import SwiftUI
import Foundation
import ObolCore

// CSV export for the complete filtered ledger, not only the visible page. The
// file is written to this device's temporary directory and handed to the
// system share sheet. Nothing is ever written into the repository or the app
// bundle.

struct LedgerExportFile: Identifiable {
    let id = UUID()
    let url: URL
    let rowCount: Int
}

/// Locale-independent two-decimal text for numeric CSV amounts and for the
/// editor's amount field. Rounding uses the Core money rule, so the view never
/// invents its own financial rounding.
enum LedgerDecimalText {
    static func plain(_ value: Decimal) -> String {
        let rounded = Money.roundCurrency(value)
        if rounded.isNaN || rounded.isInfinite {
            return "0.00"
        }

        var scaled = rounded * 100
        var cents = Decimal()
        NSDecimalRound(&cents, &scaled, 0, .plain)

        if cents == 0 {
            return "0.00"
        }

        let isNegative = cents < 0
        let magnitude = isNegative ? cents * -1 : cents
        var digits = NSDecimalNumber(decimal: magnitude).stringValue
        if digits.count < 3 {
            digits = String(repeating: "0", count: 3 - digits.count) + digits
        }
        let split = digits.index(digits.endIndex, offsetBy: -2)
        let whole = String(digits[..<split])
        let fraction = String(digits[split...])
        return (isNegative ? "-" : "") + whole + "." + fraction
    }
}

enum LedgerExporter {
    /// Deterministic column order. It mirrors the web ledger export and adds
    /// the native-only `purchase_date`, `project_id` and `is_recurring`, which
    /// the native ledger can filter or display.
    private static let header = [
        "id",
        "title",
        "amount",
        "type",
        "status",
        "expected_date",
        "realized_date",
        "purchase_date",
        "account_id",
        "card_id",
        "destination_account_id",
        "category_id",
        "is_simulated",
        "is_scheduled",
        "is_silent",
        "invoice_id",
        "invoice_period",
        "recurrence_id",
        "created",
        "project_id",
        "is_recurring"
    ]

    static func csv(rows: [LedgerRowModel], snapshot: ObolCore.FinancialSnapshot) -> String {
        var invoicePeriods: [String: String] = [:]
        invoicePeriods.reserveCapacity(snapshot.invoices.count)
        for invoice in snapshot.invoices {
            invoicePeriods[invoice.id] = invoice.period
        }

        var lines: [String] = [header.joined(separator: ",")]
        lines.reserveCapacity(rows.count + 1)

        for row in rows {
            let transaction = row.transaction
            let values: [String] = [
                transaction.id,
                transaction.title,
                LedgerDecimalText.plain(transaction.amount),
                transaction.type.rawValue,
                transaction.status.rawValue,
                ObolDate.string(transaction.expectedDate),
                transaction.realizedDate.map(ObolDate.string) ?? "",
                transaction.purchaseDate.map(ObolDate.string) ?? "",
                transaction.accountID ?? "",
                transaction.cardID ?? "",
                transaction.destinationAccountID ?? "",
                transaction.categoryID ?? "",
                flag(transaction.isSimulated),
                flag(transaction.isScheduled),
                flag(transaction.isSilent),
                transaction.invoiceID ?? "",
                transaction.invoiceID.flatMap { invoicePeriods[$0] } ?? "",
                transaction.recurrenceID ?? "",
                transaction.created.map(ObolDate.string) ?? "",
                transaction.projectID ?? "",
                flag(transaction.isRecurring)
            ]
            lines.append(values.map { escape($0) }.joined(separator: ","))
        }

        // The UTF-8 BOM keeps spreadsheet importers reading user text
        // (accents, quotes, separators) exactly as stored.
        return "\u{FEFF}" + lines.joined(separator: "\n")
    }

    /// Quotes a field containing any delimiter the web export also guards
    /// (`"`, `,`, `;`, CR, LF) and doubles embedded quotes so user text stays
    /// literal in the file.
    private static func escape(_ value: String) -> String {
        guard value.contains(where: { character in
            character == "\"" || character == "," || character == ";" || character == "\n" || character == "\r"
        }) else {
            return value
        }
        return "\"" + value.replacingOccurrences(of: "\"", with: "\"\"") + "\""
    }

    private static func flag(_ value: Bool?) -> String {
        value == true ? "true" : "false"
    }

    /// Writes the export into the system temporary directory and returns its
    /// URL for the share sheet. Returns nil when the file cannot be written.
    static func writeTemporaryFile(_ content: String) -> URL? {
        guard let data = content.data(using: .utf8) else { return nil }
        let directory = FileManager.default.temporaryDirectory
        let name = "obol-ledger-\(timestampSuffix())-\(UUID().uuidString.prefix(8)).csv"
        let url = directory.appendingPathComponent(name)
        do {
            try data.write(to: url, options: .atomic)
            return url
        } catch {
            return nil
        }
    }

    private static func timestampSuffix() -> String {
        let now = Date()
        let components = ObolDate.calendar.dateComponents(
            [.year, .month, .day, .hour, .minute, .second],
            from: now
        )
        guard let year = components.year,
              let month = components.month,
              let day = components.day,
              let hour = components.hour,
              let minute = components.minute,
              let second = components.second else {
            return "00000000T000000"
        }
        return String(
            format: "%04d%02d%02dT%02d%02d%02d",
            year, month, day, hour, minute, second
        )
    }
}

/// Share step for one prepared CSV file. `ShareLink` presents the system share
/// sheet with the real temporary file; the sheet never touches finance state.
struct LedgerExportSheet: View {
    let file: LedgerExportFile

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Label(rowSummary, systemImage: "tablecells")
                    .font(.subheadline)

                Text("The file covers every transaction that matches the current filters, including rows beyond the current page. It lives in this device's temporary directory and is never added to the app bundle or repository.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                ShareLink(
                    item: file.url,
                    preview: SharePreview(
                        file.url.lastPathComponent,
                        image: Image(systemName: "tablecells")
                    )
                ) {
                    Label("Share CSV file", systemImage: "square.and.arrow.up")
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .accessibilityLabel("Share the exported CSV file")

                Spacer()
            }
            .padding(20)
            .navigationTitle("Export CSV")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var rowSummary: String {
        file.rowCount == 1 ? "1 row" : "\(file.rowCount) rows"
    }
}
