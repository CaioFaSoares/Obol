import Foundation
import SwiftUI
import ObolCore
import ObolNativeRuntime

/// Projects: creation, receipt registration, completion, and read-only
/// received totals. `ForecastEngine.projectSummaries` counts only realized,
/// non-simulated income rows; this screen never recomputes that rule.
struct ProjectsView: View {
    @EnvironmentObject private var appState: AppState

    @State private var showCreate = false
    @State private var paymentTarget: Project?
    @State private var completeTarget: Project?
    @State private var isMutating = false
    @State private var errorText: String?
    @State private var refreshError: String?

    var body: some View {
        // One product projection per render for both project sections.
        let summaries = rows
        List {
            activeSection(summaries)
            completedSection(summaries)
            if let message = refreshError {
                Section {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            if let message = errorText {
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
            ManagementProjectSheet()
        }
        .sheet(item: $paymentTarget) { project in
            ManagementProjectPaymentSheet(project: project)
        }
        .confirmationDialog(
            "Mark project as completed?",
            isPresented: completionBinding,
            titleVisibility: .visible
        ) {
            Button("Mark completed") {
                if let project = completeTarget {
                    Task { await complete(project) }
                }
            }
            Button("Cancel", role: .cancel) {
                completeTarget = nil
            }
        } message: {
            Text("The project moves to the completed list. Its received total and remaining value stay readable, and the total value never changes.")
        }
    }

    private var completionBinding: Binding<Bool> {
        Binding(
            get: { completeTarget != nil },
            set: { presented in
                if !presented { completeTarget = nil }
            }
        )
    }

    private var rows: [ProjectSummary] {
        ForecastEngine().projectSummaries(appState.snapshot)
            .sorted {
                $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }
    }

    @ViewBuilder
    private func activeSection(_ summaries: [ProjectSummary]) -> some View {
        let active = summaries.filter { $0.status == .active }
        Section {
            if active.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("No active projects")
                        .font(.headline)
                    Text("Create a project to track expected and received amounts.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(active, id: \.projectID) { summary in
                ManagementProjectRow(
                    summary: summary,
                    isMutating: isMutating,
                    registerPayment: { paymentTarget = project(id: summary.projectID) },
                    complete: { completeTarget = project(id: summary.projectID) }
                )
            }
            ManagementCreationButton(title: "New project", systemImage: "plus.circle") {
                showCreate = true
            }
        } header: {
            Text("Active projects")
        } footer: {
            Text("A receipt records a realized income for the project only: no bank account moves and the project total value stays unchanged.")
        }
    }

    @ViewBuilder
    private func completedSection(_ summaries: [ProjectSummary]) -> some View {
        let completed = summaries.filter { $0.status == .completed }
        if !completed.isEmpty {
            Section {
                ForEach(completed, id: \.projectID) { summary in
                    ManagementProjectRow(
                        summary: summary,
                        isMutating: isMutating,
                        registerPayment: { paymentTarget = project(id: summary.projectID) },
                        complete: nil
                    )
                }
            } header: {
                Text("Completed projects")
            } footer: {
                Text("Received totals count only realized, non-simulated income rows assigned to the project.")
            }
        }
    }

    private func project(id: String) -> Project? {
        appState.snapshot.project(id: id)
    }

    private func complete(_ project: Project) async {
        guard !isMutating else { return }
        isMutating = true
        errorText = nil
        defer {
            isMutating = false
            completeTarget = nil
        }
        do {
            try await appState.apply(.completeProject(id: project.id))
        } catch {
            errorText = error.localizedDescription
        }
    }
}

/// One project row: name, total value, received, remaining and progress. Every
/// money value is product output.
struct ManagementProjectRow: View {
    let summary: ProjectSummary
    let isMutating: Bool
    let registerPayment: () -> Void
    let complete: (() -> Void)?

    private var percent: Int {
        Int((summary.progress * 100).rounded())
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            summaryBlock
            HStack(spacing: 24) {
                Button(action: registerPayment) {
                    Label("Register receipt", systemImage: "arrow.down.circle")
                        .frame(minHeight: 44)
                }
                .buttonStyle(.bordered)
                .disabled(isMutating)
                if let complete {
                    Button(action: complete) {
                        Label("Mark completed", systemImage: "checkmark.seal")
                        .frame(minHeight: 44)
                    }
                    .buttonStyle(.bordered)
                    .disabled(isMutating)
                }
            }
        }
        .frame(minHeight: 44)
    }

    /// Informational text as one VoiceOver element; the action buttons below
    /// stay individually focusable.
    private var summaryBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(summary.name)
                    .font(.headline)
                    .lineLimit(2)
                    .allowsTightening(true)
                Spacer(minLength: 12)
                Text(summary.status == .completed ? "Completed" : "Active")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack(alignment: .firstTextBaseline) {
                Text("Received \(AppFormatting.currency(summary.paid))")
                    .font(.subheadline)
                    .monospacedDigit()
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 12)
                Text("Remaining \(AppFormatting.currency(summary.remaining))")
                    .font(.subheadline)
                    .monospacedDigit()
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                ProgressView(value: summary.progress)
                Text("\(percent)%")
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            Text("Total value \(AppFormatting.currency(summary.totalValue))")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(accessibility))
    }

