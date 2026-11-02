// Durable deterministic metadata-only journal backfill for preexisting finance
// rows (D016 D5, canon §12.3). Owned by the runtime composition; never by
// application code.
//
// Responsibilities, exactly:
// - verify that the `obol_sync_meta` singleton exists and is structurally sound
//   before touching anything (a corrupt ledger fails loudly and is never
//   restamped, never rewound);
// - enumerate the seven finance collections in the pinned order — accounts,
//   cards, categories, projects, recurrences, invoices, transactions — with ids
//   ascending inside each collection, through the repository's deterministic
//   `readBackfillRows`;
// - commit each bounded chunk as ONE complete commit group: revision-1 version
//   rows, `origin: 'seed'` upsert events with contiguous `seq`, one `commitId`
//   per chunk, and chain hashes continuing the stored head (never genesis once
//   the journal is non-empty);
// - stay idempotent for retries-after-crash through the durable
//   `obol_sync_changes.eventKey` (`backfill:<entityType>:<entityId>`): a
//   committed key is skipped, so no event, revision or chain hash is ever
//   duplicated, restamped or rewritten;
// - refuse a base whose rows already carry version rows without their
//   backfill event: that is partial prior state, and restamping it to
//   revision 1 would silently rewind a live ledger;
// - write `journalBackfilledAt`/`journalBackfillVersion` ONLY after every row
//   has been committed — inside the same atomic chunk when that chunk held
//   rows, or as a marker-only batch on an empty base;
// - remain metadata-only: no finance row is written, patched or moved by this
//   module, and finance bytes/ids stay byte-identical.
//
// Never owned here: HTTP routes and business rules. The chain-hash and
// canonical-JSON helpers are the shared module's, so a backfill event and a
// live mutation event are wire-identical in shape.

import type PocketBase from 'pocketbase';

import type { SyncClock } from '../../domain/sync/MutationContext';
import { SYNC_PULL_MAX_PAGE_BYTES } from '../../domain/sync/SyncProtocol';
import {
  SYNC_MAX_COMMIT_EVENTS,
  type SyncStoredChangeEvent,
} from '../../domain/sync/SyncChange';
import {
  SYNC_GENESIS_HASH,
  syncRevisionKey,
  type SyncEntityId,
  type SyncEntityType,
  type SyncHash,
  type SyncJsonObject,
  type SyncRevisionKey,
} from '../../domain/sync/SyncRevision';
import {
  canonicalJsonLength,
  changeChainHash,
  normalizeSyncTimestamp,
  recordHash,
  toSyncJsonValue,
} from './CanonicalJson';
import { newOperationId } from './RecordIds';
import {
  MutationPreconditionError,
  PocketbaseUnitOfWork,
} from '../repositories/PocketbaseUnitOfWork';
import {
  PocketbaseSyncRepository,
  type BackfillCursor,
  type BackfillPage,
  type SyncMetaSnapshot,
} from '../repositories/PocketbaseSyncRepository';

/**
 * The pinned durable idempotency key of one backfilled entity, documented on
 * `SyncStoredChangeEvent.eventKey`.
 */
export function backfillEventKey(
  entityType: SyncEntityType,
  entityId: SyncEntityId,
): string {
  return `backfill:${entityType}:${entityId}`;
}

/**
 * Rows per committed backfill chunk: comfortably below `SYNC_MAX_COMMIT_EVENTS`,
 * with the resume loop simply paging again for a larger base.
 */
const BACKFILL_CHUNK_ROWS = 2000;

/**
 * Identifies the backfill marker format. The admin reset writes the same
 * complete marker for its empty, fully journaled post-reset base, so a later
 * boot never restamps revisions of rows created after the reset.
 */
export const BACKFILL_MARKER_VERSION = 1;

/**
 * Metadata-only central journal backfill. Constructed by the runtime owner for
 * the central role and driven inside its FIFO gate, so no financial mutation
 * can interleave with a chunk commit.
 */
export class JournalBackfill {
  constructor(
    private readonly pb: PocketBase,
    private readonly synchronizer: PocketbaseSyncRepository,
    private readonly clock: SyncClock,
  ) {}

