// Sync-protocol persistence adapter owned by the sync API slice (E007).
//
// Implements the server-side read/write ports that are not part of the
// runtime owner's journal repository:
// - deployment identity/state reads (ledger, owner fingerprint, station rows,
//   finance row counts);
// - the seed and import-as-new snapshot commits, each ONE PocketBase batch
//   containing finance rows, revision-1 version rows, the complete journal
//   commit, the meta advance and (for import) the durable receipt;
// - import receipt replay/collision checks.
//
// All PocketBase access stays in this repository module. The application and
// domain layers never import PocketBase, Elysia or this file.

import type PocketBase from 'pocketbase';
import type { BatchService } from 'pocketbase';

import type {
  SyncClock,
} from '../../domain/sync/MutationContext';
import { systemSyncClock } from '../../domain/sync/MutationContext';
import {
  SYNC_GENESIS_HASH,
  SYNC_ENTITY_TYPES,
  SYNC_COLLECTIONS,
  isSyncEntityId,
  isSyncEntityType,
  syncRevisionKey,
  type SyncEntityId,
  type SyncEntityType,
  type SyncHash,
  type SyncJsonObject,
  type SyncSha256Hash,
} from '../../domain/sync/SyncRevision';
import {
  SYNC_GENESIS_CURSOR,
  SYNC_MAX_COMMIT_EVENTS,
  type SyncChangeEvent,
  type SyncCursor,
} from '../../domain/sync/SyncChange';
import {
  SyncProtocolRequestError,
  type SyncImportResponse,
  type SyncSeedSnapshot,
  type SyncStationId,
} from '../../domain/sync/SyncProtocol';
import type {
  SyncCursorEventView,
  SyncEventPageReader,
  SyncImportGateway,
  SyncImportGatewayInput,
  SyncImportResult,
  SyncLedgerView,
  SyncPullPage,
  SyncSeedGateway,
  SyncSeedGatewayInput,
  SyncServerStateView,
  SyncSnapshotResult,
  SyncStationRegistrationInput,
  SyncStationRegistrationView,
  SyncStationRegistry,
} from '../../application/ports/sync/SyncPorts';
import type { SyncBatchAppender } from './PocketbaseUnitOfWork';
import {
  JournalReadError,
  PocketbaseSyncRepository,
  type SyncJournalPage,
} from './PocketbaseSyncRepository';
import {
  canonicalHash,
  changeChainHash,
  normalizeSyncTimestamp,
  recordHash,
  sha256HashOfBytes,
  toSyncJsonObject,
  toSyncJsonValue,
} from '../sync/CanonicalJson';
import { newOperationId } from '../sync/RecordIds';
import type { FinancialMutationRuntime } from '../sync/FinancialMutationRuntime';

type PocketRecordRow = Record<string, unknown>;

/** Pinned snapshot-import receipt collection (migration 1700000021). */
const IMPORT_RECEIPT_COLLECTION = 'obol_sync_snapshot_imports';

/**
 * Record keys PocketBase owns or derives itself. They are never schema fields,
 * yet a snapshot may legitimately carry `id` and the native `created`/
 * `updated` audit columns, so they never participate in the store-support
 * check below.
 */
const SYSTEM_RECORD_FIELDS: Readonly<Record<string, true>> = {
  id: true,
  created: true,
  updated: true,
  collectionId: true,
  collectionName: true,
  expand: true,
};

interface SnapshotCommitOutcome {
  readonly snapshot: SyncSnapshotResult;
  readonly response: SyncImportResponse;
}

interface SnapshotImportReceipt {
  readonly importId: string;
  readonly stationId: string;
  readonly payloadHash: SyncSha256Hash;
  readonly serverInstanceId: string;
  readonly dataEpoch: number;
  readonly result: SyncJsonObject;
  readonly createdAt: string;
  readonly recordId: string;
}

/** One validated finance row, in collection order and id order. */
interface SnapshotRowWrite {
  readonly entityType: SyncEntityType;
  readonly collection: string;
  readonly entityId: SyncEntityId;
  readonly record: SyncJsonObject;
}

