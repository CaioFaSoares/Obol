// Framework-free application ports for the D016 sync surface (E007 sync API
// slice). The policies in `application/use-cases/sync` depend only on these
// interfaces and domain sync types. Every adapter lives under
// `infrastructure/` and binds the ports to the shared `FinancialMutationRuntime`,
// the FIFO `MutationCoordinator` and PocketBase.
//
// Forbidden imports here: Elysia, PocketBase, awilix, or any
// `infrastructure/*` module. The ports deliberately mention neither HTTP nor
// PocketBase collection names.

import type {
  SyncChangeEvent,
  SyncCursor,
} from '../../../domain/sync/SyncChange';
import type {
  SyncOperationResult,
  SyncOperationWire,
} from '../../../domain/sync/SyncOperation';
import type {
  SyncEntityType,
  SyncHash,
  SyncSha256Hash,
} from '../../../domain/sync/SyncRevision';
import type {
  SyncDataEpoch,
  SyncServerInstanceId,
  SyncSeedSnapshot,
  SyncStationId,
  SyncStationPlatform,
} from '../../../domain/sync/SyncProtocol';

// ---------------------------------------------------------------------------
// Server ledger and identity
// ---------------------------------------------------------------------------

/** Committed singleton ledger state (`obol_sync_meta`), read-only view. */
export interface SyncLedgerView {
  readonly serverInstanceId: SyncServerInstanceId;
  readonly dataEpoch: SyncDataEpoch;
  readonly protocolMin: number;
  readonly protocolMax: number;
  /** `seq` of the last written event; always a commit boundary. */
  readonly lastSeq: SyncCursor;
  /** `chainHash` of the last written event (empty string at seq 0). */
  readonly headHash: SyncHash;
}

/** Minimum event projection the handshake uses to validate a cursor. */
export interface SyncCursorEventView {
  readonly chainHash: SyncHash;
  readonly commitIndex: number;
  readonly commitSize: number;
}

/** Everything the sync policies need to know about the deployment. */
export interface SyncServerStateView {
  /** Committed ledger singleton, or `null` before central initialization. */
  readLedger(): Promise<SyncLedgerView | null>;
  /** `sha256:` + unpadded base64url over the owner record id bytes. */
  ownerFingerprint(): Promise<SyncSha256Hash>;
  /** Deployment display name served by the handshake. */
  serverName(): string;
  /** One registered station row, or `null` when unknown. */
  readStation(stationId: SyncStationId): Promise<SyncStationRegistrationView | null>;
  /** Committed event at one exact `seq`, or `null` when unseen. */
  readCursorEvent(seq: SyncCursor): Promise<SyncCursorEventView | null>;
  /** Per-entity finance row counts; keys are singular entity types. */
  financeRowCounts(): Promise<Readonly<Record<SyncEntityType, number>>>;
}

export interface SyncStationRegistrationView {
  readonly stationId: SyncStationId;
  readonly deviceLabel: string | null;
  readonly platform: SyncStationPlatform | null;
  readonly lastCursor: SyncCursor | null;
}

// ---------------------------------------------------------------------------
// Station registration (handshake)
// ---------------------------------------------------------------------------

export interface SyncStationRegistrationInput {
  readonly stationId: SyncStationId;
  readonly platform: SyncStationPlatform;
  readonly deviceLabel: string;
  /** Server clock ISO timestamp of this handshake. */
  readonly at: string;
  /**
   * The station's own reported cursor, or `null` until it has one. Stored for
   * diagnostics only; the server never pushes from it.
   */
  readonly lastCursor: SyncCursor | null;
}

/**
 * Registers or refreshes one durable station installation inside the shared
 * FIFO gate (metadata write only, never a financial effect).
 */
