// Shared mutation runtime for every served BFF mode (D016 D1/D9/D10/D13 and
// the E007/D016 orchestrator decisions). One class owns the complete FIFO
// mutation composition: the gate (`MutationCoordinator`), the sync metadata
// ledger (`PocketbaseSyncRepository`), the durable central backfill, the
// local station intent recorder and the typed Awilix scoping that lets the
// existing financial use cases run untouched against one unit of work.
//
// Owned strictly here:
// - the SINGLE documented structural PocketBase-view adapter cast
//   (`unitOfWork.view() as unknown as PocketBase`) inside `scopeFor`; every
//   other PB access stays in `infrastructure/repositories`;
// - central `initialize()`: ensure the server identity/meta singleton, verify
//   it structurally (corrupt metadata fails loudly and is never restamped),
//   and run the durable deterministic metadata-only journal backfill to its
//   final marker — all before any served write can commit, lazily awaited by
//   every mutation handler so direct `.handle` users are protected;
// - local `initialize()`: ensure the durable station identity row
//   (`obol_station_state`, mode `standalone`, retained across reboots) with
//   no central journal;
// - typed `execute()`: routes one financial use case through the FIFO gate
//   with origin `web`/`job`/`admin`, returns the actual use-case result and,
//   in local role, records canonical outbox intents inside the same commit;
// - scoped composition for push/station executors: `coordinator.runBatch`
//   leases plus `scopeFor(uow, clock)` per independently committed operation
//   (owned by the sync executor, never here).
//
// Never owned here: no HTTP routes, no business rules (the use cases own
// every financial effect), no raw writer resolution — `scopeFor` exposes use
// cases against the buffered unit of work only. The ONE exception is the
// destructive reset: `scopeFor` builds its repository against the raw client
// so it can commit its own exclusive real PocketBase batch inside the FIFO
// gate (the buffered view has no `createBatch`).

import type PocketBase from 'pocketbase';
import type { AwilixContainer } from 'awilix';
import { asClass, asFunction, asValue } from 'awilix';

import { systemSyncClock, type SyncClock } from '../../domain/sync/MutationContext';
import {
  SYNC_PROTOCOL_MAX,
  SYNC_PROTOCOL_MIN,
  SYNC_PROTOCOL_VERSION,
  isSyncUuid,
} from '../../domain/sync/SyncProtocol';
import {
  MutationCoordinator,
  type MutationExecution,
  type StationOutboxPlanContext,
} from './MutationCoordinator';
import { JournalBackfill } from './JournalBackfill';
import { StationMutationRecorder, type StationMutationPlanIntent } from './StationMutationRecorder';
import { newOperationId } from './RecordIds';
import {
  MutationPreconditionError,
  PocketbaseUnitOfWork,
} from '../repositories/PocketbaseUnitOfWork';
import { PocketbaseSyncRepository } from '../repositories/PocketbaseSyncRepository';
import { PocketbaseTransactionRepository } from '../repositories/PocketbaseTransactionRepository';
import { PocketbaseAccountRepository } from '../repositories/PocketbaseAccountRepository';
import { PocketbaseCardRepository } from '../repositories/PocketbaseCardRepository';
import { PocketbaseInvoiceRepository } from '../repositories/PocketbaseInvoiceRepository';
import { PocketbaseRecurrenceRepository } from '../repositories/PocketbaseRecurrenceRepository';
import { PocketbaseCategoryRepository } from '../repositories/PocketbaseCategoryRepository';
import { PocketbaseProjectRepository } from '../repositories/PocketbaseProjectRepository';
import { PocketbaseDatabaseMaintenanceRepository } from '../repositories/PocketbaseDatabaseMaintenanceRepository';
import { createContainer, type ContainerMutationRuntimeContext } from '../di/container';
import { executeUseCase } from '../use-case-routes/dispatch';
import type { UseCaseRegistry, UseCaseToken } from '../use-case-routes/registry';

