// The in-process FIFO mutation gate and the single atomic commit path for
// every financial write (D016 D2/D3/D9/D10, canon §12.2).
//
// One `run()` holds exactly one gate slot: HTTP routes, scheduler jobs, sync
// operation application and desktop station recording all resolve through it.
// Inside the slot one `PocketbaseUnitOfWork` buffers the use case's reads and
// writes, and the resulting finance rows, revision rows, change events, meta
// pointer (central journal) or station outbox plus local version rows (local
// modes), together with the accepted operation receipt, leave the process as
// ONE PocketBase batch.
//
// Owned here, and nowhere else:
// - the gate. Call order is preserved; an unrelated caller can never overtake
//   the slot. A `run()` issued inside a still-running mutation callback JOINS
//   that mutation (shared unit of work and clock, `deferred` outcome, the
//   outermost call owns the commit) so an awaited nested call cannot deadlock.
//   A context left behind by a finished mutation is NOT a live scope and
//   queues like any other caller.
// - the push-batch lease. `runBatch()` holds one gate slot for a whole batch
//   while every `lease.run()` still creates a fresh unit of work and commits
//   independently, so a valid operation followed by a rejected one keeps the
//   valid commit. The lease only sequences; it never re-implements a commit,
//   and an expired lease can never be reused to bypass the gate.
// - idempotency FIRST, before any use case runs. The complete eleven-field
//   envelope hash is recomputed from the received envelope; a mismatch is
//   `ENVELOPE_HASH_MISMATCH` and never touches the ledger. A stored receipt
//   with the same hash replays the original applied result; the same `opId`
//   with a different hash is the final `OP_ID_REUSED`.
// - write-set coverage on what the use case ACTUALLY wrote: a stale declared
//   revision is `SYNC_CONFLICT` with the pre-write authoritative record, an
//   existing entity written without a declared revision is `UNCOVERED_WRITE`
//   unless it is the additive `(card_id, period)` invoice delta, a create over
//   an existing version row (live or tombstone) is `ENTITY_ID_TAKEN`, and a
//   tombstoned ledger row beside a live finance row is a loud inconsistency.
// - deterministic revision/sequence assignment (create = 1, update/delete =
//   current + 1, one event per touched entity), canonical chain hashes that
//   continue the stored head — never genesis once the journal is non-empty —
//   and one `commitId` per commit.
// - capacity refusals BEFORE any effect: the per-commit event bound and the
//   serialized commit-group byte bound. The PocketBase batch body/request
//   bounds are enforced by `PocketbaseUnitOfWork.executeCommit()`.
//
// Failure semantics: PB batches are atomic, so a failed batch leaves nothing
// partial. Every path releases the gate, discards the buffer and expires the
// scope; a failing batch lease only abandons operations that had not started,
// while already committed operations stay committed.
//
// Never owned here: HTTP routes, direct PocketBase client calls (all PB access
// lives in `infrastructure/repositories/`), and business rules — the injected
// use cases own every financial effect.

import { AsyncLocalStorage } from 'node:async_hooks';
import type PocketBase from 'pocketbase';

import type { SyncClock } from '../../domain/sync/MutationContext';
import {
  SYNC_MAX_COMMIT_EVENTS,
  type SyncChangeEvent,
  type SyncChangeKind,
  type SyncChangeOrigin,
  type SyncCommitId,
  type SyncCursor,
  type SyncStoredChangeEvent,
} from '../../domain/sync/SyncChange';
import { SYNC_PULL_MAX_PAGE_BYTES } from '../../domain/sync/SyncProtocol';
import {
  SYNC_COLLECTIONS,
  SYNC_GENESIS_HASH,
  isSyncEntityId,
  isSyncEntityType,
  syncRevisionKey,
  type SyncEntityId,
  type SyncEntityType,
  type SyncEntityVersionRef,
  type SyncHash,
  type SyncJsonObject,
  type SyncRecord,
  type SyncRevisionKey,
  type SyncSha256Hash,
} from '../../domain/sync/SyncRevision';
import {
  isSyncOperationRejectionCode,
  type SyncAppliedEntity,
  type SyncAppliedOperationResult,
  type SyncConflictEntry,
  type SyncOperationRejectionCode,
  type SyncOperationResult,
  type SyncOperationWire,
  type SyncOutboxOperation,
} from '../../domain/sync/SyncOperation';
import {
  canonicalJsonLength,
  changeChainHash,
  normalizeSyncTimestamp,
  operationEnvelopeHash,
  recordHash,
  toSyncJsonObject,
  toSyncJsonValue,
} from '../sync/CanonicalJson';
import { newOperationId } from '../sync/RecordIds';
import {
  MutationPreconditionError,
  PocketbaseUnitOfWork,
  type BufferedRowWrite,
  type SyncBatchAppender,
} from '../repositories/PocketbaseUnitOfWork';
import {
  PocketbaseSyncRepository,
  type EntityVersionWrite,
} from '../repositories/PocketbaseSyncRepository';

/** Central journaling is the default; desktop local modes opt out. */
const DEFAULT_CENTRAL_JOURNAL = true;

// ---------------------------------------------------------------------------
// Public request / outcome shapes
// ---------------------------------------------------------------------------

/**
 * The single write-set coverage exception (canon §12.2): the invoice that a
 * card purchase or a recurrence launch creates or finds. A client cannot know
 * that invoice's revision, so exactly the invoice matching `(card_id, period)`
 * is exempt; a concurrent payment or deletion declares the invoice revision
 * and conflicts normally.
 */
export interface AdditiveInvoiceDelta {
  readonly cardId: string;
  readonly period: string;
}

/**
 * One coalesced write as exposed to an outbox descriptor factory.
 *
 * `record` is the complete record after the write (`null` for a delete) and
 * `beforeRecord` is the authoritative PRE-mutation record, never a post-state:
 * a factory that re-expresses the user's intent must diff against the real
 * previous row.
 */
export interface StationOutboxWriteContext {
  readonly entityType: SyncEntityType;
  readonly entityId: SyncEntityId;
  readonly kind: SyncChangeKind;
  /** False when this mutation created the entity (no pre-write record). */
  readonly existed: boolean;
  readonly revision: number;
  readonly record: SyncRecord | null;
  readonly beforeRecord: SyncRecord | null;
}

/**
 * Read-only view of the mutation handed to a
 * `StationOutboxDescriptorFactory` after the use case buffered its writes and
 * local revisions were assigned.
 */
export interface StationOutboxPlanContext {
  readonly origin: SyncChangeOrigin;
  readonly stationId: string | null;
  /** Clock of the recorded mutation; every descriptor shares its instant. */
  readonly clock: SyncClock;
  readonly writes: readonly StationOutboxWriteContext[];
}

/**
 * Builds the durable descriptors for every operation the mutation generated
 * (the submitted one plus scheduler-generated facts and status operations).
 * Evaluated inside the commit plan, so every descriptor lands in the same
 * finance batch; a throw aborts the commit with no remote effect.
 */
export type StationOutboxDescriptorFactory = (
  context: StationOutboxPlanContext,
) => readonly SyncOutboxOperation[] | Promise<readonly SyncOutboxOperation[]>;

/** Explicit descriptors, or a factory evaluated against the actual writes. */
export type StationOutboxSource =
  | readonly SyncOutboxOperation[]
  | StationOutboxDescriptorFactory;

