import SwiftUI
import ObolCore
import ObolNativeRuntime

// MARK: - Layout

/// Minimal wrapping layout for badge rows. Keeps a long badge set readable at
/// 320 pt and at accessibility text sizes instead of clipping it.
struct DashboardFlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var rowWidth: CGFloat = 0
        var rowHeight: CGFloat = 0
        var totalHeight: CGFloat = 0
        var widestRow: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if rowWidth > 0, rowWidth + spacing + size.width > maxWidth {
                widestRow = max(widestRow, rowWidth)
                totalHeight += rowHeight + spacing
                rowWidth = size.width
                rowHeight = size.height
            } else {
                rowWidth += (rowWidth > 0 ? spacing : 0) + size.width
                rowHeight = max(rowHeight, size.height)
            }
        }

        widestRow = max(widestRow, rowWidth)
        totalHeight += rowHeight
        return CGSize(width: proposal.width ?? widestRow, height: totalHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}

// MARK: - Surfaces

struct DashboardCard<Content: View>: View {
    private let title: String?
    private let subtitle: String?
    private let content: Content

    init(title: String? = nil, subtitle: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.subtitle = subtitle
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if title != nil || subtitle != nil {
                VStack(alignment: .leading, spacing: 2) {
                    if let title {
                        Text(title)
                            .font(.headline)
                            .accessibilityAddTraits(.isHeader)
                    }
                    if let subtitle {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            content
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.08))
        )
    }
}

struct DashboardMetricCard: View {
    let title: String
    let subtitle: String
    let amount: Decimal
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)
            Text(AppFormatting.currency(amount))
                .font(.title3.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(tint)
                // The value keeps every digit: it wraps instead of truncating.
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel(Text("\(title): \(AppFormatting.currency(amount))"))
            Text(subtitle)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

struct DashboardEmptyState: View {
    let title: String
    let message: String
    let systemImage: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(title, systemImage: systemImage)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(message)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}

struct DashboardStatusBanner: View {
    let title: String
    let message: String
    let systemImage: String
    let tint: Color
    let retry: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: systemImage)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(tint)
            Text(message)
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
            if let retry {
                Button("Retry", action: retry)
                    .font(.subheadline.weight(.semibold))
                    .frame(minWidth: 88, minHeight: 44)
                    .accessibilityHint(Text("Recomputes the projection from the local snapshot."))
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.10), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(tint.opacity(0.35))
        )
    }
}

// MARK: - Money and badges

enum DashboardMoney {
    /// Signed display for a projection event: positive is an inflow, negative
    /// an outflow. Presentation only; all rules live in ObolCore.
    static func signed(_ amount: Decimal) -> String {
        if amount < 0 { return "-" + AppFormatting.currency(-amount) }
        if amount > 0 { return "+" + AppFormatting.currency(amount) }
        return AppFormatting.currency(0)
    }

    static func transactionAmount(_ transaction: ObolCore.Transaction) -> String {
        switch transaction.type {
        case .income:
            return "+" + AppFormatting.currency(transaction.amount)
        case .expense:
            return "-" + AppFormatting.currency(transaction.amount)
        case .transfer:
            return AppFormatting.currency(transaction.amount)
        }
    }

    static func transactionTint(_ transaction: ObolCore.Transaction) -> Color {
        switch transaction.type {
        case .income: return .green
        case .expense: return .red
        case .transfer: return .gray
        }
    }

    static func eventTint(_ event: ForecastEvent) -> Color {
        if event.kind == .transfer { return .gray }
        if event.amount > 0 { return .green }
        if event.amount < 0 { return .red }
        return .gray
    }
}

struct DashboardBadge: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(tint.opacity(0.16), in: Capsule())
    }
}

struct DashboardBadgeModel: Identifiable {
    let id: String
    let text: String
    let tint: Color

    static func badges(for transaction: ObolCore.Transaction) -> [DashboardBadgeModel] {
        var badges: [DashboardBadgeModel] = []
        switch transaction.status {
        case .realized:
            badges.append(make("Realized", .green))
        case .pending:
            badges.append(make("Pending", .orange))
        }
        if transaction.isScheduled == true { badges.append(make("Scheduled", .blue)) }
        if transaction.isSilent == true { badges.append(make("Silent", .purple)) }
        if transaction.isSimulated == true { badges.append(make("Simulated", .indigo)) }
        if transaction.type == .transfer { badges.append(make("Transfer", .teal)) }
        if transaction.cardID != nil { badges.append(make("Card", .pink)) }
        if transaction.recurrenceID != nil { badges.append(make("Recurring", .gray)) }
        if transaction.projectID != nil { badges.append(make("Project", .cyan)) }
        return badges
    }

