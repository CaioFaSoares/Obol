// PocketBase persistence for the desktop station replica (D016 D7/D11,
// canon §12.4, desktop offline station contract).
//
// This repository is the ONLY place the desktop station engine reads or writes
// PocketBase. It owns:
//
// - the durable station binding row and the coherent `pendingImport`
//   checkpoint (no token, password or other secret ever enters either);
// - complete settled snapshot reads for the seven finance collections;
// - the durable outbox, local version layer (`serverRevision`,
//   `serverDeleted`, `baseRecord`, separate `localRevision`/`deleted`) and
//   conflict rows;
// - the authoritative-base materialization: a station is a durable server
//   base plus pending user intents, so the working finance rows are rebuilt
//   by replaying every pending intent through the SAME scoped use cases the
//   web routes use. The replay reads a fixed baseline
//   (`PocketbaseUnitOfWork` replay fork) and never copies finance rules;
// - atomic application of one pull page (complete commit groups, the final
//   working diff, base/version overrides, preemptive conflicts, cursor and
//   chain hash in ONE PocketBase batch);
// - atomic application of push results (accepted base rows and causal
//   receipts, conflict/rejection retention, dependency advancement);
// - atomic import adoption (revision-1 baseline, covered-op retirement,
//   post-checkpoint local work preserved and replayed) and deterministic
//   binding rollback after a definitively rejected checkpoint.
//
// It never copies financial math: working data changes only through an
// accepted server record or through the existing use cases executed against a
// replay fork. No hashing rule is reimplemented here;
// `infrastructure/sync/CanonicalJson` is the single implementation.
//
// The existing unit-of-work metadata appender exposes create/update only, so
// retired metadata rows are marked terminal (`accepted` outbox rows,
// `discarded` conflict rows, tombstoned version rows) instead of deleted from
// inside a finance batch. They never become pending work again.

import { createHash } from 'node:crypto';

import type { AwilixContainer } from 'awilix';
import type PocketBase from 'pocketbase';

import type { Recurrence } from '../../domain/entities/Recurrence';
import type { InvoiceRepository } from '../../domain/interfaces/InvoiceRepository';
import type { SyncClock } from '../../domain/sync/MutationContext';
import {
  SYNC_COLLECTIONS,
  SYNC_ENTITY_TYPES,
  isSyncEntityId,
  isSyncEntityType,
  type SyncCollectionName,
  type SyncEntityId,
  type SyncEntityType,
  type SyncJsonObject,
  type SyncSha256Hash,
} from '../../domain/sync/SyncRevision';
import {
  SYNC_OPERATION_TYPES,
  type SyncAppliedEntity,
  type SyncConflictEntry,
  type SyncEntitySnapshot,
  type SyncOperationResult,
  type SyncOperationType,
  type SyncOperationWire,
  type SyncOutboxStatus,
} from '../../domain/sync/SyncOperation';
import type { SyncChangeEvent, SyncCommitGroup } from '../../domain/sync/SyncChange';
import {
  SYNC_PROTOCOL_VERSION,
  type SyncDataEpoch,
  type SyncSeedSnapshot,
  type SyncServerInstanceId,
  type SyncStationId,
} from '../../domain/sync/SyncProtocol';
import {
  STATION_IMPORT_REQUEST_MAX_BYTES,
  STATION_PENDING_IMPORT_MAX_BYTES,
  STATION_PENDING_IMPORT_VERSION,
  STATION_SNAPSHOT_FIELDS,
  StationSnapshotError,
  buildStationIdMap,
  parseStationAcknowledgement,
  parseStationPendingImport,
  rewriteStationRecordReferences,
  stationOperationWire,
  stationSnapshotRow,
  validateStationPullPage,
  validateStationSnapshot,
  type StationAcknowledgement,
  type StationBinding,
  type StationConflictDetail,
  type StationConflictSnapshot,
  type StationIdMap,
  type StationOutboxSnapshot,
  type StationPendingImportCheckpoint,
} from '../../domain/sync/StationProtocol';
import {
  canonicalHash,
  canonicalJsonLength,
  changeChainHash,
  normalizeSyncTimestamp,
  operationEnvelopeHash,
  parseSyncSha256Hash,
  parseSyncHash,
  recordHash,
  toSyncJsonObject,
} from '../sync/CanonicalJson';
import { FinancialMutationRuntime } from '../sync/FinancialMutationRuntime';
import { newOperationId, newSyncEntityId } from '../sync/RecordIds';
import { resolveUseCase } from '../use-case-routes/dispatch';
import {
  PocketbaseUnitOfWork,
  type ReplayBaseline,
  type SyncBatchAppender,
} from './PocketbaseUnitOfWork';

type PocketRecordRow = Record<string, unknown>;

/** Full stored rows of one finance collection keyed by record id. */
type CollectionRowMap = Map<SyncCollectionName, Map<string, PocketRecordRow>>;

/** Decoded `obol_station_state` row plus the parsed import checkpoint. */
export interface StationReplicaState {
  readonly rowId: string | null;
  readonly binding: StationBinding;
  readonly pendingImport: StationPendingImportCheckpoint | null;
}

/** Local activity counters used by pairing preview and export receipts. */
export interface StationReplicaCounts {
  readonly entityCount: number;
  readonly operationCount: number;
  /** True when any durable local operation log exists (outbox or versions). */
  readonly hasOperationLog: boolean;
  readonly conflictCount: number;
}

/** Coherent local dataset used by export and destructive-choice receipts. */
export interface StationReplicaExport {
  readonly snapshot: SyncSeedSnapshot;
  readonly outbox: readonly StationOutboxSnapshot[];
  readonly conflicts: readonly StationConflictSnapshot[];
  readonly counts: StationReplicaCounts;
}

/** Planned local version row (creation or in-place update). */
interface VersionPlan {
  readonly rowId: string | null;
  readonly entityType: SyncEntityType;
  readonly entityId: SyncEntityId;
  readonly localRevision: number;
  readonly serverRevision?: number | null;
  readonly serverDeleted?: boolean;
  readonly baseRecord?: SyncJsonObject | null;
  readonly deleted: boolean;
  /** Terminal tombstone for an id that no longer exists locally. */
  readonly retire?: boolean;
}

/** Conflict detail JSON stored beside a conflict resolution row. */
interface StoredConflictBox {
  readonly conflicts?: readonly StationConflictDetail[];
  readonly entries?: readonly StationConflictDetail[];
  readonly message?: string;
  readonly code?: string;
  readonly writeKeys?: readonly string[];
}

/** A replay failure that must become a typed conflict, never lost finance. */
class StationReplayError extends Error {
  constructor(
    readonly opId: string,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'StationReplayError';
  }
}

/**
 * A local mutation or a station decision changed the pending set after this
 * cycle read it. Nothing was committed; the next cycle replays from the new
 * durable state instead of overwriting concurrent work.
 */
export class StationReplicaStaleError extends Error {
  constructor() {
    super(
      'Local changes arrived while the station replica was materializing the working data; nothing was committed and the next cycle will replay them.',
    );
    this.name = 'StationReplicaStaleError';
  }
}

/** Construction options. The runtime is injectable for tests/wiring. */
export interface PocketbaseStationReplicaOptions {
  /**
   * Runtime whose scoped container executes the existing financial use cases
   * against a replay fork. Only `scopeFor` is used: the replica never touches
   * the FIFO gate or commits through it.
   */
  readonly replayRuntime?: FinancialMutationRuntime;
}

/** The empty binding of a never-paired standalone profile. */
function standaloneBinding(stationId: string): StationBinding {
  return {
    serverUrl: '',
    serverInstanceId: '',
    ownerFingerprint: '',
    stationId,
    cursor: 0,
    lastChainHash: '',
    dataEpoch: 0,
    protocolVersion: SYNC_PROTOCOL_VERSION,
    mode: 'standalone',
  };
}

/** Narrow a stored JSON value into a plain JSON object. */
function jsonObjectOf(value: unknown, context: string): SyncJsonObject | null {
  if (value === null || value === undefined) return null;
  return toSyncJsonObject(value, context);
}

/** Narrow an unknown value into a plain record (validated object). */
function recordOf(value: unknown, context: string): PocketRecordRow {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StationSnapshotError(`${context} must be a JSON object.`);
  }
  return value as PocketRecordRow;
}

/** Deterministic `entityType:entityId` key used by versions and dependencies. */
function entityKey(entityType: SyncEntityType, entityId: SyncEntityId): string {
  return `${entityType}:${entityId}`;
}

/** Stable signature of a pending set used to detect concurrent local work. */
function outboxSignature(operations: readonly StationOutboxSnapshot[]): string {
  return operations
    .map(
      (operation) =>
        `${operation.opId}|${operation.payloadHash}|${operation.status}|${operation.attempts}|${operation.dependsOn.join(',')}`,
    )
    .sort()
    .join('\n');
}

/** Splits one `entityType:entityId` key, or returns null for malformed input. */
function entityIdentityOf(
  key: string,
): { readonly entityType: SyncEntityType; readonly entityId: SyncEntityId } | null {
  const separator = key.indexOf(':');
  if (separator <= 0) return null;
  const entityType = key.slice(0, separator);
  const entityId = key.slice(separator + 1);
  if (!isSyncEntityType(entityType) || !isSyncEntityId(entityId)) return null;
  return { entityType, entityId };
}

/** Declared snapshot fields only, as the exact body a finance write sends. */
function snapshotBodyOf(
  entityType: SyncEntityType,
  record: PocketRecordRow,
): PocketRecordRow {
  const body: PocketRecordRow = { ...stationSnapshotRow(entityType, record) };
  delete body['id'];
  return body;
}

/** PB stores dates with a space separator; hashes need the ISO Z form. */
function normalizeStoredTimestamp(value: unknown): string {
  if (typeof value !== 'string') return '';
  const withSeparator = value.includes(' ') ? value.replace(' ', 'T') : value;
  const parsed = new Date(withSeparator);
  return Number.isNaN(parsed.getTime()) ? withSeparator : parsed.toISOString();
}

function decodeOutboxStatus(value: unknown): SyncOutboxStatus {
  if (
    value === 'queued' ||
    value === 'in_flight' ||
    value === 'accepted' ||
    value === 'conflict' ||
    value === 'rejected'
  ) {
    return value;
  }
  return 'queued';
}

function decodeOperationType(value: unknown): SyncOperationType {
  if (typeof value !== 'string') {
    throw new StationSnapshotError('An outbox row carries no operation type.');
  }
  for (const known of SYNC_OPERATION_TYPES) {
    if (known === value) return known;
  }
  throw new StationSnapshotError(
    `obol_station_outbox carries the unknown operation type "${value}".`,
  );
}

function decodeBeforeSnapshots(
  value: unknown,
  opId: string,
): readonly SyncEntitySnapshot[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new StationSnapshotError(
      `obol_station_outbox ${opId}.beforeSnapshots must be an array.`,
    );
  }
  const snapshots: SyncEntitySnapshot[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const box: PocketRecordRow = { ...entry };
    const entityType = box['entityType'];
    const entityId = box['entityId'];
    if (typeof entityType !== 'string' || !isSyncEntityType(entityType)) continue;
    if (typeof entityId !== 'string') continue;
    snapshots.push({
      entityType,
      entityId,
      revision: typeof box['revision'] === 'number' ? box['revision'] : null,
      record: jsonObjectOf(box['record'], `${opId}.beforeSnapshots.record`),
    });
  }
  return snapshots;
}

function decodeOutbox(row: PocketRecordRow, stationId: string): StationOutboxSnapshot {
  const opId = String(row['opId']);
  const entityType = row['entityType'];
  const entityId = row['entityId'];
  const type = decodeOperationType(row['type']);
  if (typeof entityType !== 'string' || !isSyncEntityType(entityType)) {
    throw new StationSnapshotError(`obol_station_outbox ${opId} carries an unknown entity type.`);
  }
  if (typeof entityId !== 'string' || entityId.length === 0) {
    throw new StationSnapshotError(`obol_station_outbox ${opId} carries no entity id.`);
  }
  const payload = jsonObjectOf(row['payload'], `obol_station_outbox ${opId}.payload`) ?? {};
  const baseRevisions = jsonObjectOf(
    row['baseRevisions'],
    `obol_station_outbox ${opId}.baseRevisions`,
  ) ?? {};
  const revisions: Record<string, number> = {};
  for (const [key, revision] of Object.entries(baseRevisions)) {
    if (typeof revision === 'number') revisions[key] = revision;
  }
  const dependsOn = Array.isArray(row['dependsOn'])
    ? row['dependsOn'].filter((entry): entry is string => typeof entry === 'string')
    : [];
  const payloadHash = parseSyncSha256Hash(
    row['payloadHash'],
    `obol_station_outbox ${opId}.payloadHash`,
  );
  const envelope = stationOperationWire({
    protocolVersion:
      typeof row['protocolVersion'] === 'number'
        ? row['protocolVersion']
        : SYNC_PROTOCOL_VERSION,
    stationId,
    opId,
    type,
    entityType,
    entityId,
    payload,
    baseRevisions: revisions,
    dependsOn,
    clientCreatedAt: normalizeStoredTimestamp(row['clientCreatedAt']),
    effectiveAt: normalizeStoredTimestamp(row['effectiveAt']),
    payloadHash,
  });
  return {
    rowId: String(row['id']),
    opId,
    status: decodeOutboxStatus(row['status']),
    envelope,
    payloadHash,
    dependsOn,
    beforeSnapshots: decodeBeforeSnapshots(row['beforeSnapshots'], opId),
    attempts: typeof row['attempts'] === 'number' ? row['attempts'] : 0,
    lastError: typeof row['lastError'] === 'string' ? row['lastError'] : null,
    createdAt: normalizeStoredTimestamp(row['createdAt']),
    updatedAt: normalizeStoredTimestamp(row['updatedAt']),
    acknowledgement: jsonObjectOf(
      row['acknowledgement'],
      `obol_station_outbox ${opId}.acknowledgement`,
    ),
  };
}