function batchAppender(batch: BatchService): SyncBatchAppender {
  return {
    create: (collectionName, body) => {
      batch.collection(collectionName).create(body);
    },
    update: (collectionName, recordId, body) => {
      batch.collection(collectionName).update(recordId, body);
    },
  };
}

function snapshotRowsInCommitOrder(snapshot: SyncSeedSnapshot): SnapshotRowWrite[] {
  const rows: SnapshotRowWrite[] = [];
  for (const entityType of SYNC_ENTITY_TYPES) {
    const collection = SYNC_COLLECTIONS[entityType];
    const records = snapshot[collection] as unknown as readonly PocketRecordRow[];
    const sorted = [...records].sort((left, right) =>
      String(left['id']).localeCompare(String(right['id'])),
    );
    for (const record of sorted) {
      rows.push({
        entityType,
        collection,
        entityId: String(record['id']),
        record: toSyncJsonObject(record, `snapshot ${collection}/${String(record['id'])}`),
      });
    }
  }
  return rows;
}

function countsOfRows(
  rows: readonly SnapshotRowWrite[],
): Readonly<Record<SyncEntityType, number>> {
  const counts = {} as Record<SyncEntityType, number>;
  for (const entityType of SYNC_ENTITY_TYPES) {
    counts[entityType] = 0;
  }
  for (const row of rows) {
    counts[row.entityType] += 1;
  }
  return counts;
}

function decodeImportResult(
  receipt: SnapshotImportReceipt,
  expectedImportId: string,
): SyncImportResult {
  const result = receipt.result;
  if (result['importId'] !== expectedImportId) {
    throw new Error(
      `Snapshot import receipt ${receipt.recordId} stores a different importId`,
    );
  }
  const serverInstanceId = result['serverInstanceId'];
  const cursor = result['cursor'];
  const dataEpoch = result['dataEpoch'];
  const rawCounts = result['counts'];
  if (
    typeof serverInstanceId !== 'string' ||
    typeof dataEpoch !== 'number' ||
    !Number.isInteger(dataEpoch) ||
    typeof cursor !== 'number' ||
    !Number.isInteger(cursor) ||
    rawCounts === null ||
    typeof rawCounts !== 'object' ||
    Array.isArray(rawCounts)
  ) {
    throw new Error(
      `Snapshot import receipt ${receipt.recordId} stores a malformed result`,
    );
  }
  // `Array.isArray` cannot subtract `readonly SyncJsonValue[]` from the
  // negative branch, so the checked payload is narrowed by the canonical
  // converter itself instead of a cast: anything that is not a plain JSON
  // object fails there.
  const countsObject = toSyncJsonObject(
    rawCounts,
    `snapshot import receipt ${receipt.recordId} counts`,
  );
  const counts = {} as Record<SyncEntityType, number>;
  for (const entityType of SYNC_ENTITY_TYPES) {
    const count = countsObject[entityType];
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      throw new Error(
        `Snapshot import receipt ${receipt.recordId} lacks the ${entityType} count`,
      );
    }
    counts[entityType] = count;
  }
  return {
    serverInstanceId,
    dataEpoch,
    cursor,
    counts,
    importId: expectedImportId,
  };
}

/**
 * Read/write adapter for the sync API slice's protocol persistence. Owns the
 * import receipt collection and the finance reads the gateway needs; the
 * runtime owner's journal repository stays the ledger authority.
 */
export class PocketbaseSyncProtocolRepository {
  constructor(private readonly pb: PocketBase) {}

  // -----------------------------------------------------------------------
  // Finance reads
  // -----------------------------------------------------------------------

  /** One finance row by entity id, or `null` when absent. */
  async readFinanceRecord(
    entityType: SyncEntityType,
    entityId: string,
  ): Promise<PocketRecordRow | null> {
    if (!isSyncEntityId(entityId)) {
      throw new Error(
        `Refusing a finance read for the non-canonical id ${JSON.stringify(entityId)}`,
      );
    }
    const rows = (await this.pb
      .collection(SYNC_COLLECTIONS[entityType])
      .getList(1, 1, { filter: `id = '${entityId}'` })) as unknown as {
      items: PocketRecordRow[];
    };
    return rows.items[0] ?? null;
  }

