// Pure station-replica contract for the desktop standalone/station runtime
// (D016 D7/D11, canon §12.2/§12.4, desktop offline station contract).
//
// This module owns only framework-free types and deterministic plans shared
// by the desktop station engine and the PocketBase replica repository:
//
// - the coherent pre-network import checkpoint stored in
//   `obol_station_state.pendingImport` (frozen six-field request, id remap,
//   covered local operation ids, identity tuple, previous binding);
// - the complete seven-collection settled snapshot shape and its id/remap
//   rules (fresh 15-character ids, every reference rewritten);
// - the durable outbox/conflict projections the replica reads back;
// - pure dependency/eligibility planning for bounded push batches, including
//   the "dependencies accepted before send" rule and the never-split commit
//   group validation used for pull pages.
//
// No hashing lives here: every hash uses the single canonical implementation
// in `infrastructure/sync/CanonicalJson.ts`. No PocketBase, Elysia, Awilix or
// infrastructure type is imported. No business rule is recomputed: the
// existing scoped use cases own every financial effect.

import type {
  SyncChangeEvent,
  SyncCommitGroup,
  SyncCursor,
} from './SyncChange';
import {
  SYNC_OPERATION_ENTITY_TYPES,
  SYNC_OPERATION_TYPES,
  type SyncEntitySnapshot,
  type SyncOperationType,
  type SyncOperationWire,
  type SyncOutboxStatus,
} from './SyncOperation';
import type {
  SyncEntityId,
  SyncEntityType,
  SyncHash,
  SyncJsonObject,
  SyncRevision,
  SyncSha256Hash,
} from './SyncRevision';
import {
  SYNC_COLLECTIONS,
  SYNC_ENTITY_TYPES,
  isSyncEntityId,
  isSyncEntityType,
} from './SyncRevision';
import {
  SYNC_IMPORT_MAX_ROWS,
  SYNC_OPERATION_MAX_BYTES,
  SYNC_PROTOCOL_VERSION,
  SYNC_PULL_MAX_PAGE_BYTES,
  SYNC_PUSH_MAX_BODY_BYTES,
  SYNC_PUSH_MAX_OPERATIONS,
  isSyncUuid,
  isSyncUuidV7,
  type SyncDataEpoch,
  type SyncSeedSnapshot,
  type SyncServerInstanceId,
  type SyncStationId,
  type SyncStationMode,
} from './SyncProtocol';
import { SYNC_MAX_COMMIT_EVENTS } from './SyncChange';

// ---------------------------------------------------------------------------
// Bounds (shared with the wire contract)
// ---------------------------------------------------------------------------

/** Maximum serialized import checkpoint accepted by `pendingImport`. */
export const STATION_PENDING_IMPORT_MAX_BYTES = 12 * 1024 * 1024;
/** Complete import/seeding request bound (D7). */
export const STATION_IMPORT_REQUEST_MAX_BYTES = 10 * 1024 * 1024;
/** Financial-row bound of one import/seed snapshot. */
export const STATION_IMPORT_MAX_ROWS = SYNC_IMPORT_MAX_ROWS;
/** Target pull page size; complete commit groups may exceed it. */
export const STATION_PULL_LIMIT = 200;
/** Pull page byte cap mirrored from the server contract. */
export const STATION_PULL_MAX_PAGE_BYTES = SYNC_PULL_MAX_PAGE_BYTES;
/** Push batch bounds mirrored from the server contract. */
export const STATION_PUSH_MAX_OPERATIONS = SYNC_PUSH_MAX_OPERATIONS;
export const STATION_PUSH_MAX_BODY_BYTES = SYNC_PUSH_MAX_BODY_BYTES;
export const STATION_OPERATION_MAX_BYTES = SYNC_OPERATION_MAX_BYTES;
/** One station commit group is never larger than this many entity events. */
export const STATION_MAX_COMMIT_EVENTS = SYNC_MAX_COMMIT_EVENTS;
/** Protocol version this desktop build speaks. */
export const STATION_PROTOCOL_VERSION = SYNC_PROTOCOL_VERSION;
/** Version of the persisted checkpoint JSON shape. */
export const STATION_PENDING_IMPORT_VERSION = 1;

// ---------------------------------------------------------------------------
// Snapshot identity and remapping
// ---------------------------------------------------------------------------