function decodeConflict(row: PocketRecordRow): StationConflictSnapshot {
  const resolution = row['resolution'];
  return {
    rowId: String(row['id']),
    opId: String(row['opId']),
    resolution:
      resolution === 'server' || resolution === 'retry' || resolution === 'discarded'
        ? resolution
        : 'pending',
    conflict: jsonObjectOf(
      row['conflict'],
      `obol_station_conflicts ${String(row['opId'])}`,
    ),
    createdAt: normalizeStoredTimestamp(row['createdAt']),
    updatedAt: normalizeStoredTimestamp(row['updatedAt']),
  };
}

function conflictDetailsOf(
  row: StationConflictSnapshot | undefined,
): readonly StationConflictDetail[] {
  if (row === undefined || row.conflict === null) return [];
  const box = row.conflict as unknown as StoredConflictBox;
  return box.conflicts ?? box.entries ?? [];
}

function conflictWriteKeysOf(
  row: StationConflictSnapshot | undefined,
): readonly string[] {
  if (row === undefined || row.conflict === null) return [];
  const box = row.conflict as unknown as StoredConflictBox;
  return Array.isArray(box.writeKeys)
    ? box.writeKeys.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** Pending dependents (transitively) of one operation id. */
function transitiveDependents(
  operations: readonly StationOutboxSnapshot[],
  opId: string,
): readonly StationOutboxSnapshot[] {
  const found = new Map<string, StationOutboxSnapshot>();
  let frontier = [opId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const operation of operations) {
      if (found.has(operation.opId)) continue;
      if (operation.status === 'accepted') continue;
      if (!operation.dependsOn.some((entry) => frontier.includes(entry))) continue;
      found.set(operation.opId, operation);
      next.push(operation.opId);
    }
    frontier = next;
  }
  return [...found.values()];
}

function operationKey(operation: StationOutboxSnapshot): string {
  return entityKey(operation.envelope.entityType, operation.envelope.entityId);
}

function pendingOpsByEntity(
  operations: readonly StationOutboxSnapshot[],
): Map<string, StationOutboxSnapshot[]> {
  const map = new Map<string, StationOutboxSnapshot[]>();
  for (const operation of operations) {
    if (
      operation.status !== 'queued' &&
      operation.status !== 'in_flight' &&
      operation.status !== 'conflict'
    ) {
      continue;
    }
    const key = operationKey(operation);
    const list = map.get(key) ?? [];
    list.push(operation);
    map.set(key, list);
  }
  return map;
}

/** Numeric base-revision map of one stored envelope. */
function revisionMapOf(value: unknown): Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const box = recordOf(value, 'baseRevisions');
  const revisions: Record<string, number> = {};
  for (const [key, entry] of Object.entries(box)) {
    if (typeof entry === 'number' && Number.isInteger(entry) && entry >= 1) {
      revisions[key] = entry;
    }
  }
  return revisions;
}

function declaredRevisionOf(
  operation: StationOutboxSnapshot,
  entityType: SyncEntityType,
  entityId: SyncEntityId,
): number | null {
  const revisions = revisionMapOf(operation.envelope.baseRevisions);
  const value = revisions[entityKey(entityType, entityId)];
  return value === undefined ? null : value;
}

/** True when the stored envelope bytes still hash to the stored hash. */
function frozenEnvelopeIntact(operation: StationOutboxSnapshot): boolean {
  try {
    return operationEnvelopeHash(operation.envelope) === operation.payloadHash;
  } catch {
    return false;
  }
}

/** Deep equality over the JSON values current use cases can read/write. */
function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null) return left === right;
  if (typeof left !== typeof right) return false;
  if (typeof left !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!sameJsonValue(left[index], right[index])) return false;
    }
    return true;
  }
  const leftBox = left as Record<string, unknown>;
  const rightBox = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftBox);
  const rightKeys = Object.keys(rightBox);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(rightBox, key)) return false;
    if (!sameJsonValue(leftBox[key], rightBox[key])) return false;
  }
  return true;
}

/** Field value with the empty-string form PocketBase uses for unset fields. */
function declaredFieldValue(row: PocketRecordRow | undefined, field: string): unknown {
  if (row === undefined) return '';
  const value = row[field];
  return value === undefined ? '' : value;
}

/** Declared fields PocketBase stores in its space-separated date form. */
const DATE_FIELDS: Readonly<Record<string, true>> = {
  expected_date: true,
  realized_date: true,
  purchase_date: true,
  due_date: true,
  end_date: true,
  created: true,
  updated: true,
};

/** Compares only the declared snapshot fields of two stored rows. */
function declaredRowsDiffer(
  entityType: SyncEntityType,
  left: PocketRecordRow,
  right: PocketRecordRow | undefined,
): boolean {
  for (const field of STATION_SNAPSHOT_FIELDS[entityType]) {
    if (field === 'id') continue;
    const leftValue = declaredFieldValue(left, field);
    const rightValue = declaredFieldValue(right, field);
    if (DATE_FIELDS[field] === true) {
      const leftDate = typeof leftValue === 'string' ? normalizeStoredTimestamp(leftValue) : leftValue;
      const rightDate = typeof rightValue === 'string' ? normalizeStoredTimestamp(rightValue) : rightValue;
      if (!sameJsonValue(leftDate, rightDate)) return true;
      continue;
    }
    if (!sameJsonValue(leftValue, rightValue)) return true;
  }
  return false;
}

function isNotFound(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (error as { status?: unknown }).status === 404
  );
}

function emptyRowMap(): CollectionRowMap {
  const map: CollectionRowMap = new Map();
  for (const entityType of SYNC_ENTITY_TYPES) {
    map.set(SYNC_COLLECTIONS[entityType], new Map());
  }
  return map;
}

function cloneRowMap(source: CollectionRowMap): CollectionRowMap {
  const copy = emptyRowMap();
  for (const [collection, rows] of source) {
    const target = copy.get(collection)!;
    for (const [id, row] of rows) {
      target.set(id, { ...row });
    }
  }
  return copy;
}

/**
 * Deterministic side-effect id. A replayed intent that creates a record the
 * user never addressed by id gets the same 15-character id on every replay,
 * restart and lost-response retry.
 */
function replayEntityId(opId: string, ordinal: number): string {
  return createHash('sha256').update(`${opId}:${ordinal}`, 'utf8').digest('hex').slice(0, 15);
}

/** One coherent replay result over a fixed baseline. */
interface ReplayOutcome {
  readonly rows: CollectionRowMap;
  /** entity keys each pending operation actually wrote, in replay order. */
  readonly writesByOp: ReadonlyMap<string, readonly string[]>;
}

/** Side-effect id allocation: exact per-operation hints plus the shared pool. */
interface ReplayIdPools {
  readonly pools: Map<SyncCollectionName, string[]>;
  readonly hints: Map<string, Map<SyncCollectionName, string[]>>;
}

export class PocketbaseStationReplicaRepository {
  private readonly replayRuntime: FinancialMutationRuntime;

  constructor(
    private readonly pb: PocketBase,
    options: PocketbaseStationReplicaOptions = {},
  ) {
    // Only `scopeFor` is used from this runtime. It never runs a mutation
    // through its coordinator, so it is not a second writer: every use-case
    // write stays in the replay fork's buffer until this repository's single
    // batch commits the final diff.
    this.replayRuntime =
      options.replayRuntime ??
      new FinancialMutationRuntime(pb, { role: 'local', serverName: 'Obol local' });
  }

  // -----------------------------------------------------------------------
  // Station state and binding
  // -----------------------------------------------------------------------

  /** Reads the singleton station state row; an empty standalone state before it exists. */
  async readState(): Promise<StationReplicaState> {
    const result = (await this.pb.collection('obol_station_state').getList(1, 1)) as {
      items: PocketRecordRow[];
    };
    const row = result.items[0];
    if (row === undefined) {
      return {
        rowId: null,
        binding: standaloneBinding(''),
        pendingImport: null,
      };
    }
    const stationId = typeof row['stationId'] === 'string' ? row['stationId'] : '';
    const binding: StationBinding = {
      serverUrl: typeof row['serverUrl'] === 'string' ? row['serverUrl'] : '',
      serverInstanceId:
        typeof row['serverInstanceId'] === 'string' ? row['serverInstanceId'] : '',
      ownerFingerprint: parseSyncHash(
        row['ownerFingerprint'] ?? '',
        'obol_station_state.ownerFingerprint',
      ),
      stationId,
      cursor: typeof row['cursor'] === 'number' ? row['cursor'] : 0,
      lastChainHash: parseSyncHash(
        row['lastChainHash'] ?? '',
        'obol_station_state.lastChainHash',
      ),
      dataEpoch: typeof row['dataEpoch'] === 'number' ? row['dataEpoch'] : 0,
      protocolVersion:
        typeof row['protocolVersion'] === 'number'
          ? row['protocolVersion']
          : SYNC_PROTOCOL_VERSION,
      mode: row['mode'] === 'station' ? 'station' : 'standalone',
    };
    return {
      rowId: String(row['id']),
      binding,
      pendingImport: parseStationPendingImport(row['pendingImport']),
    };
  }

  /** Writes one binding patch in its own atomic metadata transaction. */
  async planBinding(
    patch: Partial<StationBinding>,
    pendingImport: StationPendingImportCheckpoint | null | undefined,
  ): Promise<void> {
    const unitOfWork = new PocketbaseUnitOfWork(this.pb);
    await this.planStateUpsert(unitOfWork.metadataBatch(), patch, pendingImport);
    await unitOfWork.executeCommit();
  }

  private async planStateUpsert(
    appender: SyncBatchAppender,
    patch: Partial<StationBinding>,
    pendingImport: StationPendingImportCheckpoint | null | undefined,
  ): Promise<void> {
    const existing = await this.readState();
    const body: PocketRecordRow = { ...patch };
    if (pendingImport !== undefined) {
      body['pendingImport'] = pendingImport === null ? null : pendingImport;
    }
    if (existing.rowId !== null) {
      appender.update('obol_station_state', existing.rowId, body);
      return;
    }
    appender.create('obol_station_state', {
      ...standaloneBinding(existing.binding.stationId),
      ...body,
    });
  }

  /**
   * Builds and persists the coherent pre-network import checkpoint in ONE
   * batch with the station binding. The live finance rows are NOT remapped
   * here: a deterministic server rejection therefore leaves the old local
   * finances byte-identical. The frozen snapshot carries the fresh ids and
   * the checkpoint keeps the id map used on adoption.
   */
  async createImportCheckpoint(input: {
    readonly serverUrl: string;
    readonly serverInstanceId: SyncServerInstanceId;
    readonly ownerFingerprint: SyncSha256Hash;
    readonly dataEpoch: SyncDataEpoch;
    readonly stationId: SyncStationId;
    readonly protocolVersion: number;
    readonly at: string;
  }): Promise<StationPendingImportCheckpoint> {
    const state = await this.readState();
    if (state.pendingImport !== null) {
      throw new StationSnapshotError(
        'A snapshot import checkpoint is already frozen in this profile; resume that exact request instead of minting a new import id.',
      );
    }
    const outboxBefore = await this.readOutbox();
    const snapshot = await this.readSnapshot();
    const outboxAfter = await this.readOutbox();
    if (outboxSignature(outboxBefore) !== outboxSignature(outboxAfter)) {
      throw new StationReplicaStaleError();
    }
    validateStationSnapshot(snapshot);
    const { idMap, snapshot: remapped } = buildStationIdMap(snapshot, newSyncEntityId);
    const importId = newOperationId();
    const requestBase = {
      protocolVersion: input.protocolVersion,
      stationId: input.stationId,
      serverInstanceId: input.serverInstanceId,
      dataEpoch: input.dataEpoch,
      importId,
      snapshot: remapped,
    };
    const payloadHash = canonicalHash(
      toSyncJsonObject(requestBase, 'snapshot import hash input'),
    );
    const request = { ...requestBase, payloadHash };
    if (
      canonicalJsonLength(toSyncJsonObject(request, 'snapshot import request')) >
      STATION_IMPORT_REQUEST_MAX_BYTES
    ) {
      throw new StationSnapshotError(
        'The settled snapshot is larger than the 10 MiB import request bound; it stays local and can be exported.',
      );
    }

    const outbox = outboxAfter;
    const checkpointBox = {
      version: STATION_PENDING_IMPORT_VERSION,
      importId,
      payloadHash,
      identity: {
        serverUrl: input.serverUrl,
        serverInstanceId: input.serverInstanceId,
        ownerFingerprint: input.ownerFingerprint,
        stationId: input.stationId,
        dataEpoch: input.dataEpoch,
        protocolVersion: input.protocolVersion,
      },
      request,
      coveredOpIds: outbox
        .filter((operation) => operation.status !== 'accepted')
        .map((operation) => operation.opId),
      idMap,
      previousBinding: state.binding,
      createdAt: input.at,
    };
    if (
      canonicalJsonLength(toSyncJsonObject(checkpointBox, 'pending import checkpoint')) >
      STATION_PENDING_IMPORT_MAX_BYTES
    ) {
      throw new StationSnapshotError(
        'The pending import checkpoint would exceed the 12 MiB local bound.',
      );
    }
    // Structural cast: the fields above are exactly the declared checkpoint
    // shape and the frozen request was validated as JSON.
    const checkpoint = checkpointBox as unknown as StationPendingImportCheckpoint;

    const unitOfWork = new PocketbaseUnitOfWork(this.pb);
    await this.planStateUpsert(
      unitOfWork.metadataBatch(),
      {
        serverUrl: input.serverUrl,
        serverInstanceId: input.serverInstanceId,
        ownerFingerprint: input.ownerFingerprint,
        stationId: input.stationId,
        dataEpoch: input.dataEpoch,
        protocolVersion: input.protocolVersion,
        mode: 'station',
      },
      checkpoint,
    );
    await unitOfWork.executeCommit();
    return checkpoint;
  }

