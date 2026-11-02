import SwiftUI
import ObolCore
import ObolNativeRuntime

/// Conflict workspace. Every conflict is grouped by the operation that caused
/// it and shows the base revision, the current server revision, the current
/// server record and the local intent. Resolution is always one of three
/// explicit choices plus an explicit policy for the dependent operations.
/// There is no automatic last-writer-wins and no cascade.
struct ConflictResolutionListView: View {
    @EnvironmentObject private var appState: AppState

    @State private var localError: String?
    @State private var localNotice: String?

    var body: some View {
        List {
            if let localError {
                Section {
                    ErrorNotice(message: localError) {
                        self.localError = nil
                    }
                }
            }
            if let localNotice {
                Section {
                    NoticeText(message: localNotice)
                }
            }

            if groups.isEmpty {
                Text("No conflicts")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(groups) { group in
                    ConflictGroupView(group: group, listNotice: $localNotice)
                }
            }
        }
        .navigationTitle("Conflicts")
        .refreshable {
            do {
                try await appState.refresh()
            } catch {
                localError = "The conflicts could not be refreshed: \(error.localizedDescription)"
            }
        }
    }

    /// One group per conflicted operation, in the store's conflict order.
    private var groups: [ConflictGroup] {
        var order: [String] = []
        var rows: [String: [ConflictRecord]] = [:]
        for record in appState.conflicts {
            if rows[record.opId] == nil {
                order.append(record.opId)
            }
            rows[record.opId, default: []].append(record)
        }
        return order.map { ConflictGroup(opId: $0, rows: rows[$0] ?? []) }
    }
}

// MARK: - Group

private struct ConflictGroup: Identifiable {
    let opId: String
    let rows: [ConflictRecord]

    var id: String { opId }
}

/// One conflicted operation: the server side and the local side of every
/// affected entity, the three explicit resolutions and the dependent policy.
private struct ConflictGroupView: View {
    let group: ConflictGroup
    @Binding var listNotice: String?

    @EnvironmentObject private var appState: AppState

    @State private var dependentStrategy: DependentStrategy = .blockQueued
    @State private var isResolving = false
    @State private var localError: String?

    private var intent: OutboxOperation? {
        appState.outbox.first { $0.opId == group.opId }
    }

    private var isPending: Bool {
        group.rows.contains { $0.resolution == .pending }
            && intent?.status == .conflict
    }

    private var isBusy: Bool {
        isResolving || appState.isWorking
    }

    private var containsIdentifierCollision: Bool {
        group.rows.contains { $0.kind == .entityIdTaken }
    }

    var body: some View {
        Section {
            groupHeader
            comparisons
            intentSummary
            if let localError {
                ErrorNotice(message: localError) {
                    self.localError = nil
                }
            }
            if isPending {
                DependentStrategySelector(selection: $dependentStrategy, isEnabled: !isBusy)
                resolutions
            } else {
                NoticeText(message: "This conflict was already resolved on this device. No further action is offered here.")
            }
        } header: {
            Text(groupTitle)
        } footer: {
            Text("Nothing is merged automatically. A resolution applies to this operation only; dependent operations follow the policy you select.")
        }
    }

    private var groupTitle: String {
        let kind = group.rows.first?.kind
        let entityCount = group.rows.count
        let kindLabel = kind.map(kindTitle) ?? "Conflict"
        return "\(kindLabel) · \(entityCount) entit\(entityCount == 1 ? "y" : "ies")"
    }