/** One financial mutation submitted to the FIFO gate. */
export interface MutationRequest {
  /** `web`/`job`/`admin`/`station`/`sync`/`seed`. */
  readonly origin: SyncChangeOrigin;
  /** Registered station id for station/sync mutations, `null` otherwise. */
  readonly stationId: string | null;
  /** Server clock for web/job/admin; the operation clock for sync replay. */
  readonly clock: SyncClock;
  /**
   * Accepted operation envelope plus its complete-envelope hash when the
   * mutation applies a synchronized operation; `null` for web/job/admin.
   */
  readonly operation: SyncOperationWire | null;
  /** Additive invoice delta exemption for this operation, when applicable. */
  readonly additiveInvoiceDelta?: AdditiveInvoiceDelta | null;
  /**
   * Station/standalone durable descriptors recorded in `obol_station_outbox`
   * inside the same finance batch: an explicit array or a factory evaluated
   * against the actual write set. Ignored centrally. Never truncated and
   * never silently deduplicated: a repeated opId or more than
   * `SYNC_MAX_COMMIT_EVENTS` descriptors aborts the commit before any write.
   */
  readonly stationOutbox?: StationOutboxSource | null;
  /**
   * `true` (default) writes the central `obol_sync_*` journal, meta pointer and
   * version rows plus the operation receipt. Desktop local modes set `false`:
   * the finance batch then records the provided outbox descriptors plus
   * `obol_station_versions` rows instead, and no central journal exists.
   */
  readonly centralJournal?: boolean;
  /**
   * Local-only inbound apply bookkeeping: authoritative accepted server
   * entities whose version rows merge into the SAME batch. Only meaningful
   * with `centralJournal: false`. The plan is the UNION of the working writes
   * and these keys with exactly one row upsert per key: a working write keeps
   * its optimistic localRevision, while a received entity overrides the
   * authoritative `serverRevision`/`serverDeleted`/`baseRecord` trio.
   */
  readonly stationServerEntities?: readonly SyncAppliedEntity[] | null;
}

/**
 * Outcome of one mutation. `applied` describes exactly one commit; `duplicate`
 * replays a stored receipt; `rejected`/`conflict` write nothing; `blocked` is
 * a push-batch ordering concern produced by the route layer, never here.
 */
export type MutationOutcome =
  | {
      readonly status: 'applied';
      readonly opId: string | null;
      readonly commitId: SyncCommitId;
      /** First journal `seq` written by this commit (head when it wrote none). */
      readonly firstSeq: SyncCursor;
      /** Last journal `seq` written by this commit (cursor after the commit). */
      readonly lastSeq: SyncCursor;
      /** `chainHash` of the last event of this commit (head when none). */
      readonly headHash: SyncHash;
      readonly entityVersions: readonly SyncEntityVersionRef[];
      readonly entities: readonly SyncAppliedEntity[];
    }
  | {
      readonly status: 'duplicate';
      readonly opId: string;
      readonly payloadHash: SyncSha256Hash;
      /** Stored original per-operation result (applied shape, replayed). */
      readonly storedResult: SyncOperationResult;
    }
  | {
      readonly status: 'rejected';
      readonly opId: string | null;
      readonly code: SyncOperationRejectionCode;
      readonly message: string;
    }
  | {
      readonly status: 'conflict';
      readonly opId: string | null;
      readonly code: 'SYNC_CONFLICT';
      readonly conflicts: readonly SyncConflictEntry[];
    }
  | {
      /** A nested call joins its outer mutation: it never commits. */
      readonly status: 'deferred';
    };

/** A completed `run()`: the protocol outcome plus the use case return value. */
export interface MutationExecution<T> {
  readonly outcome: MutationOutcome;
  /** The use case's own return value (`undefined` on non-executed paths). */
  readonly result?: T;
}

/**
 * A terminal non-applied operation outcome that must leave a durable receipt:
 * the opId is final even when nothing financial was written.
 */
export type TerminalOperationOutcome =
  | {
      readonly status: 'conflict';
      readonly conflicts: readonly SyncConflictEntry[];
    }
  | {
      readonly status: 'rejected';
      readonly code: SyncOperationRejectionCode;
      readonly message: string;
    };

/**
 * Exclusive batch lease handed to `MutationCoordinator.runBatch`.
 *
 * The lease owns ONE gate slot for the whole callback while every
 * `lease.run()` commits independently through the same single commit path as
 * `run()`. Business use cases invoked inside an operation may still join its
 * mutation scope (a nested `run()` shares the unit of work and defers the
 * outcome); operations are serialized in submission order.
 *
 * Call shape for the push executor:
 *
 * ```ts
 * await coordinator.runBatch(async (lease) => {
 *   for (const operation of acceptedOperations) {
 *     const { outcome } = await lease.run(
 *       {
 *         origin: 'sync',
 *         stationId: operation.stationId,
 *         clock: { now: () => operation.effectiveAt },
 *         operation,
 *         additiveInvoiceDelta: null,
 *       },
 *       (unitOfWork) => applySyncOperation(operation, unitOfWork),
 *     );
 *     results.push(operationResultOf(outcome));
 *   }
 * });
 * ```
 *
 * The lease is valid only inside its callback and for operations it already
 * started. A handle that escapes that window fails with
 * `MutationPreconditionError`; an ordinary `run()` from an expired inherited
 * context queues on the FIFO gate anew.
 */
export interface MutationBatchLease {
  /**
   * Runs one operation inside the lease with its own unit of work and its own
   * commit. A rejection stays per operation and never poisons the calls that
   * follow it in the lease.
   */
  run<T>(
    request: MutationRequest,
    apply: (unitOfWork: PocketbaseUnitOfWork) => Promise<T>,
  ): Promise<MutationExecution<T>>;
}

interface PlannedEntityWrite {
  readonly source: BufferedRowWrite;
  /** Revision this write receives in the current journaling mode. */
  revision: number;
  readonly existed: boolean;
}

type CoverageResolution =
  | { readonly kind: 'ok'; readonly planned: readonly PlannedEntityWrite[] }
  | {
      readonly kind: 'rejected';
      readonly code: SyncOperationRejectionCode;
      readonly message: string;
    }
  | { readonly kind: 'conflict'; readonly conflicts: readonly SyncConflictEntry[] };

interface StationLocalRevisionWrite {
  readonly entityType: SyncEntityType;
  readonly entityId: SyncEntityId;
  readonly localRevision: number;
  readonly serverRevision?: number | null;
  readonly serverDeleted?: boolean;
  readonly baseRecord?: SyncJsonObject | null;
  readonly deleted: boolean;
}

/** @internal shared scope behind the nested-call contract. */
interface ActiveMutationScope {
  readonly unitOfWork: PocketbaseUnitOfWork;
  readonly request: MutationRequest;
  /**
   * Liveness window: true only while the use case callback runs. It flips
   * before planning/commit and on every exit path, so an escaped
   * `AsyncLocalStorage` store can never resurrect a finished unit of work.
   */
  alive: boolean;
}

/**
 * @internal one acquired FIFO batch lease. `active` is the validity window: it
 * flips once the callback settles, so an escaped store can never reuse a dead
 * lease. `released` guards the single gate slot against a second release.
 */
interface ActiveBatchLease {
  active: boolean;
  released: boolean;
  /** Lease-local sequencing chain; never touches the global FIFO tail. */
  tail: Promise<unknown>;
}