  /**
   * Clears the checkpoint. `restorePreviousBinding` is used only when the
   * server definitively rejected the import (collision or reused id): the
   * previous mode/binding come back, the local finance stays intact, and no
   * new import id is minted by this call.
   */
  async dismissImportCheckpoint(restorePreviousBinding: boolean): Promise<void> {
    const state = await this.readState();
    const checkpoint = state.pendingImport;
    const patch: Partial<StationBinding> =
      restorePreviousBinding && checkpoint !== null
        ? {
            serverUrl: checkpoint.previousBinding.serverUrl,
            serverInstanceId: checkpoint.previousBinding.serverInstanceId,
            ownerFingerprint: checkpoint.previousBinding.ownerFingerprint,
            stationId: checkpoint.previousBinding.stationId,
            cursor: checkpoint.previousBinding.cursor,
            lastChainHash: checkpoint.previousBinding.lastChainHash,
            dataEpoch: checkpoint.previousBinding.dataEpoch,
            protocolVersion: checkpoint.previousBinding.protocolVersion,
            mode: checkpoint.previousBinding.mode,
          }
        : {};
    await this.planBinding(patch, null);
  }

  // -----------------------------------------------------------------------
  // Complete settled snapshot
  // -----------------------------------------------------------------------

  /** Reads all seven finance collections in deterministic collection/id order. */
  async readSnapshot(): Promise<SyncSeedSnapshot> {
    const working = await this.readWorkingMaps();
    return this.snapshotOfWorking(working);
  }

  private snapshotOfWorking(working: CollectionRowMap): SyncSeedSnapshot {
    const collections: Record<string, readonly SyncJsonObject[]> = {};
    for (const entityType of SYNC_ENTITY_TYPES) {
      const collection = SYNC_COLLECTIONS[entityType];
      const rows = [...(working.get(collection)?.values() ?? [])].sort((left, right) =>
        String(left['id']) < String(right['id']) ? -1 : 1,
      );
      collections[collection] = rows.map((row) => stationSnapshotRow(entityType, row));
    }
    const snapshot = collections as unknown as SyncSeedSnapshot;
    return snapshot;
  }

  /** Local activity counters used by the pairing decision matrix. */
  async readCounts(): Promise<StationReplicaCounts> {
    const snapshot = await this.readSnapshot();
    let entityCount = 0;
    for (const entityType of SYNC_ENTITY_TYPES) {
      entityCount += snapshot[SYNC_COLLECTIONS[entityType]].length;
    }
    const outbox = await this.listRows('obol_station_outbox');
    const versions = await this.listRows('obol_station_versions');
    const conflicts = await this.listRows('obol_station_conflicts');
    return {
      entityCount,
      operationCount: outbox.filter((row) => row['status'] !== 'accepted').length,
      hasOperationLog:
        outbox.some((row) => row['status'] !== 'accepted') ||
        versions.some((row) => {
          const revision = row['localRevision'];
          return typeof revision === 'number' && revision > 0;
        }),
      conflictCount: conflicts.filter((row) => row['resolution'] === 'pending').length,
    };
  }

  /** Coherent dataset for export and for destructive-choice receipts. */
  async readExport(): Promise<StationReplicaExport> {
    return {
      snapshot: await this.readSnapshot(),
      outbox: await this.readOutbox(),
      conflicts: await this.readConflicts(),
      counts: await this.readCounts(),
    };
  }

  /**
   * Numeric fingerprint of the actual financial working data. It changes only
   * when a finance row changes (create/update/delete), never because a status
   * was polled or a metadata row was rewritten.
   */
  async readDataRevision(): Promise<number> {
    const snapshot = await this.readSnapshot();
    const hash = canonicalHash(toSyncJsonObject(snapshot, 'local finance snapshot'));
    const digest = Buffer.from(hash.slice('sha256:'.length), 'base64url');
    return digest.readUIntBE(0, 6);
  }

  // -----------------------------------------------------------------------
  // Outbox
  // -----------------------------------------------------------------------

  /** Reads every durable outbox row, decoded and in creation order. */
  async readOutbox(): Promise<readonly StationOutboxSnapshot[]> {
    const state = await this.readState();
    const rows = await this.listRows('obol_station_outbox', 'createdAt,opId');
    return rows.map((row) => decodeOutbox(row, state.binding.stationId));
  }

  /**
   * Enriches still-queued envelopes with the base revisions of every entity
   * their own use case writes, before the first send. The recorder can only
   * name the canonical target; server-computed side effects (account balance,
   * invoice, payment transaction, skipped recurrence) are discovered by the
   * same replay that materializes the working data. A stable base is declared
   * so the server's coverage check accepts the operation; a changed base is
   * left to the explicit rebase conflict. After the first send the envelope is
   * immutable and is never touched.
   */
  async prepareOutboxForSend(at: string): Promise<void> {
    const outbox = await this.readOutbox();
    const candidates = outbox.filter(
      (operation) => operation.status === 'queued' && operation.attempts === 0,
    );
    if (candidates.length === 0) return;
    const versions = await this.readVersionMap();
    const working = await this.readWorkingMaps();
    const pending = outbox.filter((operation) => operation.status !== 'accepted');
    let outcome: ReplayOutcome;
    try {
      outcome = await this.replayPendingIntents(versions, versions, working, pending);
    } catch {
      // A pending intent that cannot be replayed is not frozen here; the
      // normal push/rejection path reports the server outcome and the user
      // resolves it explicitly.
      return;
    }

    const updates = new Map<string, PocketRecordRow>();
    for (const operation of candidates) {
      const baseRevisions: Record<string, number> = {
        ...revisionMapOf(operation.envelope.baseRevisions),
      };
      let changed = false;
      for (const key of outcome.writesByOp.get(operation.opId) ?? []) {
        if (baseRevisions[key] !== undefined) continue;
        const version = versions.get(key);
        if (version?.serverRevision == null) continue;
        baseRevisions[key] = version.serverRevision;
        changed = true;
      }
      if (!changed) continue;
      const envelope = stationOperationWire({
        ...operation.envelope,
        payload: toSyncJsonObject(operation.envelope.payload, 'operation payload'),
        baseRevisions,
        dependsOn: operation.dependsOn,
        payloadHash: operation.payloadHash,
      });
      updates.set(operation.opId, {
        baseRevisions,
        dependsOn: operation.dependsOn,
        payloadHash: operationEnvelopeHash(envelope),
        updatedAt: at,
      });
    }
    if (updates.size === 0) return;

    const unitOfWork = new PocketbaseUnitOfWork(this.pb);
    const appender = unitOfWork.metadataBatch();
    for (const [opId, update] of updates) {
      const row = outbox.find((entry) => entry.opId === opId);
      if (row !== undefined) appender.update('obol_station_outbox', row.rowId, update);
    }
    await this.assertOutboxUnchanged(outbox);
    await unitOfWork.executeCommit();
  }

  /**
   * Freezes and marks the planned operations in flight BEFORE the network
   * call: attempts increase and the exact stored bytes stay unchanged. A lost
   * response therefore retries one immutable envelope, never a new opId.
   */
  async markOutboxSending(opIds: readonly string[], at: string): Promise<void> {
    if (opIds.length === 0) return;
    const unitOfWork = new PocketbaseUnitOfWork(this.pb);
    const appender = unitOfWork.metadataBatch();
    const outbox = await this.readOutbox();
    for (const opId of opIds) {
      const operation = outbox.find((entry) => entry.opId === opId);
      if (operation === undefined) continue;
      appender.update('obol_station_outbox', operation.rowId, {
        status: 'in_flight',
        attempts: operation.attempts + 1,
        lastError: null,
        updatedAt: at,
      });
    }
    await unitOfWork.executeCommit();
  }

  /**
   * Marks operations that can never fit the documented 64 KiB per-operation
   * wire bound as rejected, so one oversized intent never strands a valid
   * batch or loops forever. Nothing is sent for those rows.
   */
  async markOutboxRejected(
    opIds: readonly string[],
    reason: string,
    at: string,
  ): Promise<void> {
    if (opIds.length === 0) return;
    const unitOfWork = new PocketbaseUnitOfWork(this.pb);
    const appender = unitOfWork.metadataBatch();
    const outbox = await this.readOutbox();
    for (const opId of opIds) {
      const operation = outbox.find((entry) => entry.opId === opId);
      if (operation === undefined) continue;
      appender.update('obol_station_outbox', operation.rowId, {
        status: 'rejected',
        lastError: reason,
        updatedAt: at,
      });
    }
    await unitOfWork.executeCommit();
  }

  /**
   * Applies one push response in ONE local batch: accepted base rows and
   * minimal causal receipts, conflict and rejection retention, the rebuilt
   * working finance rows and dependency advancement for never-sent later
   * operations. The pull cursor is never advanced from a push response.
   */
  async applyPushResults(
    results: readonly SyncOperationResult[],
    at: string,
  ): Promise<void> {
    if (results.length === 0) return;
    const previousVersions = await this.readVersionMap();
    const outbox = await this.readOutbox();
    const conflicts = await this.readConflicts();
    const working = await this.readWorkingMaps();
    const versionWrites = new Map<string, VersionPlan>();
    const conflictWrites = new Map<string, StoredConflictBox>();
    const outboxUpdates = new Map<string, PocketRecordRow>();
    const ackByOp = new Map<string, StationAcknowledgement>();
    const acceptedOpIds = new Set<string>();
    const directRecords: Array<{
      readonly entityType: SyncEntityType;
      readonly entityId: SyncEntityId;
      readonly revision: number;
      readonly record: SyncJsonObject | null;
    }> = [];

    for (const result of results) {
      const operation = outbox.find((entry) => entry.opId === result.opId);
      if (operation === undefined) continue;
      if (
        (result.status === 'applied' || result.status === 'duplicate') &&
        !frozenEnvelopeIntact(operation)
      ) {
        conflictWrites.set(operation.opId, {
          conflicts: [],
          code: 'ENVELOPE_HASH_MISMATCH',
          message:
            'The stored operation bytes do not hash to their stored hash; this result cannot be accepted for them.',
        });
        outboxUpdates.set(operation.opId, {
          status: 'conflict',
          lastError: 'ENVELOPE_HASH_MISMATCH',
          updatedAt: at,
        });
        continue;
      }
      switch (result.status) {
        case 'applied':
        case 'duplicate': {
          if (result.entities.length === 0) {
            // Acceptance without the authoritative records is unproven:
            // keep the frozen intent until a duplicate validation or pull
            // event supplies the exact receipt.
            outboxUpdates.set(operation.opId, {
              status: 'in_flight',
              lastError: 'The server accepted this operation without returning its entities; awaiting the pull receipt.',
              updatedAt: at,
            });
            break;
          }
          for (const entity of result.entities) {
            const applied = this.planBaseVersion(
              versionWrites,
              previousVersions,
              entity.entityType,
              entity.entityId,
              entity.revision,
              entity.record,
            );
            if (applied) {
              directRecords.push({
                entityType: entity.entityType,
                entityId: entity.entityId,
                revision: entity.revision,
                record: entity.record,
              });
            }
          }
          const acknowledgement: StationAcknowledgement = {
            opId: result.opId,
            commitId: null,
            seq: null,
            entityVersions: result.entityVersions.map((version) => ({
              entityType: version.entityType,
              entityId: version.entityId,
              revision: version.revision,
            })),
          };
          ackByOp.set(operation.opId, acknowledgement);
          acceptedOpIds.add(operation.opId);
          outboxUpdates.set(operation.opId, {
            status: 'accepted',
            lastError: null,
            acknowledgement,
            updatedAt: at,
          });
          break;
        }
        case 'conflict': {
          const details: StationConflictDetail[] = result.conflicts.map(
            (conflict: SyncConflictEntry) => ({
              entityType: conflict.entityType,
              entityId: conflict.entityId,
              baseRevision: conflict.baseRevision,
              currentRevision: conflict.currentRevision,
              current: conflict.current,
            }),
          );
          for (const conflict of result.conflicts) {
            const applied = this.planBaseVersion(
              versionWrites,
              previousVersions,
              conflict.entityType,
              conflict.entityId,
              conflict.currentRevision,
              conflict.current,
            );
            if (applied) {
              directRecords.push({
                entityType: conflict.entityType,
                entityId: conflict.entityId,
                revision: conflict.currentRevision,
                record: conflict.current,
              });
            }
          }
          conflictWrites.set(operation.opId, {
            conflicts: details,
            message: 'The server holds a newer revision for this operation.',
            code: 'SYNC_CONFLICT',
          });
          outboxUpdates.set(operation.opId, {
            status: 'conflict',
            lastError: 'SYNC_CONFLICT',
            updatedAt: at,
          });
          break;
        }
        case 'rejected': {
          // The intent is retained until the user acknowledges it; its
          // optimistic working effect stays visible and replayable.
          outboxUpdates.set(operation.opId, {
            status: 'rejected',
            lastError: `${result.code}: ${result.message}`,
            updatedAt: at,
          });
          break;
        }
        case 'blocked': {
          outboxUpdates.set(operation.opId, {
            status: 'queued',
            lastError: `${result.code}: ${result.message}`,
            updatedAt: at,
          });
          break;
        }
        default:
          break;
      }
    }

    const remaining = outbox.filter(
      (operation) =>
        operation.status !== 'accepted' && !acceptedOpIds.has(operation.opId),
    );

    const unitOfWork = new PocketbaseUnitOfWork(this.pb);
    const appender = unitOfWork.metadataBatch();
    for (const [opId, update] of outboxUpdates) {
      const row = outbox.find((entry) => entry.opId === opId);
      if (row !== undefined) appender.update('obol_station_outbox', row.rowId, update);
    }

    if (remaining.length === 0) {
      for (const record of directRecords) {
        await this.planDirectWorkingRow(
          unitOfWork,
          working,
          record.entityType,
          record.entityId,
          record.record,
        );
      }
      await this.pruneUnsourcedLocalCreates(
        unitOfWork,
        working,
        versionWrites,
        previousVersions,
      );
    } else {
      const outcome = await this.replayOrConflict(
        versionWrites,
        previousVersions,
        working,
        remaining,
        conflictWrites,
        outboxUpdates,
        conflicts,
        ackByOp,
        at,
      );
      if (outcome !== null) {
        await this.planWorkingDiff(unitOfWork, working, outcome.rows);
        this.planReplayVersionRows(
          versionWrites,
          previousVersions,
          outcome.writesByOp,
        );
      }
    }

    this.planConflictRows(appender, conflictWrites, conflicts, at);
    this.flushVersionPlans(appender, versionWrites, previousVersions);
    this.advanceDependents(appender, outbox, outboxUpdates, ackByOp, at);
    await this.assertOutboxUnchanged(outbox);
    await unitOfWork.executeCommit();
  }

