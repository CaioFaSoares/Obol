// The single PocketBase access point for every sync metadata collection
// (D016 D4/D5/D8/D11, canon §12.4). Mutation commits append their metadata
// through `PocketbaseUnitOfWork.metadataBatch()` and the `plan*` methods here,
// so finance rows and ledger rows land in one atomic batch; everything that is
// NOT part of a mutation commit (meta read/ensure, receipts, station registry
// and state, ordered journal pages, deterministic backfill enumeration) is
// read or written directly from this repository.
//
// Guarantees:
// - the metadata boundary is enforced: metadata collections are writable, the
//   seven finance collections are READ-ONLY here (backfill enumeration only),
//   and no other collection name reaches PocketBase;
// - every stored row is decoded with its column invariants checked instead of
//   being trusted: meta epoch/protocol/seq/head agreement, version-row
//   identity and revision, receipt hashes and status, station state shape;
// - journal pages are COMPLETE COMMIT GROUPS only. `limit` (1..500) is a
//   target event count that whole groups may exceed, the page is additionally
//   bounded by the 32 MiB serialized-`events` cap, a cursor that names a
//   non-boundary event is rejected rather than repaired, and every event is
//   re-verified against its own chain hash and its predecessor's hash, so a
//   replaced or edited journal is refused instead of being served;
// - backfill enumeration is deterministic (collection order
//   accounts→cards→categories→projects→recurrences→invoices→transactions, id
//   ascending inside each collection) and resumable: every fetch advances the
//   `id > lastId` bound instead of paginating a set that already moved, so no
//   row is ever skipped or re-read;
// - filters interpolate only validated identifiers (15-character entity ids,
//   UUID station/operation ids), never arbitrary text.
//
// Never owned here: HTTP routes, business rules, finance writes. Finance rows
// are read verbatim; nothing in this module recomputes or normalizes a
// financial value.

import type PocketBase from 'pocketbase';
import type { RecordService } from 'pocketbase';

import {
  SYNC_COLLECTIONS,
  SYNC_GENESIS_HASH,
  isSyncEntityId,
  isSyncEntityType,
  parseSyncRevisionKey,
  syncRevisionKey,
  type SyncCollectionName,
  type SyncEntityId,
  type SyncEntityType,
  type SyncHash,
  type SyncJsonObject,
  type SyncRecord,
  type SyncRevisionKey,
  type SyncSha256Hash,
} from '../../domain/sync/SyncRevision';
import {
  SYNC_CHANGE_KINDS,
  SYNC_CHANGE_ORIGINS,
  SYNC_GENESIS_CURSOR,
  SYNC_MAX_COMMIT_EVENTS,
  isCommitBoundary,
  type SyncChangeKind,
  type SyncChangeOrigin,
  type SyncCursor,
  type SyncStoredChangeEvent,
} from '../../domain/sync/SyncChange';
import {
  SYNC_PULL_LIMIT_MAX,
  SYNC_PULL_LIMIT_MIN,
  SYNC_PULL_MAX_PAGE_BYTES,
  isSyncUuid,
} from '../../domain/sync/SyncProtocol';
import {
  canonicalJsonLength,
  changeChainHash,
  normalizeSyncTimestamp,
  parseSyncHash,
  parseSyncSha256Hash,
  recordHash,
  toSyncJsonObject,
  toSyncJsonValue,
} from '../sync/CanonicalJson';

/**
 * One PocketBase record exactly as the SDK returns it. The SDK surface is
 * dynamically typed, so this alias is the one place a remote row is cast.
 */
type PocketRecordRow = Record<string, unknown>;

/** Finance collections in the pinned D5 backfill order. */
const BACKFILL_COLLECTION_ORDER: ReadonlyArray<SyncCollectionName> = Object.values(
  SYNC_COLLECTIONS,
) as ReadonlyArray<SyncCollectionName>;

/** Finance collection name -> owning sync entity type. */
const ENTITY_TYPE_BY_COLLECTION: Readonly<Record<string, SyncEntityType>> =
  Object.fromEntries(
    (Object.keys(SYNC_COLLECTIONS) as SyncEntityType[]).map((entityType) => [
      SYNC_COLLECTIONS[entityType],
      entityType,
    ]),
  ) as Readonly<Record<string, SyncEntityType>>;

/** Largest resume window a single backfill enumeration may consume. */
const BACKFILL_MAX_ROWS = 10_000;
/** Finance-row page size of the deterministic enumeration (PB list cap). */
const BACKFILL_PAGE_SIZE = 500;

/** Bounded OR-filter width for version and event-key lookups. */
const VERSION_FILTER_CHUNK = 40;
const EVENT_KEY_FILTER_CHUNK = 40;
/** Journal list page size while assembling one commit-group page. */
const JOURNAL_LIST_PAGE_SIZE = 500;

// ---------------------------------------------------------------------------
// Decoded row shapes (pinned to the §12.4 collections)
// ---------------------------------------------------------------------------

/** `obol_sync_meta` singleton, decoded and validated. */
export interface SyncMetaSnapshot {
  readonly serverInstanceId: string;
  readonly dataEpoch: number;
  readonly protocolMin: number;
  readonly protocolMax: number;
  readonly lastSeq: number;
  readonly headHash: SyncHash;
  readonly journalBackfilledAt: string | null;
  readonly journalBackfillVersion: number | null;
  /** PocketBase record id of the singleton row (metadata updates reuse it). */
  readonly recordId: string;
}

/** Initial values for `ensureSyncMeta()` on a fresh deployment. */
export interface NewSyncMetaValues {
  readonly serverInstanceId: string;
  readonly dataEpoch: number;
  readonly protocolMin: number;
  readonly protocolMax: number;
}

/** `obol_sync_entity_versions` row, decoded. */
export interface SyncEntityVersionSnapshot {
  readonly entityType: SyncEntityType;
  readonly entityId: SyncEntityId;
  readonly revision: number;
  readonly deleted: boolean;
  readonly lastSeq: number;
  readonly recordId: string;
}

/** One version row the coordinator wants written inside its commit batch. */
export interface EntityVersionWrite {
  readonly entityType: SyncEntityType;
  readonly entityId: SyncEntityId;
  readonly revision: number;
  readonly deleted: boolean;
  readonly lastSeq: number;
}

/** `obol_sync_operations` stored receipt (complete-envelope idempotency). */
export interface SyncOperationReceiptSnapshot {
  readonly opId: string;
  readonly stationId: string;
  readonly protocolVersion: number;
  readonly type: string;
  readonly entityType: SyncEntityType;
  readonly entityId: SyncEntityId;
  readonly payloadHash: SyncSha256Hash;
  readonly baseRevisions: SyncJsonObject | null;
  readonly dependsOn: readonly string[] | null;
  readonly status: 'accepted' | 'conflict' | 'rejected';
  /** Stored original per-operation result (`null` outside `accepted`). */
  readonly result: SyncJsonObject | null;
  readonly conflict: SyncJsonObject | null;
  readonly receivedAt: string;
  readonly effectiveAt: string;
  readonly recordId: string;
}

/** `obol_sync_stations` registry row, decoded. */
export interface SyncStationSnapshot {
  readonly stationId: string;
  readonly deviceLabel: string | null;
  readonly platform: 'ios' | 'macos' | 'windows' | null;
  readonly firstSeenAt: string | null;
  readonly lastSeenAt: string | null;
  readonly lastCursor: number | null;
  readonly recordId: string;
}

/** A metadata row read back with its PB record id (targets later updates). */
export interface SyncMetadataRowRef {
  readonly rowId: string;
  readonly row: PocketRecordRow;
}

/** Station registration input for `planStationRegistration()`. */
export interface StationRegistrationInput {
  readonly stationId: string;
  readonly deviceLabel?: string;
  readonly platform?: 'ios' | 'macos' | 'windows';
  readonly firstSeenAt?: string;
  readonly lastSeenAt?: string;
  readonly lastCursor?: number;
}

/**
 * `obol_station_state` singleton row, decoded. The binding fields are empty
 * strings and `mode` is `standalone` until the device pairs. The optional
 * import checkpoint column is read through `readPendingImport()` instead of
 * this snapshot, because it may hold up to 12 MiB.
 */