  /**
   * Runs the backfill to completion.
   *
   * Idempotent: a present, structurally valid final marker returns immediately;
   * an interrupted run resumes from chunk zero and skips durable event keys. A
   * corrupt meta singleton or a window of rows whose version rows exist without
   * their event fails loudly through the repository decode plus this module's
   * prior-state check — the ledger is never restamped.
   */
  async ensureComplete(): Promise<void> {
    const meta = await this.readValidMeta();
    if (meta.journalBackfilledAt !== null) {
      // The repository already requires the marker timestamp and version to be
      // written together, so a marked ledger is complete by construction.
      return;
    }

    let cursor: BackfillCursor | null = null;
    for (;;) {
      const page = await this.synchronizer.readBackfillRows({
        after: cursor,
        maxRows: BACKFILL_CHUNK_ROWS,
      });

      const candidateKeys: string[] = [];
      const seenKeys = new Set<string>();
      for (const row of page.rows) {
        const key = backfillEventKey(row.entityType, recordIdOf(row.record));
        if (seenKeys.has(key)) {
          throw new MutationPreconditionError(
            `Backfill enumeration produced entity ${key} twice; the deterministic scan is out of order`,
          );
        }
        seenKeys.add(key);
        candidateKeys.push(key);
      }

      const completed =
        candidateKeys.length > 0
          ? await this.synchronizer.readEventKeys(candidateKeys)
          : new Set<string>();
      const pendingRows = page.rows.filter(
        (row) =>
          !completed.has(backfillEventKey(row.entityType, recordIdOf(row.record))),
      );

      if (pendingRows.length > 0) {
        // The exhausted chunk carries the final marker in the same batch, so
        // "marked" and "complete" can never disagree.
        await this.commitChunk(pendingRows, page.exhausted);
      } else if (page.exhausted) {
        await this.commitFinalMarker();
      }

      if (page.exhausted) {
        return;
      }
      if (page.nextCursor === null) {
        throw new MutationPreconditionError(
          'The backfill enumerator returned no resume cursor without the exhausted flag',
        );
      }
      cursor = page.nextCursor;
    }
  }

  /**
   * Commits one atomic metadata chunk: events, revision-1 version rows and the
   * advanced meta head in one PocketBase batch. `includeMarker` is set only for
   * the exhausted chunk, so the marker lands after complete data.
   */
  private async commitChunk(
    rows: BackfillPage['rows'],
    includeMarker: boolean,
  ): Promise<void> {
    if (rows.length > SYNC_MAX_COMMIT_EVENTS) {
      throw new MutationPreconditionError(
        `A backfill chunk of ${rows.length} rows would exceed the ${SYNC_MAX_COMMIT_EVENTS}-event commit bound`,
      );
    }

    const meta = await this.readValidMeta();
    await this.assertNoPriorRevisionState(rows);

    const commitId = newOperationId();
    const createdAt = this.canonicalTimestamp();
    const previousTopHash: SyncHash =
      meta.lastSeq === 0 ? SYNC_GENESIS_HASH : meta.headHash;
    const commitSize = rows.length;

    const events: SyncStoredChangeEvent[] = [];
    let previousHash: SyncHash = previousTopHash;
    rows.forEach((row, index) => {
      const entityId = recordIdOf(row.record);
      const seq = meta.lastSeq + index + 1;
      const chainHash = changeChainHash({
        seq,
        commitId,
        commitIndex: index,
        commitSize,
        kind: 'upsert',
        entityType: row.entityType,
        entityId,
        revision: 1,
        recordHash: recordHash(row.record),
        origin: 'seed',
        stationId: null,
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
        entityId,
        revision: 1,
        record: row.record,
        origin: 'seed',
        createdAt,
        prevHash: previousHash,
        chainHash,
        eventKey: backfillEventKey(row.entityType, entityId),
      });
      previousHash = chainHash;
    });

    let eventBytes = 0;
    for (const event of events) {
      eventBytes += canonicalJsonLength(
        toSyncJsonValue(event, 'backfill event'),
      );
    }
    if (eventBytes > SYNC_PULL_MAX_PAGE_BYTES) {
      throw new MutationPreconditionError(
        `Backfill chunk of ${events.length} events serializes to ${eventBytes} bytes; the bound is ${SYNC_PULL_MAX_PAGE_BYTES}.`,
      );
    }

    const unitOfWork = new PocketbaseUnitOfWork(this.pb);
    const appender = unitOfWork.metadataBatch();
    await this.synchronizer.planChangeEventCreates(appender, events);
    await this.synchronizer.planEntityVersionUpserts(
      appender,
      events.map((event) => ({
        entityType: event.entityType,
        entityId: event.entityId,
        revision: 1,
        deleted: false,
        lastSeq: event.seq,
      })),
    );
    await this.synchronizer.planSyncMetaForCommit(appender, {
      lastSeq: meta.lastSeq + events.length,
      headHash: events[events.length - 1]!.chainHash,
      ...(includeMarker ? this.markerValues() : {}),
    });
    await unitOfWork.executeCommit();
  }

