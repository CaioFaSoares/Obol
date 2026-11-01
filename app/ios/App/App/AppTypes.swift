import Foundation

// Root-owned presentation values shared by every native feature.
//
// Nothing here carries a bearer token, password, or account credential:
// those stay inside the Core session/keychain layer. Feature views read
// these values through the injected AppState and never derive finance
// themselves.

/// The five top-level native destinations of Obol 0.4.
public enum AppTab: String, CaseIterable, Identifiable, Sendable {
    case dashboard
    case ledger
    case cards
    case management
    case settings

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .dashboard: return "Dashboard"
        case .ledger: return "Transactions"
        case .cards: return "Cards"
        case .management: return "Manage"
        case .settings: return "Settings"
        }
    }
}

/// One honest description of the synchronization surface.
///
/// `phase` is the only state a badge or banner may render; counts are the
/// authoritative local queue facts. An absent store still starts as
/// `standalone`, never as a fabricated "up to date".
public struct SyncPresentation: Equatable, Sendable {
    public enum Phase: Equatable, Sendable {
        /// No server binding: every change is stored and queued locally.
        case standalone
        /// The last bounded cycle failed on the network path; data is intact.
        case offline
        /// A bounded foreground cycle is currently running.
        case syncing
        /// The binding is healthy and no unresolved local operation remains.
        case upToDate
        /// The server rejected the stored session; re-authentication is
        /// required, while local finance stays fully usable.
        case authRequired
        /// At least one intent needs an explicit conflict decision.
        case conflict
        /// The last cycle failed for a reason that needs user attention.
        case error
        /// The binding or store reported a typed stop; no automatic repair.
        case blocked
    }

    public var phase: Phase
    public var isPaired: Bool
    public var pendingCount: Int
    public var conflictCount: Int
    public var lastSyncAt: Date?
    public var detail: String?
    public var serverName: String?

    public init(
        phase: Phase,
        isPaired: Bool,
        pendingCount: Int,
        conflictCount: Int,
        lastSyncAt: Date? = nil,
        detail: String? = nil,
        serverName: String? = nil
    ) {
        self.phase = phase
        self.isPaired = isPaired
        self.pendingCount = pendingCount
        self.conflictCount = conflictCount
        self.lastSyncAt = lastSyncAt
        self.detail = detail
        self.serverName = serverName
    }
}

/// A pairing-matrix action. The root derives the offered set from the live
/// server handshake and the local store facts; a view renders only what is
/// present and never decides protocol validity.
public enum PairingAction: String, CaseIterable, Identifiable, Sendable {
    case resume
    case useServerData
    case importLocalData
    case seedEmptyServer
    case stayLocal

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .resume:
            return "Resume this device's station"
        case .useServerData:
            return "Replace this device with the server data"
        case .importLocalData:
            return "Import this device"
        case .seedEmptyServer:
            return "Seed the empty server"
        case .stayLocal:
            return "Stay standalone"
        }
    }

    /// Only a replacement discards local financial data.
    public var isDestructive: Bool { self == .useServerData }
}

/// The preview of a scanned server plus the locally computed decision facts.
/// It contains no token and no password; the ephemeral session stays private
/// to `AppState` until a decision is confirmed or canceled.
public struct PairingPreview: Equatable, Sendable {
    public let serverName: String
    public let serverAddress: String
    public let hasServerData: Bool
    public let localEntityCount: Int
    public let localOperationCount: Int
    public let isRePairing: Bool
    public let actions: [PairingAction]
    public let warnings: [String]

    /// Both the ledger rows and the queued intents count as local data.
    public var hasLocalData: Bool {
        localEntityCount > 0 || localOperationCount > 0
    }

    public init(
        serverName: String,
        serverAddress: String,
        hasServerData: Bool,
        localEntityCount: Int,
        localOperationCount: Int,
        isRePairing: Bool,
        actions: [PairingAction],
        warnings: [String]
    ) {
        self.serverName = serverName
        self.serverAddress = serverAddress
        self.hasServerData = hasServerData
        self.localEntityCount = localEntityCount
        self.localOperationCount = localOperationCount
        self.isRePairing = isRePairing
        self.actions = actions
        self.warnings = warnings
    }
}
