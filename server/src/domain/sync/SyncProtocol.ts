// Complete sync wire contract: protocol bounds, station binding/state and the
// handshake, push, pull and seed shapes (D016 D4/D7/D8, canon §12.3).
// Framework-free: no Elysia, PocketBase or validator imports.
//
// Routes live under `/api/sync` and require the D009 session. Authentication
// failures stay HTTP 401. Request-level protocol, instance, epoch, rollback and
// cursor failures are HTTP 409 with a uniform `{ code, message }` body; a body
// or count over a bound is HTTP 413. Push returns HTTP 200 with per-operation
// results; HTTP 200 does not mean every operation applied.

import type { Account } from '../entities/Account';
import type { Card } from '../entities/Card';
import type { Category } from '../entities/Category';
import type { Invoice } from '../entities/Invoice';
import type { Project } from '../entities/Project';
import type { Recurrence } from '../entities/Recurrence';
import type { Transaction } from '../entities/Transaction';
import type {
  SyncChangeEvent,
  SyncCursor,
  SyncCursorCheckpoint,
} from './SyncChange';
import type {
  SyncOperationRejectionCode,
  SyncOperationResult,
  SyncOperationWire,
} from './SyncOperation';
import type {
  SyncEntityType,
  SyncHash,
  SyncSha256Hash,
} from './SyncRevision';

// ---------------------------------------------------------------------------
// Protocol constants and bounds
// ---------------------------------------------------------------------------

export const SYNC_PROTOCOL_VERSION = 1;
export const SYNC_PROTOCOL_MIN = 1;
export const SYNC_PROTOCOL_MAX = 1;

/** Push: at most 100 operations per request. */
export const SYNC_PUSH_MAX_OPERATIONS = 100;
/** Push: at most 1 MiB request body. */
export const SYNC_PUSH_MAX_BODY_BYTES = 1_048_576;
/** Push: at most 64 KiB serialized per operation. */
export const SYNC_OPERATION_MAX_BYTES = 65_536;

/** Pull `limit` is a target event count, never permission to split a commit. */
export const SYNC_PULL_LIMIT_MIN = 1;
export const SYNC_PULL_LIMIT_MAX = 500;
/**
 * Pull page byte cap over the serialized `events` array. A single commit that
 * cannot fit fails the request with `COMMIT_PAGE_TOO_LARGE`; the server never
 * splits a group. A page may contain up to `SYNC_MAX_COMMIT_EVENTS` events when
 * the first complete group exceeds `limit`.
 */
export const SYNC_PULL_MAX_PAGE_BYTES = 33_554_432;

/** Seed: one-time legacy snapshot bounds; one atomic commit group. */
export const SYNC_SEED_MAX_BYTES = 10_485_760;
export const SYNC_SEED_MAX_ROWS = 10_000;

/**
 * `POST /api/sync/import` (D7 snapshot import-as-new) shares the seed
 * bounds: the complete request body and the whole settled snapshot stay
 * under 10 MiB and 10,000 financial rows.
 */
export const SYNC_IMPORT_MAX_BYTES = SYNC_SEED_MAX_BYTES;
export const SYNC_IMPORT_MAX_ROWS = SYNC_SEED_MAX_ROWS;

/**
 * Exact hash input of the six-field import `payloadHash`
 * (`sha256:` + unpadded base64url over the canonical JSON of these fields,
 * in this order, excluding the transmitted `payloadHash` itself).
 */
export const SYNC_IMPORT_HASH_FIELDS = [
  'protocolVersion',
  'stationId',
  'serverInstanceId',
  'dataEpoch',
  'importId',
  'snapshot',
] as const;

export interface SyncImportHashInput {
  readonly protocolVersion: number;
  readonly stationId: SyncStationId;
  readonly serverInstanceId: SyncServerInstanceId;
  readonly dataEpoch: SyncDataEpoch;
  /** Durable UUIDv7; replayed imports must reuse the original one. */
  readonly importId: string;
  /** Complete settled seven-collection snapshot with fresh 15-char ids. */
  readonly snapshot: SyncSeedSnapshot;
}

export const SYNC_STATION_PLATFORMS = ['ios', 'macos', 'windows'] as const;
export type SyncStationPlatform = (typeof SYNC_STATION_PLATFORMS)[number];