  /** Transactions generated by one recurrence, for month idempotency. */
  async listTransactionsByRecurrence(
    recurrenceId: string,
  ): Promise<readonly PocketRecordRow[]> {
    if (!isSyncEntityId(recurrenceId)) {
      throw new Error(
        `Refusing a recurrence query for the non-canonical id ${JSON.stringify(recurrenceId)}`,
      );
    }
    const rows = (await this.pb
      .collection(SYNC_COLLECTIONS.transaction)
      .getFullList({
        filter: `recurrence_id = '${recurrenceId}'`,
      })) as unknown as PocketRecordRow[];
    return rows;
  }

  /** Every row id of one finance collection. */
  async listFinanceIds(collection: string): Promise<readonly string[]> {
    const rows = (await this.pb
      .collection(collection)
      .getFullList({ fields: 'id' })) as unknown as Array<{ id: string }>;
    return rows.map((row) => String(row.id));
  }

  /** `entityType:entityId` keys present in the version ledger (tombstones included). */
  async listEntityVersionKeys(): Promise<ReadonlySet<string>> {
    const rows = (await this.pb
      .collection('obol_sync_entity_versions')
      .getFullList({ fields: 'entityType,entityId' })) as unknown as Array<{
      entityType: string;
      entityId: string;
    }>;
    const keys = new Set<string>();
    for (const row of rows) {
      if (!isSyncEntityType(row.entityType)) {
        throw new Error(
          `The version ledger holds the unknown entity type ${JSON.stringify(row.entityType)}`,
        );
      }
      keys.add(syncRevisionKey(row.entityType, row.entityId));
    }
    return keys;
  }

  /** Version-ledger row count (seed emptiness check). */
  async countEntityVersions(): Promise<number> {
    const page = (await this.pb
      .collection('obol_sync_entity_versions')
      .getList(1, 1)) as unknown as { totalItems: number };
    return page.totalItems;
  }

  // -----------------------------------------------------------------------
  // Import receipts
  // -----------------------------------------------------------------------

  async readImportReceipt(importId: string): Promise<SnapshotImportReceipt | null> {
    const page = (await this.pb
      .collection(IMPORT_RECEIPT_COLLECTION)
      .getList(1, 1, { filter: `importId = '${importId}'` })) as unknown as {
      items: PocketRecordRow[];
    };
    const row = page.items[0];
    if (!row) return null;
    const result = row['result'];
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error(
        `Snapshot import receipt ${String(row['id'])} stores a non-object result`,
      );
    }
    return {
      importId: String(row['importId']),
      stationId: String(row['stationId']),
      payloadHash: String(row['payloadHash']) as SyncSha256Hash,
      serverInstanceId: String(row['serverInstanceId']),
      dataEpoch: Number(row['dataEpoch']),
      result: toSyncJsonObject(result, `snapshot import result ${String(row['id'])}`),
      createdAt: String(row['createdAt']),
      recordId: String(row['id']),
    };
  }

  planImportReceipt(
    appender: SyncBatchAppender,
    receipt: {
      readonly importId: string;
      readonly stationId: string;
      readonly payloadHash: SyncSha256Hash;
      readonly serverInstanceId: string;
      readonly dataEpoch: number;
      readonly result: SyncImportResponse;
      readonly createdAt: string;
    },
  ): void {
    appender.create(IMPORT_RECEIPT_COLLECTION, {
      importId: receipt.importId,
      stationId: receipt.stationId,
      payloadHash: receipt.payloadHash,
      serverInstanceId: receipt.serverInstanceId,
      dataEpoch: receipt.dataEpoch,
      result: toSyncJsonObject(receipt.result, 'snapshot import response'),
      createdAt: receipt.createdAt,
    });
  }
}

// ---------------------------------------------------------------------------
// Server state view
// ---------------------------------------------------------------------------

