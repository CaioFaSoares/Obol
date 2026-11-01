import Foundation
import SwiftUI
import Charts
import ObolCore
import ObolNativeRuntime

/// Trajectory chart built on iOS 16 primitives only: `chartOverlay` with a
/// spatial tap maps the touch position to the nearest forecast day. No
/// iOS 17-only selection API is used, and the chart always exposes a text
/// summary for assistive technologies.
struct DashboardTrajectoryChart: View {
    let days: [ForecastDay]
    let dayIndex: [String: ForecastDay]
    let selectedKey: String?
    let lowerBound: Double
    let upperBound: Double
    let summary: String
    let onSelect: (ForecastDay) -> Void

    @State private var highlightedKey: String?
    @ScaledMetric(relativeTo: .body) private var chartHeight: CGFloat = 200

    init(
        days: [ForecastDay],
        dayIndex: [String: ForecastDay],
        selectedKey: String?,
        lowerBound: Double,
        upperBound: Double,
        summary: String,
        onSelect: @escaping (ForecastDay) -> Void
    ) {
        self.days = days
        self.dayIndex = dayIndex
        self.selectedKey = selectedKey
        self.lowerBound = lowerBound
        self.upperBound = upperBound
        self.summary = summary
        self.onSelect = onSelect
    }

    private var highlightedDay: ForecastDay? {
        let key = highlightedKey ?? selectedKey
        guard let key = key else { return nil }
        return dayIndex[key]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(highlightedDay.map { AppFormatting.day($0.date) } ?? "Tap the chart to inspect a day")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 8)
                if let highlightedDay {
                    Text(AppFormatting.currency(highlightedDay.balance))
                        .font(.caption.weight(.semibold))
                        .monospacedDigit()
                        .foregroundStyle(highlightedDay.balance < 0 ? .red : .green)
                        .multilineTextAlignment(.trailing)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .accessibilityElement(children: .combine)

            chart
        }
    }

    private var chart: some View {
        Chart {
            ForEach(days, id: \.dashboardKey) { day in
                AreaMark(
                    x: .value("Date", day.date),
                    y: .value("Projected cash", doubleValue(day.balance))
                )
                .interpolationMethod(.monotone)
                .foregroundStyle(
                    LinearGradient(
                        colors: [Color.accentColor.opacity(0.24), Color.accentColor.opacity(0.02)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )

                LineMark(
                    x: .value("Date", day.date),
                    y: .value("Projected cash", doubleValue(day.balance))
                )
                .interpolationMethod(.monotone)
                .foregroundStyle(Color.accentColor)
                .lineStyle(StrokeStyle(lineWidth: 2))
            }

            RuleMark(y: .value("Zero", 0.0))
                .foregroundStyle(Color.gray.opacity(0.45))
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))

            if let highlightedDay {
                RuleMark(x: .value("Selected date", highlightedDay.date))
                    .foregroundStyle(Color.gray.opacity(0.6))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                PointMark(
                    x: .value("Selected date", highlightedDay.date),
                    y: .value("Selected cash", doubleValue(highlightedDay.balance))
                )
                .foregroundStyle(highlightedDay.balance < 0 ? Color.red : Color.accentColor)
                .symbolSize(64)
            }
        }
        .chartYScale(domain: lowerBound...upperBound)
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 4)) { value in
                AxisGridLine()
                AxisTick()
                AxisValueLabel {
                    if let date = value.as(Date.self) {
                        Text(date, format: .dateTime.month(.abbreviated).day())
                            .font(.caption2)
                    }
                }
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 4))
        }
        .environment(\.locale, Locale(identifier: "en_US"))
        .frame(height: chartHeight)
        .chartOverlay { proxy in
            GeometryReader { geometry in
                Rectangle()
                    .fill(Color.clear)
                    .contentShape(Rectangle())
                    .gesture(
                        SpatialTapGesture()
                            .onEnded { value in
                                guard let day = day(at: value.location, proxy: proxy, geometry: geometry) else { return }
                                highlightedKey = day.dashboardKey
                                onSelect(day)
                            }
                    )
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(summary))
        .accessibilityHint(Text("Use the projected calendar below to open any day with assistive technologies."))
    }

    /// Decimal is converted to Double only for chart geometry; every monetary
    /// rule stays in ObolCore.
    private func doubleValue(_ amount: Decimal) -> Double {
        NSDecimalNumber(decimal: amount).doubleValue
    }

    private func day(at location: CGPoint, proxy: ChartProxy, geometry: GeometryProxy) -> ForecastDay? {
        let plotFrame = geometry[proxy.plotAreaFrame]
        guard plotFrame.width > 0 else { return nil }
        let x = location.x - plotFrame.minX
        guard x >= 0, x <= plotFrame.width else { return nil }
        guard let date: Date = proxy.value(atX: x) else { return nil }

        var best: ForecastDay?
        var bestDistance = TimeInterval.greatestFiniteMagnitude
        for day in days {
            let distance = abs(day.date.timeIntervalSince(date))
            if distance < bestDistance {
                bestDistance = distance
                best = day
            }
        }
        return best
    }
}