/** Old local id -> fresh id, per entity type. */
export type StationIdMap = Readonly<
  Record<SyncEntityType, Readonly<Record<string, string>>>
>;

/**
 * Relation fields per entity type, in the stored (PocketBase) names, that must
 * be rewritten by an import remap. `source_invoice_id` is accepted when a
 * deployment still stores it even though the current financial schema does not
 * declare it; an absent field is simply skipped.
 */
export const STATION_SNAPSHOT_REFERENCE_FIELDS: Readonly<
  Record<SyncEntityType, readonly string[]>
> = {
  account: [],
  card: [],
  category: [],
  invoice: ['card_id'],
  project: [],
  recurrence: ['account_id', 'card_id', 'category_id'],
  transaction: [
    'account_id',
    'card_id',
    'category_id',
    'project_id',
    'destination_account_id',
    'invoice_id',
    'recurrence_id',
    'source_invoice_id',
  ],
};

/** Target entity type of each snapshot relation field. */
const REFERENCE_TARGETS: Readonly<Record<string, SyncEntityType>> = {
  account_id: 'account',
  card_id: 'card',
  category_id: 'category',
  project_id: 'project',
  destination_account_id: 'account',
  invoice_id: 'invoice',
  recurrence_id: 'recurrence',
  source_invoice_id: 'invoice',
};

/**
 * Every field a settled snapshot row may carry (the server's snapshot
 * validator rejects unknown fields). The native models encode the optional
 * `created`/`updated` audit dates and migration 1700000024 stores them as
 * applicable `date` columns, so they travel with a snapshot (export, remap and
 * import) instead of being dropped as storage metadata.
 */
export const STATION_SNAPSHOT_FIELDS: Readonly<
  Record<SyncEntityType, readonly string[]>
> = {
  account: ['id', 'name', 'type', 'initial_balance', 'created', 'updated'],
  card: ['id', 'name', 'closing_day', 'due_day', 'limit', 'created', 'updated'],
  category: ['id', 'name', 'type', 'monthly_budget', 'created', 'updated'],
  invoice: [
    'id',
    'card_id',
    'period',
    'due_date',
    'status',
    'total_amount',
    'paid_amount',
    'created',
    'updated',
  ],
  project: ['id', 'name', 'total_value', 'status', 'created', 'updated'],
  recurrence: [
    'id',
    'name',
    'amount',
    'payday',
    'type',
    'status',
    'frequency',
    'weekday',
    'account_id',
    'card_id',
    'category_id',
    'end_date',
    'total_installments',
    'skipped_periods',
    'created',
    'updated',
  ],
  transaction: [
    'id',
    'title',
    'amount',
    'type',
    'status',
    'expected_date',
    'realized_date',
    'purchase_date',
    'is_recurring',
    'is_silent',
    'is_simulated',
    'is_scheduled',
    'account_id',
    'card_id',
    'category_id',
    'project_id',
    'destination_account_id',
    'invoice_id',
    'recurrence_id',
    'created',
    'updated',
  ],
};

/**
 * Copies only the declared snapshot fields of one stored row. Present values
 * (including the empty string PocketBase stores for an unset field) are kept
 * verbatim; storage metadata never enters.
 */
export function stationSnapshotRow(
  entityType: SyncEntityType,
  stored: Record<string, unknown>,
): SyncJsonObject {
  const row: Record<string, unknown> = {};
  for (const field of STATION_SNAPSHOT_FIELDS[entityType]) {
    if (!(field in stored)) continue;
    const value = stored[field];
    // PocketBase stores an unset date as the empty string. A snapshot row
    // never carries a blank audit timestamp: absent and null are the same
    // thing to every consumer, and an empty string is not an instant.
    if (
      (field === 'created' || field === 'updated') &&
      typeof value === 'string' &&
      value.trim().length === 0
    ) {
      continue;
    }
    row[field] = value;
  }
  // The picked values are the stored JSON scalars/arrays of a finance row.
  const snapshotRow = row as unknown as SyncJsonObject;
  return snapshotRow;
}

/** Structural snapshot problem; the caller reports it without mutating data. */
export class StationSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StationSnapshotError';
  }
}

/** ID source injected by infrastructure (`newSyncEntityId`). */
export type StationEntityIdFactory = () => string;