    private var accessibility: String {
        var parts = [
            summary.name,
            summary.status == .completed ? "Completed" : "Active",
            "Received \(AppFormatting.currency(summary.paid))",
            "Remaining \(AppFormatting.currency(summary.remaining))",
            "Total value \(AppFormatting.currency(summary.totalValue))",
            "Progress \(percent) percent"
        ]
        parts.append("Register receipt available")
        if complete != nil { parts.append("Completion available") }
        return parts.joined(separator: ", ")
    }
}

/// Project creation. Project editing and deletion are outside the supported
/// operation set, so this form only creates.
struct ManagementProjectSheet: View {
    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var totalText = ""
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
                    ManagementMoneyField(title: "Total value", text: $totalText)
                        .disabled(isSubmitting)
                } header: {
                    Text("Project")
                } footer: {
                    Text("Receipts never change the total value or a bank account. They are recorded separately for the project.")
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
            .navigationTitle("New project")
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

        let project = Project(
            name: trimmedName,
            totalValue: ManagementMoney.parse(totalText)
        )
        do {
            try await appState.apply(.createProject(project))
            dismiss()
        } catch {
            errorText = error.localizedDescription
        }
    }
}

/// Receipt registration for one project: amount plus optional description.
struct ManagementProjectPaymentSheet: View {
    let project: Project

    @EnvironmentObject private var appState: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var amountText = ""
    @State private var descriptionText = ""
    @State private var isSubmitting = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ManagementMoneyField(title: "Amount received", text: $amountText)
                        .disabled(isSubmitting)
                    TextField("Description (optional)", text: $descriptionText)
                        .accessibilityLabel(Text("Description (optional)"))
                        .frame(minHeight: 44)
                        .disabled(isSubmitting)
                } header: {
                    Text("Receipt for \(project.name)")
                } footer: {
                    Text("A receipt records a realized income tied to this project only. No bank account moves and the project total value stays unchanged.")
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
            .navigationTitle("Register receipt")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(isSubmitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Record") {
                        Task { await submit() }
                    }
                    .disabled(amount <= 0 || isSubmitting)
                }
            }
            .keyboardDoneToolbar()
        }
        .interactiveDismissDisabled(isSubmitting)
    }

    private var amount: Decimal {
        ManagementMoney.parse(amountText)
    }

    private func submit() async {
        guard !isSubmitting, amount > 0 else { return }
        isSubmitting = true
        errorText = nil
        defer { isSubmitting = false }

        let trimmedDescription = descriptionText.trimmingCharacters(in: .whitespacesAndNewlines)
        let description: String? = trimmedDescription.isEmpty ? nil : trimmedDescription

        do {
            try await appState.apply(
                .registerProjectPayment(
                    projectID: project.id,
                    amount: amount,
                    description: description
                )
            )
            dismiss()
        } catch {
            errorText = error.localizedDescription
        }
    }
}
