import Foundation
import SwiftUI
import ObolCore
import ObolNativeRuntime

/// Month grid over the already-fetched forecast timeline. Every day in the
/// timeline is a real Button that announces its date and projected balance;
/// days without a timeline point are muted and not clickable. Month navigation
/// stays inside the renderable months.
struct DashboardCalendarView: View {
    let days: [ForecastDay]
    let dayIndex: [String: ForecastDay]
    let todayKey: String
    let selectedKey: String?
    let firstMonth: Date
    let lastMonth: Date
    let onSelect: (ForecastDay) -> Void

    @State private var visibleMonth: Date?
    @State private var didInitialize = false
    @ScaledMetric(relativeTo: .body) private var cellHeight: CGFloat = 56

    private let calendar = ObolDate.calendar
    private let weekdaySymbols = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

    init(
        days: [ForecastDay],
        dayIndex: [String: ForecastDay],
        todayKey: String,
        selectedKey: String?,
        firstMonth: Date,
        lastMonth: Date,
        onSelect: @escaping (ForecastDay) -> Void
    ) {
        self.days = days
        self.dayIndex = dayIndex
        self.todayKey = todayKey
        self.selectedKey = selectedKey
        self.firstMonth = firstMonth
        self.lastMonth = lastMonth
        self.onSelect = onSelect
    }