    private var groupHeader: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: "\(group.rows.first?.entityType.rawValue ?? "entity") · \(group.opId)")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            if let message = group.rows.first?.message, !message.isEmpty {
                Text(message)
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text(verbatim: resolutionTitle(group.rows.first?.resolution ?? .pending))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(minHeight: 44, alignment: .leading)
    }

    private var comparisons: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(group.rows.enumerated()), id: \.offset) { _, conflict in
                VStack(alignment: .leading, spacing: 6) {
                    Text(verbatim: "\(conflict.entityType.rawValue) \(conflict.entityId)")
                        .font(.subheadline.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                    HStack(alignment: .firstTextBaseline, spacing: 16) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Base revision")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            if let base = conflict.baseRevision {
                                Text(verbatim: String(base))
                            } else {
                                Text("New entity")
                                    .foregroundStyle(.secondary)
                            }
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Current server revision")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(verbatim: String(conflict.currentRevision))
                        }
                        Spacer(minLength: 0)
                    }
                    .font(.subheadline)
                    if let record = conflict.currentRecord {
                        JSONBlock(title: "Current server record", value: record)
                    } else {
                        Text("The server entity no longer exists.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: 10)
                        .fill(SettingsSurface.raised)
                )
            }
        }
    }

    @ViewBuilder
    private var intentSummary: some View {
        if let intent {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text("My pending change")
                        .font(.caption.weight(.semibold))
                    Spacer(minLength: 8)
                    Text(verbatim: "Effective \(AppFormatting.timestamp(intent.effectiveAt))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Text(verbatim: "\(intent.type.rawValue) on \(intent.entityType.rawValue) \(intent.entityId)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                JSONBlock(title: "Local intent payload", value: intent.payload)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .fill(SettingsSurface.raised)
            )
        } else {
            NoticeText(message: "The queued intent for this operation is no longer in the outbox, so nothing local can be rebased from here.")
        }
    }

    @ViewBuilder
    private var resolutions: some View {
        VStack(alignment: .leading, spacing: 8) {
            resolutionButton(
                "Use the server record",
                detail: "Keep the current server version and discard this local intent.",
                enabled: !isBusy
            ) {
                resolve(.useServer)
            }
            resolutionButton(
                "Retry at the current server revision",
                detail: containsIdentifierCollision
                    ? "Not available: this is an identifier collision, and the same id cannot be retried."
                    : "Rebase this intent on the current server revision under a new operation id.",
                enabled: !isBusy && !containsIdentifierCollision
            ) {
                resolve(.retryWithCurrentServerRevision)
            }
            resolutionButton(
                "Discard my change",
                detail: "Remove this intent and restore its before-snapshots where nothing else claims the entity.",
                role: .destructive,
                enabled: !isBusy
            ) {
                resolve(.discard)
            }
            if isResolving {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Applying the resolution…")
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func resolve(_ resolution: ConflictResolution) {
        guard !isBusy else { return }
        isResolving = true
        localError = nil
        Task { @MainActor in
            defer { isResolving = false }
            do {
                try await appState.resolveConflict(
                    opId: group.opId,
                    resolution: resolution,
                    dependents: dependentStrategy
                )
                listNotice = "The conflict was resolved (\(resolutionButtonTitle(resolution))) and the outbox was updated. Dependent operations followed the selected policy."
            } catch {
                localError = "The resolution was not applied: \(error.localizedDescription)"
            }
        }
    }

    private func resolutionButton(
        _ title: String,
        detail: String,
        role: ButtonRole? = nil,
        enabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(role: role, action: action) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.medium))
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.bordered)
        .disabled(!enabled)
    }
}

// MARK: - Dependent policy

/// The explicit policy for operations that depend on the one being resolved
/// or acknowledged. The safe default keeps them queued and blocked; the other
/// two options are never applied without the user selecting them.
struct DependentStrategySelector: View {
    @Binding var selection: DependentStrategy
    let isEnabled: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Dependent operations")
                .font(.caption)
                .foregroundStyle(.secondary)
            option(
                .blockQueued,
                title: "Keep them queued and blocked",
                detail: "Dependents wait until you resolve them explicitly."
            )
            option(
                .rejectDependents,
                title: "Reject the direct dependents",
                detail: "Direct dependents are marked rejected; their envelopes and before-snapshots are preserved."
            )
            option(
                .retryWithoutDependency,
                title: "Re-queue without this dependency",
                detail: "Each dependent gets a new operation id and no longer depends on this one."
            )
        }
    }

    private func option(
        _ value: DependentStrategy,
        title: String,
        detail: String
    ) -> some View {
        Button {
            selection = value
        } label: {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: selection == value ? "checkmark.circle.fill" : "circle")
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.subheadline)
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .frame(minHeight: 44, alignment: .top)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .accessibilityValue(Text(selection == value ? "Selected" : "Not selected"))
    }
}

// MARK: - Labels

private func kindTitle(_ kind: ConflictKind) -> String {
    switch kind {
    case .syncConflict: return "Changed on the server"
    case .entityIdTaken: return "Identifier already taken"
    }
}

private func resolutionTitle(_ resolution: ConflictResolutionState) -> String {
    switch resolution {
    case .pending: return "Needs an explicit decision"
    case .server: return "Resolved: server record kept"
    case .retry: return "Resolved: retried at the current revision"
    case .discarded: return "Resolved: local change discarded"
    }
}

private func resolutionButtonTitle(_ resolution: ConflictResolution) -> String {
    switch resolution {
    case .useServer: return "use the server record"
    case .retryWithCurrentServerRevision: return "retry at the current revision"
    case .discard: return "discard the local change"
    }
}