export interface SyncStationStateSnapshot {
  readonly serverUrl: string;
  readonly serverInstanceId: string;
  readonly ownerFingerprint: string;
  readonly stationId: string;
  readonly cursor: number;
  readonly lastChainHash: string;
  readonly dataEpoch: number;
  readonly protocolVersion: number;
  readonly mode: 'standalone' | 'station';
  readonly recordId: string;
}

/**
 * Partial update for `obol_station_state`. Besides the decoded binding fields
 * it accepts the optional `pendingImport` checkpoint column (canon §12.4), so
 * a caller can persist or clear the frozen import request inside its own
 * atomic batch.
 */
export type StationStateUpdate = Partial<
  Omit<SyncStationStateSnapshot, 'recordId'>
> & {
  readonly pendingImport?: SyncJsonObject | null;
};

/**
 * Local version row (`obol_station_versions`) decoded.
 *
 * `serverRevision`/`serverDeleted`/`baseRecord` are the authoritative pulled
 * remote state; `localRevision`/`deleted` are optimistic-local bookkeeping.
 * `baseRecord` keeps the whole pulled remote base for crash-safe replica
 * reconstruction and is never a before-snapshot of a pending intent.
 */
export interface StationLocalVersionSnapshot {
  readonly serverRevision: number | null;
  readonly serverDeleted: boolean;
  readonly baseRecord: SyncJsonObject | null;
  readonly localRevision: number;
  readonly deleted: boolean;
  readonly recordId: string;
}

/** One page of the journal: complete commit groups only (D4 pull). */
export interface SyncJournalPage {
  readonly events: readonly SyncStoredChangeEvent[];
  /** `seq` of the last event of the last complete group returned. */
  readonly nextCursor: SyncCursor;
  readonly hasMore: boolean;
  /** Committed journal state for the handshake/cursor checks. */
  readonly lastSeq: number;
  readonly headHash: SyncHash;
}

/** Backfill enumeration cursor over the finance collections (D5 order). */
export interface BackfillCursor {
  readonly collection: SyncCollectionName;
  /** Last emitted record id of that collection, or `null` to start it. */
  readonly lastId: string | null;
}

/** One bounded backfill batch of finance rows plus its resume cursor. */
export interface BackfillPage {
  readonly rows: ReadonlyArray<{
    readonly entityType: SyncEntityType;
    readonly collection: SyncCollectionName;
    /** Complete stored record; ids and relations are preserved verbatim. */
    readonly record: SyncRecord;
  }>;
  readonly nextCursor: BackfillCursor | null;
  readonly exhausted: boolean;
}

/** Deterministic order of collections over which backfill enumerates. */
export const SYNC_BACKFILL_COLLECTION_ORDER = BACKFILL_COLLECTION_ORDER;

// ---------------------------------------------------------------------------
// Journal read failures (mapped to wire codes by the pull adapter)
// ---------------------------------------------------------------------------

/**
 * Pull journal integrity codes (D4 pull validation rules).
 *
 * `JOURNAL_CHAIN_BROKEN` is separate from `PAGE_INVALID` on purpose: the page
 * shape is well formed, but a stored row no longer reproduces its own
 * `chainHash` or no longer links to its predecessor, so the journal was edited
 * or restored from another history. The pull adapter maps it to
 * `SERVER_ROLLBACK_DETECTED`, the code D016 D4 assigns to a replaced or
 * restored journal.
 */
export type JournalReadErrorCode =
  | 'PAGE_INVALID'
  | 'CURSOR_NOT_ON_COMMIT_BOUNDARY'
  | 'COMMIT_PAGE_TOO_LARGE'
  | 'JOURNAL_CURSOR_GONE'
  | 'JOURNAL_CHAIN_BROKEN';

export class JournalReadError extends Error {
  readonly code: JournalReadErrorCode;

  constructor(code: JournalReadErrorCode, message: string) {
    super(message);
    this.name = 'JournalReadError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Column validation helpers
// ---------------------------------------------------------------------------

/** A stored column that cannot satisfy its contract. */
function corrupt(context: string, message: string): Error {
  return new Error(`${context} ${message}`);
}

function requireText(value: unknown, context: string): string {
  if (typeof value !== 'string' || value === '') {
    throw corrupt(context, 'must be a non-empty string');
  }
  return value;
}

/**
 * Optional stored text: PocketBase serializes a text column that was never
 * written as the empty string, so `""` and an omitted/null value both mean
 * "absent". A journal row written by seed, backfill or a non-station origin
 * legitimately carries no `opId`/`eventKey` (there is no originating
 * operation), and a station row may carry no `deviceLabel`; none of those is
 * corruption, and none may fail a read at request time.
 */
function optionalText(value: unknown, context: string): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  return requireText(value, context);
}

function requireInteger(
  value: unknown,
  context: string,
  minimum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < minimum
  ) {
    throw corrupt(context, `must be an integer >= ${minimum}, got ${String(value)}`);
  }
  return value;
}

function optionalInteger(
  value: unknown,
  context: string,
  minimum: number,
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requireInteger(value, context, minimum);
}

/** Station and operation ids are UUIDs and are interpolated into filters. */
function requireUuidText(value: unknown, context: string): string {
  const text = requireText(value, context);
  if (!isSyncUuid(text)) {
    throw corrupt(context, `must be a lowercase hyphenated UUID, got "${text}"`);
  }
  return text;
}

function requireEntityTypeValue(
  value: unknown,
  context: string,
): SyncEntityType {
  const text = requireText(value, context);
  if (!isSyncEntityType(text)) {
    throw corrupt(context, `"${text}" is not a sync entity type`);
  }
  return text;
}

function requireEntityIdValue(value: unknown, context: string): SyncEntityId {
  const text = requireText(value, context);
  if (!isSyncEntityId(text)) {
    throw corrupt(context, `"${text}" is not a 15-character entity id`);
  }
  return text;
}

function requireChangeKind(value: unknown, context: string): SyncChangeKind {
  const text = requireText(value, context);
  const kind = (SYNC_CHANGE_KINDS as readonly string[]).includes(text)
    ? (text as SyncChangeKind)
    : null;
  if (kind === null) {
    throw corrupt(context, `"${text}" is not a change kind`);
  }
  return kind;
}

function requireChangeOrigin(value: unknown, context: string): SyncChangeOrigin {
  const text = requireText(value, context);
  const origin = (SYNC_CHANGE_ORIGINS as readonly string[]).includes(text)
    ? (text as SyncChangeOrigin)
    : null;
  if (origin === null) {
    throw corrupt(context, `"${text}" is not a change origin`);
  }
  return origin;
}

/** Decodes the select column of `obol_sync_operations.status`. */
function requireReceiptStatus(
  value: unknown,
  context: string,
): SyncOperationReceiptSnapshot['status'] {
  const text = requireText(value, context);
  if (text === 'accepted' || text === 'conflict' || text === 'rejected') {
    return text;
  }
  throw corrupt(context, `carries unknown status "${text}"`);
}

/** Decodes the select column of `obol_sync_stations.platform`. */
function parseStationPlatform(
  value: unknown,
  context: string,
): SyncStationSnapshot['platform'] {
  if (value === undefined || value === null) {
    return null;
  }
  const text = requireText(value, context);
  if (text === 'ios' || text === 'macos' || text === 'windows') {
    return text;
  }
  throw corrupt(context, `carries unknown platform "${text}"`);
}

/** Decodes the select column of `obol_station_state.mode`. */
function parseStationMode(
  value: unknown,
  context: string,
): SyncStationStateSnapshot['mode'] {
  if (value === undefined || value === null) {
    return 'standalone';
  }
  if (value === 'standalone' || value === 'station') {
    return value;
  }
  throw corrupt(context, `carries unknown mode ${JSON.stringify(value)}`);
}

/**
 * Decodes one optional JSON column into a canonical JSON object. Absent
 * columns decode as `null`; a present non-object payload is ledger corruption
 * and fails loudly instead of replaying an unchecked blob.
 */
function decodeOptionalJsonRecord(
  value: unknown,
  context: string,
): SyncJsonObject | null {
  if (value === undefined || value === null) {
    return null;
  }
  return toSyncJsonObject(value, context);
}