export interface SyncStationRegistry {
  register(input: SyncStationRegistrationInput): Promise<void>;
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

/** One page of the journal: complete commit groups only (D016 D4 pull). */
export interface SyncPullPage {
  readonly serverInstanceId: SyncServerInstanceId;
  readonly dataEpoch: SyncDataEpoch;
  readonly events: readonly SyncChangeEvent[];
  /** `seq` of the last event of the last complete group returned. */
  readonly nextCursor: SyncCursor;
  readonly hasMore: boolean;
}

export interface SyncEventPageReader {
  /**
   * Reads the next page as ordered complete commit groups. Cursor, limit and
   * page bound failures raise `SyncProtocolRequestError`; journal cursor drift
   * and a stored chain that no longer verifies report
   * `SERVER_ROLLBACK_DETECTED`.
   */
  pullPage(query: {
    readonly cursor: SyncCursor;
    readonly limit: number;
  }): Promise<SyncPullPage>;
}

// ---------------------------------------------------------------------------
// Push batch
// ---------------------------------------------------------------------------

export interface SyncPushBatch {
  readonly protocolVersion: number;
  readonly stationId: SyncStationId;
  readonly ops: readonly SyncOperationWire[];
}

export interface SyncBatchResult {
  readonly serverInstanceId: SyncServerInstanceId;
  readonly dataEpoch: SyncDataEpoch;
  /** Current journal head after the batch; informational for clients. */
  readonly cursor: SyncCursor;
  /** Per-operation results, in request order. */
  readonly results: readonly SyncOperationResult[];
}

/**
 * Applies one ordered push batch under one exclusive lease with independent
 * per-operation commits. Ordering, dependency blocking, idempotency, conflict
 * and coverage policy live in the adapter and its operation executor.
 */
export interface SyncPushGateway {
  push(batch: SyncPushBatch): Promise<SyncBatchResult>;
}

// ---------------------------------------------------------------------------
// Seed and import snapshots
// ---------------------------------------------------------------------------

export interface SyncSnapshotResult {
  readonly serverInstanceId: SyncServerInstanceId;
  readonly dataEpoch: SyncDataEpoch;
  /** New cursor after the single snapshot commit, on a commit boundary. */
  readonly cursor: SyncCursor;
  /** Imported/seeded row counts; keys are singular entity types. */
  readonly counts: Readonly<Record<SyncEntityType, number>>;
}

export interface SyncSeedGatewayInput {
  readonly protocolVersion: number;
  readonly stationId: SyncStationId;
  readonly serverInstanceId: SyncServerInstanceId;
  readonly dataEpoch: SyncDataEpoch;
  readonly snapshot: SyncSeedSnapshot;
}

/** One-time empty-server seed (D016 D4 seed). Refused atomically otherwise. */
export interface SyncSeedGateway {
  seed(input: SyncSeedGatewayInput): Promise<SyncSnapshotResult>;
}

export interface SyncImportGatewayInput {
  readonly protocolVersion: number;
  readonly stationId: SyncStationId;
  readonly serverInstanceId: SyncServerInstanceId;
  readonly dataEpoch: SyncDataEpoch;
  /** Durable UUIDv7 kept across retries of one import. */
  readonly importId: string;
  readonly snapshot: SyncSeedSnapshot;
  /** Recomputed six-field envelope hash (`sha256:` + 43 base64url chars). */
  readonly payloadHash: SyncSha256Hash;
}

export interface SyncImportResult extends SyncSnapshotResult {
  readonly importId: string;
}

/**
 * Writes one receipt-guarded, permanently immutable snapshot import (D7
 * import-as-new). Same `importId` + hash + station + identity replays the
 * stored original result without any write; different frozen content is
 * `IMPORT_ID_REUSED`; any id collision is `IMPORT_ENTITY_ID_TAKEN` — both
 * rejected before any write. All finance inserts, revision-1 rows, the
 * journal commit and the receipt land in ONE actual PB transaction.
 */
export interface SyncImportGateway {
  import(input: SyncImportGatewayInput): Promise<SyncImportResult>;
}