/** Construction options of one BFF mutation runtime. */
export interface FinancialMutationRuntimeOptions {
  /** `central`: hosted BFF with the central journal; `local`: dock/desktop. */
  readonly role: 'central' | 'local';
  /**
   * Optional durable station identity for local role; when omitted the local
   * identity is created once in `obol_station_state` and reused.
   */
  readonly stationId?: string | null;
  /** Server name handed to the sync handshake; defaults to 'Obol'. */
  readonly serverName?: string;
}

/** Origins of `FinancialMutationRuntime.execute()` internal mutations. */
export type FinancialMutationOrigin = 'web' | 'job' | 'admin';

const JOB_MUTATION_TOKENS: Readonly<Record<string, true>> = {
  reconcileInvoicesUseCase: true,
  processMonthlyRecurrencesUseCase: true,
};

/**
 * The FIFO mutation runtime. Every financial write, scheduler job and admin
 * reset resolves through `execute()` (or a `coordinator` lease for the sync
 * push/pull compositions), so the whole process has exactly one gate, one
 * unit of work per mutation and one atomic PocketBase batch per commit.
 */
export class FinancialMutationRuntime {
  /** The authenticated PocketBase instance every dispatch shares. */
  readonly pb: PocketBase;
  /** Sync handshake server name. */
  readonly serverName: string;
  readonly options: FinancialMutationRuntimeOptions;
  readonly syncRepository: PocketbaseSyncRepository;
  readonly coordinator: MutationCoordinator;

  /** Server identity after central `initialize()`; null before/local. */
  serverInstanceId: string | null = null;

  /** Central data epoch after `initialize()`; null before/local. */
  serverEpoch: number | null = null;

  private readonly role: 'central' | 'local';
  private stationId: string | null;
  private readonly container: AwilixContainer;
  private readonly recorder: StationMutationRecorder;
  private readonly backfill: JournalBackfill;
  private initializePromise: Promise<void> | null = null;

  constructor(pb: PocketBase, options: FinancialMutationRuntimeOptions) {
    this.pb = pb;
    this.serverName = options.serverName ?? 'Obol';
    this.options = options;
    this.role = options.role;
    this.stationId = options.stationId ?? null;
    this.syncRepository = new PocketbaseSyncRepository(pb);
    this.coordinator = new MutationCoordinator(pb, this.syncRepository);
    this.recorder = new StationMutationRecorder(this.syncRepository, this.stationId);
    this.backfill = new JournalBackfill(pb, this.syncRepository, systemSyncClock);
    // The one-argument `createContainer` form composes pure use-case
    // resolution; this runtime registers its typed clock, role and recorder
    // as values. The container imports the runtime TYPE only, so the value
    // import here creates no cycle.
    this.container = createContainer(pb, this.mutationContext());
  }

  /**
   * Typed value context for a dispatch container. Exposed so `createServer`
   * can register the same runtime it dispatches through without reaching
   * into private state.
   */
  mutationContext(): ContainerMutationRuntimeContext {
    return {
      runtime: this,
      clock: systemSyncClock,
      recorder: this.recorder,
    };
  }

  /**
   * Idempotent initialization: central role ensures identity/meta with the
   * deterministic metadata-only backfill marker; local role ensures the
   * durable station identity. Concurrent callers join ONE attempt; a failed
   * attempt is retryable by the next caller (the rejection is not cached).
   */
  async initialize(): Promise<void> {
    if (this.initializePromise === null) {
      this.initializePromise = this.performInitialize().catch((error) => {
        this.initializePromise = null;
        throw error;
      });
    }
    await this.initializePromise;
  }

  private async performInitialize(): Promise<void> {
    if (this.role === 'central') {
      await this.initializeCentral();
      return;
    }
    await this.initializeLocal();
  }

  /**
   * Central identity + durable deterministic backfill before a served write
   * commits. The meta singleton is never restamped: `ensureSyncMeta()` keeps
   * an existing instance id/epoch/seq/head, the repository decode validates
   * its columns, and the backfill skips durable event keys without
   * rewriting a committed revision or chain hash.
   */
  private async initializeCentral(): Promise<void> {
    const meta = await this.syncRepository.ensureSyncMeta({
      serverInstanceId: newOperationId(),
      dataEpoch: 1,
      protocolMin: SYNC_PROTOCOL_MIN,
      protocolMax: SYNC_PROTOCOL_MAX,
    });
    this.serverInstanceId = meta.serverInstanceId;
    this.serverEpoch = meta.dataEpoch;

    // The whole backfill holds the same FIFO gate as served mutations: a
    // lazy first request that starts initialization cannot interleave with
    // another mutation's commit.
    await this.coordinator.runBatch(async () => {
      await this.backfill.ensureComplete();
    });
    await this.refreshLedgerIdentity();
  }

