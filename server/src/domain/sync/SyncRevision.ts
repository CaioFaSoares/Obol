// Entity identity, collection mapping and revision records for
// server-authoritative synchronization (canon §12, D016 D3/D8).
//
// Framework-free: this module has no imports and may be consumed by domain,
// application, infrastructure and the native clients' contract. Collection
// names stay plural because PocketBase keeps them plural; entity type names
// stay singular on the wire and in every revision key.

/** Canonical entity type names used by the sync protocol. */
export const SYNC_ENTITY_TYPES = [
  'account',
  'card',
  'category',
  'invoice',
  'project',
  'recurrence',
  'transaction',
] as const;

export type SyncEntityType = (typeof SYNC_ENTITY_TYPES)[number];

/** Singular entity type -> plural PocketBase collection. */
export const SYNC_COLLECTIONS = {
  account: 'accounts',
  card: 'cards',
  category: 'categories',
  invoice: 'invoices',
  project: 'projects',
  recurrence: 'recurrences',
  transaction: 'transactions',
} as const satisfies Readonly<Record<SyncEntityType, string>>;

export type SyncCollectionName = (typeof SYNC_COLLECTIONS)[SyncEntityType];

export function isSyncEntityType(value: string): value is SyncEntityType {
  return (SYNC_ENTITY_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// JSON values and records
// ---------------------------------------------------------------------------

/**
 * JSON value accepted by canonical JSON hashing. Numbers must be finite
 * (decimals are emitted with the platform's shortest round-trip form and
 * negative zero as `0`); `undefined`, functions, bigints and class instances
 * are not representable.
 */
export type SyncJsonValue =
  | string
  | number
  | boolean
  | null
  | SyncJsonObject
  | readonly SyncJsonValue[];

export interface SyncJsonObject {
  readonly [key: string]: SyncJsonValue;
}

/** Complete server record after a change, as stored in a change event. */
export type SyncRecord = SyncJsonObject;

/**
 * `sha256:` + unpadded base64url(SHA-256(bytes)) for every non-empty hash on
 * the wire and in storage.
 */
export type SyncSha256Hash = `sha256:${string}`;

/** The empty genesis hash used before the first journal event. */
export type SyncGenesisHash = '';

export type SyncHash = SyncSha256Hash | SyncGenesisHash;

export const SYNC_HASH_PREFIX = 'sha256:';
export const SYNC_GENESIS_HASH: SyncGenesisHash = '';

// ---------------------------------------------------------------------------
// Entity identity
// ---------------------------------------------------------------------------

/**
 * 15-character lowercase alphanumeric PocketBase-compatible record id. A
 * client generates it for creates and reuses the server id for existing rows.
 */
export type SyncEntityId = string;

export const SYNC_ENTITY_ID_LENGTH = 15;
export const SYNC_ENTITY_ID_PATTERN = '^[a-z0-9]{15}$';

const SYNC_ENTITY_ID_REGEXP = new RegExp(SYNC_ENTITY_ID_PATTERN);

export function isSyncEntityId(value: string): boolean {
  return SYNC_ENTITY_ID_REGEXP.test(value);
}

export interface SyncEntityRef {
  readonly entityType: SyncEntityType;
  readonly entityId: SyncEntityId;
}

// ---------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------

/** Monotonic integer revision of one entity. */
export type SyncRevision = number;

/** A create starts at revision 1; update and delete are current + 1. */
export const SYNC_INITIAL_REVISION: SyncRevision = 1;

/** `entityType:entityId`, the key of `baseRevisions` and version rows. */
export type SyncRevisionKey = `${SyncEntityType}:${SyncEntityId}`;

export function syncRevisionKey(
  entityType: SyncEntityType,
  entityId: SyncEntityId
): SyncRevisionKey {
  return `${entityType}:${entityId}`;
}

export function parseSyncRevisionKey(key: string): SyncEntityRef | null {
  const separator = key.indexOf(':');
  if (separator <= 0) return null;

  const entityType = key.slice(0, separator);
  const entityId = key.slice(separator + 1);
  if (!isSyncEntityType(entityType) || !isSyncEntityId(entityId)) return null;

  return { entityType, entityId };
}

/**
 * Revisions the client observed for existing entities the operation may write.
 * A create declares no entry for the created entity. Declared entries the
 * operation does not write are ignored and do not conflict.
 *
 * Sole exception: an invoice created or found by `SyncInvoiceUseCase` for a
 * card purchase or recurrence launch is an additive `(card_id, period)` delta
 * and needs no base revision. A concurrent payment or deletion still declares
 * the invoice revision and conflicts normally.
 */
export type SyncBaseRevisions = Readonly<
  Partial<Record<SyncRevisionKey, SyncRevision>>
>;

export interface SyncEntityVersionRef extends SyncEntityRef {
  readonly revision: SyncRevision;
}

/** Server revision row (`obol_sync_entity_versions`). */
export interface SyncEntityVersion extends SyncEntityVersionRef {
  readonly deleted: boolean;
  readonly lastSeq: number;
}

/** Client-local version row (`obol_station_versions` / iOS `sync_versions`). */
export interface SyncStationEntityVersion extends SyncEntityRef {
  readonly serverRevision: SyncRevision;
  readonly localRevision: SyncRevision;
  readonly deleted: boolean;
}

/**
 * One entity the unit of work actually wrote in a commit, after revision
 * assignment. `existed` is false for a create. Used for the hard
 * `UNCOVERED_WRITE` check against `baseRevisions`.
 */
export interface SyncWriteSetEntry extends SyncEntityVersionRef {
  readonly existed: boolean;
  readonly deleted: boolean;
}