/** Read-only deployment view consumed by the handshake/push/seed policies. */
export class PocketbaseSyncServerStateView implements SyncServerStateView {
  constructor(
    private readonly pb: PocketBase,
    private readonly syncRepository: PocketbaseSyncRepository,
    private readonly deploymentName: string,
  ) {}

  async readLedger(): Promise<SyncLedgerView | null> {
    const meta = await this.syncRepository.readSyncMeta();
    if (meta === null) return null;
    return {
      serverInstanceId: meta.serverInstanceId,
      dataEpoch: meta.dataEpoch,
      protocolMin: meta.protocolMin,
      protocolMax: meta.protocolMax,
      lastSeq: meta.lastSeq,
      headHash: meta.headHash,
    };
  }

  async ownerFingerprint(): Promise<SyncSha256Hash> {
    const page = (await this.pb.collection('owner').getList(1, 1)) as unknown as {
      items: Array<{ id: string }>;
    };
    const owner = page.items[0];
    if (!owner) {
      throw new Error(
        'The deployment has no owner record; ownerFingerprint cannot be derived',
      );
    }
    return sha256HashOfBytes(new TextEncoder().encode(String(owner.id)));
  }

  serverName(): string {
    return this.deploymentName;
  }

  async readStation(
    stationId: SyncStationId,
  ): Promise<SyncStationRegistrationView | null> {
    const station = await this.syncRepository.readStation(stationId);
    if (station === null) return null;
    return {
      stationId: station.stationId,
      deviceLabel: station.deviceLabel,
      platform: station.platform,
      lastCursor: station.lastCursor,
    };
  }

  async readCursorEvent(seq: SyncCursor): Promise<SyncCursorEventView | null> {
    if (!Number.isInteger(seq) || seq < 1) return null;
    // A row whose hash no longer verifies is a replaced history, not an
    // internal failure: the handshake must answer `SERVER_ROLLBACK_DETECTED`.
    const event = await this.syncRepository
      .readChangeEventAt(seq)
      .catch((error: unknown) => {
        if (error instanceof JournalReadError) {
          throw protocolErrorFor(error);
        }
        throw error;
      });
    if (event === null) return null;
    return {
      chainHash: event.chainHash,
      commitIndex: event.commitIndex,
      commitSize: event.commitSize,
    };
  }

  async financeRowCounts(): Promise<Readonly<Record<SyncEntityType, number>>> {
    const counts = {} as Record<SyncEntityType, number>;
    for (const entityType of SYNC_ENTITY_TYPES) {
      const page = (await this.pb
        .collection(SYNC_COLLECTIONS[entityType])
        .getList(1, 1)) as unknown as { totalItems: number };
      counts[entityType] = page.totalItems;
    }
    return counts;
  }
}

// ---------------------------------------------------------------------------
// Station registry (metadata-only write inside the shared FIFO gate)
// ---------------------------------------------------------------------------

export class RuntimeSyncStationRegistry implements SyncStationRegistry {
  constructor(
    private readonly runtime: FinancialMutationRuntime,
    private readonly clock: SyncClock = systemSyncClock,
  ) {}