  /**
   * Verifies the complete chain of one pull page before any local write:
   * contiguous sequence from the stored cursor, valid entity identity and
   * revision, record/kind agreement, previous-hash linkage and the fourteen
   * hashed fields. A mismatch rejects the whole page.
   */
  private verifyPullChain(
    events: readonly SyncChangeEvent[],
    cursor: number,
    expectedPrev: string,
  ): void {
    let previous = expectedPrev;
    let expectedSeq = cursor + 1;
    for (const event of events) {
      if (event.seq !== expectedSeq) {
        throw new StationSnapshotError(
          `Pull page is not contiguous: expected seq ${expectedSeq}, got ${event.seq}.`,
        );
      }
      expectedSeq += 1;
      if (!isSyncEntityId(event.entityId)) {
        throw new StationSnapshotError(`Pull event ${event.seq} carries an invalid entity id.`);
      }
      if (!Number.isInteger(event.revision) || event.revision < 1) {
        throw new StationSnapshotError(`Pull event ${event.seq} carries an invalid revision.`);
      }
      if (event.kind === 'upsert' && event.record === null) {
        throw new StationSnapshotError(`Pull event ${event.seq} is an upsert without a record.`);
      }
      if (event.kind === 'delete' && event.record !== null) {
        throw new StationSnapshotError(`Pull event ${event.seq} is a delete with a record.`);
      }
      if (event.prevHash !== previous) {
        throw new StationSnapshotError(
          `Pull event ${event.seq} does not continue the stored chain.`,
        );
      }
      const expected = changeChainHash({
        seq: event.seq,
        commitId: event.commitId,
        commitIndex: event.commitIndex,
        commitSize: event.commitSize,
        kind: event.kind,
        entityType: event.entityType,
        entityId: event.entityId,
        revision: event.revision,
        recordHash: recordHash(event.record),
        origin: event.origin,
        stationId: event.stationId ?? null,
        opId: event.opId ?? null,
        createdAt: normalizeSyncTimestamp(event.createdAt, 'pull event createdAt'),
        prevHash: event.prevHash,
      });
      if (expected !== event.chainHash) {
        throw new StationSnapshotError(`Pull event ${event.seq} has an invalid chain hash.`);
      }
      previous = event.chainHash;
    }
  }

  // -----------------------------------------------------------------------
  // Pull application
  // -----------------------------------------------------------------------

  /**
   * Applies one validated pull page atomically: the authoritative base
   * overrides, a rebuilt working dataset (when pending intents exist), the
   * preemptive conflicts for a stale base, the cursor and the chain hash land
   * in the same batch. A pending local operation is never overwritten (no
   * last-writer-wins): the newer server base is stored for explicit
   * resolution and the operation is marked conflicted.
   */
  async applyPullGroups(
    groups: readonly SyncCommitGroup[],
    at: string,
  ): Promise<void> {
    const events = groups.flatMap((group) => group.events);
    if (events.length === 0) return;

    const state = await this.readState();
    validateStationPullPage(events, state.binding.cursor);
    this.verifyPullChain(events, state.binding.cursor, state.binding.lastChainHash);

    const previousVersions = await this.readVersionMap();
    const outbox = await this.readOutbox();
    const conflicts = await this.readConflicts();
    const working = await this.readWorkingMaps();
    const pendingByEntity = pendingOpsByEntity(outbox);
    const versionWrites = new Map<string, VersionPlan>();
    const conflictWrites = new Map<string, StoredConflictBox>();
    const outboxUpdates = new Map<string, PocketRecordRow>();
    const ackByOp = new Map<string, StationAcknowledgement>();
    const acceptedOpIds = new Set<string>();
    const directRecords: Array<{
      readonly entityType: SyncEntityType;
      readonly entityId: SyncEntityId;
      readonly revision: number;
      readonly record: SyncJsonObject | null;
    }> = [];

    for (const event of events) {
      const pending = pendingByEntity.get(entityKey(event.entityType, event.entityId)) ?? [];

      // A push response cannot carry the commit id/seq; a later pull event for
      // the same accepted opId completes that minimal causal receipt.
      if (event.opId !== undefined) {
        const acceptedRow = outbox.find(
          (operation) => operation.opId === event.opId && operation.status === 'accepted',
        );
        if (acceptedRow !== undefined) {
          const previous = parseStationAcknowledgement(acceptedRow.acknowledgement);
          if (previous !== null && previous.commitId === null) {
            const merged = new Map(
              previous.entityVersions.map((version) => [
                entityKey(version.entityType, version.entityId),
                version,
              ]),
            );
            merged.set(entityKey(event.entityType, event.entityId), {
              entityType: event.entityType,
              entityId: event.entityId,
              revision: event.revision,
            });
            outboxUpdates.set(acceptedRow.opId, {
              status: 'accepted',
              acknowledgement: {
                opId: acceptedRow.opId,
                commitId: event.commitId,
                seq: event.seq,
                entityVersions: [...merged.values()],
              },
              updatedAt: at,
            });
          }
        }
        if (acceptedOpIds.has(event.opId)) {
          const receipt = this.mergeAcknowledgement(
            ackByOp.get(event.opId) ?? null,
            event.opId,
            event,
          );
          ackByOp.set(event.opId, receipt);
          outboxUpdates.set(event.opId, {
            status: 'accepted',
            lastError: null,
            acknowledgement: receipt,
            updatedAt: at,
          });
        }
      }

      const ownCandidates =
        event.opId === undefined
          ? []
          : outbox.filter(
              (operation) =>
                operation.opId === event.opId &&
                operation.status !== 'accepted' &&
                operation.status !== 'rejected' &&
                !acceptedOpIds.has(operation.opId),
            );
      for (const operation of ownCandidates) {
        if (
          event.stationId !== undefined &&
          event.stationId !== operation.envelope.stationId
        ) {
          continue;
        }
        if (operation.attempts === 0 || !frozenEnvelopeIntact(operation)) {
          // An opId alone never proves this station sent these bytes.
          const prior = conflictWrites.get(operation.opId) ??
            this.storedConflictBox(conflicts.find((row) => row.opId === operation.opId));
          conflictWrites.set(operation.opId, {
            ...prior,
            conflicts: prior.conflicts ?? prior.entries ?? [],
            code: 'ENVELOPE_HASH_MISMATCH',
            message:
              'A pulled change carries this operation id but the frozen envelope bytes are not intact or were never sent; acceptance is not inferred.',
          });
          outboxUpdates.set(operation.opId, {
            status: 'conflict',
            lastError: 'ENVELOPE_HASH_MISMATCH',
            updatedAt: at,
          });
          continue;
        }
        const receipt = this.mergeAcknowledgement(
          ackByOp.get(operation.opId) ??
            parseStationAcknowledgement(operation.acknowledgement),
          operation.opId,
          event,
        );
        ackByOp.set(operation.opId, receipt);
        acceptedOpIds.add(operation.opId);
        outboxUpdates.set(operation.opId, {
          status: 'accepted',
          lastError: null,
          acknowledgement: receipt,
          updatedAt: at,
        });
      }

      for (const operation of pending) {
        if (acceptedOpIds.has(operation.opId)) continue;
        const declared = declaredRevisionOf(operation, event.entityType, event.entityId);
        if (declared === null || event.revision > declared) {
          const prior = conflictWrites.get(operation.opId) ??
            this.storedConflictBox(conflicts.find((row) => row.opId === operation.opId));
          const details = prior.conflicts ?? prior.entries ?? [];
          const detail: StationConflictDetail = {
            entityType: event.entityType,
            entityId: event.entityId,
            baseRevision: declared,
            currentRevision: event.revision,
            current: event.record,
          };
          conflictWrites.set(operation.opId, {
            ...prior,
            conflicts: [
              ...details.filter(
                (entry) =>
                  entry.entityType !== detail.entityType ||
                  entry.entityId !== detail.entityId,
              ),
              detail,
            ],
            writeKeys: prior.writeKeys,
            message: 'The server holds a newer revision for this operation.',
            code: 'SYNC_CONFLICT',
          });
          outboxUpdates.set(operation.opId, {
            status: 'conflict',
            lastError: 'SYNC_CONFLICT',
            updatedAt: at,
          });
        }
      }

      const applied = this.planBaseVersion(
        versionWrites,
        previousVersions,
        event.entityType,
        event.entityId,
        event.revision,
        event.record,
      );
      if (applied) {
        directRecords.push({
          entityType: event.entityType,
          entityId: event.entityId,
          revision: event.revision,
          record: event.record,
        });
      }
    }

    const remaining = outbox.filter(
      (operation) =>
        operation.status !== 'accepted' && !acceptedOpIds.has(operation.opId),
    );

    const unitOfWork = new PocketbaseUnitOfWork(this.pb);
    const appender = unitOfWork.metadataBatch();
    for (const [opId, update] of outboxUpdates) {
      const row = outbox.find((entry) => entry.opId === opId);
      if (row !== undefined) appender.update('obol_station_outbox', row.rowId, update);
    }

    if (remaining.length === 0) {
      for (const record of directRecords) {
        await this.planDirectWorkingRow(
          unitOfWork,
          working,
          record.entityType,
          record.entityId,
          record.record,
        );
      }
      await this.pruneUnsourcedLocalCreates(
        unitOfWork,
        working,
        versionWrites,
        previousVersions,
      );
    } else {
      const outcome = await this.replayOrConflict(
        versionWrites,
        previousVersions,
        working,
        remaining,
        conflictWrites,
        outboxUpdates,
        conflicts,
        ackByOp,
        at,
      );
      if (outcome !== null) {
        await this.planWorkingDiff(unitOfWork, working, outcome.rows);
        this.planReplayVersionRows(
          versionWrites,
          previousVersions,
          outcome.writesByOp,
        );
      }
    }

    this.planConflictRows(appender, conflictWrites, conflicts, at);
    this.flushVersionPlans(appender, versionWrites, previousVersions);

    const lastEvent = events[events.length - 1]!;
    await this.planStateUpsert(
      appender,
      {
        cursor: lastEvent.seq,
        lastChainHash: lastEvent.chainHash,
        serverUrl: state.binding.serverUrl,
        serverInstanceId: state.binding.serverInstanceId,
        ownerFingerprint: state.binding.ownerFingerprint,
        stationId: state.binding.stationId,
        dataEpoch: state.binding.dataEpoch,
        protocolVersion: state.binding.protocolVersion,
        mode: 'station',
      },
      undefined,
    );
    this.advanceDependents(appender, outbox, outboxUpdates, ackByOp, at);
    await this.assertOutboxUnchanged(outbox);
    await unitOfWork.executeCommit();
  }

  // -----------------------------------------------------------------------
  // Conflicts and rejected intent resolution
  // -----------------------------------------------------------------------

  async readConflicts(): Promise<readonly StationConflictSnapshot[]> {
    const rows = await this.listRows('obol_station_conflicts', 'createdAt,opId');
    return rows.map(decodeConflict);
  }

  /**
   * Resolves one explicit conflict. A retry creates a NEW opId for a frozen
   * envelope (bytes are never mutated after the first send); never-sent
   * dependents may be advanced in place. `blockQueued` leaves dependents
   * visibly conflicted; `rejectDependents` rejects the transitive dependent
   * set. The working dataset is then materialized again from the durable base
   * through the actual use cases.
   */
  async resolveConflict(input: {
    readonly opId: string;
    readonly resolution: 'useServer' | 'retryWithCurrentServerRevision' | 'discard';
    readonly dependents: 'blockQueued' | 'rejectDependents' | 'retryWithoutDependency';
    readonly at: string;
  }): Promise<void> {
    const previousVersions = await this.readVersionMap();
    const outbox = await this.readOutbox();
    const conflicts = await this.readConflicts();
    const working = await this.readWorkingMaps();
    const versionWrites = new Map<string, VersionPlan>();
    const conflictWrites = new Map<string, StoredConflictBox>();
    const outboxUpdates = new Map<string, PocketRecordRow>();
    const inserted: PocketRecordRow[] = [];
    const insertedSnapshots: StationOutboxSnapshot[] = [];
    const target = outbox.find((operation) => operation.opId === input.opId);
    if (target === undefined) {
      throw new StationSnapshotError('That pending operation no longer exists.');
    }
    const conflictRow = conflicts.find((row) => row.opId === input.opId);
    const details = conflictDetailsOf(conflictRow);
    const writeKeys = conflictWriteKeysOf(conflictRow);

    if (input.resolution === 'retryWithCurrentServerRevision') {
      const replacement = buildReplacementOperation(
        target,
        details,
        writeKeys,
        previousVersions,
      );
      inserted.push(encodeOutboxInsert(replacement, input.at));
      insertedSnapshots.push(replacement);
    }

    outboxUpdates.set(target.opId, {
      status: 'accepted',
      lastError:
        input.resolution === 'retryWithCurrentServerRevision'
          ? 'Replaced by a new operation with the current server revision.'
          : `Resolved without sending: ${input.resolution}.`,
      acknowledgement: null,
      updatedAt: input.at,
    });
    this.applyDependentPolicy(
      input.dependents,
      input.opId,
      outbox,
      outboxUpdates,
      inserted,
      insertedSnapshots,
      input.at,
    );

    const remaining = outbox.filter((operation) => {
      if (operation.opId === input.opId) return false;
      if (operation.status === 'accepted') return false;
      return outboxUpdates.get(operation.opId)?.['status'] !== 'accepted';
    });
    const replayPending = [...remaining, ...insertedSnapshots];
    const unitOfWork = new PocketbaseUnitOfWork(this.pb);
    const appender = unitOfWork.metadataBatch();
    for (const [opId, update] of outboxUpdates) {
      const row = outbox.find((entry) => entry.opId === opId);
      if (row !== undefined) appender.update('obol_station_outbox', row.rowId, update);
    }
    for (const insert of inserted) appender.create('obol_station_outbox', insert);
    if (conflictRow !== undefined) {
      appender.update('obol_station_conflicts', conflictRow.rowId, {
        resolution:
          input.resolution === 'retryWithCurrentServerRevision'
            ? 'retry'
            : input.resolution === 'useServer'
              ? 'server'
              : 'discarded',
        updatedAt: input.at,
      });
    }

    if (replayPending.length > 0) {
      const outcome = await this.replayOrConflict(
        versionWrites,
        previousVersions,
        working,
        replayPending,
        conflictWrites,
        outboxUpdates,
        conflicts,
        new Map(),
        input.at,
      );
      if (outcome !== null) {
        await this.planWorkingDiff(unitOfWork, working, outcome.rows);
        this.planReplayVersionRows(versionWrites, previousVersions, outcome.writesByOp);
      }
    } else {
      const final = this.baselineRows(versionWrites, previousVersions, working);
      await this.planWorkingDiff(unitOfWork, working, final);
    }

    this.planConflictRows(appender, conflictWrites, conflicts, input.at);
    this.flushVersionPlans(appender, versionWrites, previousVersions);
    await this.assertOutboxUnchanged(outbox);
    await unitOfWork.executeCommit();
  }