/**
 * Converts one value into canonical JSON object form. A value the contract
 * cannot represent fails as a structural precondition instead of becoming a
 * lossy record.
 */
function jsonObjectOf(value: unknown, context: string): SyncJsonObject {
  try {
    return toSyncJsonObject(value, context);
  } catch (error) {
    throw new MutationPreconditionError(
      `${context} is not representable as canonical JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Canonical JSON record of one coalesced write (`null` for a delete). */
function recordJsonOf(
  record: Readonly<Record<string, unknown>> | null,
  context: string,
): SyncRecord | null {
  return record === null ? null : jsonObjectOf(record, context);
}

/**
 * Canonical JSON record of a value that may legitimately be absent or null:
 * `null` stays `null` (create-before state, delete tombstone, empty base), a
 * present object converts canonically, anything else fails loudly.
 */
function recordJsonOrNull(value: unknown, context: string): SyncRecord | null {
  if (value === undefined || value === null) {
    return null;
  }
  return jsonObjectOf(value, context);
}

/** Reads one entity reference triple from a stored result object. */
function storedEntityRef(value: unknown, context: string): SyncEntityVersionRef {
  const object = jsonObjectOf(value, context);
  const entityType = object['entityType'];
  const entityId = object['entityId'];
  const revision = object['revision'];
  if (typeof entityType !== 'string' || !isSyncEntityType(entityType)) {
    throw new MutationPreconditionError(`${context} has an invalid entityType`);
  }
  if (typeof entityId !== 'string' || !isSyncEntityId(entityId)) {
    throw new MutationPreconditionError(`${context} has an invalid entityId`);
  }
  if (typeof revision !== 'number' || !Number.isInteger(revision)) {
    throw new MutationPreconditionError(`${context} has an invalid revision`);
  }
  return { entityType, entityId, revision };
}

/**
 * Decodes the stored per-operation result of one ACCEPTED receipt. The BFF
 * records only applied results there, so any other shape is ledger corruption
 * and fails loudly instead of replaying an unchecked blob as a typed result.
 */
function storedAppliedResult(
  stored: SyncJsonObject | null,
  opId: string,
): SyncAppliedOperationResult {
  if (stored === null || stored['status'] !== 'applied') {
    throw new MutationPreconditionError(
      `Stored result for opId ${opId} is not an applied operation result`,
    );
  }
  if (stored['opId'] !== opId) {
    throw new MutationPreconditionError(
      `Stored result for opId ${opId} names a different operation`,
    );
  }
  const rawVersions = stored['entityVersions'];
  const rawEntities = stored['entities'];
  if (!Array.isArray(rawVersions) || !Array.isArray(rawEntities)) {
    throw new MutationPreconditionError(
      `Stored result for opId ${opId} lacks its entity lists`,
    );
  }
  const versions: readonly unknown[] = rawVersions;
  const entities: readonly unknown[] = rawEntities;
  return {
    opId,
    status: 'applied',
    entityVersions: versions.map((entry, index) =>
      storedEntityRef(entry, `stored entityVersions[${index}] of ${opId}`),
    ),
    entities: entities.map((entry, index): SyncAppliedEntity => {
      const context = `stored entities[${index}] of ${opId}`;
      const object = jsonObjectOf(entry, context);
      const record = object['record'];
      if (record === undefined) {
        throw new MutationPreconditionError(`${context} lacks its record`);
      }
      return {
        ...storedEntityRef(object, context),
        record:
          record === null ? null : jsonObjectOf(record, `${context} record`),
      };
    }),
  };
}

/**
 * Decodes the stored conflict list of a CONFLICTED receipt (`{ conflicts }`).
 * A malformed ledger is a structural fault, never a silently emptied conflict.
 */
function storedConflictEntries(
  stored: SyncJsonObject | null,
  opId: string,
): readonly SyncConflictEntry[] {
  if (stored === null || !Array.isArray(stored['conflicts'])) {
    throw new MutationPreconditionError(
      `Stored conflict for opId ${opId} lacks its conflict list`,
    );
  }
  const entries: readonly unknown[] = stored['conflicts'];
  return entries.map((entry, index): SyncConflictEntry => {
    const context = `stored conflicts[${index}] of ${opId}`;
    const object = jsonObjectOf(entry, context);
    const entityType = object['entityType'];
    const entityId = object['entityId'];
    const baseRevision = object['baseRevision'];
    const currentRevision = object['currentRevision'];
    if (typeof entityType !== 'string' || !isSyncEntityType(entityType)) {
      throw new MutationPreconditionError(`${context} has an invalid entityType`);
    }
    if (typeof entityId !== 'string' || !isSyncEntityId(entityId)) {
      throw new MutationPreconditionError(`${context} has an invalid entityId`);
    }
    if (baseRevision !== null && typeof baseRevision !== 'number') {
      throw new MutationPreconditionError(`${context} has an invalid baseRevision`);
    }
    if (typeof baseRevision === 'number' && !Number.isInteger(baseRevision)) {
      throw new MutationPreconditionError(`${context} has an invalid baseRevision`);
    }
    if (
      typeof currentRevision !== 'number' ||
      !Number.isInteger(currentRevision)
    ) {
      throw new MutationPreconditionError(
        `${context} has an invalid currentRevision`,
      );
    }
    const current = object['current'];
    if (current === undefined) {
      throw new MutationPreconditionError(`${context} lacks its current record`);
    }
    return {
      entityType,
      entityId,
      baseRevision,
      currentRevision,
      current: recordJsonOrNull(current, `${context} current`),
    };
  });
}

/**
 * Decodes the stored rejection (`{ code, message }`) of a REJECTED receipt.
 * Only the documented stable codes replay; anything else is ledger corruption.
 */
function storedRejection(
  stored: SyncJsonObject | null,
  opId: string,
): { readonly code: SyncOperationRejectionCode; readonly message: string } {
  if (stored === null) {
    throw new MutationPreconditionError(
      `Stored rejection for opId ${opId} lacks its result`,
    );
  }
  const code = stored['code'];
  const message = stored['message'];
  if (typeof code !== 'string' || !isSyncOperationRejectionCode(code)) {
    throw new MutationPreconditionError(
      `Stored rejection for opId ${opId} carries an unknown code`,
    );
  }
  if (typeof message !== 'string') {
    throw new MutationPreconditionError(
      `Stored rejection for opId ${opId} lacks its message`,
    );
  }
  return { code, message };
}

/** Serialized size of one commit group, the pre-write page-bound proxy. */
function serializedEventBytes(events: readonly SyncChangeEvent[]): number {
  let total = 0;
  for (const event of events) {
    total += canonicalJsonLength(toSyncJsonValue(event, 'change event'));
  }
  return total;
}

// ---------------------------------------------------------------------------
// Coordinator
// ---------------------------------------------------------------------------

export class MutationCoordinator {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly activeScope = new AsyncLocalStorage<ActiveMutationScope>();
  private readonly batchScope = new AsyncLocalStorage<ActiveBatchLease>();

  constructor(
    private readonly pb: PocketBase,
    private readonly synchronizer: PocketbaseSyncRepository,
  ) {}

  // -----------------------------------------------------------------------
  // Gate
  // -----------------------------------------------------------------------

  /**
   * Runs one financial mutation on the FIFO gate.
   *
   * Nested calls: a `run()` issued inside the currently running mutation
   * callback joins that mutation — same unit of work, same clock, no commit,
   * `deferred` outcome, and a request that disagrees with the active scope
   * fails fast because mixing two scopes in one commit is an integration
   * fault. A continuation the callback left behind finds an expired scope and
   * queues like any unrelated caller.
   *
   * Failure semantics: a throw from the use case (including a domain
   * `ValidationError`/`NotFoundError`) releases the gate after discarding the
   * buffered state. Capacity, coverage and conflict outcomes return cleanly
   * and also release the gate with zero remote writes.
   */
  async run<T>(
    request: MutationRequest,
    runMutation: (unitOfWork: PocketbaseUnitOfWork) => Promise<T>,
  ): Promise<MutationExecution<T>> {
    const active = this.activeScope.getStore();
    if (active !== undefined && active.alive) {
      this.assertNestedCompatibility(active.request, request);
      const result = await runMutation(active.unitOfWork);
      return { outcome: { status: 'deferred' }, result };
    }

    // An active batch lease already owns the FIFO slot: this operation runs
    // inside that slot with a fresh unit of work instead of re-queuing on the
    // tail it would then wait behind (which would deadlock). An EXPIRED
    // inherited store is not a lease and falls through to the queue.
    const lease = this.batchScope.getStore();
    if (lease !== undefined && lease.active) {
      return this.runWithinLease(lease, request, runMutation);
    }

    const queued = this.tail.then(() =>
      this.executeMutation(request, runMutation),
    );
    // Errors belong to the caller; the gate chain itself stays alive.
    this.tail = queued.then(
      () => undefined,
      () => undefined,
    );
    return (await queued) as MutationExecution<T>;
  }

  /**
   * Holds ONE FIFO gate slot for a whole push batch while each `lease.run()`
   * commits its own fresh unit of work. Gate ownership (batch-wide) is
   * separate from transaction ownership (per operation), so a valid operation
   * followed by an invalid one keeps the valid commit without an outer `run()`
   * trying to join incompatible scopes.
   *
   * FIFO: the lease takes the same `tail` slot as `run()`; every unrelated
   * caller waits until the callback AND every operation it started settled.
   *
   * Preconditions (typed, no gate acquired): called from inside a still
   * running mutation (nested calls join that operation instead) or from inside
   * another active lease. An expired store is ignored and simply queues.
   *
   * Failure semantics: if the callback throws, operations that had not
   * started are refused with no write, an operation already executing finishes
   * its single commit, the slot is released and no live store remains.
   * Committed operations stay committed.
   */
  async runBatch<T>(
    execute: (lease: MutationBatchLease) => Promise<T>,
  ): Promise<T> {
    const active = this.activeScope.getStore();
    if (active !== undefined && active.alive) {
      throw new MutationPreconditionError(
        'A batch lease cannot start inside an active mutation; nested calls must join the running operation',
      );
    }
    const enclosing = this.batchScope.getStore();
    if (enclosing !== undefined && enclosing.active) {
      throw new MutationPreconditionError(
        'A batch lease cannot start inside another active batch lease',
      );
    }

    const queued = this.tail.then(async () => {
      const lease: ActiveBatchLease = {
        active: true,
        released: false,
        tail: Promise.resolve(),
      };
      const handle: MutationBatchLease = {
        run: (request, apply) => this.runWithinLease(lease, request, apply),
      };
      try {
        return await this.batchScope.run(lease, () => execute(handle));
      } finally {
        // Close the validity window first: an operation that has not started
        // must never write after its lease ended.
        lease.active = false;
        try {
          // An operation already executing still owns its unit of work; let
          // its single commit finish before releasing the slot.
          await lease.tail;
        } catch {
          // Its caller already received the error; the lease must still
          // release the gate and leave the store clean.
        }
        this.releaseBatchLease(lease);
      }
    });
    this.tail = queued.then(
      () => undefined,
      () => undefined,
    );
    return await queued;
  }

  /**
   * Per-operation path inside a held lease. Work is sequenced on a lease-local
   * chain (submission order, one commit at a time) and delegates to
   * `executeMutation`, the same single path `run()` uses. The global `tail` is
   * never touched.
   */
  private async runWithinLease<T>(
    lease: ActiveBatchLease,
    request: MutationRequest,
    runMutation: (unitOfWork: PocketbaseUnitOfWork) => Promise<T>,
  ): Promise<MutationExecution<T>> {
    if (!lease.active) {
      throw new MutationPreconditionError(
        'The batch lease has already ended; a leased operation can never reuse a released gate slot',
      );
    }
    const work = async (): Promise<MutationExecution<T>> => {
      if (!lease.active) {
        throw new MutationPreconditionError(
          'The batch lease ended before this operation could start; nothing was written',
        );
      }
      return this.executeMutation(request, runMutation);
    };
    // Run the next operation even when the previous one rejected: commits are
    // independent per operation inside one lease.
    const queued = lease.tail.then(work, work);
    lease.tail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  /** Marks the single gate owner released; a second release is a fault. */
  private releaseBatchLease(lease: ActiveBatchLease): void {
    if (lease.released) {
      throw new MutationPreconditionError(
        'The batch lease was released twice; the FIFO gate slot has exactly one owner',
      );
    }
    lease.released = true;
  }

  /**
   * One gate slot, one unit of work, at most one commit.
   *
   * Idempotency resolves BEFORE a unit of work exists, so a duplicate or a
   * tampered envelope never even buffers a read. The scope expires as soon as
   * the use case callback returns — before planning and before the batch — and
   * again on every exit path, so no continuation can observe a live scope.
   */
  private async executeMutation<T>(
    request: MutationRequest,
    runMutation: (unitOfWork: PocketbaseUnitOfWork) => Promise<T>,
  ): Promise<MutationExecution<T>> {
    if (request.operation !== null) {
      const idempotency = await this.resolveIdempotency(request);
      if (idempotency !== null) {
        return { outcome: idempotency };
      }
    }

    const unitOfWork = new PocketbaseUnitOfWork(this.pb);
    const scope: ActiveMutationScope = { unitOfWork, request, alive: true };
    try {
      if (request.operation !== null) {
        // Revision preconditions are evaluated BEFORE the use case runs so a
        // stale base revision is always a `conflict`, never preempted by the
        // domain state check that the stale state would also trip
        // (`already realized`, `already paid`).
        const revisionConflict = await this.resolveTargetRevisionConflict(
          request,
          unitOfWork,
        );
        if (revisionConflict !== null) {
          return { outcome: revisionConflict };
        }
      }
      const result = await this.activeScope.run(scope, () =>
        runMutation(unitOfWork),
      );
      // The callback is over: a continuation it left behind must queue like an
      // unrelated caller instead of joining a finished unit of work.
      scope.alive = false;
      const outcome = await this.evaluateAndCommit(request, unitOfWork);
      return { outcome, result };
    } finally {
      // Every error path (use case throw, planning fault, commit failure) also
      // leaves no live scope behind. `discard()` is idempotent: a committed
      // unit of work re-closes harmlessly, every other path leaves zero remote
      // effects and zero buffered state.
      scope.alive = false;
      unitOfWork.discard();
    }
  }

  // -----------------------------------------------------------------------
  // Idempotency (first, before any use case write)
  // -----------------------------------------------------------------------

  /**
   * `null` means "continue into the use case"; otherwise the operation is a
   * clean replay or a final rejection. The complete-envelope hash is
   * recomputed from the received fields so a malformed or tampered envelope
   * can never reach the receipt ledger, and the stored receipt is consulted
   * before any effect could be re-applied. A stored accepted receipt replays
   * its applied result (`duplicate`); a stored conflicted or rejected receipt
   * replays that terminal outcome with zero new effect; any other envelope
   * under the same opId is the final `OP_ID_REUSED`.
   */
  private async resolveIdempotency(
    request: MutationRequest,
  ): Promise<MutationOutcome | null> {
    const operation = request.operation as SyncOperationWire;
    let envelopeHash: SyncSha256Hash;
    try {
      envelopeHash = operationEnvelopeHash(operation);
    } catch (error) {
      throw new MutationPreconditionError(
        `Operation envelope is not hashable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (envelopeHash !== operation.payloadHash) {
      return {
        status: 'rejected',
        opId: operation.opId,
        code: 'ENVELOPE_HASH_MISMATCH',
        message:
          'The declared payloadHash does not match the received envelope bytes; nothing was written.',
      };
    }

    const receipt = await this.synchronizer.readOperationReceipt(operation.opId);
    if (receipt === null) {
      return null;
    }
    if (receipt.payloadHash !== operation.payloadHash) {
      return {
        status: 'rejected',
        opId: operation.opId,
        code: 'OP_ID_REUSED',
        message: `opId ${operation.opId} was already recorded with a different envelope hash.`,
      };
    }
    if (receipt.status === 'accepted') {
      return {
        status: 'duplicate',
        opId: operation.opId,
        payloadHash: operation.payloadHash,
        storedResult: storedAppliedResult(receipt.result, operation.opId),
      };
    }
    // A conflicted or rejected opId is final too (D016 D2 rule 3): the exact
    // same envelope replays its stored terminal outcome with no new effect,
    // and any other envelope was already rejected as OP_ID_REUSED above.
    if (receipt.status === 'conflict') {
      return {
        status: 'conflict',
        opId: operation.opId,
        code: 'SYNC_CONFLICT',
        conflicts: storedConflictEntries(receipt.conflict, operation.opId),
      };
    }
    const rejection = storedRejection(receipt.result, operation.opId);
    return {
      status: 'rejected',
      opId: operation.opId,
      code: rejection.code,
      message: rejection.message,
    };
  }

  /**
   * Durably records a terminal non-applied per-operation outcome.
   *
   * D016 D2 rule 3 makes an `opId` final for every outcome, not only for
   * accepted ones: a rejected or conflicted envelope must never become applied
   * after the client changes it. The receipt is the ONLY write of this call
   * (its own metadata-only PocketBase batch, no finance row, no journal
   * event), and it stores the original envelope hash so a later push of the
   * same opId with any other envelope is `OP_ID_REUSED`.
   *
   * An existing receipt is never overwritten: an accepted receipt is the
   * replayable result, and an already recorded terminal outcome is already
   * final.
   */
  async recordTerminalOutcome(
    operation: SyncOperationWire,
    outcome: TerminalOperationOutcome,
  ): Promise<void> {
    const existing = await this.synchronizer.readOperationReceipt(operation.opId);
    if (existing !== null) {
      return;
    }
    const unitOfWork = new PocketbaseUnitOfWork(this.pb);
    try {
      const appender = unitOfWork.metadataBatch();
      await this.synchronizer.planOperationReceipt(appender, {
        opId: operation.opId,
        stationId: operation.stationId,
        protocolVersion: operation.protocolVersion,
        type: operation.type,
        entityType: operation.entityType,
        entityId: operation.entityId,
        payloadHash: operation.payloadHash,
        baseRevisions: jsonObjectOf(
          operation.baseRevisions ?? {},
          `base revisions of ${operation.opId}`,
        ),
        dependsOn: operation.dependsOn ?? [],
        status: outcome.status === 'conflict' ? 'conflict' : 'rejected',
        result:
          outcome.status === 'rejected'
            ? jsonObjectOf(
                { code: outcome.code, message: outcome.message },
                `rejected result of ${operation.opId}`,
              )
            : null,
        conflict:
          outcome.status === 'conflict'
            ? jsonObjectOf(
                { conflicts: outcome.conflicts },
                `conflict of ${operation.opId}`,
              )
            : null,
        receivedAt: this.canonicalClockTimestamp(operation.effectiveAt),
        effectiveAt: operation.effectiveAt,
        clientCreatedAt: operation.clientCreatedAt,
      });
      await unitOfWork.executeCommit();
    } finally {
      unitOfWork.discard();
    }
  }

  /**
   * A nested call must describe the SAME mutation: origin, station and
   * operation envelope, and the same journaling mode. Anything else would put
   * two logical mutations into one commit.
   */
  private assertNestedCompatibility(
    activeRequest: MutationRequest,
    request: MutationRequest,
  ): void {
    const sameOrigin = activeRequest.origin === request.origin;
    const sameStation =
      (activeRequest.stationId ?? null) === (request.stationId ?? null);
    const activeOpId = activeRequest.operation?.opId ?? null;
    const nestedOpId = request.operation?.opId ?? null;
    const sameJournal =
      (activeRequest.centralJournal ?? DEFAULT_CENTRAL_JOURNAL) ===
      (request.centralJournal ?? DEFAULT_CENTRAL_JOURNAL);
    if (!sameOrigin || !sameStation || activeOpId !== nestedOpId || !sameJournal) {
      throw new MutationPreconditionError(
        'A nested mutation must run inside the same mutation scope: matching origin, station id, operation envelope and journaling mode are required',
      );
    }
  }

  /**
   * Canonical server-side event timestamp. The journal `createdAt` is a hashed
   * field stored in a PocketBase `date` column, so it is normalized once here
   * to the exact UTC millisecond form the read path reproduces; a clock that
   * cannot produce an ISO-8601 timestamp fails before any write instead of
   * poisoning the chain.
   */
  private canonicalClockTimestamp(value: string): string {
    try {
      return normalizeSyncTimestamp(value, 'mutation clock timestamp');
    } catch (error) {
      throw new MutationPreconditionError(
        `The mutation clock produced an unusable timestamp: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Evaluation, capacity bounds and the one batch commit
  // -----------------------------------------------------------------------

  private async evaluateAndCommit(
    request: MutationRequest,
    unitOfWork: PocketbaseUnitOfWork,
  ): Promise<MutationOutcome> {
    const centralJournal = request.centralJournal ?? DEFAULT_CENTRAL_JOURNAL;
    const writes = unitOfWork.bufferedRowWrites();
    const commitId = newOperationId();
    const opId = request.operation?.opId ?? null;

    // Capacity is refused before any remote effect, at both contract bounds.
    if (writes.length > SYNC_MAX_COMMIT_EVENTS) {
      return {
        status: 'rejected',
        opId,
        code: 'COMMIT_TOO_LARGE',
        message: `This mutation would emit ${writes.length} entity events; the hard bound is ${SYNC_MAX_COMMIT_EVENTS}.`,
      };
    }

    // Operation paths run the full coverage/conflict resolution on the ACTUAL
    // write set; web/job/admin paths only need the current revisions and the
    // same structural ledger preconditions. Local modes assign station
    // revisions inside the station row planning.
    let planned: readonly PlannedEntityWrite[];
    if (!centralJournal) {
      planned = writes.map((source) => ({
        source,
        revision: 0,
        existed: source.kind !== 'create',
      }));
    } else if (request.operation !== null) {
      const coverage = await this.resolveCoverage(request, unitOfWork, writes);
      if (coverage.kind === 'rejected') {
        return {
          status: 'rejected',
          opId,
          code: coverage.code,
          message: coverage.message,
        };
      }
      if (coverage.kind === 'conflict') {
        return {
          status: 'conflict',
          opId,
          code: 'SYNC_CONFLICT',
          conflicts: coverage.conflicts,
        };
      }
      planned = coverage.planned;
    } else {
      planned = await this.assignLedgerRevisions(writes);
    }

    const appender = unitOfWork.metadataBatch();
    const createdAt = this.canonicalClockTimestamp(request.clock.now());
    let firstSeq: SyncCursor = 0;
    let lastSeq: SyncCursor = 0;
    let headHash: SyncHash = SYNC_GENESIS_HASH;

    if (!centralJournal) {
      // Local batch: outbox descriptors plus station-local revision rows in
      // the same finance batch. The station rows carry the revisions the
      // applied outcome reports.
      const stationPlan = await this.planStationRows(
        request,
        appender,
        unitOfWork,
        planned,
      );
      planned = planned.map((entry) => {
        const key = syncRevisionKey(
          entry.source.entityType,
          entry.source.recordId,
        );
        const revision = stationPlan.revisions.get(key);
        if (revision === undefined) {
          throw new MutationPreconditionError(
            `The station plan did not assign a local revision to ${key}`,
          );
        }
        return { ...entry, revision };
      });
      await this.planStationOutboxRows(
        request,
        appender,
        stationPlan.writeContexts,
      );
    } else {
      const meta = await this.synchronizer.readSyncMeta();
      if (meta === null) {
        throw new MutationPreconditionError(
          'obol_sync_meta is missing; run ensureSyncMeta() (and the D5 backfill) before the first commit',
        );
      }
      const events = this.buildChangeEvents(
        request,
        planned,
        commitId,
        meta.lastSeq,
        // The stored head continues the chain; genesis belongs only to the
        // truly empty journal (seq 0).
        meta.lastSeq === 0 ? SYNC_GENESIS_HASH : meta.headHash,
        createdAt,
      );
      const eventBytes = serializedEventBytes(events);
      if (eventBytes > SYNC_PULL_MAX_PAGE_BYTES) {
        return {
          status: 'rejected',
          opId,
          code: 'COMMIT_TOO_LARGE',
          message: `The serialized commit group is ${eventBytes} bytes; the bound is ${SYNC_PULL_MAX_PAGE_BYTES}.`,
        };
      }

      const versions: EntityVersionWrite[] = planned.map((entry, index) => ({
        entityType: entry.source.entityType,
        entityId: entry.source.recordId,
        revision: entry.revision,
        deleted: entry.source.kind === 'delete',
        lastSeq: meta.lastSeq + index + 1,
      }));

      if (events.length > 0) {
        const lastEvent = events[events.length - 1]!;
        await this.synchronizer.planChangeEventCreates(appender, events);
        await this.synchronizer.planEntityVersionUpserts(appender, versions);
        await this.synchronizer.planSyncMetaForCommit(appender, {
          lastSeq: meta.lastSeq + events.length,
          headHash: lastEvent.chainHash,
        });
        firstSeq = meta.lastSeq + 1;
        lastSeq = meta.lastSeq + events.length;
        headHash = lastEvent.chainHash;
      } else {
        firstSeq = meta.lastSeq;
        lastSeq = meta.lastSeq;
        headHash = meta.headHash;
      }
      if (request.operation !== null) {
        await this.planOperationReceipt(request, appender, planned, createdAt);
      }
    }

    await unitOfWork.executeCommit();

    const entityVersions: SyncEntityVersionRef[] = planned.map((entry) => ({
      entityType: entry.source.entityType,
      entityId: entry.source.recordId,
      revision: entry.revision,
    }));
    const entities: SyncAppliedEntity[] = planned.map((entry) => ({
      entityType: entry.source.entityType,
      entityId: entry.source.recordId,
      revision: entry.revision,
      record: recordJsonOf(
        entry.source.record,
        `applied record ${entry.source.entityType}:${entry.source.recordId}`,
      ),
    }));
    return {
      status: 'applied',
      opId,
      commitId,
      firstSeq,
      lastSeq,
      headHash,
      entityVersions,
      entities,
    };
  }

  // -----------------------------------------------------------------------
  // Write-set coverage, conflicts and the additive invoice delta
  // -----------------------------------------------------------------------

  /**
   * A stale declared base revision on the operation's own target is a
   * conflict with the authoritative PRE-write record.
   *
   * The target entity is the one entity every update/realize/delete/pay
   * operation is guaranteed to write, and this check runs before the use
   * case, so the state guard that the same stale revision would also trip
   * (`already realized`, `already paid`) can never turn a conflict into a
   * `rejected` result. Extra base revisions for entities the operation does
   * not write stay ignored, exactly as D3 requires; the post-write coverage
   * check still decides conflicts on everything else the use case wrote.
   */
  private async resolveTargetRevisionConflict(
    request: MutationRequest,
    unitOfWork: PocketbaseUnitOfWork,
  ): Promise<MutationOutcome | null> {
    const operation = request.operation as SyncOperationWire;
    const key = syncRevisionKey(operation.entityType, operation.entityId);
    const declared = (operation.baseRevisions ?? {})[key];
    if (declared === undefined) {
      return null;
    }
    const version = await this.synchronizer.readEntityVersion(
      operation.entityType,
      operation.entityId,
    );
    if (version === null || version.revision === declared) {
      return null;
    }
    return {
      status: 'conflict',
      opId: operation.opId,
      code: 'SYNC_CONFLICT',
      conflicts: [
        {
          entityType: operation.entityType,
          entityId: operation.entityId,
          baseRevision: declared,
          currentRevision: version.revision,
          current: recordJsonOf(
            // The authoritative PRE-write record, not a buffered result.
            await unitOfWork.preCommitRecord(
              SYNC_COLLECTIONS[operation.entityType],
              operation.entityId,
            ),
            `authoritative record ${key}`,
          ),
        },
      ],
    };
  }

  private async resolveCoverage(
    request: MutationRequest,
    unitOfWork: PocketbaseUnitOfWork,
    writes: readonly BufferedRowWrite[],
  ): Promise<CoverageResolution> {
    const operation = request.operation as SyncOperationWire;
    const baseRevisions = operation.baseRevisions ?? {};
    const delta = request.additiveInvoiceDelta ?? null;

    const keys: SyncRevisionKey[] = writes.map((write) =>
      syncRevisionKey(write.entityType, write.recordId),
    );
    const versions = await this.synchronizer.readEntityVersions(keys);

    const planned: PlannedEntityWrite[] = [];
    const conflicts: SyncConflictEntry[] = [];

    for (const write of writes) {
      const key = syncRevisionKey(write.entityType, write.recordId);
      const ledger = versions.get(key);

      if (write.kind === 'create') {
        if (ledger !== undefined) {
          return {
            kind: 'rejected',
            code: 'ENTITY_ID_TAKEN',
            message: `${key} already has a ${
              ledger.deleted ? 'tombstone' : 'live'
            } revision row; deleted ids are never reused (D016 D6).`,
          };
        }
        planned.push({ source: write, revision: 1, existed: false });
        continue;
      }

      if (ledger === undefined) {
        throw new MutationPreconditionError(
          `${key} has no obol_sync_entity_versions row; the D5 backfill must run before serving writes`,
        );
      }
      if (ledger.deleted) {
        throw new MutationPreconditionError(
          `${key} is tombstoned in the version ledger but still exists as a finance row; reconcile journal and data`,
        );
      }

      // Indexed by the canonical key, so a malformed declared key can never be
      // mistaken for coverage of a different entity.
      const declared: number | undefined = baseRevisions[key];
      if (declared === undefined) {
        // The one documented exemption: the invoice this card purchase or
        // recurrence launch created or found, keyed by `(card_id, period)`.
        const additiveExempt =
          write.entityType === 'invoice' &&
          delta !== null &&
          write.record !== null &&
          write.record['card_id'] === delta.cardId &&
          write.record['period'] === delta.period;
        if (additiveExempt) {
          planned.push({
            source: write,
            revision: ledger.revision + 1,
            existed: true,
          });
          continue;
        }
        return {
          kind: 'rejected',
          code: 'UNCOVERED_WRITE',
          message: `${key} was written without a declared base revision.`,
        };
      }
      if (typeof declared !== 'number' || !Number.isInteger(declared)) {
        return {
          kind: 'rejected',
          code: 'INVALID_PAYLOAD',
          message: `Declared base revision for ${key} must be an integer, got ${String(declared)}.`,
        };
      }
      if (declared !== ledger.revision) {
        conflicts.push({
          entityType: write.entityType,
          entityId: write.recordId,
          baseRevision: declared,
          currentRevision: ledger.revision,
          current: recordJsonOf(
            // The authoritative PRE-write record, not the buffered result.
            await unitOfWork.preCommitRecord(
              write.collectionName,
              write.recordId,
            ),
            `authoritative record ${key}`,
          ),
        });
        continue;
      }
      planned.push({
        source: write,
        revision: ledger.revision + 1,
        existed: true,
      });
    }

    if (conflicts.length > 0) {
      return { kind: 'conflict', conflicts };
    }
    return { kind: 'ok', planned };
  }

  /**
   * Revision assignment for internal mutations (web/job/admin, no operation
   * envelope): the same ledger preconditions minus the declared-revision
   * conflict checks those cannot have.
   */
  private async assignLedgerRevisions(
    writes: readonly BufferedRowWrite[],
  ): Promise<PlannedEntityWrite[]> {
    const keys: SyncRevisionKey[] = writes.map((write) =>
      syncRevisionKey(write.entityType, write.recordId),
    );
    const versions = await this.synchronizer.readEntityVersions(keys);
    const planned: PlannedEntityWrite[] = [];
    for (const write of writes) {
      const key = syncRevisionKey(write.entityType, write.recordId);
      const ledger = versions.get(key);
      if (write.kind === 'create') {
        if (ledger !== undefined) {
          throw new MutationPreconditionError(
            `${key} already has a ${
              ledger.deleted ? 'tombstone' : 'live'
            } revision row; deleted ids are never reused (D016 D6)`,
          );
        }
        planned.push({ source: write, revision: 1, existed: false });
        continue;
      }
      if (ledger === undefined) {
        throw new MutationPreconditionError(
          `${key} has no obol_sync_entity_versions row; the D5 backfill must run before serving writes`,
        );
      }
      if (ledger.deleted) {
        throw new MutationPreconditionError(
          `${key} is tombstoned in the version ledger but still exists as a finance row`,
        );
      }
      planned.push({
        source: write,
        revision: ledger.revision + 1,
        existed: true,
      });
    }
    return planned;
  }

  // -----------------------------------------------------------------------
  // Central journal rows
  // -----------------------------------------------------------------------

  /**
   * Builds the complete event chain for one commit. `previousTopHash` is the
   * authoritative stored head the journal continues from (genesis only when
   * the journal is empty); each event then links to the previous event's
   * `chainHash`, so the whole commit stays continuous.
   */
  private buildChangeEvents(
    request: MutationRequest,
    planned: readonly PlannedEntityWrite[],
    commitId: SyncCommitId,
    headSeq: SyncCursor,
    previousTopHash: SyncHash,
    createdAt: string,
  ): SyncStoredChangeEvent[] {
    const events: SyncStoredChangeEvent[] = [];
    const commitSize = planned.length;
    let previousHash: SyncHash = previousTopHash;

    planned.forEach((entry, index) => {
      const seq = headSeq + index + 1;
      // create and update are both wire `upsert`; only a delete is `delete`.
      const kind = entry.source.kind === 'delete' ? 'delete' : 'upsert';
      const eventRecord = recordJsonOf(
        entry.source.record,
        `change event record ${entry.source.entityType}:${entry.source.recordId}`,
      );
      const chainHash = changeChainHash({
        seq,
        commitId,
        commitIndex: index,
        commitSize,
        kind,
        entityType: entry.source.entityType,
        entityId: entry.source.recordId,
        revision: entry.revision,
        recordHash: recordHash(eventRecord),
        origin: request.origin,
        stationId: request.stationId ?? null,
        opId: request.operation?.opId ?? null,
        createdAt,
        prevHash: previousHash,
      });
      events.push({
        seq,
        commitId,
        commitIndex: index,
        commitSize,
        kind,
        entityType: entry.source.entityType,
        entityId: entry.source.recordId,
        revision: entry.revision,
        record: eventRecord,
        origin: request.origin,
        ...(request.stationId !== null ? { stationId: request.stationId } : {}),
        ...(request.operation !== null ? { opId: request.operation.opId } : {}),
        createdAt,
        prevHash: previousHash,
        chainHash,
      });
      previousHash = chainHash;
    });

    return events;
  }

  private async planOperationReceipt(
    request: MutationRequest,
    appender: SyncBatchAppender,
    planned: readonly PlannedEntityWrite[],
    receivedAt: string,
  ): Promise<void> {
    const operation = request.operation as SyncOperationWire;
    const entityVersions: SyncEntityVersionRef[] = planned.map((entry) => ({
      entityType: entry.source.entityType,
      entityId: entry.source.recordId,
      revision: entry.revision,
    }));
    const result: SyncAppliedOperationResult = {
      opId: operation.opId,
      status: 'applied',
      entityVersions,
      entities: planned.map((entry) => ({
        entityType: entry.source.entityType,
        entityId: entry.source.recordId,
        revision: entry.revision,
        record: recordJsonOf(
          entry.source.record,
          `receipt record ${entry.source.entityType}:${entry.source.recordId}`,
        ),
      })),
    };
    await this.synchronizer.planOperationReceipt(appender, {
      opId: operation.opId,
      stationId: operation.stationId,
      protocolVersion: operation.protocolVersion,
      type: operation.type,
      entityType: operation.entityType,
      entityId: operation.entityId,
      payloadHash: operation.payloadHash,
      baseRevisions: jsonObjectOf(
        operation.baseRevisions ?? {},
        `base revisions of ${operation.opId}`,
      ),
      dependsOn: operation.dependsOn ?? [],
      status: 'accepted',
      result: jsonObjectOf(result, `stored result of ${operation.opId}`),
      receivedAt,
      // The frozen envelope values are stored verbatim: they are what the
      // client hashed and what a later duplicate is compared against.
      effectiveAt: operation.effectiveAt,
      clientCreatedAt: operation.clientCreatedAt,
    });
  }

  // -----------------------------------------------------------------------
  // Local station rows (obol_station_versions + obol_station_outbox)
  // -----------------------------------------------------------------------

  /**
   * Appends station-local version rows and returns the localRevision map the
   * applied outcome reports.
   *
   * The plan is the UNION of the working write keys and the received
   * `stationServerEntities` keys with EXACTLY ONE version-row upsert per key:
   * an ordinary local write increments `localRevision` and keeps the
   * optimistic `deleted` flag; a received authoritative entity overrides the
   * `serverRevision`/`serverDeleted`/`baseRecord` trio without clobbering that
   * optimistic state, so a key that is both merges into one row.
   */
  private async planStationRows(
    request: MutationRequest,
    appender: SyncBatchAppender,
    unitOfWork: PocketbaseUnitOfWork,
    planned: readonly PlannedEntityWrite[],
  ): Promise<{
    readonly revisions: ReadonlyMap<string, number>;
    readonly writeContexts: readonly StationOutboxWriteContext[];
  }> {
    const revisions = new Map<string, number>();
    const versionWrites: StationLocalRevisionWrite[] = [];
    const indexByKey = new Map<SyncRevisionKey, number>();
    const writeContexts: StationOutboxWriteContext[] = [];

    for (const entry of planned) {
      const key = syncRevisionKey(entry.source.entityType, entry.source.recordId);
      const existing = await this.synchronizer.readStationLocalVersion(
        entry.source.entityType,
        entry.source.recordId,
      );
      const localRevision = (existing?.localRevision ?? 0) + 1;
      revisions.set(key, localRevision);
      indexByKey.set(key, versionWrites.length);
      versionWrites.push({
        entityType: entry.source.entityType,
        entityId: entry.source.recordId,
        localRevision,
        deleted: entry.source.kind === 'delete',
      });
      // Pre-mutation record for the outbox factory: the authoritative state
      // before this write (`null` for a create), read from the unpatched
      // remote base the unit of work already cached.
      const beforeRecord = entry.existed
        ? recordJsonOrNull(
            await unitOfWork.preCommitRecord(
              entry.source.collectionName,
              entry.source.recordId,
            ),
            `before record ${key}`,
          )
        : null;
      writeContexts.push({
        entityType: entry.source.entityType,
        entityId: entry.source.recordId,
        kind: entry.source.kind === 'delete' ? 'delete' : 'upsert',
        existed: entry.existed,
        revision: localRevision,
        record: recordJsonOf(
          entry.source.record,
          `outbox context record ${key}`,
        ),
        beforeRecord,
      });
    }

    for (const entity of request.stationServerEntities ?? []) {
      if (
        !isSyncEntityType(entity.entityType) ||
        !isSyncEntityId(entity.entityId) ||
        !Number.isInteger(entity.revision) ||
        entity.revision < 1
      ) {
        throw new MutationPreconditionError(
          'Received server entities must carry a known entity type, a 15-character id and a positive integer revision',
        );
      }
      const key = syncRevisionKey(entity.entityType, entity.entityId);
      const serverRecord = recordJsonOrNull(
        entity.record,
        `received server record ${key}`,
      );
      const index = indexByKey.get(key);
      if (index === undefined) {
        const existing = await this.synchronizer.readStationLocalVersion(
          entity.entityType,
          entity.entityId,
        );
        // Received-only key: keep the optimistic-local fields and store the
        // authoritative pulled trio. A server delete clears `baseRecord`
        // explicitly (`null`, never an omitted field).
        indexByKey.set(key, versionWrites.length);
        versionWrites.push({
          entityType: entity.entityType,
          entityId: entity.entityId,
          localRevision: existing?.localRevision ?? 0,
          serverRevision: entity.revision,
          serverDeleted: serverRecord === null,
          deleted: existing?.deleted ?? false,
          baseRecord: serverRecord,
        });
        continue;
      }
      const merged = versionWrites[index]!;
      versionWrites[index] = {
        ...merged,
        serverRevision: entity.revision,
        serverDeleted: serverRecord === null,
        baseRecord: serverRecord,
      };
    }

    if (versionWrites.length > 0) {
      await this.synchronizer.planStationVersionUpserts(appender, versionWrites);
    }
    return { revisions, writeContexts };
  }

  /**
   * Appends one `obol_station_outbox` row per descriptor produced by
   * `request.stationOutbox`, in order, into the SAME batch as the finance rows
   * and station versions. An explicit array and a factory evaluated against
   * the actual write set share this one path, so no generated fact or status
   * operation is dropped and no second commit is needed. A repeated `opId` or
   * more than `SYNC_MAX_COMMIT_EVENTS` descriptors aborts before any remote
   * write; re-recording an identical envelope is idempotent in the repository.
   */
  private async planStationOutboxRows(
    request: MutationRequest,
    appender: SyncBatchAppender,
    writeContexts: readonly StationOutboxWriteContext[],
  ): Promise<void> {
    const source = request.stationOutbox;
    if (source === undefined || source === null) {
      return;
    }
    const descriptors =
      typeof source === 'function'
        ? await source({
            origin: request.origin,
            stationId: request.stationId,
            clock: request.clock,
            writes: writeContexts,
          })
        : source;

    if (descriptors.length > SYNC_MAX_COMMIT_EVENTS) {
      throw new MutationPreconditionError(
        `Station outbox planning produced ${descriptors.length} descriptors; the bound is ${SYNC_MAX_COMMIT_EVENTS}`,
      );
    }
    const recorded = new Set<string>();
    for (const descriptor of descriptors) {
      if (recorded.has(descriptor.opId)) {
        throw new MutationPreconditionError(
          `Station outbox planning produced opId ${descriptor.opId} twice; queued intents are unique`,
        );
      }
      recorded.add(descriptor.opId);
      await this.synchronizer.planStationOutbox(appender, {
        opId: descriptor.opId,
        payloadHash: descriptor.payloadHash,
        // Envelope values are persisted verbatim: they were hashed before the
        // first send and stay immutable, so the row must replay exactly.
        envelope: {
          protocolVersion: descriptor.protocolVersion,
          type: descriptor.type,
          entityType: descriptor.entityType,
          entityId: descriptor.entityId,
          payload: toSyncJsonValue(
            descriptor.payload,
            `outbox payload of ${descriptor.opId}`,
          ),
          payloadHash: descriptor.payloadHash,
          baseRevisions: toSyncJsonValue(
            descriptor.baseRevisions,
            `outbox baseRevisions of ${descriptor.opId}`,
          ),
          dependsOn: toSyncJsonValue(
            descriptor.dependsOn,
            `outbox dependsOn of ${descriptor.opId}`,
          ),
          effectiveAt: descriptor.effectiveAt,
          clientCreatedAt: descriptor.clientCreatedAt,
        },
        beforeSnapshots: descriptor.beforeSnapshots.map((snapshot) => ({
          entityType: snapshot.entityType,
          entityId: snapshot.entityId,
          revision: snapshot.revision,
          record: snapshot.record,
        })),
        status: descriptor.status,
        attempts: descriptor.attempts,
        lastError: descriptor.lastError ?? null,
        createdAt: descriptor.createdAt,
        updatedAt: descriptor.updatedAt,
      });
    }
  }
}