  async register(input: SyncStationRegistrationInput): Promise<void> {
    await this.runtime.initialize();
    const execution = await this.runtime.coordinator.run(
      {
        origin: 'sync',
        stationId: null,
        clock: this.clock,
        operation: null,
      },
      async (unitOfWork) => {
        await this.runtime.syncRepository.planStationRegistration(
          unitOfWork.metadataBatch(),
          {
            stationId: input.stationId,
            deviceLabel: input.deviceLabel,
            platform: input.platform,
            firstSeenAt: input.at,
            lastSeenAt: input.at,
            ...(input.lastCursor !== null
              ? { lastCursor: input.lastCursor }
              : {}),
          },
        );
      },
    );
    if (execution.outcome.status !== 'applied') {
      throw new Error(
        `Station registration did not commit (${execution.outcome.status})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Pull page reader
// ---------------------------------------------------------------------------

/**
 * Maps a journal read failure to the wire code the protocol assigns.
 *
 * A cursor that left the journal, or a stored row that no longer reproduces
 * its own `chainHash` or link to its predecessor, means the server's history
 * is not the history the station was told about: `SERVER_ROLLBACK_DETECTED`.
 * Request-shape and paging-structure failures stay `PAGE_INVALID`, and a
 * mid-group cursor stays `CURSOR_NOT_ON_COMMIT_BOUNDARY`.
 */
function protocolErrorFor(error: JournalReadError): SyncProtocolRequestError {
  switch (error.code) {
    case 'CURSOR_NOT_ON_COMMIT_BOUNDARY':
      return new SyncProtocolRequestError('CURSOR_NOT_ON_COMMIT_BOUNDARY', error.message);
    case 'COMMIT_PAGE_TOO_LARGE':
      return new SyncProtocolRequestError('COMMIT_PAGE_TOO_LARGE', error.message);
    case 'JOURNAL_CURSOR_GONE':
    case 'JOURNAL_CHAIN_BROKEN':
      return new SyncProtocolRequestError('SERVER_ROLLBACK_DETECTED', error.message);
    case 'PAGE_INVALID':
    default:
      return new SyncProtocolRequestError('PAGE_INVALID', error.message);
  }
}

export class RuntimeSyncEventPageReader implements SyncEventPageReader {
  constructor(
    private readonly runtime: FinancialMutationRuntime,
    private readonly stateView: SyncServerStateView,
  ) {}

  async pullPage(query: {
    readonly cursor: SyncCursor;
    readonly limit: number;
  }): Promise<SyncPullPage> {
    let page: SyncJournalPage;
    try {
      page = await this.runtime.syncRepository.readJournalPage(query);
    } catch (error) {
      if (error instanceof JournalReadError) {
        throw protocolErrorFor(error);
      }
      throw error;
    }
    const ledger = await this.stateView.readLedger();
    if (ledger === null) {
      throw new Error(
        'obol_sync_meta is missing; the mutation runtime must initialize before serving sync',
      );
    }
    // `SyncStoredChangeEvent` is a `SyncChangeEvent` plus the optional
    // idempotency key, which is never part of the chain hash.
    const events: readonly SyncChangeEvent[] = page.events;
    await this.assertPageIntegrity(query.cursor, events);
    return {
      serverInstanceId: ledger.serverInstanceId,
      dataEpoch: ledger.dataEpoch,
      events,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }

  /**
   * Re-verifies the stored chain before serving a page: the first event links
   * to the cursor's committed hash, every following event links to its
   * predecessor, and every `chainHash` recomputes from the event fields. A
   * mismatch is a replaced/corrupt journal, never silently served.
   */
  private async assertPageIntegrity(
    cursor: SyncCursor,
    events: readonly SyncChangeEvent[],
  ): Promise<void> {
    if (events.length === 0) return;
    let expectedPrevHash: SyncHash = SYNC_GENESIS_HASH;
    if (cursor !== SYNC_GENESIS_CURSOR) {
      const boundary = await this.runtime.syncRepository.readChangeEventAt(cursor);
      if (boundary === null) {
        throw new SyncProtocolRequestError(
          'SERVER_ROLLBACK_DETECTED',
          `No journal event exists at cursor ${cursor}.`,
        );
      }
      expectedPrevHash = boundary.chainHash;
    }

    for (const event of events) {
      if (event.prevHash !== expectedPrevHash) {
        throw new SyncProtocolRequestError(
          'SERVER_ROLLBACK_DETECTED',
          `Journal event ${event.seq} does not link to the previous chain hash.`,
        );
      }
      const recomputed = changeChainHash({
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
        createdAt: event.createdAt,
        prevHash: event.prevHash,
      });
      if (recomputed !== event.chainHash) {
        throw new SyncProtocolRequestError(
          'SERVER_ROLLBACK_DETECTED',
          `Journal event ${event.seq} does not match its stored chain hash.`,
        );
      }
      expectedPrevHash = event.chainHash;
    }
  }
}

// ---------------------------------------------------------------------------
// Snapshot seed / import gateway
// ---------------------------------------------------------------------------

/**
 * Commits a complete snapshot as ONE atomic PocketBase batch. Controllers
 * await runtime initialization first; the gateway additionally verifies the
 * ledger identity it was handed.
 */
export class PocketbaseSnapshotGateway implements SyncSeedGateway, SyncImportGateway {
  private readonly protocolRepository: PocketbaseSyncProtocolRepository;
  private readonly stateView: PocketbaseSyncServerStateView;

  constructor(
    private readonly runtime: FinancialMutationRuntime,
    protocolRepository?: PocketbaseSyncProtocolRepository,
    private readonly clock: SyncClock = systemSyncClock,
  ) {
    this.protocolRepository =
      protocolRepository ??
      new PocketbaseSyncProtocolRepository(runtime.pb);
    this.stateView = new PocketbaseSyncServerStateView(
      runtime.pb,
      runtime.syncRepository,
      runtime.serverName,
    );
  }

  async seed(input: SyncSeedGatewayInput): Promise<SyncSnapshotResult> {
    await this.runtime.initialize();
    return await this.runtime.coordinator.runBatch(async () => {
      const meta = await this.requiredMeta();
      this.assertLedgerIdentity(
        meta.serverInstanceId,
        meta.dataEpoch,
        input.serverInstanceId,
        input.dataEpoch,
      );
      await this.assertServerEmpty();

      const rows = snapshotRowsInCommitOrder(input.snapshot);
      await this.assertSnapshotFieldsSupported(rows);
      const outcome = await this.commitSnapshot(meta, rows, input.stationId);
      return outcome.snapshot;
    });
  }

  async import(input: SyncImportGatewayInput): Promise<SyncImportResult> {
    await this.runtime.initialize();
    return await this.runtime.coordinator.runBatch(async () => {
      const meta = await this.requiredMeta();
      this.assertLedgerIdentity(
        meta.serverInstanceId,
        meta.dataEpoch,
        input.serverInstanceId,
        input.dataEpoch,
      );
      this.assertImportHash(input);

      const receipt = await this.protocolRepository.readImportReceipt(
        input.importId,
      );
      if (receipt !== null) {
        if (
          receipt.payloadHash !== input.payloadHash ||
          receipt.stationId !== input.stationId ||
          receipt.serverInstanceId !== meta.serverInstanceId ||
          receipt.dataEpoch !== meta.dataEpoch
        ) {
          throw new SyncProtocolRequestError(
            'IMPORT_ID_REUSED',
            `importId ${input.importId} was already accepted with different frozen content.`,
          );
        }
        return decodeImportResult(receipt, input.importId);
      }

      const rows = snapshotRowsInCommitOrder(input.snapshot);
      await this.assertSnapshotFieldsSupported(rows);
      await this.assertNoEntityIdCollisions(rows);

      const outcome = await this.commitSnapshot(meta, rows, input.stationId, {
        importId: input.importId,
        payloadHash: input.payloadHash,
      });
      return outcome.response;
    });
  }

  private async requiredMeta(): Promise<{
    serverInstanceId: string;
    dataEpoch: number;
    lastSeq: number;
    headHash: SyncHash;
    recordId: string;
  }> {
    const meta = await this.runtime.syncRepository.readSyncMeta();
    if (meta === null) {
      throw new Error(
        'obol_sync_meta is missing; the mutation runtime must initialize before serving sync',
      );
    }
    return meta;
  }

  private assertLedgerIdentity(
    actualInstance: string,
    actualEpoch: number,
    requestedInstance: string,
    requestedEpoch: number,
  ): void {
    if (actualInstance !== requestedInstance) {
      throw new SyncProtocolRequestError(
        'ENDPOINT_MISMATCH',
        'The snapshot request names a different server instance.',
      );
    }
    if (actualEpoch !== requestedEpoch) {
      throw new SyncProtocolRequestError(
        'DATA_EPOCH_CHANGED',
        `The server data epoch is ${actualEpoch}; the request keeps ${requestedEpoch}.`,
      );
    }
  }

  /** Six-field hash re-verified inside the gate, before any write. */
  private assertImportHash(input: SyncImportGatewayInput): void {
    const six = {
      protocolVersion: input.protocolVersion,
      stationId: input.stationId,
      serverInstanceId: input.serverInstanceId,
      dataEpoch: input.dataEpoch,
      importId: input.importId,
      snapshot: input.snapshot,
    };
    const recomputed = canonicalHash(
      toSyncJsonValue(six, 'import hash input'),
    );
    if (recomputed !== input.payloadHash) {
      throw new SyncProtocolRequestError(
        'PAGE_INVALID',
        'The declared import payloadHash does not match the frozen six-field envelope.',
      );
    }
  }

  /** Authoritative seed emptiness: finance rows, version rows and journal. */
  private async assertServerEmpty(): Promise<void> {
    const counts = await this.stateView.financeRowCounts();
    if (Object.values(counts).some((count) => count > 0)) {
      throw new SyncProtocolRequestError(
        'SERVER_NOT_EMPTY',
        'The server already holds financial data; a seed is never merged into it.',
      );
    }
    if ((await this.protocolRepository.countEntityVersions()) > 0) {
      throw new SyncProtocolRequestError(
        'SERVER_NOT_EMPTY',
        'The server already holds entity revisions; a seed is only for an empty deployment.',
      );
    }
    if ((await this.runtime.syncRepository.countChangeEvents()) > 0) {
      throw new SyncProtocolRequestError(
        'SERVER_NOT_EMPTY',
        'The server already holds journal events; a seed is only for an empty deployment.',
      );
    }
  }

  /**
   * Any existing finance id or version-ledger key (including a tombstone)
   * rejects the whole import with no effects. Fresh ids are minted by the
   * client; the server never remaps or merges.
   */
  private async assertNoEntityIdCollisions(
    rows: readonly SnapshotRowWrite[],
  ): Promise<void> {
    const idsByType = new Map<SyncEntityType, Set<string>>();
    for (const row of rows) {
      const set = idsByType.get(row.entityType) ?? new Set<string>();
      set.add(row.entityId);
      idsByType.set(row.entityType, set);
    }
    for (const [entityType, ids] of idsByType) {
      const existing = await this.protocolRepository.listFinanceIds(
        SYNC_COLLECTIONS[entityType],
      );
      for (const id of existing) {
        if (ids.has(id)) {
          throw new SyncProtocolRequestError(
            'IMPORT_ENTITY_ID_TAKEN',
            `${entityType}:${id} already exists on this server; imports never merge or overwrite.`,
          );
        }
      }
    }
    const versionKeys = await this.protocolRepository.listEntityVersionKeys();
    for (const row of rows) {
      if (versionKeys.has(syncRevisionKey(row.entityType, row.entityId))) {
        throw new SyncProtocolRequestError(
          'IMPORT_ENTITY_ID_TAKEN',
          `${row.entityType}:${row.entityId} already has a server revision (including tombstones); fresh ids are required.`,
        );
      }
    }
  }

  /**
   * Every declared snapshot field must exist on the live collection schema.
   *
   * PocketBase ignores record keys the collection does not declare, so a
   * snapshot row would be stored with that field silently dropped and the
   * seed/import would answer 200 while losing data (a `recurrences` row with
   * `category_id` on a deployment that missed the schema migration). The
   * schema is read once per collection and compared with exactly the keys the
   * caller sent; the first unsupported field rejects the whole request before
   * any row is written.
   */
  private async assertSnapshotFieldsSupported(
    rows: readonly SnapshotRowWrite[],
  ): Promise<void> {
    const storedFieldsByCollection = new Map<string, ReadonlySet<string>>();
    for (const row of rows) {
      let storedFields = storedFieldsByCollection.get(row.collection);
      if (storedFields === undefined) {
        const collection = await this.runtime.pb.collections.getOne(
          row.collection,
        );
        storedFields = new Set(
          collection.fields.map((field) => field.name),
        );
        storedFieldsByCollection.set(row.collection, storedFields);
      }
      for (const field of Object.keys(row.record)) {
        if (SYSTEM_RECORD_FIELDS[field] === true) continue;
        if (storedFields.has(field)) continue;
        throw new SyncProtocolRequestError(
          'PAGE_INVALID',
          `The ${row.collection} collection cannot store the field "${field}" declared by ${row.entityType}:${row.entityId}; this snapshot would be committed with that field silently dropped.`,
        );
      }
    }
  }

  /**
   * Writes every finance row, its revision-1 version row, the complete journal
   * commit and the meta advance in one PB batch; import additionally appends
   * its receipt to the SAME batch.
   */
  private async commitSnapshot(
    meta: {
      serverInstanceId: string;
      dataEpoch: number;
      lastSeq: number;
      headHash: SyncHash;
    },
    rows: readonly SnapshotRowWrite[],
    stationId: SyncStationId,
    importIdentity?: {
      readonly importId: string;
      readonly payloadHash: SyncSha256Hash;
    },
  ): Promise<SnapshotCommitOutcome> {
    if (rows.length > SYNC_MAX_COMMIT_EVENTS) {
      throw new SyncProtocolRequestError(
        'REQUEST_TOO_LARGE',
        `One snapshot commit carries ${String(rows.length)} entity events; the bound is ${String(SYNC_MAX_COMMIT_EVENTS)}.`,
        413,
      );
    }
    const createdAt = normalizeSyncTimestamp(
      this.clock.now(),
      'snapshot commit timestamp',
    );
    const commitId = newOperationId();
    const commitSize = rows.length;
    let previousHash: SyncHash =
      meta.lastSeq === SYNC_GENESIS_CURSOR ? SYNC_GENESIS_HASH : meta.headHash;

    const events: SyncChangeEvent[] = [];
    rows.forEach((row, index) => {
      const seq = meta.lastSeq + index + 1;
      const chainHash = changeChainHash({
        seq,
        commitId,
        commitIndex: index,
        commitSize,
        kind: 'upsert',
        entityType: row.entityType,
        entityId: row.entityId,
        revision: 1,
        recordHash: recordHash(row.record),
        origin: 'seed',
        stationId,
        opId: null,
        createdAt,
        prevHash: previousHash,
      });
      events.push({
        seq,
        commitId,
        commitIndex: index,
        commitSize,
        kind: 'upsert',
        entityType: row.entityType,
        entityId: row.entityId,
        revision: 1,
        record: row.record,
        origin: 'seed',
        stationId,
        createdAt,
        prevHash: previousHash,
        chainHash,
      });
      previousHash = chainHash;
    });

    const cursor = meta.lastSeq + rows.length;
    const counts = countsOfRows(rows);
    const response: SyncImportResponse = {
      serverInstanceId: meta.serverInstanceId,
      dataEpoch: meta.dataEpoch,
      cursor,
      counts,
      importId: importIdentity?.importId ?? '',
    };

    const batch = this.runtime.pb.createBatch();
    const appender = batchAppender(batch);

    for (const row of rows) {
      // `BatchCollection.create` accepts the client-chosen PocketBase id.
      batch.collection(row.collection).create({ ...row.record });
    }
    if (rows.length > 0) {
      await this.runtime.syncRepository.planEntityVersionUpserts(
        appender,
        rows.map((row, index) => ({
          entityType: row.entityType,
          entityId: row.entityId,
          revision: 1,
          deleted: false,
          lastSeq: meta.lastSeq + index + 1,
        })),
      );
      await this.runtime.syncRepository.planChangeEventCreates(
        appender,
        events,
      );
    }
    await this.runtime.syncRepository.planSyncMetaForCommit(appender, {
      lastSeq: cursor,
      headHash: rows.length > 0 ? previousHash : meta.headHash,
    });
    if (importIdentity !== undefined) {
      this.protocolRepository.planImportReceipt(appender, {
        importId: importIdentity.importId,
        stationId,
        payloadHash: importIdentity.payloadHash,
        serverInstanceId: meta.serverInstanceId,
        dataEpoch: meta.dataEpoch,
        result: response,
        createdAt,
      });
    }

    await batch.send();

    return {
      snapshot: {
        serverInstanceId: response.serverInstanceId,
        dataEpoch: response.dataEpoch,
        cursor: response.cursor,
        counts: response.counts,
      },
      response,
    };
  }
}