  /** Acknowledges one rejected operation and applies the dependent policy. */
  async acknowledgeRejected(input: {
    readonly opId: string;
    readonly dependents: 'blockQueued' | 'rejectDependents' | 'retryWithoutDependency';
    readonly at: string;
  }): Promise<void> {
    const previousVersions = await this.readVersionMap();
    const outbox = await this.readOutbox();
    const conflicts = await this.readConflicts();
    const working = await this.readWorkingMaps();
    const versionWrites = new Map<string, VersionPlan>();
    const conflictWrites = new Map<string, StoredConflictBox>();
    const outboxUpdates = new Map<string, PocketRecordRow>();
    const inserted: PocketRecordRow[] = [];
    const insertedSnapshots: StationOutboxSnapshot[] = [];
    const target = outbox.find((operation) => operation.opId === input.opId);
    if (target === undefined) {
      throw new StationSnapshotError('That rejected operation no longer exists.');
    }
    if (target.status !== 'rejected') {
      throw new StationSnapshotError(
        'Only a server-rejected operation can be acknowledged as rejected.',
      );
    }
    outboxUpdates.set(target.opId, {
      status: 'accepted',
      lastError: 'Rejected intent acknowledged by the user.',
      acknowledgement: null,
      updatedAt: input.at,
    });
    this.applyDependentPolicy(
      input.dependents,
      input.opId,
      outbox,
      outboxUpdates,
      inserted,
      insertedSnapshots,
      input.at,
    );

    const remaining = outbox.filter((operation) => {
      if (operation.opId === input.opId) return false;
      if (operation.status === 'accepted') return false;
      return outboxUpdates.get(operation.opId)?.['status'] !== 'accepted';
    });
    const replayPending = [...remaining, ...insertedSnapshots];
    const unitOfWork = new PocketbaseUnitOfWork(this.pb);
    const appender = unitOfWork.metadataBatch();
    for (const [opId, update] of outboxUpdates) {
      const row = outbox.find((entry) => entry.opId === opId);
      if (row !== undefined) appender.update('obol_station_outbox', row.rowId, update);
    }
    for (const insert of inserted) appender.create('obol_station_outbox', insert);

    if (replayPending.length > 0) {
      const outcome = await this.replayOrConflict(
        versionWrites,
        previousVersions,
        working,
        replayPending,
        conflictWrites,
        outboxUpdates,
        conflicts,
        new Map(),
        input.at,
      );
      if (outcome !== null) {
        await this.planWorkingDiff(unitOfWork, working, outcome.rows);
        this.planReplayVersionRows(versionWrites, previousVersions, outcome.writesByOp);
      }
    } else {
      const final = this.baselineRows(versionWrites, previousVersions, working);
      await this.planWorkingDiff(unitOfWork, working, final);
    }

    this.planConflictRows(appender, conflictWrites, conflicts, input.at);
    this.flushVersionPlans(appender, versionWrites, previousVersions);
    await this.assertOutboxUnchanged(outbox);
    await unitOfWork.executeCommit();
  }

  // -----------------------------------------------------------------------
  // Import adoption and destructive replacement
  // -----------------------------------------------------------------------

  /**
   * Adopts one accepted import in ONE local batch: revision-1 baseline for
   * every imported record under its fresh id, only covered old operations
   * retired, post-checkpoint local mutations preserved and replayed onto the
   * fresh ids, and no pull cursor advance.
   */
  async adoptImport(
    checkpoint: StationPendingImportCheckpoint,
    result: { readonly dataEpoch: SyncDataEpoch; readonly importId: string },
    at: string,
  ): Promise<void> {
    const state = await this.readState();
    if (state.pendingImport === null || state.pendingImport.importId !== checkpoint.importId) {
      throw new StationSnapshotError(
        'The pending import checkpoint is no longer the active one.',
      );
    }
    if (result.importId !== checkpoint.importId) {
      throw new StationSnapshotError('The import response names a different importId.');
    }
    if (
      state.binding.serverInstanceId !== checkpoint.identity.serverInstanceId ||
      state.binding.stationId !== checkpoint.identity.stationId
    ) {
      throw new StationSnapshotError(
        'The station binding changed while the import was in flight; refusing to adopt it.',
      );
    }

    const covered = new Set(checkpoint.coveredOpIds);
    const outbox = await this.readOutbox();
    const previousVersions = await this.readVersionMap();
    const working = await this.readWorkingMaps();
    const pendingAfterCheckpoint = outbox.filter(
      (operation) => !covered.has(operation.opId) && operation.status !== 'accepted',
    );
    const frozenAfterCheckpoint = pendingAfterCheckpoint.filter(
      (operation) => operation.attempts > 0,
    );
    if (frozenAfterCheckpoint.length > 0) {
      throw new StationSnapshotError(
        'A post-checkpoint operation was already sent; the import cannot rewrite a frozen envelope. Export and choose explicitly.',
      );
    }

    const idMap = checkpoint.idMap;
    const versionWrites = new Map<string, VersionPlan>();
    const importedBaseline = emptyRowMap();

    for (const entityType of SYNC_ENTITY_TYPES) {
      const collection = SYNC_COLLECTIONS[entityType];
      const mapping = idMap[entityType];
      const baselineRows = checkpoint.request.snapshot[collection];
      const baselineById = new Map<string, SyncJsonObject>();
      for (const row of baselineRows) {
        const rowBox = recordOf(row, `${collection} frozen snapshot row`);
        baselineById.set(String(rowBox['id']), stationSnapshotRow(entityType, rowBox));
      }
      for (const [oldId, freshId] of Object.entries(mapping)) {
        const baseline = baselineById.get(freshId);
        if (baseline === undefined) {
          throw new StationSnapshotError(
            `The frozen import snapshot has no ${collection}/${freshId}.`,
          );
        }
        importedBaseline.get(collection)!.set(freshId, { ...baseline });
        const oldVersion = previousVersions.get(entityKey(entityType, oldId));
        versionWrites.set(entityKey(entityType, freshId), {
          rowId: null,
          entityType,
          entityId: freshId,
          localRevision: oldVersion?.localRevision ?? 0,
          serverRevision: 1,
          serverDeleted: false,
          baseRecord: baseline,
          deleted: false,
        });
        if (oldVersion !== undefined) {
          versionWrites.set(entityKey(entityType, oldId), {
            ...oldVersion,
            retire: true,
            deleted: true,
          });
        }
      }
    }

    // Rewrite only never-sent post-checkpoint intents onto the fresh ids.
    const rewritten: StationOutboxSnapshot[] = [];
    const outboxUpdates = new Map<string, PocketRecordRow>();
    const conflictWrites = new Map<string, StoredConflictBox>();
    for (const operation of pendingAfterCheckpoint) {
      const patch = rewritePendingOperation(operation, idMap, covered, at);
      outboxUpdates.set(operation.opId, patch);
      rewritten.push(applyOutboxPatch(operation, patch, at));
    }

    let outcome: ReplayOutcome | null = null;
    if (rewritten.length > 0) {
      outcome = await this.replayOrConflict(
        versionWrites,
        new Map([...previousVersions].filter(([key]) => {
          const identity = entityIdentityOf(key);
          return identity === null || idMap[identity.entityType][identity.entityId] === undefined;
        })),
        importedBaseline,
        rewritten,
        conflictWrites,
        outboxUpdates,
        await this.readConflicts(),
        new Map(),
        at,
        true,
      );
      if (outcome === null) {
        // An accepted import cannot be rolled back by the server; keep the
        // checkpoint and let the user resolve explicitly instead of
        // fabricating a partial post-checkpoint dataset.
        throw new StationSnapshotError(
          'The accepted import cannot materialize a post-checkpoint intent through its use case; the checkpoint is preserved. Resolve the reported conflict explicitly.',
        );
      }
    }

    const unitOfWork = new PocketbaseUnitOfWork(this.pb);
    const appender = unitOfWork.metadataBatch();
    for (const [opId, update] of outboxUpdates) {
      const row = outbox.find((entry) => entry.opId === opId);
      if (row !== undefined) appender.update('obol_station_outbox', row.rowId, update);
    }

    // Retire exactly the operations covered by the settled snapshot; their
    // rows stay as terminal history and never push again.
    for (const operation of outbox) {
      if (!covered.has(operation.opId)) continue;
      appender.update('obol_station_outbox', operation.rowId, {
        status: 'accepted',
        lastError: `Covered by snapshot import ${checkpoint.importId}.`,
        acknowledgement: null,
        updatedAt: at,
      });
    }
    for (const conflict of await this.readConflicts()) {
      if (!covered.has(conflict.opId)) continue;
      appender.update('obol_station_conflicts', conflict.rowId, {
        resolution: 'discarded',
        updatedAt: at,
      });
    }

    const final = outcome === null
      ? cloneRowMap(importedBaseline)
      : outcome.rows;
    await this.planWorkingDiff(unitOfWork, working, final);
    if (outcome !== null) {
      this.planReplayVersionRows(versionWrites, previousVersions, outcome.writesByOp);
    }
    this.planConflictRows(appender, conflictWrites, await this.readConflicts(), at);
    this.flushVersionPlans(appender, versionWrites, previousVersions);
    await this.planStateUpsert(
      appender,
      {
        serverUrl: checkpoint.identity.serverUrl,
        serverInstanceId: checkpoint.identity.serverInstanceId,
        ownerFingerprint: checkpoint.identity.ownerFingerprint,
        stationId: checkpoint.identity.stationId,
        dataEpoch: result.dataEpoch,
        protocolVersion: checkpoint.identity.protocolVersion,
        mode: 'station',
      },
      null,
    );
    await this.assertOutboxUnchanged(outbox);
    await unitOfWork.executeCommit();
  }

  /**
   * REPLACE/discard path: clears local finance rows and retires station sync
   * rows before a new binding is adopted. Destructive by explicit user choice
   * only, after a completed export receipt. Finance deletes are bounded
   * batches, so a crash can leave a partially cleared local store that is
   * safe to clear again; it never touches the remote server.
   */
  async replaceLocalDataWithBinding(binding: StationBinding): Promise<void> {
    const snapshot = await this.readSnapshot();
    for (const entityType of SYNC_ENTITY_TYPES) {
      const collection = SYNC_COLLECTIONS[entityType];
      const ids = snapshot[collection].map((row) =>
        String(recordOf(row, `${collection} row`)['id']),
      );
      const chunk = 500;
      for (let index = 0; index < ids.length; index += chunk) {
        const unitOfWork = new PocketbaseUnitOfWork(this.pb);
        for (const id of ids.slice(index, index + chunk)) {
          unitOfWork.collection(collection).delete(id);
        }
        await unitOfWork.executeCommit();
      }
    }

    const unitOfWork = new PocketbaseUnitOfWork(this.pb);
    const appender = unitOfWork.metadataBatch();
    const at = new Date().toISOString();
    for (const operation of await this.readOutbox()) {
      if (operation.status === 'accepted') continue;
      appender.update('obol_station_outbox', operation.rowId, {
        status: 'accepted',
        lastError: 'Retired by REPLACE with the exported local dataset.',
        acknowledgement: null,
        updatedAt: at,
      });
    }
    for (const conflict of await this.readConflicts()) {
      if (conflict.resolution !== 'pending') continue;
      appender.update('obol_station_conflicts', conflict.rowId, {
        resolution: 'discarded',
        updatedAt: at,
      });
    }
    for (const plan of (await this.readVersionMap()).values()) {
      if (plan.rowId === null) continue;
      appender.update('obol_station_versions', plan.rowId, {
        deleted: true,
        serverDeleted: true,
        baseRecord: null,
        serverRevision: null,
      });
    }
    await this.planStateUpsert(appender, binding, null);
    await unitOfWork.executeCommit();
  }

  // -----------------------------------------------------------------------
  // Replay: authoritative base + pending intents -> working rows
  // -----------------------------------------------------------------------

