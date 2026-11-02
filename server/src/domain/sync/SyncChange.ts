// Immutable journal change events, commit groups and cursor boundaries
// (D016 D4/D5/D6, canon §12.3). Framework-free.
//
// Pull is commit-group atomic: every change event of one atomic financial
// operation shares `commitId`, occupies contiguous `seq` values and carries
// `commitIndex` (0-based) plus `commitSize`. A page returns complete groups
// only; a page cursor always names a group's last event.

import type {
  SyncEntityId,
  SyncEntityType,
  SyncHash,
  SyncRecord,
  SyncRevision,
  SyncSha256Hash,
} from './SyncRevision';

export const SYNC_CHANGE_KINDS = ['upsert', 'delete'] as const;
export type SyncChangeKind = (typeof SYNC_CHANGE_KINDS)[number];

export const SYNC_CHANGE_ORIGINS = [
  'station',
  'web',
  'job',
  'admin',
  'sync',
  'seed',
] as const;
export type SyncChangeOrigin = (typeof SYNC_CHANGE_ORIGINS)[number];

/** UUID shared by every event of one atomic financial commit. */
export type SyncCommitId = string;

/** Hard bound of entity events in one commit; a larger write is rejected. */
export const SYNC_MAX_COMMIT_EVENTS = 10_000;

/** Position of one event inside its commit. */
export interface SyncCommitIdentity {
  readonly commitId: SyncCommitId;
  /** 0-based index within the commit. */
  readonly commitIndex: number;
  /** Number of entity events in the commit; positive. */
  readonly commitSize: number;
}

/** One complete commit group as returned by pull or used by the client. */
export interface SyncCommitGroup {
  readonly commitId: SyncCommitId;
  readonly commitSize: number;
  readonly events: readonly SyncChangeEvent[];
}

export interface SyncChangeEvent extends SyncCommitIdentity {
  /** 1-based journal sequence; contiguous and immutable. */
  readonly seq: number;
  readonly kind: SyncChangeKind;
  readonly entityType: SyncEntityType;
  readonly entityId: SyncEntityId;
  readonly revision: SyncRevision;
  /** Complete server record after the change, or `null` for a delete. */
  readonly record: SyncRecord | null;
  readonly origin: SyncChangeOrigin;
  /** Present for station-originated changes; null/absent for web/job/admin. */
  readonly stationId?: string;
  /**
   * Present for accepted client operations; absent for backfill, seed and
   * non-station origins, which have no originating operation envelope.
   *
   * The absence is part of the type, not a storage accident: the chain hash
   * encodes a missing `opId` as JSON `null`, and a stored text column that was
   * never written reads back as the empty string, which is normalized to
   * absent before the hash is recomputed. A journal row the product itself
   * wrote can therefore never fail a handshake or pull read.
   */
  readonly opId?: string;
  readonly createdAt: string;
  /** Previous event's `chainHash`, or the empty genesis hash at seq 1. */
  readonly prevHash: SyncHash;
  readonly chainHash: SyncSha256Hash;
}

export interface SyncStoredChangeEvent extends SyncChangeEvent {
  /** Idempotency key for backfill rows, e.g. `backfill:<entityType>:<entityId>`. */
  readonly eventKey?: string;
}

// ---------------------------------------------------------------------------
// Chain hash
// ---------------------------------------------------------------------------

/**
 * Canonical `chainHash` input:
 * `"sha256:" + unpadded base64url(SHA-256(canonical JSON of
 * seq, commitId, commitIndex, commitSize, kind, entityType, entityId,
 * revision, recordHash, origin, stationId, opId, createdAt, prevHash))`.
 *
 * `recordHash` is the canonical record hash, or the empty genesis hash when
 * `record` is `null`. Absent optional `stationId`/`opId` are encoded as JSON
 * `null`, never omitted; `eventKey` is not hashed.
 */
export interface SyncChainHashInput {
  readonly seq: number;
  readonly commitId: SyncCommitId;
  readonly commitIndex: number;
  readonly commitSize: number;
  readonly kind: SyncChangeKind;
  readonly entityType: SyncEntityType;
  readonly entityId: SyncEntityId;
  readonly revision: SyncRevision;
  readonly recordHash: SyncHash;
  readonly origin: SyncChangeOrigin;
  readonly stationId: string | null;
  readonly opId: string | null;
  readonly createdAt: string;
  readonly prevHash: SyncHash;
}

export const SYNC_CHAIN_HASH_FIELDS = [
  'seq',
  'commitId',
  'commitIndex',
  'commitSize',
  'kind',
  'entityType',
  'entityId',
  'revision',
  'recordHash',
  'origin',
  'stationId',
  'opId',
  'createdAt',
  'prevHash',
] as const satisfies readonly (keyof SyncChainHashInput)[];

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

/** `seq` of the last event the client (or server head) has observed. */
export type SyncCursor = number;

/** Cursor before the first event; its hash is the empty genesis hash. */
export const SYNC_GENESIS_CURSOR: SyncCursor = 0;

/** A cursor paired with the `chainHash` of its event, checked by handshake. */
export interface SyncCursorCheckpoint {
  readonly cursor: SyncCursor;
  /** Empty string at cursor 0. */
  readonly cursorHash: SyncHash;
}

/**
 * True when an event ends its commit group and may therefore be a cursor.
 * A cursor that names an earlier event of a group is rejected by handshake and
 * pull with `CURSOR_NOT_ON_COMMIT_BOUNDARY`; it is never repaired silently.
 */
export function isCommitBoundary(
  event: Pick<SyncCommitIdentity, 'commitIndex' | 'commitSize'>
): boolean {
  return event.commitSize > 0 && event.commitIndex === event.commitSize - 1;
}