/**
 * Runtime guard for a JSON object read from a stored snapshot or a persisted
 * checkpoint. The returned record is the validated object itself; every caller
 * still checks each field it reads.
 */
function recordOf(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StationSnapshotError(`${context} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

/** Rows of one snapshot collection, validated as a JSON array. */
function snapshotRowsOf(
  snapshot: unknown,
  collection: string,
): readonly unknown[] {
  const box = recordOf(snapshot, 'A snapshot');
  const rows = box[collection];
  if (!Array.isArray(rows)) {
    throw new StationSnapshotError(`Snapshot "${collection}" must be an array.`);
  }
  return rows;
}

/** Total financial rows across the seven collections of a typed snapshot. */
export function stationSnapshotRowCount(snapshot: SyncSeedSnapshot): number {
  let total = 0;
  for (const entityType of SYNC_ENTITY_TYPES) {
    total += snapshot[SYNC_COLLECTIONS[entityType]].length;
  }
  return total;
}

/**
 * Validates the local snapshot shape before a checkpoint is frozen: the seven
 * collections exist, every id is a 15-character lowercase id unique inside its
 * collection, and every declared relation resolves inside the snapshot. This
 * is client-side preflight only; the server revalidates the frozen request.
 * Accepts `unknown` so a persisted checkpoint is validated as parsed JSON
 * before it is trusted.
 */
export function validateStationSnapshot(snapshot: unknown): void {
  const ids = new Map<SyncEntityType, Set<string>>();
  let total = 0;
  for (const entityType of SYNC_ENTITY_TYPES) {
    const collection = SYNC_COLLECTIONS[entityType];
    const rows = snapshotRowsOf(snapshot, collection);
    total += rows.length;
    const seen = new Set<string>();
    for (const row of rows) {
      const box = recordOf(row, `Snapshot "${collection}" row`);
      const id = box['id'];
      if (typeof id !== 'string' || !isSyncEntityId(id)) {
        throw new StationSnapshotError(
          `Snapshot "${collection}" contains a row without a 15-character lowercase id.`,
        );
      }
      if (seen.has(id)) {
        throw new StationSnapshotError(
          `Snapshot "${collection}" repeats the row id "${id}".`,
        );
      }
      seen.add(id);
    }
    ids.set(entityType, seen);
  }

  if (total > STATION_IMPORT_MAX_ROWS) {
    throw new StationSnapshotError(
      `The snapshot carries more than ${STATION_IMPORT_MAX_ROWS} rows.`,
    );
  }

  for (const entityType of SYNC_ENTITY_TYPES) {
    const collection = SYNC_COLLECTIONS[entityType];
    const referenceFields = STATION_SNAPSHOT_REFERENCE_FIELDS[entityType];
    for (const row of snapshotRowsOf(snapshot, collection)) {
      const box = recordOf(row, `Snapshot "${collection}" row`);
      for (const field of referenceFields) {
        const value = box[field];
        if (typeof value !== 'string' || value.length === 0) continue;
        const targetType = REFERENCE_TARGETS[field];
        if (targetType === undefined) continue;
        if (!ids.get(targetType)?.has(value)) {
          throw new StationSnapshotError(
            `Snapshot "${collection}" row "${String(box['id'])}" references the missing ${field} "${value}".`,
          );
        }
      }
    }
  }
}

/** Mints one fresh id for every row of the snapshot. */
export function buildStationIdMap(
  snapshot: SyncSeedSnapshot,
  mint: StationEntityIdFactory,
): { readonly idMap: { [K in SyncEntityType]: Record<string, string> }; readonly snapshot: SyncSeedSnapshot } {
  const idMap: { [K in SyncEntityType]: Record<string, string> } = {
    account: {},
    card: {},
    category: {},
    invoice: {},
    project: {},
    recurrence: {},
    transaction: {},
  };
  const used = new Set<string>();

  for (const entityType of SYNC_ENTITY_TYPES) {
    const collection = SYNC_COLLECTIONS[entityType];
    const mapping = idMap[entityType];
    for (const row of snapshot[collection]) {
      const oldId = recordOf(row, `${collection} row`)['id'];
      if (typeof oldId !== 'string') {
        throw new StationSnapshotError(
          `Snapshot "${collection}" contains a row without an id.`,
        );
      }
      let fresh = mint();
      if (!isSyncEntityId(fresh)) {
        throw new StationSnapshotError('The id factory returned an invalid entity id.');
      }
      while (used.has(fresh)) {
        fresh = mint();
        if (!isSyncEntityId(fresh)) {
          throw new StationSnapshotError('The id factory returned an invalid entity id.');
        }
      }
      used.add(fresh);
      mapping[oldId] = fresh;
    }
  }

  return {
    idMap,
    snapshot: remapStationSnapshot(snapshot, idMap),
  };
}

/**
 * Applies the frozen id map to every row id and every declared reference.
 * Values are copied; nothing is recomputed, deduplicated or converted.
 */
export function remapStationSnapshot(
  snapshot: SyncSeedSnapshot,
  idMap: StationIdMap,
): SyncSeedSnapshot {
  const result: Record<string, readonly SyncJsonObject[]> = {};
  for (const entityType of SYNC_ENTITY_TYPES) {
    const collection = SYNC_COLLECTIONS[entityType];
    const mapping = idMap[entityType];
    result[collection] = snapshot[collection].map((row) => {
      const source = recordOf(row, `${collection} row`);
      const oldId = String(source['id']);
      const freshId = mapping[oldId];
      if (freshId === undefined) {
        throw new StationSnapshotError(
          `The id map has no fresh id for ${collection}/${oldId}.`,
        );
      }
      const copy: Record<string, unknown> = { ...source, id: freshId };
      for (const field of STATION_SNAPSHOT_REFERENCE_FIELDS[entityType]) {
        const value = copy[field];
        if (typeof value !== 'string' || value.length === 0) continue;
        const targetType = REFERENCE_TARGETS[field];
        if (targetType === undefined) continue;
        const mapped = idMap[targetType][value];
        if (mapped !== undefined) copy[field] = mapped;
      }
      // The copy carries only the JSON scalar/array values read back from a
      // stored row plus a rewritten id, so it is a canonical JSON object.
      const remappedRow = copy as unknown as SyncJsonObject;
      return remappedRow;
    });
  }
  // Keys are exactly the seven collection names and every value is a row
  // array; the structural cast restores the named entity row types.
  const remappedSnapshot = result as unknown as SyncSeedSnapshot;
  return remappedSnapshot;
}

/** Rewrites the declared references of one changed record. */
export function rewriteStationRecordReferences(
  entityType: SyncEntityType,
  record: SyncJsonObject,
  idMap: StationIdMap,
): SyncJsonObject {
  const copy: Record<string, unknown> = { ...record };
  for (const field of STATION_SNAPSHOT_REFERENCE_FIELDS[entityType]) {
    const value = copy[field];
    if (typeof value !== 'string' || value.length === 0) continue;
    const targetType = REFERENCE_TARGETS[field];
    if (targetType === undefined) continue;
    const mapped = idMap[targetType][value];
    if (mapped !== undefined) copy[field] = mapped;
  }
  // Only stored JSON values and rewritten reference strings are present.
  const rewritten = copy as unknown as SyncJsonObject;
  return rewritten;
}

// ---------------------------------------------------------------------------
// Durable binding and checkpoints
// ---------------------------------------------------------------------------

/** Durable station binding tuple (`obol_station_state`). */
export interface StationBinding {
  readonly serverUrl: string;
  readonly serverInstanceId: SyncServerInstanceId;
  /** Empty until the first owner handshake binds this profile. */
  readonly ownerFingerprint: SyncHash;
  readonly stationId: SyncStationId;
  readonly cursor: SyncCursor;
  /** Empty string only before the first accepted journal event. */
  readonly lastChainHash: SyncHash;
  readonly dataEpoch: SyncDataEpoch;
  readonly protocolVersion: number;
  readonly mode: SyncStationMode;
}

/** Identity tuple frozen into an import checkpoint and request. */
export interface StationImportIdentity {
  readonly serverUrl: string;
  readonly serverInstanceId: SyncServerInstanceId;
  readonly ownerFingerprint: SyncHash;
  readonly stationId: SyncStationId;
  readonly dataEpoch: SyncDataEpoch;
  readonly protocolVersion: number;
}

/**
 * Coherent pre-network import checkpoint. It never contains a password,
 * session token or any other secret, and it is never repurposed for a second
 * import: the frozen `importId` is retried verbatim.
 */
export interface StationPendingImportCheckpoint {
  readonly version: typeof STATION_PENDING_IMPORT_VERSION;
  readonly importId: string;
  readonly payloadHash: SyncSha256Hash;
  readonly identity: StationImportIdentity;
  /** Complete frozen request exactly as sent (six hashed fields + hash). */
  readonly request: {
    readonly protocolVersion: number;
    readonly stationId: SyncStationId;
    readonly serverInstanceId: SyncServerInstanceId;
    readonly dataEpoch: SyncDataEpoch;
    readonly importId: string;
    readonly snapshot: SyncSeedSnapshot;
    readonly payloadHash: SyncSha256Hash;
  };
  /** Every local outbox operation covered by the settled snapshot. */
  readonly coveredOpIds: readonly string[];
  /** Old local id -> frozen fresh id for every imported row. */
  readonly idMap: StationIdMap;
  /** Binding to restore when the server definitively rejects the import. */
  readonly previousBinding: StationBinding;
  readonly createdAt: string;
}

/** Validates the persisted checkpoint shape read back from PocketBase JSON. */
export function parseStationPendingImport(
  value: unknown,
): StationPendingImportCheckpoint | null {
  if (value === null || value === undefined) return null;
  const box = recordOf(value, 'The pending import checkpoint');
  if (box['version'] !== STATION_PENDING_IMPORT_VERSION) {
    throw new StationSnapshotError(
      'The pending import checkpoint has an unsupported version.',
    );
  }
  if (typeof box['importId'] !== 'string' || box['importId'].length === 0) {
    throw new StationSnapshotError('The pending import checkpoint has no importId.');
  }
  if (typeof box['payloadHash'] !== 'string' || box['payloadHash'].length === 0) {
    throw new StationSnapshotError('The pending import checkpoint has no payload hash.');
  }
  const covered = box['coveredOpIds'];
  if (!Array.isArray(covered) || covered.some((id) => typeof id !== 'string')) {
    throw new StationSnapshotError('The pending import checkpoint has invalid covered op ids.');
  }
  const request = recordOf(box['request'], 'The pending import checkpoint frozen request');
  recordOf(box['identity'], 'The pending import checkpoint identity tuple');
  validateStationSnapshot(request['snapshot']);
  // Every field above was validated; the cast restores the named checkpoint
  // type over the same parsed JSON object.
  const checkpoint = box as unknown as StationPendingImportCheckpoint;
  return checkpoint;
}

// ---------------------------------------------------------------------------
// Operation wire reconstruction
// ---------------------------------------------------------------------------

/** Exact `sha256:` + 43 unpadded base64url characters. */
const STATION_SHA256_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/;

/** Envelope fields read back from one durable outbox row. */
export interface StationOperationWireInput {
  readonly protocolVersion: number;
  readonly stationId: string;
  readonly opId: string;
  readonly type: SyncOperationType;
  readonly entityType: SyncEntityType;
  readonly entityId: SyncEntityId;
  readonly payload: SyncJsonObject;
  readonly baseRevisions: Readonly<Record<string, number>>;
  readonly dependsOn: readonly string[];
  readonly clientCreatedAt: string;
  readonly effectiveAt: string;
  readonly payloadHash: SyncSha256Hash;
}

/** True when the value is the exact ISO form every hashed field uses. */
function isCanonicalIsoTimestamp(value: string): boolean {
  if (value.length === 0) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

/**
 * Rebuilds one immutable operation wire from stored columns. The operation
 * type selects the discriminated union member; the envelope invariants are
 * validated here (known type, exact entity type, UUIDv7 op id, 15-character
 * entity id, positive-integer base revisions, UUIDv7 dependencies, canonical
 * timestamps and a well-formed complete-envelope hash) so a corrupt row fails
 * loudly instead of entering replay with an invented shape.
 */
export function stationOperationWire(
  input: StationOperationWireInput,
): SyncOperationWire {
  if (!Number.isInteger(input.protocolVersion) || input.protocolVersion < 1) {
    throw new StationSnapshotError('An operation protocol version must be a positive integer.');
  }
  if (!isSyncUuid(input.stationId)) {
    throw new StationSnapshotError('An operation station id is not a UUID.');
  }
  if (!isSyncUuidV7(input.opId)) {
    throw new StationSnapshotError('An operation id is not a UUIDv7.');
  }
  if (!SYNC_OPERATION_TYPES.some((type) => type === input.type)) {
    throw new StationSnapshotError('An operation row carries an unknown operation type.');
  }
  if (SYNC_OPERATION_ENTITY_TYPES[input.type] !== input.entityType) {
    throw new StationSnapshotError(
      `Operation ${input.type} writes ${SYNC_OPERATION_ENTITY_TYPES[input.type]}, not ${input.entityType}.`,
    );
  }
  if (!isSyncEntityId(input.entityId)) {
    throw new StationSnapshotError('An operation entity id is not a 15-character id.');
  }
  if (
    input.payload === null ||
    typeof input.payload !== 'object' ||
    Array.isArray(input.payload)
  ) {
    throw new StationSnapshotError('An operation payload is not a JSON object.');
  }
  for (const [key, revision] of Object.entries(input.baseRevisions)) {
    const separator = key.indexOf(':');
    if (separator <= 0) {
      throw new StationSnapshotError(`Base revision key "${key}" has no entity type.`);
    }
    if (!isSyncEntityType(key.slice(0, separator))) {
      throw new StationSnapshotError(`Base revision key "${key}" has an unknown entity type.`);
    }
    if (!isSyncEntityId(key.slice(separator + 1))) {
      throw new StationSnapshotError(`Base revision key "${key}" has an invalid entity id.`);
    }
    if (!Number.isInteger(revision) || revision < 1) {
      throw new StationSnapshotError(`Base revision "${key}" is not a positive integer.`);
    }
  }
  if (input.dependsOn.some((dependency) => !isSyncUuidV7(dependency))) {
    throw new StationSnapshotError('An operation dependency id is not a UUIDv7.');
  }
  if (!isCanonicalIsoTimestamp(input.clientCreatedAt)) {
    throw new StationSnapshotError('An operation clientCreatedAt is not a canonical ISO timestamp.');
  }
  if (!isCanonicalIsoTimestamp(input.effectiveAt)) {
    throw new StationSnapshotError('An operation effectiveAt is not a canonical ISO timestamp.');
  }
  if (!STATION_SHA256_PATTERN.test(input.payloadHash)) {
    throw new StationSnapshotError('An operation payload hash is not a sha256 hash.');
  }
  // Every envelope invariant above is checked; the operation type and entity
  // type then fix exactly one discriminated union member, so the wire value
  // below is the same validated data under its declared member type.
  const wire = {
    protocolVersion: input.protocolVersion,
    stationId: input.stationId,
    opId: input.opId,
    type: input.type,
    entityType: input.entityType,
    entityId: input.entityId,
    payload: input.payload,
    baseRevisions: input.baseRevisions,
    dependsOn: input.dependsOn,
    clientCreatedAt: input.clientCreatedAt,
    effectiveAt: input.effectiveAt,
    payloadHash: input.payloadHash,
  };
  return wire as unknown as SyncOperationWire;
}

// ---------------------------------------------------------------------------
// Outbox and conflict projections
// ---------------------------------------------------------------------------

/** One durable outbox row as the station engine consumes it. */
export interface StationOutboxSnapshot {
  readonly rowId: string;
  readonly opId: string;
  readonly status: SyncOutboxStatus;
  readonly envelope: SyncOperationWire;
  readonly payloadHash: SyncSha256Hash;
  readonly dependsOn: readonly string[];
  readonly beforeSnapshots: readonly SyncEntitySnapshot[];
  readonly attempts: number;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Minimal accepted causal receipt (`entityVersions`, commit when known). */
  readonly acknowledgement: SyncJsonObject | null;
}

/** One durable conflict row. */
export interface StationConflictSnapshot {
  readonly rowId: string;
  readonly opId: string;
  readonly resolution: 'pending' | 'server' | 'retry' | 'discarded';
  readonly conflict: SyncJsonObject | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Conflict entry carried inside `obol_station_conflicts.conflict`. */
export interface StationConflictDetail {
  readonly entityType: SyncEntityType;
  readonly entityId: SyncEntityId;
  readonly baseRevision: SyncRevision | null;
  readonly currentRevision: SyncRevision;
  readonly current: SyncJsonObject | null;
}

/** Minimal accepted causal receipt stored in an outbox row. */
export interface StationAcknowledgement {
  readonly opId: string;
  readonly commitId: string | null;
  readonly seq: number | null;
  readonly entityVersions: readonly {
    readonly entityType: SyncEntityType;
    readonly entityId: SyncEntityId;
    readonly revision: SyncRevision;
  }[];
}

/** Reads the acknowledgement JSON back into a typed receipt, or null. */
export function parseStationAcknowledgement(
  value: SyncJsonObject | null,
): StationAcknowledgement | null {
  if (value === null) return null;
  const opId = value['opId'];
  if (typeof opId !== 'string') return null;
  const rawVersions = value['entityVersions'];
  const versions = Array.isArray(rawVersions) ? rawVersions : [];
  const entityVersions: StationAcknowledgement['entityVersions'][number][] = [];
  for (const entry of versions) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const version = recordOf(entry, 'Acknowledgement entity version');
    const entityType = version['entityType'];
    const entityId = version['entityId'];
    const revision = version['revision'];
    if (
      typeof entityType === 'string' &&
      isSyncEntityType(entityType) &&
      typeof entityId === 'string' &&
      typeof revision === 'number'
    ) {
      entityVersions.push({ entityType, entityId, revision });
    }
  }
  const commitId = value['commitId'];
  const seq = value['seq'];
  return {
    opId,
    commitId: typeof commitId === 'string' ? commitId : null,
    seq: typeof seq === 'number' ? seq : null,
    entityVersions,
  };
}

// ---------------------------------------------------------------------------
// Dependencies and bounded push batches
// ---------------------------------------------------------------------------

/** Statuses that still need a server outcome. */
export function isPendingOutboxStatus(status: SyncOutboxStatus): boolean {
  return status === 'queued' || status === 'in_flight' || status === 'conflict' || status === 'rejected';
}

/** Statuses eligible to be sent (conflict/rejected wait for resolution). */
export function isSendableOutboxStatus(status: SyncOutboxStatus): boolean {
  return status === 'queued' || status === 'in_flight';
}

/** Accepted op ids available to satisfy dependencies. */
export function acceptedOperationIds(
  operations: readonly StationOutboxSnapshot[],
): ReadonlySet<string> {
  const accepted = new Set<string>();
  for (const operation of operations) {
    if (
      operation.status === 'accepted' ||
      parseStationAcknowledgement(operation.acknowledgement) !== null
    ) {
      accepted.add(operation.opId);
    }
  }
  return accepted;
}

/** True when every declared dependency is already accepted. */
export function dependenciesSatisfied(
  operation: StationOutboxSnapshot,
  accepted: ReadonlySet<string>,
): boolean {
  return operation.dependsOn.every((opId) => accepted.has(opId));
}

/** One planned push batch plus the operations it deferred. */
export interface StationPushPlan {
  readonly batch: readonly StationOutboxSnapshot[];
  /** Sendable operations that did not fit in this bounded batch. */
  readonly deferred: readonly StationOutboxSnapshot[];
  /** Operations that can never be sent at the 64 KiB per-operation bound. */
  readonly oversized: readonly StationOutboxSnapshot[];
}

export interface StationPushPlanOptions {
  /** Canonical wire byte length of one operation envelope. */
  readonly wireBytesOf: (operation: StationOutboxSnapshot) => number;
  /** Canonical request byte length of a candidate batch (without transport). */
  readonly bodyBytesOf: (operations: readonly StationOutboxSnapshot[]) => number;
}

/**
 * Plans one bounded push batch in durable creation order while respecting
 * dependencies: an operation is eligible when every `dependsOn` entry is
 * already accepted or earlier in the planned batch (the server applies the
 * batch in order). In-flight rows are retried first with their frozen bytes.
 * No operation is ever split; the batch stops before the 100-operation or
 * 1 MiB request bounds and defers only independent later work.
 */
export function planStationPushBatch(
  operations: readonly StationOutboxSnapshot[],
  accepted: ReadonlySet<string>,
  options: StationPushPlanOptions,
): StationPushPlan {
  const ordered = [...operations].sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt < right.createdAt ? -1 : 1;
    }
    return left.opId < right.opId ? -1 : left.opId > right.opId ? 1 : 0;
  });

  const oversized: StationOutboxSnapshot[] = [];
  const candidates: StationOutboxSnapshot[] = [];
  for (const operation of ordered) {
    if (!isSendableOutboxStatus(operation.status)) continue;
    if (options.wireBytesOf(operation) > STATION_OPERATION_MAX_BYTES) {
      oversized.push(operation);
      continue;
    }
    candidates.push(operation);
  }

  const batch: StationOutboxSnapshot[] = [];
  const deferred: StationOutboxSnapshot[] = [];
  const acceptedNow = new Set(accepted);
  let remaining = candidates;

  while (remaining.length > 0 && batch.length < STATION_PUSH_MAX_OPERATIONS) {
    const next = remaining.find(
      (operation) =>
        dependenciesSatisfied(operation, accepted) ||
        operation.dependsOn.every(
          (opId) => acceptedNow.has(opId),
        ),
    );
    if (next === undefined) {
      deferred.push(...remaining);
      break;
    }
    const candidateBatch = [...batch, next];
    if (
      batch.length > 0 &&
      options.bodyBytesOf(candidateBatch) > STATION_PUSH_MAX_BODY_BYTES
    ) {
      // This operation does not fit the byte bound; later independent work
      // may still fit, so keep scanning candidates against the current batch.
      remaining = remaining.filter((operation) => operation !== next);
      deferred.push(next);
      continue;
    }
    batch.push(next);
    acceptedNow.add(next.opId);
    remaining = remaining.filter((operation) => operation !== next);
  }

  if (remaining.length > 0) deferred.push(...remaining);
  return { batch, deferred, oversized };
}

// ---------------------------------------------------------------------------
// Pull page validation
// ---------------------------------------------------------------------------

/**
 * Validates the complete-group shape of one pull page before any local write:
 * contiguous `seq` from the stored cursor, one `commitId` per group,
 * `commitIndex` starting at 0 and rising by one, `commitSize` positive and
 * constant inside the group, no group split at the page end, and the 10,000
 * event group bound. Chain hashes are validated by the caller with the shared
 * canonical implementation.
 */
export function validateStationPullPage(
  events: readonly SyncChangeEvent[],
  cursor: SyncCursor,
): readonly SyncCommitGroup[] {
  if (events.length === 0) return [];
  interface MutableGroup {
    readonly commitId: string;
    readonly commitSize: number;
    readonly events: SyncChangeEvent[];
  }
  const groups: MutableGroup[] = [];
  let expectedSeq = cursor + 1;

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.seq !== expectedSeq) {
      throw new StationSnapshotError(
        `Pull page is not contiguous: expected seq ${expectedSeq}, got ${event.seq}.`,
      );
    }
    expectedSeq += 1;

    const isGroupStart = index === 0 || events[index - 1]!.commitId !== event.commitId;
    if (isGroupStart) {
      if (event.commitIndex !== 0) {
        throw new StationSnapshotError(
          `Commit group ${event.commitId} starts at index ${event.commitIndex}, not 0.`,
        );
      }
      if (!Number.isInteger(event.commitSize) || event.commitSize < 1) {
        throw new StationSnapshotError(
          `Commit group ${event.commitId} declares commitSize ${String(event.commitSize)}.`,
        );
      }
      if (event.commitSize > STATION_MAX_COMMIT_EVENTS) {
        throw new StationSnapshotError(
          `Commit group ${event.commitId} carries more than ${STATION_MAX_COMMIT_EVENTS} events.`,
        );
      }
      groups.push({ commitId: event.commitId, commitSize: event.commitSize, events: [] });
    } else {
      const current = groups[groups.length - 1]!;
      if (event.commitSize !== current.commitSize) {
        throw new StationSnapshotError(
          `Commit group ${event.commitId} changes commitSize inside the group.`,
        );
      }
      if (event.commitIndex !== current.events.length) {
        throw new StationSnapshotError(
          `Commit group ${event.commitId} has a non-contiguous commitIndex ${event.commitIndex}.`,
        );
      }
    }

    const group = groups[groups.length - 1]!;
    group.events.push(event);
  }

  const lastGroup = groups[groups.length - 1]!;
  if (lastGroup.events.length !== lastGroup.commitSize) {
    throw new StationSnapshotError(
      `Pull page ends inside commit group ${lastGroup.commitId}: ${lastGroup.events.length} of ${lastGroup.commitSize} events.`,
    );
  }
  return groups;
}