  /**
   * Materializes the working data from the durable base and every pending
   * intent through the actual scoped use cases. A replay failure is converted
   * into a typed conflict on the offending intent and preserves the current
   * working rows untouched (the caller receives `null` and commits no finance
   * diff), so a deleted reference or an id collision never wipes data.
   */
  private async replayOrConflict(
    versionWrites: Map<string, VersionPlan>,
    previousVersions: ReadonlyMap<string, VersionPlan>,
    working: CollectionRowMap,
    pending: readonly StationOutboxSnapshot[],
    conflictWrites: Map<string, StoredConflictBox>,
    outboxUpdates: Map<string, PocketRecordRow>,
    conflicts: readonly StationConflictSnapshot[],
    acks: Map<string, StationAcknowledgement>,
    at: string,
    suppressRebaseConflicts = false,
  ): Promise<ReplayOutcome | null> {
    let outcome: ReplayOutcome;
    try {
      outcome = await this.replayPendingIntents(
        versionWrites,
        previousVersions,
        working,
        pending,
      );
    } catch (error) {
      if (error instanceof StationReplayError) {
        const prior = conflictWrites.get(error.opId) ??
          this.storedConflictBox(conflicts.find((row) => row.opId === error.opId));
        conflictWrites.set(error.opId, {
          ...prior,
          conflicts: prior.conflicts ?? prior.entries ?? [],
          code: error.code,
          message: error.message,
        });
        outboxUpdates.set(error.opId, {
          status: 'conflict',
          lastError: `${error.code}: ${error.message}`,
          updatedAt: at,
        });
        return null;
      }
      throw error;
    }

    if (!suppressRebaseConflicts) {
      this.markRebasedConflicts(
        outcome,
        pending,
        versionWrites,
        previousVersions,
        conflictWrites,
        outboxUpdates,
        conflicts,
        acks,
        at,
      );
    }
    return outcome;
  }

  /**
   * After a replay, every entity whose authoritative base changed since the
   * pending intent was recorded marks that intent conflicted: it is a
   * tentative working result, never a silent rebase or a last-writer-wins
   * overwrite. A change causally produced by an operation this intent already
   * depends on advances it instead.
   */
  private markRebasedConflicts(
    outcome: ReplayOutcome,
    pending: readonly StationOutboxSnapshot[],
    versionWrites: Map<string, VersionPlan>,
    previousVersions: ReadonlyMap<string, VersionPlan>,
    conflictWrites: Map<string, StoredConflictBox>,
    outboxUpdates: Map<string, PocketRecordRow>,
    conflicts: readonly StationConflictSnapshot[],
    acks: ReadonlyMap<string, StationAcknowledgement>,
    at: string,
  ): void {
    const acceptedCausal = new Map<string, ReadonlySet<string>>();
    for (const [opId, receipt] of acks) {
      acceptedCausal.set(
        opId,
        new Set(
          receipt.entityVersions.map((version) =>
            entityKey(version.entityType, version.entityId),
          ),
        ),
      );
    }

    for (const operation of pending) {
      if (operation.status === 'conflict' || operation.status === 'rejected') continue;
      const updatedStatus = outboxUpdates.get(operation.opId)?.['status'];
      if (
        updatedStatus === 'conflict' ||
        updatedStatus === 'accepted' ||
        updatedStatus === 'rejected'
      ) {
        continue;
      }
      const keys = outcome.writesByOp.get(operation.opId) ?? [];
      for (const key of keys) {
        const identity = entityIdentityOf(key);
        if (identity === null) continue;
        const previous = previousVersions.get(key);
        const next = versionWrites.get(key) ?? previousVersions.get(key);
        const previousRevision = previous?.serverRevision ?? null;
        const nextRevision = next?.serverRevision ?? null;
        const declared = revisionMapOf(operation.envelope.baseRevisions)[key] ?? null;
        const changed = previousRevision !== nextRevision;
        const staleDeclared =
          declared !== null && nextRevision !== null && declared !== nextRevision;
        if (!changed && !staleDeclared) continue;
        // An intent rewritten onto the just-adopted import baseline is a
        // deliberate rebase of that checkpoint, not an unrelated change.
        if (previousRevision === null && declared !== null && declared === nextRevision) {
          continue;
        }

        const causal = operation.dependsOn.some((dependency) =>
          acceptedCausal.get(dependency)?.has(key) === true,
        );
        if (causal) continue;

        const prior = conflictWrites.get(operation.opId) ??
          this.storedConflictBox(conflicts.find((row) => row.opId === operation.opId));
        const details = prior.conflicts ?? prior.entries ?? [];
        const detail: StationConflictDetail = {
          entityType: identity.entityType,
          entityId: identity.entityId,
          baseRevision: declared,
          currentRevision: nextRevision ?? 0,
          current: next?.baseRecord ?? null,
        };
        conflictWrites.set(operation.opId, {
          ...prior,
          conflicts: [
            ...details.filter(
              (entry) =>
                entry.entityType !== detail.entityType ||
                entry.entityId !== detail.entityId,
            ),
            detail,
          ],
          writeKeys: keys,
          message:
            'The server changed an entity this pending change depends on; choose explicitly before it is sent.',
          code: 'SYNC_CONFLICT',
        });
        outboxUpdates.set(operation.opId, {
          status: 'conflict',
          lastError: 'SYNC_CONFLICT',
          updatedAt: at,
        });
        break;
      }
    }
  }

