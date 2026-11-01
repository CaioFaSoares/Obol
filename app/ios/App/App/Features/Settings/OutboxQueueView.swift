import SwiftUI
import ObolCore
import ObolNativeRuntime

/// The durable outbox as the user sees it: replay position, immutable
/// envelope fields, attempts, the real last error and the local state before
/// the intent. The queue itself is read-only; only an explicit acknowledgement
/// removes a rejected operation, and every dependent policy is chosen here.
struct OutboxQueueView: View {
    @EnvironmentObject private var appState: AppState

    @State private var localError: String?

    var body: some View {
        List {
            if let localError {
                Section {
                    ErrorNotice(message: localError) {
                        self.localError = nil
                    }
                }
            }

            if appState.outbox.isEmpty {
                Text("No queued operations")
                    .foregroundStyle(.secondary)
            } else {
                Section {
                    ForEach(Array(appState.outbox.enumerated()), id: \.element.opId) { index, operation in
                        NavigationLink {
                            OutboxOperationDetailView(opId: operation.opId)
                        } label: {
                            OutboxRow(operation: operation, position: index + 1)
                        }
                    }
                } footer: {
                    Text("Rows are listed in durable replay order. An accepted operation leaves this queue; a rejection stays until you acknowledge it.")
                }
            }
        }
        .navigationTitle("Operations Queue")
        .refreshable {
            do {
                try await appState.refresh()
            } catch {
                localError = "The queue could not be refreshed: \(error.localizedDescription)"
            }
        }
    }
}

// MARK: - Row

private struct OutboxRow: View {
    let operation: OutboxOperation
    let position: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                statusBadge
                Spacer(minLength: 8)
                Text(verbatim: "#\(position) · \(operation.attempts) attempt\(operation.attempts == 1 ? "" : "s")")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text(verbatim: "\(operation.type.rawValue) · \(operation.entityType.rawValue)")
                .font(.subheadline.weight(.medium))
                .fixedSize(horizontal: false, vertical: true)
            Text(verbatim: operation.entityId)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(verbatim: "Effective \(AppFormatting.day(operation.effectiveAt))")
                .font(.caption)
                .foregroundStyle(.secondary)
            if let lastError = operation.lastError, !lastError.isEmpty {
                Text(lastError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 4)
        .frame(minHeight: 44, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(accessibilitySummary))
    }

    private var accessibilitySummary: String {
        var parts = [
            "Queue position \(position)",
            statusTitle(operation.status),
            operation.type.rawValue,
            "entity \(operation.entityType.rawValue) \(operation.entityId)",
            "effective \(AppFormatting.day(operation.effectiveAt))",
            "\(operation.attempts) attempts"
        ]
        if let lastError = operation.lastError, !lastError.isEmpty {
            parts.append(lastError)
        }
        return parts.joined(separator: ", ")
    }

    @ViewBuilder
    private var statusBadge: some View {
        switch operation.status {
        case .queued:
            badge("Queued", icon: "tray", color: .blue)
        case .inFlight:
            badge("Sending", icon: "arrow.up.circle", color: .blue)
        case .accepted:
            badge("Accepted", icon: "checkmark.circle", color: .green)
        case .conflict:
            badge("Conflict", icon: "exclamationmark.triangle", color: .orange)
        case .rejected:
            badge("Rejected", icon: "xmark.octagon", color: .red)
        }
    }

    private func badge(_ title: String, icon: String, color: Color) -> some View {
        Label {
            Text(title)
                .font(.caption.weight(.semibold))
        } icon: {
            Image(systemName: icon)
                .font(.caption2)
                .accessibilityHidden(true)
        }
        .foregroundStyle(color)
    }
}

// MARK: - Detail

/// Full immutable envelope of one queued intent plus the explicit
/// acknowledgement for a rejected operation.
private struct OutboxOperationDetailView: View {
    let opId: String

    @EnvironmentObject private var appState: AppState

    @State private var dependentStrategy: DependentStrategy = .blockQueued
    @State private var isAcknowledging = false
    @State private var acknowledged = false
    @State private var confirmAcknowledge = false
    @State private var localError: String?

    private var operation: OutboxOperation? {
        appState.outbox.first { $0.opId == opId }
    }