  /**
   * Local role: ensure the durable station identity singleton with a fresh
   * UUIDv7 id when absent (mode `standalone`), never unpairing or touching
   * binding metadata, and hand that identity to the intent recorder.
   */
  private async initializeLocal(): Promise<void> {
    const existing = await this.syncRepository.readStationState();
    if (existing !== null && isSyncUuid(existing.stationId)) {
      if (this.stationId !== null && existing.stationId !== this.stationId) {
        throw new MutationPreconditionError(
          `The configured station id does not match the durable identity ${existing.stationId}; refusing to run local mutations`,
        );
      }
      this.bindStationIdentity(existing.stationId);
      return;
    }

    const stationId = this.stationId ?? newOperationId();
    if (!isSyncUuid(stationId)) {
      throw new MutationPreconditionError(
        `Local station identity "${stationId}" is not a UUID; refusing to record intents under it`,
      );
    }
    const unitOfWork = new PocketbaseUnitOfWork(this.pb);
    if (existing !== null) {
      // Repair only the missing identity; existing binding fields stay as
      // stored. A station state row without an id was never usable.
      await this.syncRepository.planStationStateUpsert(unitOfWork.metadataBatch(), {
        stationId,
      });
    } else {
      await this.syncRepository.planStationStateUpsert(unitOfWork.metadataBatch(), {
        stationId,
        cursor: 0,
        lastChainHash: '',
        dataEpoch: 0,
        protocolVersion: SYNC_PROTOCOL_VERSION,
        mode: 'standalone',
      });
    }
    await unitOfWork.executeCommit();
    this.bindStationIdentity(stationId);
  }

  private bindStationIdentity(stationId: string): void {
    if (!isSyncUuid(stationId)) {
      throw new MutationPreconditionError(
        `Durable station identity "${stationId}" is not a UUID`,
      );
    }
    this.stationId = stationId;
    this.recorder.setStationId(stationId);
  }

  /** The durable local station identity (null until local initialize ran). */
  get stationIdentity(): string | null {
    return this.stationId;
  }

  /**
   * Fresh scoped container with the unit-of-work-backed repositories and the
   * scoped operation clock. This member contains the SINGLE documented
   * structural PB-view adapter cast — repositories keep their PocketBase
   * constructor types while every write is buffered by the unit of work.
   */
  scopeFor(
    unitOfWork: PocketbaseUnitOfWork,
    clock: SyncClock,
  ): AwilixContainer {
    const scope = this.container.createScope();
    scope.register({
      // The one documented structural adapter cast of the integration.
      pb: asValue(unitOfWork.view() as unknown as PocketBase),
      clock: asValue(clock),
      transactionRepository: asClass(PocketbaseTransactionRepository).scoped(),
      accountRepository: asClass(PocketbaseAccountRepository).scoped(),
      cardRepository: asClass(PocketbaseCardRepository).scoped(),
      invoiceRepository: asClass(PocketbaseInvoiceRepository).scoped(),
      recurrenceRepository: asClass(PocketbaseRecurrenceRepository).scoped(),
      categoryRepository: asClass(PocketbaseCategoryRepository).scoped(),
      projectRepository: asClass(PocketbaseProjectRepository).scoped(),
      // The destructive reset must NEVER run against the buffered unit-of-work
      // view (`createBatch` does not exist there): it commits its own single
      // real PocketBase batch against the raw client this runtime owns, while
      // still holding this FIFO gate slot so no other mutation can
      // interleave. Per-mutation scope keeps the instance exclusive to the
      // operation holding it.
      maintenanceRepository: asFunction(
        () => new PocketbaseDatabaseMaintenanceRepository(this.pb, this.role),
      ).scoped(),
    });
    return scope;
  }