  /**
   * Replays every pending intent in durable creation order through the real
   * scoped use cases. The fork reads the authoritative base and buffers every
   * write; nothing reaches PocketBase here.
   */
  private async replayPendingIntents(
    versionWrites: ReadonlyMap<string, VersionPlan>,
    previousVersions: ReadonlyMap<string, VersionPlan>,
    working: CollectionRowMap,
    pending: readonly StationOutboxSnapshot[],
  ): Promise<ReplayOutcome> {
    const baseline = this.baselineRows(versionWrites, previousVersions, working);
    const mergedVersions = new Map(previousVersions);
    for (const [key, version] of versionWrites) mergedVersions.set(key, version);
    const idPools = this.replayIdPools(baseline, working, mergedVersions, pending);
    let currentOpId = '';
    let mintOrdinal = 0;
    const fork = new PocketbaseUnitOfWork(this.pb, {
      replayBaseline: this.baselineReader(baseline, idPools, () => currentOpId),
      mintEntityId: () => {
        mintOrdinal += 1;
        return replayEntityId(currentOpId, mintOrdinal);
      },
    });

    const writesByOp = new Map<string, readonly string[]>();
    let previousWrites = new Map<string, string>();

    for (const operation of pending) {
      currentOpId = operation.opId;
      mintOrdinal = 0;
      const clock: SyncClock = { now: () => operation.envelope.effectiveAt };
      try {
        const scope = this.replayRuntime.scopeFor(fork, clock);
        await this.applyPendingOperation(scope, operation.envelope);
      } catch (error) {
        fork.discard();
        throw new StationReplayError(
          operation.opId,
          'REPLAY_UNAVAILABLE',
          `${operation.envelope.type}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      const writes = fork.bufferedRowWrites();
      const currentWrites = new Map<string, string>();
      for (const write of writes) {
        currentWrites.set(
          entityKey(write.entityType, write.recordId),
          write.record === null
            ? 'null'
            : canonicalHash(toSyncJsonObject(write.record, 'replayed write record')),
        );
      }
      const written: string[] = [];
      for (const [key, hash] of currentWrites) {
        if (previousWrites.get(key) !== hash) written.push(key);
      }
      writesByOp.set(operation.opId, written);
      previousWrites = currentWrites;
    }

    const rows = cloneRowMap(baseline);
    for (const write of fork.bufferedRowWrites()) {
      const collection = SYNC_COLLECTIONS[write.entityType];
      const rowsOfCollection = rows.get(collection)!;
      if (write.kind === 'delete' || write.record === null) {
        rowsOfCollection.delete(write.recordId);
      } else {
        rowsOfCollection.set(write.recordId, { ...write.record });
      }
    }
    return { rows, writesByOp };
  }

  /**
   * Deterministic side-effect id pool. Local-create rows are the durable write
   * keys of pending intents; ids that a later intent already names are
   * assigned first so that intent keeps resolving after replay. Unused ids
   * follow in ascending order. A create without a pool id gets a stable hash
   * id derived from its operation.
   */
  private replayIdPools(
    baseline: CollectionRowMap,
    working: CollectionRowMap,
    versions: ReadonlyMap<string, VersionPlan>,
    pending: readonly StationOutboxSnapshot[],
  ): ReplayIdPools {
    const claimed = new Set<string>();
    const referenceOrder = new Map<string, number>();
    const payloadTargets: Readonly<Record<string, SyncEntityType>> = {
      account_id: 'account',
      destination_account_id: 'account',
      card_id: 'card',
      category_id: 'category',
      project_id: 'project',
      recurrence_id: 'recurrence',
      invoice_id: 'invoice',
    };
    const remember = (key: string): void => {
      if (!referenceOrder.has(key)) referenceOrder.set(key, referenceOrder.size + 1);
    };
    for (const operation of pending) {
      if (
        operation.envelope.type === 'account.create' ||
        operation.envelope.type === 'card.create' ||
        operation.envelope.type === 'category.create' ||
        operation.envelope.type === 'project.create' ||
        operation.envelope.type === 'recurrence.create' ||
        operation.envelope.type === 'transaction.create'
      ) {
        claimed.add(operationKey(operation));
      }
      remember(operationKey(operation));
      for (const snapshot of operation.beforeSnapshots) {
        remember(entityKey(snapshot.entityType, snapshot.entityId));
      }
      for (const [field, value] of Object.entries(operation.envelope.payload)) {
        const targetType = payloadTargets[field];
        if (targetType !== undefined && typeof value === 'string' && isSyncEntityId(value)) {
          remember(entityKey(targetType, value));
        }
      }
      for (const key of Object.keys(revisionMapOf(operation.envelope.baseRevisions))) {
        remember(key);
      }
    }

    const hints = new Map<string, Map<SyncCollectionName, string[]>>();
    const hintId = (creatorOpId: string, collection: SyncCollectionName, id: string): void => {
      const byCollection = hints.get(creatorOpId) ?? new Map<SyncCollectionName, string[]>();
      const list = byCollection.get(collection) ?? [];
      list.push(id);
      byCollection.set(collection, list);
      hints.set(creatorOpId, byCollection);
    };
    const isLocalCreate = (entityType: SyncEntityType, entityId: string): boolean =>
      versions.get(entityKey(entityType, entityId))?.serverRevision == null;

    for (const target of pending) {
      const targetType = target.envelope.entityType;
      if (targetType !== 'transaction' && targetType !== 'invoice') continue;
      if (!isLocalCreate(targetType, target.envelope.entityId)) continue;
      const snapshot = target.beforeSnapshots.find(
        (entry) =>
          entry.entityType === targetType &&
          entry.entityId === target.envelope.entityId,
      );
      const record = snapshot?.record ?? null;
      if (record === null) continue;

      let creators: StationOutboxSnapshot[] = [];
      if (targetType === 'transaction') {
        creators = pending.filter((operation) => {
          if (operation.envelope.type === 'invoice.pay') {
            return (
              record['invoice_id'] === operation.envelope.entityId &&
              normalizeStoredTimestamp(record['realized_date']) ===
                operation.envelope.effectiveAt
            );
          }
          if (operation.envelope.type === 'project.payment') {
            return (
              record['project_id'] === operation.envelope.entityId &&
              normalizeStoredTimestamp(record['expected_date']) ===
                operation.envelope.effectiveAt
            );
          }
          if (operation.envelope.type === 'recurrence.launch') {
            return record['recurrence_id'] === operation.envelope.entityId;
          }
          return false;
        });
      } else {
        creators = pending.filter((operation) => {
          if (
            operation.envelope.type === 'transaction.create' ||
            operation.envelope.type === 'transaction.update'
          ) {
            return operation.envelope.payload.card_id === record['card_id'];
          }
          if (operation.envelope.type === 'recurrence.launch') {
            const recurrence = working
              .get(SYNC_COLLECTIONS.recurrence)
              ?.get(operation.envelope.entityId);
            return (
              recurrence?.['card_id'] === record['card_id'] ||
              versions.get(entityKey('recurrence', operation.envelope.entityId))
                ?.baseRecord?.['card_id'] === record['card_id']
            );
          }
          return false;
        });
      }
      if (creators.length === 1) {
        hintId(creators[0]!.opId, SYNC_COLLECTIONS[targetType], target.envelope.entityId);
      }
    }

    const hinted = new Set<string>();
    for (const byCollection of hints.values()) {
      for (const [collection, ids] of byCollection) {
        for (const id of ids) hinted.add(`${collection}:${id}`);
      }
    }

    const pools = new Map<SyncCollectionName, string[]>();
    for (const entityType of SYNC_ENTITY_TYPES) {
      const collection = SYNC_COLLECTIONS[entityType];
      const baselineIds = new Set(baseline.get(collection)?.keys() ?? []);
      const localCreates = [...(working.get(collection)?.keys() ?? [])].filter((id) => {
        if (baselineIds.has(id)) return false;
        if (hinted.has(`${collection}:${id}`)) return false;
        const key = entityKey(entityType, id);
        if (claimed.has(key)) return false;
        const version = versions.get(key);
        return version !== undefined && version.serverRevision == null;
      });
      localCreates.sort((left, right) => {
        const leftKey = entityKey(entityType, left);
        const rightKey = entityKey(entityType, right);
        const leftOrder = referenceOrder.get(leftKey);
        const rightOrder = referenceOrder.get(rightKey);
        if (leftOrder !== undefined || rightOrder !== undefined) {
          return (leftOrder ?? Number.MAX_SAFE_INTEGER) - (rightOrder ?? Number.MAX_SAFE_INTEGER);
        }
        // No later intent names these ids; their durable creation order is
        // the order the original commits created them in.
        const leftCreated = String(working.get(collection)?.get(left)?.['created'] ?? '');
        const rightCreated = String(working.get(collection)?.get(right)?.['created'] ?? '');
        if (leftCreated !== rightCreated) return leftCreated < rightCreated ? -1 : 1;
        return left < right ? -1 : left > right ? 1 : 0;
      });
      pools.set(collection, localCreates);
    }
    return { pools, hints };
  }

  private baselineReader(
    baseline: CollectionRowMap,
    idPools: ReplayIdPools,
    currentOpId: () => string,
  ): ReplayBaseline {
    return {
      getRecord: (collectionName, id) =>
        baseline.get(collectionName)?.get(id) ?? null,
      listRecords: (collectionName) =>
        [...(baseline.get(collectionName)?.values() ?? [])],
      preferredCreateId: (collectionName) => {
        const hinted = idPools.hints.get(currentOpId())?.get(collectionName);
        if (hinted !== undefined && hinted.length > 0) return hinted.shift()!;
        const pool = idPools.pools.get(collectionName);
        if (pool === undefined || pool.length === 0) return null;
        return pool.shift()!;
      },
    };
  }

  /**
   * Executes the exact operation-to-use-case mapping of the shared push
   * executor against the replay scope. No financial rule is duplicated.
   */
  private async applyPendingOperation(
    scope: AwilixContainer,
    operation: SyncOperationWire,
  ): Promise<unknown> {
    switch (operation.type) {
      case 'account.create':
        return await resolveUseCase(scope, 'createAccountUseCase').execute({
          ...operation.payload,
          id: operation.entityId,
        });
      case 'card.create':
        return await resolveUseCase(scope, 'createCardUseCase').execute({
          ...operation.payload,
          id: operation.entityId,
        });
      case 'card.update':
        return await resolveUseCase(scope, 'updateCardUseCase').execute(
          operation.entityId,
          operation.payload,
        );
      case 'category.create':
        return await resolveUseCase(scope, 'createCategoryUseCase').execute({
          ...operation.payload,
          id: operation.entityId,
        });
      case 'project.create':
        return await resolveUseCase(scope, 'createProjectUseCase').execute({
          ...operation.payload,
          id: operation.entityId,
        });
      case 'project.payment':
        return await resolveUseCase(scope, 'registerPaymentUseCase').execute(
          operation.entityId,
          operation.payload,
        );
      case 'project.complete':
        return await resolveUseCase(scope, 'completeProjectUseCase').execute(
          operation.entityId,
        );
      case 'recurrence.create': {
        const { skipped_periods: skippedPeriods, ...fields } = operation.payload;
        const input: Partial<Recurrence> = {
          ...fields,
          id: operation.entityId,
          ...(skippedPeriods === undefined
            ? {}
            : { skipped_periods: [...skippedPeriods] }),
        };
        return await resolveUseCase(scope, 'createRecurrenceUseCase').execute(input);
      }
      case 'recurrence.update':
        return await resolveUseCase(scope, 'updateRecurrenceUseCase').execute(
          operation.entityId,
          operation.payload,
        );
      case 'recurrence.delete':
        return await resolveUseCase(scope, 'deleteRecurrenceUseCase').execute(
          operation.entityId,
        );
      case 'recurrence.toggleStatus':
        return await resolveUseCase(scope, 'toggleRecurrenceStatusUseCase').execute(
          operation.entityId,
          operation.payload.status,
        );
      case 'recurrence.launch':
        // The operation clock is `effectiveAt`, so the use case recomputes
        // exactly the month the offline launch targeted.
        return await resolveUseCase(scope, 'launchRecurrenceUseCase').execute(
          operation.entityId,
        );
      case 'transaction.create':
        return await resolveUseCase(scope, 'createTransactionUseCase').execute({
          ...operation.payload,
          id: operation.entityId,
        });
      case 'transaction.update':
        return await resolveUseCase(scope, 'updateTransactionUseCase').execute(
          operation.entityId,
          operation.payload,
        );
      case 'transaction.realize':
        return await resolveUseCase(scope, 'realizeTransactionUseCase').execute(
          operation.entityId,
          operation.payload,
        );
      case 'transaction.delete':
        return await resolveUseCase(scope, 'deleteTransactionUseCase').execute(
          operation.entityId,
        );
      case 'invoice.pay': {
        if (!/^\d{4}-\d{2}$/.test(operation.payload.period)) {
          throw new StationSnapshotError('The invoice period must be YYYY-MM.');
        }
        const invoices = scope.resolve<InvoiceRepository>('invoiceRepository');
        const invoice = await invoices.findById(operation.entityId);
        if (invoice.period !== operation.payload.period) {
          throw new StationSnapshotError(
            `Invoice ${operation.entityId} is period ${invoice.period}, not ${operation.payload.period}.`,
          );
        }
        return await resolveUseCase(scope, 'payInvoiceUseCase').execute({
          cardId: invoice.card_id,
          period: invoice.period,
          accountId: operation.payload.account_id,
          amountPaid: operation.payload.amount_paid,
          ignoreBalance: operation.payload.ignore_balance,
        });
      }
      case 'invoice.delete': {
        if (
          !isSyncEntityId(operation.payload.card_id) ||
          !/^\d{4}-\d{2}$/.test(operation.payload.period)
        ) {
          throw new StationSnapshotError(
            'invoice.delete requires a canonical card id and a YYYY-MM period.',
          );
        }
        const invoices = scope.resolve<InvoiceRepository>('invoiceRepository');
        const invoice = await invoices.findByPeriodAndCard(
          operation.payload.card_id,
          operation.payload.period,
        );
        if (invoice === null) {
          throw new StationSnapshotError(
            `Invoice for period ${operation.payload.period} was not found.`,
          );
        }
        if (invoice.id !== operation.entityId) {
          throw new StationSnapshotError(
            `Invoice ${operation.payload.card_id}/${operation.payload.period} is not ${operation.entityId}.`,
          );
        }
        return await resolveUseCase(scope, 'deleteInvoiceUseCase').execute(
          operation.payload.card_id,
          operation.payload.period,
        );
      }
      default: {
        const exhaustive: never = operation;
        throw new StationSnapshotError(
          `Unsupported operation ${String(exhaustive)} during replay.`,
        );
      }
    }
  }

  /**
   * Removes optimistic local-create rows that no pending intent sources after
   * an accepted operation replaced the authoritative dataset. Such a row is a
   * client-side side effect whose server counterpart arrived under a different
   * id; keeping it would duplicate the fact. It only runs when no pending
   * intent remains, so a replayable local create is never touched.
   */
  private async pruneUnsourcedLocalCreates(
    unitOfWork: PocketbaseUnitOfWork,
    working: CollectionRowMap,
    versionWrites: Map<string, VersionPlan>,
    previousVersions: ReadonlyMap<string, VersionPlan>,
  ): Promise<void> {
    for (const entityType of SYNC_ENTITY_TYPES) {
      const collection = SYNC_COLLECTIONS[entityType];
      for (const id of working.get(collection)?.keys() ?? []) {
        const key = entityKey(entityType, id);
        const version = versionWrites.get(key) ?? previousVersions.get(key);
        if (version === undefined || version.serverRevision != null) continue;
        try {
          await unitOfWork.collection(collection).delete(id);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
        versionWrites.set(key, { ...version, retire: true, deleted: true });
      }
    }
  }

  /**
   * Authoritative rows: accepted server base records plus legacy working rows
   * that have no version row yet. A local-only create stays out because the
   * pending intent recreates it.
   */
  private baselineRows(
    versionWrites: ReadonlyMap<string, VersionPlan>,
    previousVersions: ReadonlyMap<string, VersionPlan>,
    working: CollectionRowMap,
  ): CollectionRowMap {
    const baseline = emptyRowMap();
    const versioned = new Set<string>();
    const merged = new Map(previousVersions);
    for (const [key, version] of versionWrites) merged.set(key, version);
    for (const [key, version] of merged) {
      versioned.add(key);
      const collection = SYNC_COLLECTIONS[version.entityType];
      const rows = baseline.get(collection)!;
      if (version.serverDeleted === true) continue;
      if (version.baseRecord !== undefined && version.baseRecord !== null) {
        rows.set(version.entityId, { ...version.baseRecord });
        continue;
      }
      if (version.serverRevision != null) {
        const workingRow = working.get(collection)?.get(version.entityId);
        if (workingRow !== undefined) rows.set(version.entityId, { ...workingRow });
      }
    }
    for (const entityType of SYNC_ENTITY_TYPES) {
      const collection = SYNC_COLLECTIONS[entityType];
      for (const [id, row] of working.get(collection) ?? []) {
        if (versioned.has(entityKey(entityType, id))) continue;
        baseline.get(collection)!.set(id, { ...row });
      }
    }
    return baseline;
  }

  // -----------------------------------------------------------------------
  // Working diff and direct application
  // -----------------------------------------------------------------------

  /** Applies one authoritative record directly when no pending intent exists. */
  private async planDirectWorkingRow(
    unitOfWork: PocketbaseUnitOfWork,
    working: CollectionRowMap,
    entityType: SyncEntityType,
    entityId: SyncEntityId,
    record: SyncJsonObject | null,
  ): Promise<void> {
    const collection = SYNC_COLLECTIONS[entityType];
    const hasWorking = working.get(collection)?.has(entityId) === true;
    if (record === null) {
      if (!hasWorking) return;
      try {
        await unitOfWork.collection(collection).delete(entityId);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      return;
    }
    const body = snapshotBodyOf(entityType, record);
    if (hasWorking) {
      await unitOfWork.collection(collection).update(entityId, body);
    } else {
      await unitOfWork.collection(collection).create({ ...body, id: entityId });
    }
  }

  /**
   * Stages the final working dataset as one coalesced diff against the rows
   * currently stored. Nothing is deleted and recreated in intermediate
   * states: the caller's single batch carries the final writes.
   */
  private async planWorkingDiff(
    unitOfWork: PocketbaseUnitOfWork,
    working: CollectionRowMap,
    final: CollectionRowMap,
  ): Promise<void> {
    for (const entityType of SYNC_ENTITY_TYPES) {
      const collection = SYNC_COLLECTIONS[entityType];
      const current = working.get(collection) ?? new Map<string, PocketRecordRow>();
      const desired = final.get(collection) ?? new Map<string, PocketRecordRow>();

      for (const [id, row] of desired) {
        const existing = current.get(id);
        if (existing !== undefined && !declaredRowsDiffer(entityType, row, existing)) {
          continue;
        }
        const body = snapshotBodyOf(entityType, row);
        if (existing !== undefined) {
          await unitOfWork.collection(collection).update(id, body);
        } else {
          await unitOfWork.collection(collection).create({ ...body, id });
        }
      }

      for (const id of current.keys()) {
        if (desired.has(id)) continue;
        try {
          await unitOfWork.collection(collection).delete(id);
        } catch (error) {
          if (!isNotFound(error)) throw error;
        }
      }
    }
  }

  /** Adds version rows for entities a replay created that had none. */
  private planReplayVersionRows(
    versionWrites: Map<string, VersionPlan>,
    previousVersions: ReadonlyMap<string, VersionPlan>,
    writesByOp: ReadonlyMap<string, readonly string[]>,
  ): void {
    for (const keys of writesByOp.values()) {
      for (const key of keys) {
        if (versionWrites.has(key)) continue;
        const identity = entityIdentityOf(key);
        if (identity === null) continue;
        const previous = previousVersions.get(key);
        if (previous !== undefined) {
          versionWrites.set(key, {
            ...previous,
            serverRevision: previous.serverRevision ?? null,
          });
          continue;
        }
        versionWrites.set(key, {
          rowId: null,
          entityType: identity.entityType,
          entityId: identity.entityId,
          localRevision: 1,
          serverRevision: null,
          serverDeleted: false,
          baseRecord: null,
          deleted: false,
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal planning helpers
  // -----------------------------------------------------------------------

  private async listRows(
    collectionName: string,
    sort?: string,
  ): Promise<PocketRecordRow[]> {
    return (await this.pb.collection(collectionName).getFullList({
      ...(sort === undefined ? {} : { sort }),
      batch: 500,
    })) as unknown as PocketRecordRow[];
  }

  /** Full stored finance rows of all seven collections keyed by collection/id. */
  private async readWorkingMaps(): Promise<CollectionRowMap> {
    const rows = emptyRowMap();
    for (const entityType of SYNC_ENTITY_TYPES) {
      const collection = SYNC_COLLECTIONS[entityType];
      const stored = await this.listRows(collection, 'id');
      for (const row of stored) {
        rows.get(collection)!.set(String(row['id']), row);
      }
    }
    return rows;
  }

  /** Reads every local version row into `entityType:entityId` form. */
  private async readVersionMap(): Promise<Map<string, VersionPlan>> {
    const rows = await this.listRows('obol_station_versions');
    const versions = new Map<string, VersionPlan>();
    for (const row of rows) {
      const entityType = row['entityType'];
      const entityId = row['entityId'];
      if (typeof entityType !== 'string' || !isSyncEntityType(entityType)) continue;
      if (typeof entityId !== 'string') continue;
      versions.set(entityKey(entityType, entityId), {
        rowId: String(row['id']),
        entityType,
        entityId,
        localRevision:
          typeof row['localRevision'] === 'number' ? row['localRevision'] : 0,
        // PocketBase stores a blank number as `0`; that is "never accepted a
        // server revision", not revision zero.
        serverRevision:
          typeof row['serverRevision'] === 'number' && row['serverRevision'] >= 1
            ? row['serverRevision']
            : null,
        serverDeleted: row['serverDeleted'] === true,
        baseRecord: jsonObjectOf(
          row['baseRecord'],
          'obol_station_versions.baseRecord',
        ),
        deleted: row['deleted'] === true,
      });
    }
    return versions;
  }

  /** Plans one authoritative base override without touching local revision. */
  private planBaseVersion(
    changed: Map<string, VersionPlan>,
    previous: ReadonlyMap<string, VersionPlan>,
    entityType: SyncEntityType,
    entityId: SyncEntityId,
    revision: number,
    record: SyncJsonObject | null,
  ): boolean {
    const key = entityKey(entityType, entityId);
    const current = changed.get(key) ?? previous.get(key);
    const currentRevision = current?.serverRevision ?? null;
    if (currentRevision !== null && revision < currentRevision) {
      // The authoritative base never rewinds.
      return false;
    }
    changed.set(key, {
      rowId: current?.rowId ?? null,
      entityType,
      entityId,
      localRevision: current?.localRevision ?? 0,
      serverRevision: revision,
      serverDeleted: record === null,
      baseRecord: record,
      deleted: current?.deleted ?? false,
    });
    return true;
  }

  private flushVersionPlans(
    appender: SyncBatchAppender,
    plans: Map<string, VersionPlan>,
    existing: ReadonlyMap<string, VersionPlan>,
  ): void {
    for (const [key, plan] of plans) {
      const current = existing.get(key);
      const rowId = plan.rowId ?? current?.rowId ?? null;
      const body: PocketRecordRow = {
        entityType: plan.entityType,
        entityId: plan.entityId,
        localRevision: plan.retire === true ? 0 : plan.localRevision,
        deleted: plan.retire === true ? true : plan.deleted,
      };
      if (plan.retire === true) {
        body['serverRevision'] = null;
        body['serverDeleted'] = true;
        body['baseRecord'] = null;
      } else {
        if (plan.serverRevision !== undefined) {
          body['serverRevision'] = plan.serverRevision;
        }
        if (plan.serverDeleted !== undefined) body['serverDeleted'] = plan.serverDeleted;
        if (plan.baseRecord !== undefined) body['baseRecord'] = plan.baseRecord;
      }
      if (rowId === null || rowId === '') {
        appender.create('obol_station_versions', body);
      } else {
        appender.update('obol_station_versions', rowId, body);
      }
    }
  }

  private planConflictRows(
    appender: SyncBatchAppender,
    conflicts: Map<string, StoredConflictBox>,
    existing: readonly StationConflictSnapshot[],
    at: string,
  ): void {
    for (const [opId, box] of conflicts) {
      const row = existing.find((entry) => entry.opId === opId);
      const body: PocketRecordRow = {
        opId,
        conflict: box,
        resolution: 'pending',
        updatedAt: at,
      };
      if (row === undefined) {
        appender.create('obol_station_conflicts', { ...body, createdAt: at });
      } else {
        appender.update('obol_station_conflicts', row.rowId, body);
      }
    }
  }

  private storedConflictBox(
    row: StationConflictSnapshot | undefined,
  ): StoredConflictBox {
    if (row === undefined || row.conflict === null) return {};
    return row.conflict as unknown as StoredConflictBox;
  }

  private mergeAcknowledgement(
    previous: StationAcknowledgement | null,
    opId: string,
    event: {
      readonly entityType: SyncEntityType;
      readonly entityId: SyncEntityId;
      readonly revision: number;
      readonly commitId: string;
      readonly seq: number;
    },
  ): StationAcknowledgement {
    const versions = new Map(
      (previous?.entityVersions ?? []).map((version) => [
        entityKey(version.entityType, version.entityId),
        version,
      ]),
    );
    versions.set(entityKey(event.entityType, event.entityId), {
      entityType: event.entityType,
      entityId: event.entityId,
      revision: event.revision,
    });
    return {
      opId,
      commitId: event.commitId,
      seq: event.seq,
      entityVersions: [...versions.values()],
    };
  }

  /**
   * Advances never-sent dependent envelopes from accepted causal receipts.
   * Accepted rows stay as terminal history; a causal revision may add a key
   * the device's recorder did not know (server-computed side effects) but an
   * unrelated remote change is never rebased. A frozen dependent is never
   * rewritten.
   */
  private advanceDependents(
    appender: SyncBatchAppender,
    outbox: readonly StationOutboxSnapshot[],
    updates: Map<string, PocketRecordRow>,
    acks: Map<string, StationAcknowledgement>,
    at: string,
  ): void {
    const statusByOp = new Map<string, SyncOutboxStatus>();
    for (const operation of outbox) {
      statusByOp.set(operation.opId, operation.status);
    }
    for (const [opId, update] of updates) {
      const status = update['status'];
      if (typeof status === 'string') statusByOp.set(opId, status as SyncOutboxStatus);
    }
    const accepted = new Set<string>(acks.keys());
    const receipts = new Map<string, StationAcknowledgement>(acks);
    for (const operation of outbox) {
      if (operation.status !== 'accepted') continue;
      accepted.add(operation.opId);
      const stored = parseStationAcknowledgement(operation.acknowledgement);
      if (stored !== null && !receipts.has(operation.opId)) {
        receipts.set(operation.opId, stored);
      }
    }
    for (const [opId, status] of statusByOp) {
      if (status === 'accepted') accepted.add(opId);
    }

    for (const operation of outbox) {
      const status = statusByOp.get(operation.opId) ?? operation.status;
      if (status === 'accepted') continue;
      if (operation.attempts > 0) continue;
      const satisfied = operation.dependsOn.filter((opId) => accepted.has(opId));
      if (satisfied.length === 0) continue;
      const baseRevisions: Record<string, number> = {
        ...revisionMapOf(operation.envelope.baseRevisions),
      };
      for (const dependency of satisfied) {
        const receipt = receipts.get(dependency);
        if (receipt === undefined) continue;
        for (const version of receipt.entityVersions) {
          const key = entityKey(version.entityType, version.entityId);
          const current = baseRevisions[key];
          if (current === undefined || version.revision > current) {
            baseRevisions[key] = version.revision;
          }
        }
      }
      const envelope = stationOperationWire({
        ...operation.envelope,
        payload: toSyncJsonObject(operation.envelope.payload, 'operation payload'),
        baseRevisions,
        dependsOn: operation.dependsOn.filter((opId) => !accepted.has(opId)),
        payloadHash: operation.payloadHash,
      });
      appender.update('obol_station_outbox', operation.rowId, {
        baseRevisions,
        dependsOn: envelope.dependsOn,
        payloadHash: operationEnvelopeHash(envelope),
        updatedAt: at,
      });
    }
  }

  /** Applies the chosen dependent policy for one resolved/rejected operation. */
  private applyDependentPolicy(
    policy: 'blockQueued' | 'rejectDependents' | 'retryWithoutDependency',
    opId: string,
    outbox: readonly StationOutboxSnapshot[],
    updates: Map<string, PocketRecordRow>,
    inserted: PocketRecordRow[],
    insertedSnapshots: StationOutboxSnapshot[],
    at: string,
  ): void {
    const dependents = transitiveDependents(outbox, opId);
    for (const dependent of dependents) {
      if (policy === 'blockQueued') {
        updates.set(dependent.opId, {
          status: 'conflict',
          lastError: `Blocked by resolved operation ${opId}; resolve this dependent explicitly.`,
          updatedAt: at,
        });
        continue;
      }
      if (policy === 'rejectDependents') {
        updates.set(dependent.opId, {
          status: 'rejected',
          lastError: `Dependency ${opId} was resolved without applying this later operation.`,
          updatedAt: at,
        });
        continue;
      }
      const dependsOn = dependent.dependsOn.filter((entry) => entry !== opId);
      const envelope = stationOperationWire({
        ...dependent.envelope,
        payload: toSyncJsonObject(dependent.envelope.payload, 'dependent operation payload'),
        baseRevisions: revisionMapOf(dependent.envelope.baseRevisions),
        dependsOn,
        payloadHash: dependent.payloadHash,
      });
      if (dependent.attempts > 0) {
        const replacement = stationOperationWire({
          ...envelope,
          payload: toSyncJsonObject(envelope.payload, 'replacement operation payload'),
          baseRevisions: revisionMapOf(envelope.baseRevisions),
          opId: newOperationId(),
          payloadHash: dependent.payloadHash,
        });
        const replacementSnapshot: StationOutboxSnapshot = {
          ...dependent,
          opId: replacement.opId,
          envelope: replacement,
          payloadHash: operationEnvelopeHash(replacement),
          dependsOn,
          attempts: 0,
          status: 'queued',
          lastError: null,
        };
        inserted.push(encodeOutboxInsert(replacementSnapshot, at));
        insertedSnapshots.push(replacementSnapshot);
        updates.set(dependent.opId, {
          status: 'accepted',
          lastError: 'Replaced by a new operation after dependency resolution.',
          acknowledgement: null,
          updatedAt: at,
        });
      } else {
        updates.set(dependent.opId, {
          dependsOn,
          payloadHash: operationEnvelopeHash(envelope),
          status: 'queued',
          lastError: null,
          updatedAt: at,
        });
      }
    }
  }

  /**
   * Refuses to commit a plan built from a pending set that changed while the
   * replay was running. A concurrent local mutation means the financial rows
   * it wrote are not represented in `final`; discarding the unit of work and
   * retrying next cycle is the only safe outcome.
   */
  private async assertOutboxUnchanged(
    expected: readonly StationOutboxSnapshot[],
  ): Promise<void> {
    const current = await this.readOutbox();
    if (outboxSignature(current) !== outboxSignature(expected)) {
      throw new StationReplicaStaleError();
    }
  }
}

// ---------------------------------------------------------------------------
// Pure row/operation helpers
// ---------------------------------------------------------------------------

/** Adapts one stored outbox patch into a full in-memory operation snapshot. */
function applyOutboxPatch(
  operation: StationOutboxSnapshot,
  patch: PocketRecordRow,
  at: string,
): StationOutboxSnapshot {
  const entityId =
    typeof patch['entityId'] === 'string' ? patch['entityId'] : operation.envelope.entityId;
  const payload =
    jsonObjectOf(patch['payload'], 'rewritten operation payload') ??
    toSyncJsonObject(operation.envelope.payload, 'rewritten operation payload');
  const baseRevisions = revisionMapOf(patch['baseRevisions']);
  const dependsOn = Array.isArray(patch['dependsOn'])
    ? patch['dependsOn'].filter((entry): entry is string => typeof entry === 'string')
    : operation.dependsOn;
  const payloadHash = parseSyncSha256Hash(
    patch['payloadHash'],
    'rewritten operation payloadHash',
  );
  const envelope = stationOperationWire({
    ...operation.envelope,
    entityId,
    payload,
    baseRevisions,
    dependsOn,
    payloadHash,
  });
  return {
    ...operation,
    opId: envelope.opId,
    envelope,
    payloadHash,
    dependsOn,
    updatedAt: at,
  };
}

function buildReplacementOperation(
  operation: StationOutboxSnapshot,
  details: readonly StationConflictDetail[],
  writeKeys: readonly string[],
  versions: ReadonlyMap<string, VersionPlan>,
): StationOutboxSnapshot {
  const baseRevisions: Record<string, number> = {
    ...revisionMapOf(operation.envelope.baseRevisions),
  };
  for (const detail of details) {
    const key = entityKey(detail.entityType, detail.entityId);
    const stored = versions.get(key)?.serverRevision ?? null;
    baseRevisions[key] = stored !== null && stored > detail.currentRevision
      ? stored
      : detail.currentRevision;
  }
  for (const key of writeKeys) {
    if (baseRevisions[key] !== undefined) continue;
    const version = versions.get(key);
    if (version?.serverRevision != null) {
      baseRevisions[key] = version.serverRevision;
    }
  }
  const opId = newOperationId();
  const envelope = stationOperationWire({
    ...operation.envelope,
    payload: toSyncJsonObject(operation.envelope.payload, 'replacement operation payload'),
    opId,
    baseRevisions,
    dependsOn: [...operation.dependsOn],
    payloadHash: operation.payloadHash,
  });
  return {
    ...operation,
    opId,
    payloadHash: operationEnvelopeHash(envelope),
    envelope,
    attempts: 0,
    status: 'queued',
    lastError: null,
  };
}

function encodeOutboxInsert(
  operation: StationOutboxSnapshot,
  at: string,
): PocketRecordRow {
  return {
    opId: operation.envelope.opId,
    protocolVersion: operation.envelope.protocolVersion,
    type: operation.envelope.type,
    entityType: operation.envelope.entityType,
    entityId: operation.envelope.entityId,
    payload: operation.envelope.payload,
    payloadHash: operationEnvelopeHash(operation.envelope),
    baseRevisions: operation.envelope.baseRevisions,
    dependsOn: operation.envelope.dependsOn,
    effectiveAt: operation.envelope.effectiveAt,
    clientCreatedAt: operation.envelope.clientCreatedAt,
    beforeSnapshots: operation.beforeSnapshots,
    status: operation.status,
    attempts: 0,
    lastError: operation.lastError,
    createdAt: operation.createdAt || at,
    updatedAt: at,
  };
}

/**
 * Rewrites one never-sent post-checkpoint operation onto fresh imported ids
 * and removes dependencies on covered operations. Recomputes the complete
 * envelope hash; the opId stays because this envelope was never sent.
 */
function rewritePendingOperation(
  operation: StationOutboxSnapshot,
  idMap: StationIdMap,
  covered: ReadonlySet<string>,
  at: string,
): PocketRecordRow {
  const entityType = operation.envelope.entityType;
  const entityId =
    idMap[entityType][operation.envelope.entityId] ?? operation.envelope.entityId;
  const payload = rewriteStationRecordReferences(
    entityType,
    toSyncJsonObject(operation.envelope.payload, 'pending operation payload'),
    idMap,
  );
  const baseRevisions: Record<string, number> = {};
  for (const [key, revision] of Object.entries(
    revisionMapOf(operation.envelope.baseRevisions),
  )) {
    const identity = entityIdentityOf(key);
    if (identity !== null) {
      const mapped = idMap[identity.entityType][identity.entityId];
      if (mapped !== undefined) {
        baseRevisions[entityKey(identity.entityType, mapped)] = 1;
        continue;
      }
    }
    baseRevisions[key] = revision;
  }
  const dependsOn = operation.dependsOn.filter((entry) => !covered.has(entry));
  const envelope = stationOperationWire({
    ...operation.envelope,
    entityId,
    payload,
    baseRevisions,
    dependsOn,
    payloadHash: operation.payloadHash,
  });
  return {
    entityId,
    payload,
    baseRevisions,
    dependsOn,
    payloadHash: operationEnvelopeHash(envelope),
    updatedAt: at,
  };
}