  /** Final marker for an empty or already-committed base: meta only marks. */
  private async commitFinalMarker(): Promise<void> {
    const meta = await this.readValidMeta();
    const unitOfWork = new PocketbaseUnitOfWork(this.pb);
    await this.synchronizer.planSyncMetaForCommit(unitOfWork.metadataBatch(), {
      lastSeq: meta.lastSeq,
      headHash: meta.headHash,
      ...this.markerValues(),
    });
    await unitOfWork.executeCommit();
  }

  /**
   * Fails closed when a row that still lacks its backfill event already carries
   * a version row. That state is a partially applied ledger, and writing
   * revision 1 over it would restamp (and silently rewind) live revisions.
   */
  private async assertNoPriorRevisionState(
    rows: BackfillPage['rows'],
  ): Promise<void> {
    const keys: SyncRevisionKey[] = rows.map((row) =>
      syncRevisionKey(row.entityType, recordIdOf(row.record)),
    );
    const versions = await this.synchronizer.readEntityVersions(keys);
    const restamped = keys.filter((key) => versions.has(key));
    if (restamped.length > 0) {
      throw new MutationPreconditionError(
        `Entity version rows exist without their backfill event (${restamped
          .slice(0, 5)
          .join(', ')}${restamped.length > 5 ? ', …' : ''}); the sync ledger is inconsistent and the backfill refuses to restamp it`,
      );
    }
  }

  private markerValues(): {
    readonly journalBackfilledAt: string;
    readonly journalBackfillVersion: number;
  } {
    return {
      journalBackfilledAt: this.canonicalTimestamp(),
      journalBackfillVersion: BACKFILL_MARKER_VERSION,
    };
  }

  private canonicalTimestamp(): string {
    try {
      return normalizeSyncTimestamp(this.clock.now(), 'backfill clock timestamp');
    } catch (error) {
      throw new MutationPreconditionError(
        `The backfill clock produced an unusable timestamp: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Reads the meta singleton and raises it to the runtime's structural sanity
   * bar. A missing row is a precondition (callers run `ensureSyncMeta()`
   * first); corrupt columns fail loudly through the repository decode plus this
   * epoch/journal validation, and are never rewritten here.
   */
  private async readValidMeta(): Promise<SyncMetaSnapshot> {
    const meta = await this.synchronizer.readSyncMeta();
    if (meta === null) {
      throw new MutationPreconditionError(
        'obol_sync_meta is missing; ensureSyncMeta() must run before the backfill',
      );
    }
    if (
      !Number.isInteger(meta.dataEpoch) ||
      meta.dataEpoch < 1 ||
      !Number.isInteger(meta.lastSeq) ||
      meta.lastSeq < 0
    ) {
      throw new MutationPreconditionError(
        'obol_sync_meta carries a corrupt epoch or journal head; refusing to backfill over it',
      );
    }
    return meta;
  }
}

/** The PocketBase record id of one backfilled finance row. */
function recordIdOf(record: SyncJsonObject): string {
  const id = record['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new MutationPreconditionError(
      'Backfilled finance row has no record id',
    );
  }
  return id;
}
