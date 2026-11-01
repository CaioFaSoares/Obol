import SwiftUI
import ObolCore
import ObolNativeRuntime

/// Planned budgets. `ForecastEngine.budgetSummaries` owns the accrual policy,
/// so this screen renders the product result and labels the planned basis
/// instead of recomputing it.
struct BudgetsView: View {
    @EnvironmentObject private var appState: AppState

    @State private var showCreateCategory = false
    @State private var refreshError: String?

    var body: some View {
        List {
            basisSection
            budgetSection
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
        .sheet(isPresented: $showCreateCategory) {
            ManagementCategorySheet()
        }
    }

    private var summaries: [BudgetSummary] {
        ForecastEngine()
            .budgetSummaries(appState.snapshot, includeSimulations: true)
            .sorted {
                $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }
    }

    private func hasPlannedBudget(_ summary: BudgetSummary) -> Bool {
        appState.snapshot.category(id: summary.categoryID)?.monthlyBudget != nil
    }

    private var basisSection: some View {
        Section {
            Label(
                "Planned basis: accrual for this month. Pending and simulated transactions are included, and an expense counts on its purchase date when set, otherwise on its expected date.",
                systemImage: "chart.bar"
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var budgetSection: some View {
        Section {
            if summaries.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("No categories yet")
                        .font(.headline)
                    Text("Create a category to group transactions and plan a monthly budget.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(summaries, id: \.categoryID) { summary in
                ManagementBudgetRow(
                    summary: summary,
                    hasPlannedBudget: hasPlannedBudget(summary)
                )
            }
            ManagementCreationButton(title: "New category", systemImage: "plus.circle") {
                showCreateCategory = true
            }
        } header: {
            Text("Planned budgets")
        } footer: {
            Text("Simulated amounts stay in the planning total. They never move real cash.")
        }
    }
}

/// One planned-budget row. Every amount is product output; the over-budget
/// note is text, not a color-only signal.
struct ManagementBudgetRow: View {
    let summary: BudgetSummary
    let hasPlannedBudget: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(summary.name)
                .font(.headline)
                .lineLimit(2)
                .allowsTightening(true)
            if hasPlannedBudget {
                HStack(alignment: .firstTextBaseline) {
                    Text("Budget \(AppFormatting.currency(summary.monthlyBudget))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 12)
                    Text("Spent \(AppFormatting.currency(summary.spent))")
                        .font(.caption)
                        .monospacedDigit()
                        .fixedSize(horizontal: false, vertical: true)
                }
                if summary.isOverBudget {
                    Label(
                        "Over budget; remaining \(AppFormatting.currency(summary.remaining))",
                        systemImage: "exclamationmark.triangle"
                    )
                    .font(.caption)
                    .foregroundStyle(.orange)
                } else {
                    Text("Remaining \(AppFormatting.currency(summary.remaining))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            } else {
                Text("No monthly budget planned. Spent so far \(AppFormatting.currency(summary.spent)).")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(accessibility))
    }

    private var accessibility: String {
        var parts = [summary.name]
        if hasPlannedBudget {
            parts.append("Budget \(AppFormatting.currency(summary.monthlyBudget))")
            parts.append("Spent \(AppFormatting.currency(summary.spent))")
            if summary.isOverBudget {
                parts.append("Over budget; remaining \(AppFormatting.currency(summary.remaining))")
            } else {
                parts.append("Remaining \(AppFormatting.currency(summary.remaining))")
            }
        } else {
            parts.append("No planned budget")
            parts.append("Spent \(AppFormatting.currency(summary.spent))")
        }
        return parts.joined(separator: ", ")
    }
}

/// Category creation. Category editing and deletion are outside the supported
/// operation set, so this form only creates.
struct ManagementCategorySheet: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var type: CategoryType = .fixedBudget
    @State private var hasBudget = true
    @State private var budgetText = ""
    @State private var isSubmitting = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                        .accessibilityLabel(Text("Name"))
                        .frame(minHeight: 44)
                        .disabled(isSubmitting)
                    Picker("Type", selection: $type) {
                        Text("Fixed budget").tag(CategoryType.fixedBudget)
                        Text("Variable").tag(CategoryType.variable)
                    }
                    .disabled(isSubmitting)
                    Toggle("Planned monthly budget", isOn: $hasBudget)
                        .disabled(isSubmitting)
                    if hasBudget {
                        ManagementMoneyField(title: "Monthly budget", text: $budgetText)
                            .disabled(isSubmitting)
                    }
                } header: {
                    Text("Category")
                } footer: {
                    Text("Categories are creation-only in this release. A category without a budget still groups transactions.")
                }
                if let message = errorText {
                    Section {
                        Label(message, systemImage: "exclamationmark.triangle")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    }
                }
            }
            .scrollDismissesKeyboard(.immediately)
            .navigationTitle("New category")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        Task { await submit() }
                    }
                    .disabled(submitDisabled || isSubmitting)
                }
            }
            .keyboardDoneToolbar()
        }
        .interactiveDismissDisabled(isSubmitting)
    }

    private var trimmedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var submitDisabled: Bool {
        trimmedName.isEmpty
    }

    private func submit() async {
        guard !isSubmitting, !submitDisabled else { return }
        isSubmitting = true
        errorText = nil
        defer { isSubmitting = false }

        let category = ObolCore.Category(
            name: trimmedName,
            type: type,
            monthlyBudget: hasBudget ? ManagementMoney.parse(budgetText) : nil
        )
        do {
            try await appState.apply(.createCategory(category))
            dismiss()
        } catch {
            errorText = error.localizedDescription
        }
    }
}