function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class PocketbaseSyncRepository {
  constructor(private readonly pb: PocketBase) {}

  // -----------------------------------------------------------------------
  // Collection boundary
  // -----------------------------------------------------------------------

  /**
   * Metadata collections this repository may write. Finance collections are
   * deliberately absent; they are reachable only through the read-only
   * enumeration accessor.
   */
  private static readonly WRITABLE_METADATA_COLLECTIONS: Readonly<
    Record<string, true>
  > = {
    obol_sync_meta: true,
    obol_sync_entity_versions: true,
    obol_sync_changes: true,
    obol_sync_operations: true,
    obol_sync_stations: true,
    obol_station_outbox: true,
    obol_station_state: true,
    obol_station_conflicts: true,
    obol_station_versions: true,
  };

  /** Resolves one writable metadata collection service. */
  private recordsOf(collectionName: string): RecordService {
    if (!PocketbaseSyncRepository.WRITABLE_METADATA_COLLECTIONS[collectionName]) {
      throw new Error(
        `PocketbaseSyncRepository writes only obol_sync_*/obol_station_* collections; "${collectionName}" is not one of them`,
      );
    }
    return this.pb.collection(collectionName);
  }

  /**
   * Resolves one FINANCE collection service for the deterministic backfill
   * enumeration. Read-only by contract: the only callers use `getList`/`getOne`,
   * and no finance write exists in this module.
   */
  private financeRecordsOf(collectionName: SyncCollectionName): RecordService {
    if (!ENTITY_TYPE_BY_COLLECTION[collectionName]) {
      throw new Error(
        `"${collectionName}" is not one of the seven finance collections`,
      );
    }
    return this.pb.collection(collectionName);
  }

  // -----------------------------------------------------------------------
  // Meta
  // -----------------------------------------------------------------------

  /** Reads the `obol_sync_meta` singleton, or `null` when absent. */
  async readSyncMeta(): Promise<SyncMetaSnapshot | null> {
    // Named SDK boundary: singleton base record row.
    const result = (await this.recordsOf('obol_sync_meta').getList(1, 1)) as unknown as {
      items: PocketRecordRow[];
    };
    const row = result.items?.[0];
    if (!row) {
      return null;
    }
    return this.decodeSyncMeta(row);
  }

  /**
   * Creates the meta singleton when absent and returns its current state.
   * Idempotent under the single-writer gate; the unique row keeps a later
   * call from duplicating it, and an existing row is never restamped.
   */
  async ensureSyncMeta(initial: NewSyncMetaValues): Promise<SyncMetaSnapshot> {
    const existing = await this.readSyncMeta();
    if (existing !== null) {
      return existing;
    }
    const serverInstanceId = requireText(
      initial.serverInstanceId,
      'obol_sync_meta serverInstanceId',
    );
    const dataEpoch = requireInteger(initial.dataEpoch, 'obol_sync_meta dataEpoch', 1);
    const protocolMin = requireInteger(
      initial.protocolMin,
      'obol_sync_meta protocolMin',
      1,
    );
    const protocolMax = requireInteger(
      initial.protocolMax,
      'obol_sync_meta protocolMax',
      1,
    );
    if (protocolMin > protocolMax) {
      throw new Error(
        'obol_sync_meta protocolMin is greater than protocolMax; refusing to create an unusable ledger',
      );
    }
    await this.recordsOf('obol_sync_meta').create({
      serverInstanceId,
      dataEpoch,
      protocolMin,
      protocolMax,
      lastSeq: 0,
      headHash: SYNC_GENESIS_HASH,
    });
    const created = await this.readSyncMeta();
    if (created === null) {
      throw new Error('obol_sync_meta disappeared immediately after ensure');
    }
    return created;
  }

  /**
   * Appends the meta update for one commit so `lastSeq`/`headHash` advance
   * inside the SAME atomic batch as the finance rows, version rows and change
   * events. Reads the singleton first (the gate makes that read stable) and
   * refuses to write a seq/head pair that disagrees about the journal head.
   *
   * The optional D5 backfill marker fields are written only by the backfill
   * and by the reset; ordinary mutations never touch them.
   */
  async planSyncMetaForCommit(
    appender: SyncCommitAppender,
    values: {
      readonly lastSeq: number;
      readonly headHash: SyncHash;
      readonly journalBackfilledAt?: string;
      readonly journalBackfillVersion?: number;
    },
  ): Promise<void> {
    const lastSeq = requireInteger(values.lastSeq, 'meta commit lastSeq', 0);
    const headHash = parseSyncHash(values.headHash, 'meta commit headHash');
    if ((lastSeq === 0) !== (headHash === SYNC_GENESIS_HASH)) {
      throw new Error(
        `The commit would store lastSeq ${lastSeq} with ${
          headHash === SYNC_GENESIS_HASH ? 'the genesis' : 'a non-genesis'
        } head hash; the journal head would be inconsistent`,
      );
    }
    const marker =
      values.journalBackfilledAt === undefined
        ? undefined
        : normalizeSyncTimestamp(
            values.journalBackfilledAt,
            'meta commit journalBackfilledAt',
          );
    const markerVersion =
      values.journalBackfillVersion === undefined
        ? undefined
        : requireInteger(
            values.journalBackfillVersion,
            'meta commit journalBackfillVersion',
            1,
          );
    if ((marker === undefined) !== (markerVersion === undefined)) {
      throw new Error(
        'The backfill marker timestamp and version are written together or not at all',
      );
    }

    const meta = await this.readSyncMeta();
    if (meta === null) {
      throw new Error(
        'obol_sync_meta is missing; ensureSyncMeta() must run before the first commit',
      );
    }
    appender.update('obol_sync_meta', meta.recordId, {
      lastSeq,
      headHash,
      ...(marker !== undefined ? { journalBackfilledAt: marker } : {}),
      ...(markerVersion !== undefined
        ? { journalBackfillVersion: markerVersion }
        : {}),
    });
  }

  // -----------------------------------------------------------------------
  // Entity versions
  // -----------------------------------------------------------------------

  /**
   * Reads the current version rows for explicit revision keys. Unknown keys
   * are simply absent from the map; `deleted` rides along so the coordinator
   * can distinguish a tombstone from a live revision.
   */
  async readEntityVersions(
    keys: readonly SyncRevisionKey[],
  ): Promise<Map<SyncRevisionKey, SyncEntityVersionSnapshot>> {
    const result = new Map<SyncRevisionKey, SyncEntityVersionSnapshot>();
    for (const chunk of chunked(keys, VERSION_FILTER_CHUNK)) {
      if (chunk.length === 0) {
        continue;
      }
      const filter = chunk
        .map((key) => {
          const parsed = parseSyncRevisionKey(key);
          if (parsed === null) {
            throw new Error(`Malformed revision key "${key}"`);
          }
          return `(entityType = '${parsed.entityType}' && entityId = '${parsed.entityId}')`;
        })
        .join(' || ');
      const rows = await this.listAllRows('obol_sync_entity_versions', { filter });
      for (const row of rows) {
        const context = `obol_sync_entity_versions ${String(row.id)}`;
        const entityType = requireEntityTypeValue(row.entityType, `${context} entityType`);
        const entityId = requireEntityIdValue(row.entityId, `${context} entityId`);
        result.set(syncRevisionKey(entityType, entityId), {
          entityType,
          entityId,
          revision: requireInteger(row.revision, `${context} revision`, 1),
          deleted: row.deleted === true,
          lastSeq: requireInteger(row.lastSeq ?? 0, `${context} lastSeq`, 0),
          recordId: requireText(row.id, `${context} id`),
        });
      }
    }
    return result;
  }

  /** Reads the version row for exactly one entity, or `null` when unseen. */
  async readEntityVersion(
    entityType: SyncEntityType,
    entityId: SyncEntityId,
  ): Promise<SyncEntityVersionSnapshot | null> {
    const key = syncRevisionKey(entityType, entityId);
    const versions = await this.readEntityVersions([key]);
    return versions.get(key) ?? null;
  }

  /**
   * Appends version-row writes (create or update) for one commit batch.
   * Current rows are read first so an existing revision row updates in place
   * and a first-touch row creates; the writer supplies the assigned revision
   * and `seq`, which are written verbatim.
   */
  async planEntityVersionUpserts(
    appender: SyncCommitAppender,
    writes: readonly EntityVersionWrite[],
  ): Promise<void> {
    if (writes.length === 0) {
      return;
    }
    const keys = writes.map((write) =>
      syncRevisionKey(write.entityType, write.entityId),
    );
    const current = await this.readEntityVersions(keys);
    for (const write of writes) {
      const context = `obol_sync_entity_versions ${syncRevisionKey(
        write.entityType,
        write.entityId,
      )}`;
      const body: PocketRecordRow = {
        entityType: requireEntityTypeValue(write.entityType, `${context} entityType`),
        entityId: requireEntityIdValue(write.entityId, `${context} entityId`),
        revision: requireInteger(write.revision, `${context} revision`, 1),
        deleted: write.deleted === true,
        lastSeq: requireInteger(write.lastSeq, `${context} lastSeq`, 0),
      };
      const existing = current.get(
        syncRevisionKey(write.entityType, write.entityId),
      );
      if (existing !== undefined) {
        appender.update('obol_sync_entity_versions', existing.recordId, body);
      } else {
        appender.create('obol_sync_entity_versions', body);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Journal events
  // -----------------------------------------------------------------------

  /**
   * Appends the change-event creates for one commit batch. The events already
   * carry their `seq`, commit-group identity and hashes; nothing is rewritten
   * here.
   */
  async planChangeEventCreates(
    appender: SyncCommitAppender,
    events: readonly SyncStoredChangeEvent[],
  ): Promise<void> {
    for (const event of events) {
      appender.create('obol_sync_changes', this.encodeChangeEventRow(event));
    }
  }

  /** Total journal event count (empty-server seed checks). */
  async countChangeEvents(): Promise<number> {
    const result = (await this.recordsOf('obol_sync_changes').getList(1, 1)) as unknown as {
      totalItems: number;
    };
    return typeof result.totalItems === 'number' ? result.totalItems : 0;
  }

  /**
   * Reads the durable backfill event keys of `candidates`. A completed key is
   * skipped by a resumed backfill, never re-emitted.
   */
  async readEventKeys(candidates: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const chunk of chunked(candidates, EVENT_KEY_FILTER_CHUNK)) {
      if (chunk.length === 0) {
        continue;
      }
      for (const key of chunk) {
        if (key.includes("'")) {
          throw new Error(`Backfill event key "${key}" contains a quote`);
        }
      }
      const filter = chunk.map((key) => `eventKey = '${key}'`).join(' || ');
      const rows = await this.listAllRows('obol_sync_changes', {
        filter,
        fields: 'eventKey',
      });
      for (const row of rows) {
        if (typeof row.eventKey === 'string' && row.eventKey !== '') {
          found.add(row.eventKey);
        }
      }
    }
    return found;
  }

  /** Reads the journal event at one exact `seq`, or `null` when absent. */
  async readChangeEventAt(seq: number): Promise<SyncStoredChangeEvent | null> {
    if (!Number.isInteger(seq) || seq < 1) {
      throw new JournalReadError(
        'PAGE_INVALID',
        `A journal read needs a positive integer seq, got ${String(seq)}`,
      );
    }
    const rows = await this.listAllRows('obol_sync_changes', {
      filter: `seq = ${seq}`,
    });
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const event = this.decodeChangeEvent(row);
    if (event.seq !== seq) {
      throw new JournalReadError(
        'PAGE_INVALID',
        `The journal row read for seq ${seq} declares seq ${event.seq}`,
      );
    }
    return event;
  }

  /**
   * Reads the next journal page as ORDERED COMPLETE COMMIT GROUPS (D4 pull).
   *
   * - the cursor must be genesis or name the LAST event of a commit group; a
   *   mid-group cursor is rejected, never advanced;
   * - `limit` is a target event count; a group is never split, so the page may
   *   exceed `limit` by finishing the group it already started;
   * - the page stays under the 32 MiB serialized-`events` cap. A commit that
   *   cannot fit that cap on its own fails with `COMMIT_PAGE_TOO_LARGE`;
   * - every event is validated (integers, identity, kind/record agreement,
   *   chain hash) and its `prevHash` must match its predecessor, so a gap, an
   *   edited row or a replaced journal never reaches a client;
   * - the journal may not end inside a group, and a group may not change its
   *   `commitSize` or interleave with another `commitId`.
   */
  async readJournalPage(query: {
    readonly cursor: SyncCursor;
    readonly limit: number;
  }): Promise<SyncJournalPage> {
    const { cursor, limit } = query;
    if (
      !Number.isInteger(limit) ||
      limit < SYNC_PULL_LIMIT_MIN ||
      limit > SYNC_PULL_LIMIT_MAX
    ) {
      throw new JournalReadError(
        'PAGE_INVALID',
        `pull limit must be an integer within ${SYNC_PULL_LIMIT_MIN}..${SYNC_PULL_LIMIT_MAX}, got ${String(limit)}`,
      );
    }
    if (!Number.isInteger(cursor) || cursor < SYNC_GENESIS_CURSOR) {
      throw new JournalReadError(
        'PAGE_INVALID',
        `pull cursor must be a non-negative integer, got ${String(cursor)}`,
      );
    }

    const meta = await this.readSyncMeta();
    if (meta === null) {
      throw new JournalReadError(
        'PAGE_INVALID',
        'obol_sync_meta is missing; pull requires the committed ledger',
      );
    }
    const lastSeq = meta.lastSeq;
    const headHash = meta.headHash;
    if (cursor > lastSeq) {
      throw new JournalReadError(
        'JOURNAL_CURSOR_GONE',
        `Cursor ${cursor} is beyond the journal head ${lastSeq}`,
      );
    }

    let previousHash: SyncHash = SYNC_GENESIS_HASH;
    if (cursor !== SYNC_GENESIS_CURSOR) {
      const boundary = await this.readChangeEventAt(cursor);
      if (boundary === null) {
        throw new JournalReadError(
          'JOURNAL_CURSOR_GONE',
          `No journal event exists at cursor ${cursor}`,
        );
      }
      if (!isCommitBoundary(boundary)) {
        throw new JournalReadError(
          'CURSOR_NOT_ON_COMMIT_BOUNDARY',
          `Cursor ${cursor} names commitIndex ${boundary.commitIndex}/${boundary.commitSize}, not a group boundary`,
        );
      }
      previousHash = boundary.chainHash;
    }

    const events: SyncStoredChangeEvent[] = [];
    let pageBytes = 0;
    let group:
      | {
          readonly commitId: string;
          readonly commitSize: number;
          readonly events: SyncStoredChangeEvent[];
          bytes: number;
        }
      | null = null;
    let stop = false;
    let listPage = 1;
    let expectedSeq = cursor + 1;

    while (!stop) {
      const result = (await this.recordsOf('obol_sync_changes').getList(
        listPage,
        JOURNAL_LIST_PAGE_SIZE,
        {
          sort: 'seq',
          ...(cursor > SYNC_GENESIS_CURSOR ? { filter: `seq > ${cursor}` } : {}),
        },
      )) as unknown as { items: PocketRecordRow[] };
      const rows = result.items ?? [];
      if (rows.length === 0) {
        break;
      }

      for (const row of rows) {
        const event = this.decodeChangeEvent(row);
        if (event.seq !== expectedSeq) {
          throw new JournalReadError(
            'PAGE_INVALID',
            `Event ${event.seq} does not follow seq ${expectedSeq - 1}; the journal sequence has a gap`,
          );
        }
        expectedSeq += 1;
        if (event.prevHash !== previousHash) {
          throw new JournalReadError(
            'JOURNAL_CHAIN_BROKEN',
            `Event ${event.seq} does not continue the chain: prevHash disagrees with the previous event`,
          );
        }
        previousHash = event.chainHash;

        if (group === null) {
          if (event.commitIndex !== 0) {
            throw new JournalReadError(
              'PAGE_INVALID',
              `Event ${event.seq} opens a group of ${event.commitId} at commitIndex ${event.commitIndex} instead of 0`,
            );
          }
          group = {
            commitId: event.commitId,
            commitSize: event.commitSize,
            events: [],
            bytes: 0,
          };
        } else {
          if (event.commitId !== group.commitId) {
            throw new JournalReadError(
              'PAGE_INVALID',
              `Commit ${group.commitId} is interleaved with ${event.commitId} at seq ${event.seq}`,
            );
          }
          if (event.commitSize !== group.commitSize) {
            throw new JournalReadError(
              'PAGE_INVALID',
              `Commit ${group.commitId} changes its commitSize at seq ${event.seq}`,
            );
          }
          if (event.commitIndex !== group.events.length) {
            throw new JournalReadError(
              'PAGE_INVALID',
              `Commit ${group.commitId} skips to commitIndex ${event.commitIndex} at seq ${event.seq}`,
            );
          }
        }

        const eventBytes = canonicalJsonLength(
          toSyncJsonValue(event, `journal event ${event.seq}`),
        );
        group.events.push(event);
        group.bytes += eventBytes;

        if (!isCommitBoundary(event)) {
          if (group.bytes > SYNC_PULL_MAX_PAGE_BYTES) {
            // The group is already over the cap before it ends: it can never
            // be delivered whole.
            throw new JournalReadError(
              'COMMIT_PAGE_TOO_LARGE',
              `Commit ${group.commitId} exceeds the ${SYNC_PULL_MAX_PAGE_BYTES}-byte page cap`,
            );
          }
          continue;
        }

        if (group.events.length !== group.commitSize) {
          throw new JournalReadError(
            'PAGE_INVALID',
            `Commit ${group.commitId} ends at seq ${event.seq} with ${group.events.length}/${group.commitSize} events`,
          );
        }
        if (pageBytes + group.bytes > SYNC_PULL_MAX_PAGE_BYTES) {
          if (events.length === 0) {
            throw new JournalReadError(
              'COMMIT_PAGE_TOO_LARGE',
              `The commit at the cursor serializes beyond the ${SYNC_PULL_MAX_PAGE_BYTES}-byte page cap`,
            );
          }
          // This group belongs to a later page; the cursor stays on the last
          // boundary already returned.
          stop = true;
          group = null;
          break;
        }

        events.push(...group.events);
        pageBytes += group.bytes;
        group = null;
        if (events.length >= limit) {
          stop = true;
          break;
        }
      }

      if (stop) {
        break;
      }
      if (rows.length < JOURNAL_LIST_PAGE_SIZE) {
        break;
      }
      listPage += 1;
    }

    if (group !== null) {
      throw new JournalReadError(
        'PAGE_INVALID',
        `The journal ends inside commit ${group.commitId} (${group.events.length}/${group.commitSize} events)`,
      );
    }

    const nextCursor =
      events.length > 0 ? events[events.length - 1]!.seq : cursor;
    return {
      events,
      nextCursor,
      hasMore: lastSeq > nextCursor,
      lastSeq,
      headHash,
    };
  }

  // -----------------------------------------------------------------------
  // Operation receipts (complete-envelope idempotency)
  // -----------------------------------------------------------------------

  /** Reads the stored receipt for one `opId`, or `null` when unseen. */
  async readOperationReceipt(
    opId: string,
  ): Promise<SyncOperationReceiptSnapshot | null> {
    const verifiedOpId = requireUuidText(opId, 'obol_sync_operations opId');
    const rows = await this.listAllRows('obol_sync_operations', {
      filter: `opId = '${verifiedOpId}'`,
    });
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const context = `obol_sync_operations ${String(row.id)}`;
    const status = requireReceiptStatus(row.status, `${context} status`);
    const dependsOn = row.dependsOn;
    if (dependsOn !== undefined && dependsOn !== null && !Array.isArray(dependsOn)) {
      throw corrupt(context, 'dependsOn is not a list');
    }
    const dependsOnValues: readonly unknown[] = Array.isArray(dependsOn)
      ? dependsOn
      : [];
    return {
      opId: requireUuidText(row.opId, `${context} opId`),
      stationId: requireUuidText(row.stationId, `${context} stationId`),
      protocolVersion: requireInteger(
        row.protocolVersion,
        `${context} protocolVersion`,
        1,
      ),
      type: requireText(row.type, `${context} type`),
      entityType: requireEntityTypeValue(row.entityType, `${context} entityType`),
      entityId: requireEntityIdValue(row.entityId, `${context} entityId`),
      payloadHash: parseSyncSha256Hash(
        row.payloadHash,
        `${context} payloadHash`,
      ),
      baseRevisions: decodeOptionalJsonRecord(
        row.baseRevisions,
        `${context} baseRevisions`,
      ),
      dependsOn: dependsOnValues.map((entry, index) =>
        requireUuidText(entry, `${context} dependsOn[${index}]`),
      ),
      status,
      result: decodeOptionalJsonRecord(row.result, `${context} result`),
      conflict: decodeOptionalJsonRecord(row.conflict, `${context} conflict`),
      receivedAt: requireText(row.receivedAt, `${context} receivedAt`),
      effectiveAt: requireText(row.effectiveAt, `${context} effectiveAt`),
      recordId: requireText(row.id, `${context} id`),
    };
  }

  /**
   * Appends the stored receipt for one operation inside the commit batch. The
   * coordinator records only accepted operations, so `result` carries the
   * applied outcome that a later duplicate replays verbatim.
   */
  async planOperationReceipt(
    appender: SyncCommitAppender,
    receipt: {
      readonly opId: string;
      readonly stationId: string;
      readonly protocolVersion: number;
      readonly type: string;
      readonly entityType: SyncEntityType;
      readonly entityId: SyncEntityId;
      readonly payloadHash: SyncSha256Hash;
      readonly baseRevisions: SyncJsonObject;
      readonly dependsOn: readonly string[];
      readonly status: 'accepted' | 'conflict' | 'rejected';
      readonly result?: SyncJsonObject | null;
      readonly conflict?: SyncJsonObject | null;
      readonly receivedAt: string;
      readonly effectiveAt: string;
      readonly clientCreatedAt: string;
    },
  ): Promise<void> {
    appender.create('obol_sync_operations', {
      opId: requireUuidText(receipt.opId, 'receipt opId'),
      stationId: requireUuidText(receipt.stationId, 'receipt stationId'),
      protocolVersion: requireInteger(
        receipt.protocolVersion,
        'receipt protocolVersion',
        1,
      ),
      type: requireText(receipt.type, 'receipt type'),
      entityType: requireEntityTypeValue(receipt.entityType, 'receipt entityType'),
      entityId: requireEntityIdValue(receipt.entityId, 'receipt entityId'),
      payloadHash: parseSyncSha256Hash(receipt.payloadHash, 'receipt payloadHash'),
      baseRevisions: receipt.baseRevisions,
      dependsOn: receipt.dependsOn.map((dependency, index) =>
        requireUuidText(dependency, `receipt dependsOn[${index}]`),
      ),
      effectiveAt: receipt.effectiveAt,
      clientCreatedAt: receipt.clientCreatedAt,
      status: receipt.status,
      result: receipt.result ?? null,
      conflict: receipt.conflict ?? null,
      receivedAt: receipt.receivedAt,
    });
  }

  // -----------------------------------------------------------------------
  // Station registry, state and local version rows
  // -----------------------------------------------------------------------

  /** Reads one registered station, or `null` when unknown. */
  async readStation(stationId: string): Promise<SyncStationSnapshot | null> {
    const verifiedId = requireUuidText(stationId, 'obol_sync_stations stationId');
    const rows = await this.listAllRows('obol_sync_stations', {
      filter: `stationId = '${verifiedId}'`,
    });
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const context = `obol_sync_stations ${String(row.id)}`;
    const platform = parseStationPlatform(row.platform, `${context} platform`);
    return {
      stationId: requireUuidText(row.stationId, `${context} stationId`),
      deviceLabel: optionalText(row.deviceLabel, `${context} deviceLabel`),
      platform,
      firstSeenAt: optionalText(row.firstSeenAt, `${context} firstSeenAt`),
      lastSeenAt: optionalText(row.lastSeenAt, `${context} lastSeenAt`),
      lastCursor: optionalInteger(row.lastCursor, `${context} lastCursor`, 0),
      recordId: requireText(row.id, `${context} id`),
    };
  }

  /**
   * Idempotent create-or-refresh of the station registry row (D4 handshake).
   * The registry is diagnostics, never an authorization principal; the D009
   * session still authorizes every request.
   */
  async planStationRegistration(
    appender: SyncCommitAppender,
    registration: StationRegistrationInput,
  ): Promise<void> {
    const stationId = requireUuidText(registration.stationId, 'station registration id');
    const existing = await this.readStation(stationId);
    if (existing !== null) {
      appender.update('obol_sync_stations', existing.recordId, {
        ...(registration.deviceLabel !== undefined
          ? { deviceLabel: registration.deviceLabel }
          : {}),
        ...(registration.platform !== undefined
          ? { platform: registration.platform }
          : {}),
        ...(registration.lastSeenAt !== undefined
          ? { lastSeenAt: registration.lastSeenAt }
          : {}),
        ...(registration.lastCursor !== undefined
          ? {
              lastCursor: requireInteger(
                registration.lastCursor,
                'station registration lastCursor',
                0,
              ),
            }
          : {}),
      });
      return;
    }
    appender.create('obol_sync_stations', {
      stationId,
      deviceLabel: registration.deviceLabel ?? null,
      platform: registration.platform ?? null,
      firstSeenAt: registration.firstSeenAt ?? null,
      lastSeenAt: registration.lastSeenAt ?? null,
      lastCursor:
        registration.lastCursor === undefined
          ? null
          : requireInteger(
              registration.lastCursor,
              'station registration lastCursor',
              0,
            ),
    });
  }

  /**
   * Refreshes `lastSeenAt`/`lastCursor` of a known station. An unregistered
   * station is left alone: registration happens through the handshake, and
   * this call never invents a registry row.
   */
  async touchStationSeen(
    stationId: string,
    values: { readonly lastSeenAt?: string; readonly lastCursor?: number },
  ): Promise<void> {
    const verifiedId = requireUuidText(stationId, 'station touch id');
    const existing = await this.readStation(verifiedId);
    if (existing === null) {
      return;
    }
    const body: PocketRecordRow = {
      ...(values.lastSeenAt !== undefined
        ? { lastSeenAt: values.lastSeenAt }
        : {}),
      ...(values.lastCursor !== undefined
        ? {
            lastCursor: requireInteger(values.lastCursor, 'station touch lastCursor', 0),
          }
        : {}),
    };
    if (Object.keys(body).length === 0) {
      return;
    }
    await this.recordsOf('obol_sync_stations').update(existing.recordId, body);
  }

  /** Reads the `obol_station_state` singleton, or `null` before binding. */
  async readStationState(): Promise<SyncStationStateSnapshot | null> {
    const row = await this.readStationStateRow();
    if (row === null) {
      return null;
    }
    return this.decodeStationState(row);
  }

  /**
   * Reads the frozen snapshot-import checkpoint column of
   * `obol_station_state`, or `null` when no import is pending. Decoded on
   * demand because the column may hold up to 12 MiB.
   */
  async readPendingImport(): Promise<SyncJsonObject | null> {
    const row = await this.readStationStateRow();
    if (row === null) {
      return null;
    }
    return decodeOptionalJsonRecord(
      row['pendingImport'],
      `obol_station_state ${String(row['id'])} pendingImport`,
    );
  }

  /**
   * Upserts the `obol_station_state` singleton inside the caller's batch.
   * On first write the unwritten binding fields take the documented empty
   * defaults; the optional `pendingImport` checkpoint rides along verbatim
   * when the caller supplies it.
   */
  async planStationStateUpsert(
    appender: SyncCommitAppender,
    update: StationStateUpdate,
  ): Promise<void> {
    const body: PocketRecordRow = {};
    for (const [key, value] of Object.entries(update)) {
      if (value !== undefined) {
        body[key] = value;
      }
    }
    const existing = await this.readStationStateRow();
    if (existing !== null) {
      if (Object.keys(body).length === 0) {
        return;
      }
      appender.update('obol_station_state', requireText(existing['id'], 'obol_station_state id'), body);
      return;
    }
    appender.create('obol_station_state', {
      serverUrl: '',
      serverInstanceId: '',
      ownerFingerprint: '',
      stationId: '',
      cursor: 0,
      lastChainHash: '',
      dataEpoch: 1,
      protocolVersion: 1,
      mode: 'standalone',
      ...body,
    });
  }

  /**
   * Reads the local version row of one entity (`obol_station_versions`):
   * the device-side `localRevision`, the last accepted `serverRevision` and
   * the pulled `baseRecord`/`serverDeleted` pair.
   */
  async readStationLocalVersion(
    entityType: SyncEntityType,
    entityId: SyncEntityId,
  ): Promise<StationLocalVersionSnapshot | null> {
    const verifiedType = requireEntityTypeValue(entityType, 'station version entityType');
    const verifiedId = requireEntityIdValue(entityId, 'station version entityId');
    const rows = await this.listAllRows('obol_station_versions', {
      filter: `(entityType = '${verifiedType}' && entityId = '${verifiedId}')`,
    });
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const context = `obol_station_versions ${syncRevisionKey(verifiedType, verifiedId)}`;
    return {
      serverRevision: optionalInteger(
        row.serverRevision,
        `${context} serverRevision`,
        1,
      ),
      serverDeleted: row.serverDeleted === true,
      baseRecord: decodeOptionalJsonRecord(row.baseRecord, `${context} baseRecord`),
      localRevision: requireInteger(
        row.localRevision ?? 0,
        `${context} localRevision`,
        0,
      ),
      deleted: row.deleted === true,
      recordId: requireText(row.id, `${context} id`),
    };
  }

  /**
   * Upserts station-local version rows inside the caller's batch.
   *
   * - a provided `serverRevision`/`serverDeleted`/`baseRecord` is written
   *   verbatim (that is how an inbound pull records the authoritative state,
   *   including an explicit `null` base for a server delete);
   * - an omitted field is carried over from the stored row, so an ordinary
   *   optimistic local write never clobbers the accepted remote state;
   * - `localRevision` and the optimistic `deleted` flag come from the caller.
   */
  async planStationVersionUpserts(
    appender: SyncCommitAppender,
    writes: ReadonlyArray<{
      readonly entityType: SyncEntityType;
      readonly entityId: SyncEntityId;
      readonly localRevision: number;
      readonly serverRevision?: number | null;
      readonly serverDeleted?: boolean;
      readonly baseRecord?: SyncJsonObject | null;
      readonly deleted: boolean;
    }>,
  ): Promise<void> {
    for (const write of writes) {
      const entityType = requireEntityTypeValue(
        write.entityType,
        'station version entityType',
      );
      const entityId = requireEntityIdValue(
        write.entityId,
        'station version entityId',
      );
      const context = `obol_station_versions ${syncRevisionKey(entityType, entityId)}`;
      const existing = await this.readStationLocalVersion(entityType, entityId);
      const body: PocketRecordRow = {
        entityType,
        entityId,
        localRevision: requireInteger(
          write.localRevision,
          `${context} localRevision`,
          0,
        ),
        deleted: write.deleted === true,
      };
      if (write.serverRevision !== undefined) {
        body.serverRevision =
          write.serverRevision === null
            ? null
            : requireInteger(write.serverRevision, `${context} serverRevision`, 1);
      } else if (existing?.serverRevision != null) {
        body.serverRevision = existing.serverRevision;
      }
      if (write.serverDeleted !== undefined) {
        body.serverDeleted = write.serverDeleted === true;
      } else if (existing !== null) {
        body.serverDeleted = existing.serverDeleted;
      }
      if (write.baseRecord !== undefined) {
        body.baseRecord = write.baseRecord;
      } else if (existing?.baseRecord != null) {
        body.baseRecord = existing.baseRecord;
      }
      if (existing !== null) {
        appender.update('obol_station_versions', existing.recordId, body);
      } else {
        appender.create('obol_station_versions', body);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Station outbox (local-only recording)
  // -----------------------------------------------------------------------

  /** Reads the station outbox row of one `opId`, or `null` when unseen. */
  async readStationOutbox(opId: string): Promise<SyncMetadataRowRef | null> {
    const verifiedOpId = requireUuidText(opId, 'obol_station_outbox opId');
    const rows = await this.listAllRows('obol_station_outbox', {
      filter: `opId = '${verifiedOpId}'`,
    });
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return {
      rowId: requireText(row.id, `obol_station_outbox ${verifiedOpId} id`),
      row,
    };
  }

  /**
   * Appends one durable station outbox descriptor inside the local mutation
   * batch.
   *
   * The envelope is immutable after its first send, and `payloadHash` covers
   * that whole envelope, so:
   * - same `opId`, same hash: the intent is already recorded and only its
   *   auditable status/attempt bookkeeping is refreshed;
   * - same `opId`, different hash: loud failure. A correction is a new
   *   operation with a new `opId`, never an edited envelope.
   */
  async planStationOutbox(
    appender: SyncCommitAppender,
    outbox: {
      readonly opId: string;
      readonly payloadHash: SyncSha256Hash;
      /** Envelope columns per §12.4 (opId..clientCreatedAt). */
      readonly envelope: SyncJsonObject;
      readonly beforeSnapshots?: readonly SyncJsonObject[];
      readonly status: string;
      readonly attempts?: number;
      readonly lastError?: string | null;
      readonly acknowledgement?: SyncJsonObject | null;
      readonly createdAt: string;
      readonly updatedAt: string;
    },
  ): Promise<'created' | 'kept'> {
    const opId = requireUuidText(outbox.opId, 'obol_station_outbox opId');
    const payloadHash = parseSyncSha256Hash(
      outbox.payloadHash,
      `obol_station_outbox ${opId} payloadHash`,
    );
    const existing = await this.readStationOutbox(opId);
    if (existing !== null) {
      const storedHash = parseSyncSha256Hash(
        existing.row.payloadHash,
        `obol_station_outbox ${opId} payloadHash`,
      );
      if (storedHash !== payloadHash) {
        throw new Error(
          `Outbox opId ${opId} already recorded a different envelope hash; queued intents are immutable`,
        );
      }
      appender.update('obol_station_outbox', existing.rowId, {
        status: outbox.status,
        ...(outbox.attempts !== undefined
          ? {
              attempts: requireInteger(
                outbox.attempts,
                `obol_station_outbox ${opId} attempts`,
                0,
              ),
            }
          : {}),
        ...(outbox.lastError !== undefined && outbox.lastError !== null
          ? { lastError: outbox.lastError }
          : {}),
        ...(outbox.acknowledgement !== undefined && outbox.acknowledgement !== null
          ? { acknowledgement: outbox.acknowledgement }
          : {}),
        updatedAt: outbox.updatedAt,
      });
      return 'kept';
    }
    appender.create('obol_station_outbox', {
      opId,
      ...outbox.envelope,
      ...(outbox.beforeSnapshots !== undefined
        ? { beforeSnapshots: outbox.beforeSnapshots }
        : {}),
      status: outbox.status,
      ...(outbox.attempts !== undefined
        ? {
            attempts: requireInteger(
              outbox.attempts,
              `obol_station_outbox ${opId} attempts`,
              0,
            ),
          }
        : {}),
      ...(outbox.lastError !== undefined && outbox.lastError !== null
        ? { lastError: outbox.lastError }
        : {}),
      ...(outbox.acknowledgement !== undefined && outbox.acknowledgement !== null
        ? { acknowledgement: outbox.acknowledgement }
        : {}),
      createdAt: outbox.createdAt,
      updatedAt: outbox.updatedAt,
    });
    return 'created';
  }

  /**
   * Appends the minimal accepted causal acknowledgement (opId, commit id, seq
   * bound, per-entity versions) onto the EXISTING outbox row of one `opId`.
   * Update-only: acknowledging an unknown opId is ledger corruption. The row
   * itself is removed later, in one batch, once no dependent still needs its
   * causal versions.
   */
  async planStationOutboxAcknowledgement(
    appender: SyncCommitAppender,
    acknowledgement: {
      readonly opId: string;
      /** Minimal accepted causal receipt; never whole entity records. */
      readonly receipt: SyncJsonObject | null;
      readonly updatedAt: string;
    },
  ): Promise<'kept' | 'removed'> {
    const opId = requireUuidText(acknowledgement.opId, 'outbox acknowledgement opId');
    const existing = await this.readStationOutbox(opId);
    if (existing === null) {
      throw new Error(
        `Acknowledging unknown outbox opId ${opId}; intents are only acknowledged after they were recorded`,
      );
    }
    const cleared = acknowledgement.receipt === null;
    appender.update('obol_station_outbox', existing.rowId, {
      status: 'accepted',
      acknowledgement: acknowledgement.receipt,
      updatedAt: acknowledgement.updatedAt,
    });
    return cleared ? 'removed' : 'kept';
  }

  /**
   * Returns the most recent still-unaccepted outbox operation targeting one
   * entity, or `null`. The local commit plan uses it to declare the causal
   * `dependsOn` edge for a child whose parent revision is not yet accepted:
   * the child must never be frozen or sent before its parent.
   */
  async readUnacceptedStationOutboxForEntity(
    entityType: SyncEntityType,
    entityId: SyncEntityId,
  ): Promise<string | null> {
    const verifiedType = requireEntityTypeValue(entityType, 'outbox dependency entityType');
    const verifiedId = requireEntityIdValue(entityId, 'outbox dependency entityId');
    const rows = await this.listAllRows('obol_station_outbox', {
      filter: `(entityType = '${verifiedType}' && entityId = '${verifiedId}' && (status = 'queued' || status = 'in_flight' || status = 'conflict'))`,
      sort: '-createdAt,-id',
    });
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return requireUuidText(row.opId, 'obol_station_outbox opId');
  }

  // -----------------------------------------------------------------------
  // Deterministic backfill enumeration (D5)
  // -----------------------------------------------------------------------

  /**
   * Reads a bounded batch of finance rows in the pinned backfill order:
   * collections `accounts, cards, categories, projects, recurrences,
   * invoices, transactions`, ids ascending inside each collection.
   *
   * Resumption is exact: the `id > lastId` bound advances with every emitted
   * row and each fetch restarts the list on that already-advanced bound, so a
   * batch never re-reads or skips a row. Rows are canonical JSON copies of the
   * stored values; nothing here writes, deletes or recomputes them.
   */
  async readBackfillRows(query: {
    readonly after: BackfillCursor | null;
    readonly maxRows: number;
  }): Promise<BackfillPage> {
    const maxRows = requireInteger(
      query.maxRows,
      'backfill maxRows',
      1,
    );
    if (maxRows > BACKFILL_MAX_ROWS) {
      throw new Error(
        `backfill maxRows must be within 1..${BACKFILL_MAX_ROWS}, got ${maxRows}`,
      );
    }

    const startIndex =
      query.after === null
        ? 0
        : BACKFILL_COLLECTION_ORDER.indexOf(query.after.collection);
    if (startIndex < 0) {
      throw new Error(
        `Unknown backfill collection "${String(query.after?.collection)}"`,
      );
    }

    const rows: BackfillPage['rows'][number][] = [];
    let budget = maxRows;

    for (let index = startIndex; index < BACKFILL_COLLECTION_ORDER.length; index += 1) {
      const collection = BACKFILL_COLLECTION_ORDER[index]!;
      const entityType = this.entityTypeForCollection(collection);
      const resuming =
        query.after !== null && query.after.collection === collection;
      let lastId = resuming ? query.after!.lastId : null;

      for (;;) {
        const result = (await this.financeRecordsOf(collection).getList(
          1,
          BACKFILL_PAGE_SIZE,
          {
            sort: 'id',
            ...(lastId !== null ? { filter: `id > '${lastId}'` } : {}),
          },
        )) as unknown as { items: PocketRecordRow[] };
        const fetched = result.items ?? [];
        if (fetched.length === 0) {
          break;
        }
        for (const row of fetched) {
          const recordId = requireEntityIdValue(
            row['id'],
            `backfill row of ${collection}`,
          );
          rows.push({
            entityType,
            collection,
            record: toSyncJsonObject(row, `backfill row ${collection}/${recordId}`),
          });
          lastId = recordId;
          budget -= 1;
          if (budget === 0) {
            return {
              rows,
              nextCursor: { collection, lastId },
              exhausted: false,
            };
          }
        }
        if (fetched.length < BACKFILL_PAGE_SIZE) {
          break;
        }
      }
    }

    return { rows, nextCursor: null, exhausted: true };
  }

  // -----------------------------------------------------------------------
  // Internal row helpers
  // -----------------------------------------------------------------------

  /** Reads every matching row of one metadata collection. */
  private async listAllRows(
    collectionName: string,
    options: {
      readonly filter?: string;
      readonly sort?: string;
      readonly fields?: string;
    },
  ): Promise<PocketRecordRow[]> {
    // Named SDK boundary: getFullList pages through the result set itself.
    const rows = (await this.recordsOf(collectionName).getFullList(
      options,
    )) as PocketRecordRow[];
    return rows ?? [];
  }

  private async readStationStateRow(): Promise<PocketRecordRow | null> {
    const result = (await this.recordsOf('obol_station_state').getList(1, 1)) as unknown as {
      items: PocketRecordRow[];
    };
    return result.items?.[0] ?? null;
  }

  private decodeStationState(row: PocketRecordRow): SyncStationStateSnapshot {
    const context = `obol_station_state ${String(row.id)}`;
    return {
      serverUrl: optionalText(row.serverUrl, `${context} serverUrl`) ?? '',
      serverInstanceId:
        optionalText(row.serverInstanceId, `${context} serverInstanceId`) ?? '',
      ownerFingerprint:
        optionalText(row.ownerFingerprint, `${context} ownerFingerprint`) ?? '',
      stationId: optionalText(row.stationId, `${context} stationId`) ?? '',
      cursor: optionalInteger(row.cursor, `${context} cursor`, 0) ?? 0,
      lastChainHash:
        optionalText(row.lastChainHash, `${context} lastChainHash`) ?? '',
      dataEpoch: optionalInteger(row.dataEpoch, `${context} dataEpoch`, 0) ?? 0,
      protocolVersion:
        optionalInteger(row.protocolVersion, `${context} protocolVersion`, 1) ?? 1,
      mode: parseStationMode(row.mode, `${context} mode`),
      recordId: requireText(row.id, `${context} id`),
    };
  }

  private decodeSyncMeta(row: PocketRecordRow): SyncMetaSnapshot {
    const context = 'obol_sync_meta';
    const serverInstanceId = requireText(
      row.serverInstanceId,
      `${context} serverInstanceId`,
    );
    const dataEpoch = requireInteger(row.dataEpoch, `${context} dataEpoch`, 1);
    const protocolMin = requireInteger(row.protocolMin, `${context} protocolMin`, 1);
    const protocolMax = requireInteger(row.protocolMax, `${context} protocolMax`, 1);
    if (protocolMin > protocolMax) {
      throw corrupt(context, 'declares protocolMin above protocolMax');
    }
    const lastSeq = requireInteger(row.lastSeq, `${context} lastSeq`, 0);
    const headHash = parseSyncHash(row.headHash, `${context} headHash`);
    if ((lastSeq === 0) !== (headHash === SYNC_GENESIS_HASH)) {
      throw corrupt(
        context,
        'has a lastSeq and headHash that disagree about the journal head; refusing to serve a broken chain',
      );
    }

    // PocketBase serializes an empty optional `date` as `""` and an empty
    // optional `number` as `0`, so those are the storage forms of "never
    // written". A fresh ledger legitimately stores neither marker; a populated
    // pair must be a strict timestamp plus a positive version, and any other
    // mix (blank/invalid text, whitespace, NaN, zero beside a date) fails
    // closed instead of being repaired or restamped.
    const markerRaw = row.journalBackfilledAt;
    const markerVersionRaw = row.journalBackfillVersion;
    const markerUnset = markerRaw === undefined || markerRaw === null || markerRaw === '';
    const markerVersionUnset =
      markerVersionRaw === undefined ||
      markerVersionRaw === null ||
      markerVersionRaw === 0;
    if (markerUnset !== markerVersionUnset) {
      throw corrupt(
        context,
        'has an incomplete backfill marker (timestamp and version must be written together)',
      );
    }
    return {
      serverInstanceId,
      dataEpoch,
      protocolMin,
      protocolMax,
      lastSeq,
      headHash,
      journalBackfilledAt: markerUnset
        ? null
        : normalizeSyncTimestamp(markerRaw, `${context} journalBackfilledAt`),
      journalBackfillVersion: markerVersionUnset
        ? null
        : requireInteger(markerVersionRaw, `${context} journalBackfillVersion`, 1),
      recordId: requireText(row.id, `${context} id`),
    };
  }

  private encodeChangeEventRow(event: SyncStoredChangeEvent): PocketRecordRow {
    // Optional columns are omitted rather than written as a fake value.
    const row: PocketRecordRow = {
      seq: event.seq,
      commitId: event.commitId,
      commitIndex: event.commitIndex,
      commitSize: event.commitSize,
      kind: event.kind,
      entityType: event.entityType,
      entityId: event.entityId,
      revision: event.revision,
      record: event.record,
      origin: event.origin,
      createdAt: event.createdAt,
      prevHash: event.prevHash,
      chainHash: event.chainHash,
    };
    if (event.stationId !== undefined) {
      row.stationId = event.stationId;
    }
    if (event.opId !== undefined) {
      row.opId = event.opId;
    }
    if (event.eventKey !== undefined) {
      row.eventKey = event.eventKey;
    }
    return row;
  }

  /**
   * Decodes one stored journal event and verifies its integrity.
   *
   * PocketBase `date` columns use a space separator and an arbitrary fraction
   * width, while the chain hash covers the canonical ISO-millisecond UTC form,
   * so the stored timestamp is normalized and then the hash is RECOMPUTED from
   * the decoded fields. A journal row that does not reproduce its own
   * `chainHash` was edited or restored from a different history and is refused
   * instead of being served to a station.
   */
  private decodeChangeEvent(row: PocketRecordRow): SyncStoredChangeEvent {
    const context = `obol_sync_changes ${String(row.id)}`;
    try {
      const seq = requireInteger(row.seq, `${context} seq`, 1);
      const commitId = requireText(row.commitId, `${context} commitId`);
      const commitIndex = requireInteger(row.commitIndex, `${context} commitIndex`, 0);
      const commitSize = requireInteger(row.commitSize, `${context} commitSize`, 1);
      if (commitIndex >= commitSize) {
        throw corrupt(
          context,
          `commitIndex ${commitIndex} lies outside commitSize ${commitSize}`,
        );
      }
      if (commitSize > SYNC_MAX_COMMIT_EVENTS) {
        throw corrupt(
          context,
          `declares ${commitSize} events in one commit; the bound is ${SYNC_MAX_COMMIT_EVENTS}`,
        );
      }
      const kind = requireChangeKind(row.kind, `${context} kind`);
      const entityType = requireEntityTypeValue(row.entityType, `${context} entityType`);
      const entityId = requireEntityIdValue(row.entityId, `${context} entityId`);
      const revision = requireInteger(row.revision, `${context} revision`, 1);
      const origin = requireChangeOrigin(row.origin, `${context} origin`);
      const record =
        row.record === null || row.record === undefined
          ? null
          : toSyncJsonObject(row.record, `${context} record`);
      const prevHash = parseSyncHash(row.prevHash, `${context} prevHash`);
      const chainHash = parseSyncSha256Hash(row.chainHash, `${context} chainHash`);
      const createdAt = normalizeSyncTimestamp(row.createdAt, `${context} createdAt`);
      const stationId = optionalText(row.stationId, `${context} stationId`);
      const opId = optionalText(row.opId, `${context} opId`);
      const eventKey = optionalText(row.eventKey, `${context} eventKey`);

      if (kind === 'delete' && record !== null) {
        throw corrupt(context, 'is a delete event that carries a record');
      }
      if (kind === 'upsert' && record === null) {
        throw corrupt(context, 'is an upsert event without its record');
      }
      if (record !== null && record['id'] !== entityId) {
        throw corrupt(context, 'stores a record whose id disagrees with its entityId');
      }

      const expectedChainHash = changeChainHash({
        seq,
        commitId,
        commitIndex,
        commitSize,
        kind,
        entityType,
        entityId,
        revision,
        recordHash: recordHash(record),
        origin,
        stationId,
        opId,
        createdAt,
        prevHash,
      });
      if (expectedChainHash !== chainHash) {
        // The row parses but its hash does not recompute: the stored history
        // itself is broken, which is a rollback, not a malformed request.
        throw new JournalReadError(
          'JOURNAL_CHAIN_BROKEN',
          `${context} does not reproduce its own chainHash; the journal was altered or restored from another history`,
        );
      }

      return {
        seq,
        commitId,
        commitIndex,
        commitSize,
        kind,
        entityType,
        entityId,
        revision,
        record,
        origin,
        ...(stationId !== null ? { stationId } : {}),
        ...(opId !== null ? { opId } : {}),
        ...(eventKey !== null ? { eventKey } : {}),
        createdAt,
        prevHash,
        chainHash,
      };
    } catch (error) {
      if (error instanceof JournalReadError) {
        throw error;
      }
      throw new JournalReadError(
        'PAGE_INVALID',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private entityTypeForCollection(
    collection: SyncCollectionName,
  ): SyncEntityType {
    const entityType = ENTITY_TYPE_BY_COLLECTION[collection];
    if (entityType === undefined) {
      throw new Error(`No sync entity type maps to collection "${collection}"`);
    }
    return entityType;
  }
}

/** Appender surface shared with `PocketbaseUnitOfWork.metadataBatch()`. */
export interface SyncCommitAppender {
  create(collectionName: string, body: PocketRecordRow): void;
  update(collectionName: string, recordId: string, body: PocketRecordRow): void;
}
