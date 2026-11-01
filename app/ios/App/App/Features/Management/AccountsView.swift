import SwiftUI
import ObolCore
import ObolNativeRuntime

/// Accounts and cards maintenance for the supported 0.4 operation set:
/// accounts are creation-only, cards can be created and updated. No delete or
/// account-edit control is shown because no such operation is supported; the
/// screens state that limitation honestly instead of offering disabled
/// controls.
struct AccountsView: View {
    @EnvironmentObject private var appState: AppState

    @State private var showCreateAccount = false
    @State private var showCreateCard = false
    @State private var editedCard: Card?
    @State private var refreshError: String?

    var body: some View {
        List {
            accountsSection
            cardsSection
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
        .sheet(isPresented: $showCreateAccount) {
            CreateAccountView()
        }
        .sheet(isPresented: $showCreateCard) {
            CreateCardView(card: nil)
        }
        .sheet(item: $editedCard) { card in
            CreateCardView(card: card)
        }
    }

    // MARK: - Accounts

    private var accountsSection: some View {
        Section {
            ForEach(appState.snapshot.accounts) { account in
                AccountsRow(account: account)
            }
            ManagementEmptyHintRow(
                shown: appState.snapshot.accounts.isEmpty,
                message: "No accounts yet. Create one to track your balances."
            )
            ManagementCreationButton(title: "New account", systemImage: "plus.circle") {
                showCreateAccount = true
            }
        } header: {
            Text("Accounts")
        } footer: {
            Text("Accounts are creation-only in this release. Investment accounts hold assets and stay out of the liquid cash snapshot.")
        }
    }

    // MARK: - Cards

    private var cardsSection: some View {
        Section {
            ForEach(appState.snapshot.cards) { card in
                Button {
                    editedCard = card
                } label: {
                    CardsRow(card: card)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint(Text("Opens the card editor"))
            }
            ManagementEmptyHintRow(
                shown: appState.snapshot.cards.isEmpty,
                message: "No cards yet. Create one to track invoices."
            )
            ManagementCreationButton(title: "New card", systemImage: "plus.circle") {
                showCreateCard = true
            }
        } header: {
            Text("Cards")
        } footer: {
            Text("Tap a card to change its name, closing day, due day and limit.")
        }
    }
}

private struct AccountsRow: View {
    let account: Account

    private var typeTitle: String {
        ManagementAccountTypeLabel.title(for: account.type)
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 3) {
                Text(account.name)
                    .font(.headline)
                    .lineLimit(2)
                    .allowsTightening(true)
                Text(typeTitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 12)
            VStack(alignment: .trailing, spacing: 2) {
                Text("Starting balance")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(AppFormatting.currency(account.initialBalance))
                    .font(.subheadline)
                    .monospacedDigit()
                    .minimumScaleFactor(0.8)
                    .lineLimit(2)
            }
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("\(account.name), \(typeTitle), starting balance \(AppFormatting.currency(account.initialBalance))"))
    }
}

private struct CardsRow: View {
    let card: Card

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 3) {
                Text(card.name)
                    .font(.headline)
                    .lineLimit(2)
                    .allowsTightening(true)
                Text("Closing \(card.closingDay) · Due \(card.dueDay)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 12)
            VStack(alignment: .trailing, spacing: 2) {
                Text("Limit")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(AppFormatting.currency(card.limit))
                    .font(.subheadline)
                    .monospacedDigit()
                    .minimumScaleFactor(0.8)
                    .lineLimit(2)
            }
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("\(card.name), closing day \(card.closingDay), due day \(card.dueDay), limit \(AppFormatting.currency(card.limit))"))
    }
}