    var body: some View {
        List {
            if acknowledged {
                Section {
                    NoticeText(message: "The rejected operation was acknowledged and removed from the queue. Local working data follows the restore rules, and the selected dependent policy was applied.")
                }
            } else if let operation {
                content(for: operation)
            } else {
                Text("This operation is no longer pending.")
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Operation")
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func content(for operation: OutboxOperation) -> some View {
        Section {
            fact("Operation id", operation.opId, monospaced: true)
            fact("Station id", operation.stationId, monospaced: true)
            fact("Protocol version", String(operation.protocolVersion))
            fact("Operation type", operation.type.rawValue)
            fact("Entity", "\(operation.entityType.rawValue) \(operation.entityId)")
            fact("Status", statusTitle(operation.status))
            fact("Envelope", operation.isEnvelopeLocked
                ? "Locked: the bytes and payload hash can no longer change"
                : "Not yet sent; the envelope may still gain dependency revisions")
        } header: {
            Text("Identity")
        }

        Section {
            fact("Effective at", AppFormatting.timestamp(operation.effectiveAt))
            fact("Client created at", AppFormatting.timestamp(operation.clientCreatedAt))
            fact("Recorded at", AppFormatting.timestamp(operation.createdAt))
            fact("Updated at", AppFormatting.timestamp(operation.updatedAt))
        } header: {
            Text("Timing")
        } footer: {
            Text("The effective time is the business event time supplied when the financial action happened. It never changes on replay or retry; the other timestamps are audit data.")
        }

        Section {
            fact("Attempts", String(operation.attempts))
            if let lastError = operation.lastError, !lastError.isEmpty {
                fact("Last error", lastError)
            }
            if let blockedBy = operation.blockedBy, !blockedBy.isEmpty {
                fact("Blocked by", blockedBy, monospaced: true)
            }
        } header: {
            Text("Delivery")
        }

        Section {
            fact("Payload hash", operation.payloadHash, monospaced: true)
            if operation.dependsOn.isEmpty {
                fact("Depends on", "No dependencies")
            } else {
                fact("Depends on", operation.dependsOn.joined(separator: "\n"), monospaced: true)
            }
            if operation.baseRevisions.isEmpty {
                fact("Base revisions", "None recorded")
            } else {
                fact(
                    "Base revisions",
                    operation.baseRevisions
                        .sorted { $0.key < $1.key }
                        .map { "\($0.key) = \($0.value)" }
                        .joined(separator: "\n"),
                    monospaced: true
                )
            }
            if operation.writeSet.isEmpty {
                fact("Write set", "No additional entities")
            } else {
                fact("Write set", operation.writeSet.map(\.description).joined(separator: "\n"), monospaced: true)
            }
        } header: {
            Text("Replay")
        } footer: {
            Text("Dependencies must be accepted before this operation can freeze and send. Once the envelope is locked, only an explicit rebase creates a new operation.")
        }

        Section {
            JSONBlock(title: "Payload (local intent)", value: operation.payload)
        } header: {
            Text("Payload")
        }

        Section {
            if operation.beforeSnapshots.isEmpty {
                Text("No before-snapshots were recorded for this operation.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(operation.beforeSnapshots, id: \.key) { snapshot in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(verbatim: snapshot.key.description)
                            .font(.subheadline.weight(.semibold))
                        if let record = snapshot.record {
                            JSONBlock(title: "Record before the intent", value: record)
                        } else {
                            Text("The entity did not exist before this operation.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        } header: {
            Text("Local state before the operation")
        }

        if operation.status == .rejected {
            rejectionSection
        }
    }

    private var rejectionSection: some View {
        Section {
            if let localError {
                ErrorNotice(message: localError) {
                    self.localError = nil
                }
            }
            DependentStrategySelector(selection: $dependentStrategy, isEnabled: !isBusy)

            Button(role: .destructive) {
                confirmAcknowledge = true
            } label: {
                if isAcknowledging {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Acknowledging…")
                    }
                    .frame(minHeight: 44, alignment: .leading)
                } else {
                    Label("Acknowledge rejection and remove", systemImage: "trash")
                        .frame(minHeight: 44, alignment: .leading)
                }
            }
            .disabled(isBusy)
            .confirmationDialog(
                "Acknowledge this rejection?",
                isPresented: $confirmAcknowledge,
                titleVisibility: .visible
            ) {
                Button("Acknowledge and remove", role: .destructive) {
                    acknowledge()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("The rejected intent leaves the queue. Its before-snapshots are restored only where no other pending operation still claims the entity. Dependent operations: \(dependentStrategyTitle).")
            }
        } header: {
            Text("Rejected operation")
        } footer: {
            Text("Nothing is acknowledged automatically. Read the server reason above before removing the intent.")
        }
    }

    private var isBusy: Bool {
        isAcknowledging || appState.isWorking
    }

    private var dependentStrategyTitle: String {
        switch dependentStrategy {
        case .blockQueued: return "keep dependents queued and blocked"
        case .rejectDependents: return "reject the direct dependents"
        case .retryWithoutDependency: return "re-queue dependents without this dependency"
        }
    }

    private func acknowledge() {
        guard !isBusy else { return }
        isAcknowledging = true
        localError = nil
        Task { @MainActor in
            defer { isAcknowledging = false }
            do {
                try await appState.acknowledgeRejected(
                    opId: opId,
                    dependents: dependentStrategy
                )
                acknowledged = true
            } catch {
                localError = "The rejection could not be acknowledged: \(error.localizedDescription)"
            }
        }
    }

    private func fact(_ label: String, _ value: String, monospaced: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(verbatim: value)
                .font(monospaced ? .system(.footnote, design: .monospaced) : .footnote)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .frame(minHeight: 44, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("\(label): \(value)"))
    }
}

/// English display name for a queue status. Kept next to the queue because
/// only this feature renders statuses.
private func statusTitle(_ status: OutboxStatus) -> String {
    switch status {
    case .queued: return "Queued"
    case .inFlight: return "Sending"
    case .accepted: return "Accepted"
    case .conflict: return "Conflict"
    case .rejected: return "Rejected"
    }
}