    private var month: Date {
        let candidate = visibleMonth ?? firstMonth
        if candidate < firstMonth { return firstMonth }
        if candidate > lastMonth { return lastMonth }
        return candidate
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header

            if days.isEmpty {
                DashboardEmptyState(
                    title: "No projected days",
                    message: "The forecast returned no days to display for this horizon.",
                    systemImage: "calendar"
                )
            } else {
                weekdayHeader
                grid
                legend
            }
        }
        .onAppear {
            guard !didInitialize else { return }
            didInitialize = true
            visibleMonth = initialMonth()
        }
        .onChange(of: selectedKey) { newValue in
            // A chart tap selects a day too; keep the grid on that month.
            guard let newValue = newValue, let day = dayIndex[newValue] else { return }
            let target = ObolDate.startOfMonth(day.date)
            if target < firstMonth {
                visibleMonth = firstMonth
            } else if target > lastMonth {
                visibleMonth = lastMonth
            } else {
                visibleMonth = target
            }
        }
    }

    // MARK: Month navigation

    private var header: some View {
        HStack(spacing: 8) {
            Button {
                shift(-1)
            } label: {
                Image(systemName: "chevron.left")
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .disabled(!canGoBack)
            .accessibilityLabel(Text("Previous month"))

            Text(month, format: .dateTime.month(.wide).year())
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity)
                .accessibilityAddTraits(.isHeader)

            Button {
                shift(1)
            } label: {
                Image(systemName: "chevron.right")
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .disabled(!canGoForward)
            .accessibilityLabel(Text("Next month"))
        }
        .buttonStyle(.borderless)
        .environment(\.locale, Locale(identifier: "en_US"))
    }

    private var canGoBack: Bool { month > firstMonth }
    private var canGoForward: Bool { month < lastMonth }

    private func shift(_ offset: Int) {
        let next = ObolDate.addingMonths(offset, to: month)
        if next < firstMonth {
            visibleMonth = firstMonth
        } else if next > lastMonth {
            visibleMonth = lastMonth
        } else {
            visibleMonth = next
        }
    }

    private func initialMonth() -> Date {
        let anchor: Date
        if let selectedKey, let selected = dayIndex[selectedKey] {
            anchor = selected.date
        } else if let today = dayIndex[todayKey] {
            anchor = today.date
        } else {
            anchor = firstMonth
        }
        let candidate = ObolDate.startOfMonth(anchor)
        if candidate < firstMonth { return firstMonth }
        if candidate > lastMonth { return lastMonth }
        return candidate
    }

    // MARK: Grid

    private var weekdayHeader: some View {
        HStack(spacing: 4) {
            ForEach(weekdaySymbols, id: \.self) { symbol in
                Text(symbol)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .accessibilityHidden(true)
            }
        }
    }

    private var grid: some View {
        let dates = cells
        return LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 7),
            spacing: 4
        ) {
            ForEach(dates.indices, id: \.self) { index in
                if let date = dates[index] {
                    dayCell(date)
                } else {
                    Color.clear
                        .frame(height: cellHeight)
                        .accessibilityHidden(true)
                }
            }
        }
    }

    private var legend: some View {
        DashboardFlowLayout(spacing: 12) {
            legendItem(color: .green, label: "Positive or zero")
            legendItem(color: .red, label: "Negative")
            HStack(spacing: 4) {
                RoundedRectangle(cornerRadius: 2, style: .continuous)
                    .strokeBorder(Color.accentColor, lineWidth: 1.5)
                    .frame(width: 14, height: 14)
                    .accessibilityHidden(true)
                Text("Today")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func legendItem(color: Color, label: String) -> some View {
        HStack(spacing: 4) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    private var cells: [Date?] {
        let weekday = calendar.component(.weekday, from: month)
        let leading = (weekday - calendar.firstWeekday + 7) % 7
        let dayCount = calendar.range(of: .day, in: .month, for: month)?.count ?? 0

        var result: [Date?] = Array(repeating: nil, count: leading)
        for offset in 0..<dayCount {
            result.append(calendar.date(byAdding: .day, value: offset, to: month))
        }
        while result.count % 7 != 0 {
            result.append(nil)
        }
        return result
    }

    @ViewBuilder
    private func dayCell(_ date: Date) -> some View {
        let key = ObolDate.dayKey(date)
        let forecastDay = dayIndex[key]
        let isToday = key == todayKey
        let isSelected = key == selectedKey

        if let forecastDay {
            Button {
                onSelect(forecastDay)
            } label: {
                VStack(spacing: 2) {
                    Text(dayNumber(date))
                        .font(.caption.weight(isToday ? .bold : .regular))
                    Text(balanceLabel(forecastDay.balance))
                        .font(.caption2)
                        .monospacedDigit()
                        .multilineTextAlignment(.center)
                        // A full currency string wraps rather than truncating
                        // inside a narrow 320 pt cell.
                        .fixedSize(horizontal: false, vertical: true)
                        .foregroundStyle(forecastDay.balance < 0 ? Color.red : Color.green)
                }
                .frame(maxWidth: .infinity)
                .frame(minHeight: cellHeight)
                .padding(.vertical, 4)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(cellBackground(isToday: isToday, isSelected: isSelected))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(isToday ? Color.accentColor : Color.clear, lineWidth: 1.5)
                )
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(cellAccessibilityLabel(date: date, day: forecastDay, isToday: isToday, isSelected: isSelected)))
            .accessibilityAddTraits(isSelected ? AccessibilityTraits.isSelected : [])
        } else {
            Text(dayNumber(date))
                .font(.caption)
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity)
                .frame(height: cellHeight)
                .accessibilityLabel(Text("\(AppFormatting.day(date)), outside the projection range"))
        }
    }

    private func balanceLabel(_ balance: Decimal) -> String {
        balance < 0
            ? "-" + AppFormatting.currency(-balance)
            : AppFormatting.currency(balance)
    }

    private func cellBackground(isToday: Bool, isSelected: Bool) -> Color {
        if isSelected { return Color.accentColor.opacity(0.18) }
        if isToday { return Color.primary.opacity(0.06) }
        return Color.primary.opacity(0.02)
    }

    private func cellAccessibilityLabel(date: Date, day: ForecastDay, isToday: Bool, isSelected: Bool) -> String {
        var parts = [
            AppFormatting.day(date),
            "projected end-of-day cash \(AppFormatting.currency(day.balance))",
            day.balance < 0 ? "negative" : "positive"
        ]
        if isToday { parts.append("today") }
        if isSelected { parts.append("selected") }
        return parts.joined(separator: ", ")
    }

    private func dayNumber(_ date: Date) -> String {
        String(calendar.component(.day, from: date))
    }
}