  /**
   * Routes one financial mutation through the FIFO gate and returns the
   * actual use-case result. Local role additionally records the canonical
   * durable intent of the same mutation inside the same commit — except a
   * destructive reset, which clears the queue itself.
   */
  async execute<K extends UseCaseToken>(
    token: K,
    args: Parameters<UseCaseRegistry[K]['execute']>,
    origin: FinancialMutationOrigin = 'web',
  ): Promise<Awaited<ReturnType<UseCaseRegistry[K]['execute']>>> {
    await this.initialize();
    const clock = systemSyncClock;
    const intent = this.planIntentOf(token, args, origin);
    // The use-case value is captured inside the commit callback because the
    // gate hands back the protocol outcome, not the callback's return value:
    // a non-applied outcome (and, defensively, an applied one that never ran
    // the use case) throws instead of returning a fabricated result.
    const routed: Awaited<ReturnType<UseCaseRegistry[K]['execute']>>[] = [];
    const execution = await this.coordinator.run(
      {
        origin,
        stationId: this.stationId,
        clock,
        operation: null,
        ...(this.role === 'local'
          ? {
              centralJournal: false,
              stationOutbox: (context: StationOutboxPlanContext) =>
                this.recorder.planDescriptors(intent, context),
            }
          : {}),
      },
      async (unitOfWork) => {
        const scope = this.scopeFor(unitOfWork, clock);
        const value = await executeUseCase(scope, token, ...args);
        routed.push(value);
        return value;
      },
    );
    this.assertRoutedOutcome(execution, token, origin);
    if (token === 'resetFinancialDataUseCase' && this.role === 'central') {
      // The reset rotated the epoch and rewound the journal inside its own
      // atomic batch; refresh the cached handshake identity before serving
      // the response.
      await this.refreshLedgerIdentity();
    }
    if (routed.length === 0) {
      throw new MutationPreconditionError(
        `Mutation ${token} (${origin}) committed without executing its use case`,
      );
    }
    return routed[0];
  }

  /** Which durable local intent shape backs one dispatched use case. */
  private planIntentOf<K extends UseCaseToken>(
    token: K,
    args: Parameters<UseCaseRegistry[K]['execute']>,
    origin: FinancialMutationOrigin,
  ): StationMutationPlanIntent {
    if (token === 'resetFinancialDataUseCase') {
      return { kind: 'reset' };
    }
    if (origin === 'job' || JOB_MUTATION_TOKENS[token] === true) {
      return {
        kind: 'job',
        useCases: [{ token, args }],
      };
    }
    return { kind: 'useCase', token, args };
  }

  /** Re-reads the committed ledger identity after an epoch rotation. */
  private async refreshLedgerIdentity(): Promise<void> {
    const meta = await this.syncRepository.readSyncMeta();
    if (meta === null) {
      throw new MutationPreconditionError(
        'obol_sync_meta disappeared during runtime initialization or reset',
      );
    }
    this.serverInstanceId = meta.serverInstanceId;
    this.serverEpoch = meta.dataEpoch;
  }

  /** A gate outcome of one internal mutation is never a protocol result. */
  private assertRoutedOutcome(
    execution: MutationExecution<unknown>,
    token: UseCaseToken,
    origin: FinancialMutationOrigin,
  ): void {
    if (execution.outcome.status === 'applied') {
      return;
    }
    if (execution.outcome.status === 'deferred') {
      throw new MutationPreconditionError(
        `Internal mutation ${token} (${origin}) deferred without an outer mutation`,
      );
    }
    if (execution.outcome.status === 'rejected') {
      throw new MutationPreconditionError(
        `Mutation ${token} (${origin}) was rejected: ${execution.outcome.code} — ${execution.outcome.message}`,
      );
    }
    if (execution.outcome.status === 'conflict') {
      throw new MutationPreconditionError(
        `Mutation ${token} (${origin}) conflicted without an operation envelope — internal dispatch must never conflict`,
      );
    }
    throw new MutationPreconditionError(
      `Mutation ${token} (${origin}) resolved a duplicate protocol outcome without an operation envelope`,
    );
  }
}