    static func badges(for kind: ForecastEventKind, transaction: ObolCore.Transaction?) -> [DashboardBadgeModel] {
        var badges: [DashboardBadgeModel] = []
        switch kind {
        case .realized: badges.append(make("Realized", .green))
        case .pending: badges.append(make("Pending", .orange))
        case .transfer: badges.append(make("Transfer", .teal))
        case .invoice: badges.append(make("Invoice", .pink))
        case .projectedInvoice: badges.append(make("Projected invoice", .pink))
        case .recurrence: badges.append(make("Recurrence", .indigo))
        case .simulated: badges.append(make("Simulated", .indigo))
        }
        if let transaction {
            if transaction.isSilent == true { badges.append(make("Silent", .purple)) }
            if transaction.isScheduled == true { badges.append(make("Scheduled", .blue)) }
            if transaction.cardID != nil { badges.append(make("Card", .pink)) }
        }
        return badges
    }

    private static func make(_ text: String, _ tint: Color) -> DashboardBadgeModel {
        DashboardBadgeModel(id: text, text: text, tint: tint)
    }
}

// MARK: - Rows

struct DashboardTransactionRow: View {
    let transaction: ObolCore.Transaction
    let today: Date
    let detailLine: String
    let isBusy: Bool
    let onEdit: () -> Void
    let onRealize: (Bool) -> Void
    let onConvertSimulation: () -> Void
    let onDelete: () -> Void
    let onOpenCard: (() -> Void)?

    @State private var showsDeleteConfirmation = false

    init(
        transaction: ObolCore.Transaction,
        today: Date,
        detailLine: String,
        isBusy: Bool,
        onEdit: @escaping () -> Void,
        onRealize: @escaping (Bool) -> Void,
        onConvertSimulation: @escaping () -> Void,
        onDelete: @escaping () -> Void,
        onOpenCard: (() -> Void)? = nil
    ) {
        self.transaction = transaction
        self.today = today
        self.detailLine = detailLine
        self.isBusy = isBusy
        self.onEdit = onEdit
        self.onRealize = onRealize
        self.onConvertSimulation = onConvertSimulation
        self.onDelete = onDelete
        self.onOpenCard = onOpenCard
    }

    private var badges: [DashboardBadgeModel] { DashboardBadgeModel.badges(for: transaction) }
    private var canRealize: Bool { DashboardEligibility.canRealize(transaction, today: today) }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(transaction.title)
                    .font(.body)
                    .lineLimit(2)
                Text(detailLine)
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
                Text(DashboardMoney.transactionAmount(transaction))
                    .font(.callout.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(DashboardMoney.transactionTint(transaction))
                    .multilineTextAlignment(.trailing)
                    .fixedSize(horizontal: false, vertical: true)
                    .layoutPriority(1)
                    .accessibilityHidden(true)
                actionsMenu
            }
        }
        .frame(minHeight: 44)
        .padding(.vertical, 4)
        .confirmationDialog(
            "Delete \"\(transaction.title)\"?",
            isPresented: $showsDeleteConfirmation,
            titleVisibility: .visible
        ) {
            Button("Delete entry", role: .destructive) { onDelete() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Deleting reverts this entry's balance effect and cannot be undone.")
        }
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
            } else if transaction.isSimulated == true {
                Button {
                    onConvertSimulation()
                } label: {
                    Label("Convert to real entry", systemImage: "arrow.triangle.2.circlepath")
                }
            } else if transaction.status == .pending, transaction.isScheduled == true {
                Button("Scheduled for \(AppFormatting.day(transaction.expectedDate))") {}
                    .disabled(true)
            }

            if let onOpenCard {
                Button(action: onOpenCard) {
                    Label("Open card", systemImage: "creditcard")
                }
            }

            Button(action: onEdit) {
                Label("Edit", systemImage: "pencil")
            }

            Divider()

            Button(role: .destructive) {
                showsDeleteConfirmation = true
            } label: {
                Label("Delete", systemImage: "trash")
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.title3)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .disabled(isBusy)
        .accessibilityLabel(Text("Actions for \(transaction.title)"))
    }

    private var accessibilityText: String {
        var parts: [String] = [
            transaction.type.dashboardLabel,
            transaction.title,
            DashboardMoney.transactionAmount(transaction),
            detailLine
        ]
        let badgeText = badges.map(\.text).joined(separator: ", ")
        if !badgeText.isEmpty { parts.append(badgeText) }
        return parts.joined(separator: ". ")
    }
}

struct DashboardInvoiceRow: View {
    let invoice: ForecastInvoice
    let onOpen: () -> Void

    private var statusLabel: String {
        invoice.status == .open ? "Open" : "Closed"
    }

    var body: some View {
        Button(action: onOpen) {
            HStack(alignment: .center, spacing: 12) {
                Image(systemName: "creditcard")
                    .font(.title3)
                    .foregroundStyle(.pink)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 4) {
                    Text("\(invoice.cardName) invoice")
                        .font(.body)
                    Text("\(invoice.period) · \(statusLabel) · due \(AppFormatting.day(invoice.dueDate))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 8)

                VStack(alignment: .trailing, spacing: 2) {
                    Text(AppFormatting.currency(invoice.amountDue))
                        .font(.callout.weight(.semibold))
                        .monospacedDigit()
                        .multilineTextAlignment(.trailing)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Amount due")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }

                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            Text("\(invoice.cardName) invoice \(invoice.period), \(AppFormatting.currency(invoice.amountDue)) due on \(AppFormatting.day(invoice.dueDate)). Opens the card.")
        )
    }
}