export type SyncDataEpoch = number;
export type SyncServerInstanceId = string;
export type SyncStationId = string;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Lowercase hyphenated RFC 9562 UUID (any version), the station shape. */
export function isSyncUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Lowercase hyphenated UUIDv7, the opId/importId shape (D016 D2 rule 1). */
export function isSyncUuidV7(value: string): boolean {
  return UUID_V7_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Uniform errors
// ---------------------------------------------------------------------------

/** Request-level failures. These reject the whole request and write nothing. */
export type SyncWireErrorCode =
  | 'PROTOCOL_UNSUPPORTED'
  | 'STATION_NOT_REGISTERED'
  | 'SERVER_ROLLBACK_DETECTED'
  | 'DATA_EPOCH_CHANGED'
  | 'ENDPOINT_MISMATCH'
  | 'CURSOR_NOT_ON_COMMIT_BOUNDARY'
  | 'PAGE_INVALID'
  | 'COMMIT_PAGE_TOO_LARGE'
  | 'SERVER_NOT_EMPTY'
  | 'IMPORT_ID_REUSED'
  | 'IMPORT_ENTITY_ID_TAKEN'
  | 'REQUEST_TOO_LARGE';

/** Every stable code the sync surface may return: request and per operation. */
export type SyncErrorCode =
  | SyncWireErrorCode
  | SyncOperationRejectionCode
  | 'SYNC_CONFLICT'
  | 'DEPENDENCY_NOT_ACCEPTED';

export interface SyncErrorBody {
  readonly code: SyncErrorCode;
  readonly message: string;
}

/**
 * Uniform transport-independent protocol failure: the same `code` the wire
 * body carries plus the documented HTTP status (409 for identity, epoch,
 * rollback, cursor, seed/import, push-batch structural requests; 413 for a
 * body or count over a bound). Raised before any write can be observed and
 * never fused with per-operation outcomes.
 */
export class SyncProtocolRequestError extends Error {
  readonly code: SyncWireErrorCode;
  readonly httpStatus: number;

  constructor(code: SyncWireErrorCode, message: string, httpStatus: number = 409) {
    super(message);
    this.name = 'SyncProtocolRequestError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

// ---------------------------------------------------------------------------
// Server identity and station binding
// ---------------------------------------------------------------------------

export interface SyncServerIdentity {
  readonly serverInstanceId: SyncServerInstanceId;
  /** `sha256:` hash of the owner record id bytes; never the record id itself. */
  readonly ownerFingerprint: SyncSha256Hash;
  readonly protocolVersion: number;
  readonly protocolMin: number;
  readonly protocolMax: number;
  readonly dataEpoch: SyncDataEpoch;
  /** Lets the pairing wizard distinguish an empty server without a full pull. */
  readonly hasFinancialData: boolean;
  readonly serverName: string;
}

/**
 * The local store is bound to this tuple. A different instance id or owner
 * fingerprint is `ENDPOINT_MISMATCH`; a URL that resolves to the same pair is
 * allowed. A station id is a durable installation, never a session or device
 * name.
 */
export interface SyncStationBinding {
  readonly serverUrl: string;
  readonly serverInstanceId: SyncServerInstanceId;
  readonly ownerFingerprint: SyncSha256Hash;
  readonly stationId: SyncStationId;
}

export type SyncStationMode = 'standalone' | 'station';

/** Server station registry row (`obol_sync_stations`). */
export interface SyncStationRegistration {
  readonly stationId: SyncStationId;
  readonly deviceLabel: string;
  readonly platform: SyncStationPlatform;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  /** Last cursor reported by the station; always a commit boundary. */
  readonly lastCursor: SyncCursor;
}

/**
 * `obol_station_state` (desktop local) / iOS `sync_state`. In `standalone`
 * mode the binding fields are empty strings and `mode` is the only meaningful
 * switch until the user pairs.
 */
export interface SyncStationState extends SyncStationBinding {
  /** Always a commit boundary. */
  readonly cursor: SyncCursor;
  readonly lastChainHash: SyncHash;
  readonly dataEpoch: SyncDataEpoch;
  readonly protocolVersion: number;
  readonly mode: SyncStationMode;
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

/**
 * First handshake omits `serverInstanceId`, `dataEpoch`, `clientCursor` and
 * `clientCursorHash` (or sends `null`). A later handshake sends the stored
 * values so the server can detect endpoint drift and rollback.
 */
export interface SyncHandshakeRequest {
  readonly protocolVersion: number;
  readonly stationId: SyncStationId;
  readonly platform: SyncStationPlatform;
  readonly deviceLabel: string;
  /** Must name a commit boundary; a mid-group cursor is rejected. */
  readonly clientCursor: SyncCursor | null;
  readonly clientCursorHash: SyncHash | null;
  readonly dataEpoch: SyncDataEpoch | null;
  readonly serverInstanceId: SyncServerInstanceId | null;
}

/**
 * `cursor` is the last written event, which always ends a commit group.
 * `cursorHash` is that event's `chainHash`, or the empty string at cursor 0.
 */
export interface SyncHandshakeResponse
  extends SyncServerIdentity,
    SyncCursorCheckpoint {
  readonly headHash: SyncHash;
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

export interface SyncPushRequest {
  readonly protocolVersion: number;
  readonly stationId: SyncStationId;
  readonly serverInstanceId: SyncServerInstanceId;
  readonly dataEpoch: SyncDataEpoch;
  /** Applied in array order, at most `SYNC_PUSH_MAX_OPERATIONS`. */
  readonly ops: readonly SyncOperationWire[];
}

/**
 * Per-operation results in request order. `cursor` is informational: a client
 * advances its stored cursor only through pull.
 */
export interface SyncPushResponse {
  readonly serverInstanceId: SyncServerInstanceId;
  readonly dataEpoch: SyncDataEpoch;
  readonly cursor: SyncCursor;
  readonly results: readonly SyncOperationResult[];
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

export interface SyncPullQuery {
  readonly cursor: SyncCursor;
  /** Target event count in 1..500; complete commit groups may exceed it. */
  readonly limit: number;
}

export interface SyncPullResponse {
  readonly serverInstanceId: SyncServerInstanceId;
  readonly dataEpoch: SyncDataEpoch;
  /** Complete commit groups only, contiguous `seq`, bounded by the page cap. */
  readonly events: readonly SyncChangeEvent[];
  /** `seq` of the last event of the last complete group returned. */
  readonly nextCursor: SyncCursor;
  readonly hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/** Complete 0.3.0 snapshot; ids and relations are preserved, nothing recomputed. */
export interface SyncSeedSnapshot {
  readonly accounts: readonly Account[];
  readonly cards: readonly Card[];
  readonly categories: readonly Category[];
  readonly projects: readonly Project[];
  readonly recurrences: readonly Recurrence[];
  readonly invoices: readonly Invoice[];
  readonly transactions: readonly Transaction[];
}

/**
 * One-time migration of a legacy database with no operation log. Refused with
 * `SERVER_NOT_EMPTY` unless the server has no financial rows and no journal
 * events beyond the backfill marker. Not an operation; no `opId`.
 */
export interface SyncSeedRequest {
  readonly protocolVersion: number;
  readonly stationId: SyncStationId;
  readonly serverInstanceId: SyncServerInstanceId;
  readonly dataEpoch: SyncDataEpoch;
  readonly snapshot: SyncSeedSnapshot;
}

export interface SyncSeedResponse {
  readonly serverInstanceId: SyncServerInstanceId;
  readonly dataEpoch: SyncDataEpoch;
  /** New cursor after the single seed commit, on a commit boundary. */
  readonly cursor: SyncCursor;
  readonly counts: Readonly<Record<SyncEntityType, number>>;
}

// ---------------------------------------------------------------------------
// Import (D7 snapshot import-as-new)
// ---------------------------------------------------------------------------

/**
 * First-pairing transfer of a never-paired standalone profile into an
 * already-populated server. Not an operation; no `opId`. The complete request
 * hash covers exactly the six `SYNC_IMPORT_HASH_FIELDS`; the transmitted
 * `payloadHash` itself is never hashed and never exceeds 50 characters in
 * storage. Retries of one accepted import replay the stored original result
 * (`importId` receipt in `obol_sync_snapshot_imports`); a different snapshot
 * under a stored `importId` is `IMPORT_ID_REUSED`, and any id collision with
 * existing finance rows is `IMPORT_ENTITY_ID_TAKEN` — both are 409s rejected
 * before any write.
 */
export interface SyncImportRequest extends SyncImportHashInput {
  readonly payloadHash: SyncSha256Hash;
}

export interface SyncImportResponse {
  readonly serverInstanceId: SyncServerInstanceId;
  readonly dataEpoch: SyncDataEpoch;
  /** New cursor after the single import commit, on a commit boundary. */
  readonly cursor: SyncCursor;
  readonly counts: Readonly<Record<SyncEntityType, number>>;
  readonly importId: string;
}
