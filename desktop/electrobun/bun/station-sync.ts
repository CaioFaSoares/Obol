// Desktop station replica engine (D016 D7/D11, E007 desktop contract).
//
// One service owns pairing preview/confirmation, the bounded sync cycle
// (handshake, complete-group pull, bounded dependency-ordered push, pull
// again), the frozen snapshot import, conflict/rejection handling, export and
// truthful status publication. It never copies finance: local financial
// effects come from the existing scoped use cases, and remote changes apply
// through `PocketbaseStationReplicaRepository` only.
//
// Secrets: the remote session token lives in the OS credential store (Bun
// `secrets`: macOS Keychain / Windows Credential Manager). No password, token
// or credential appears in a status, export, outbox row, checkpoint or log.
// Local finance stays usable without a remote session.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Utils } from 'electrobun/main';

import {
  isSyncEntityId,
  isSyncEntityType,
  type SyncHash,
  type SyncEntityType,
  type SyncJsonObject,
  type SyncJsonValue,
} from '../../../server/src/domain/sync/SyncRevision';
import type {
  SyncEntitySnapshot,
  SyncOperationResult,
} from '../../../server/src/domain/sync/SyncOperation';
import type { SyncChangeEvent } from '../../../server/src/domain/sync/SyncChange';
import type {
  SyncHandshakeResponse,
  SyncImportResponse,
} from '../../../server/src/domain/sync/SyncProtocol';
import {
  STATION_OPERATION_MAX_BYTES,
  STATION_PROTOCOL_VERSION,
  STATION_PULL_LIMIT,
  STATION_PUSH_MAX_BODY_BYTES,
  STATION_PUSH_MAX_OPERATIONS,
  acceptedOperationIds,
  planStationPushBatch,
  validateStationPullPage,
  type StationBinding,
  type StationConflictSnapshot,
  type StationOutboxSnapshot,
  type StationPendingImportCheckpoint,
} from '../../../server/src/domain/sync/StationProtocol';
import {
  canonicalHash,
  canonicalJsonLength,
  changeChainHash,
  normalizeSyncTimestamp,
  parseSyncSha256Hash,
  recordHash,
  toSyncJsonObject,
  toSyncJsonValue,
} from '../../../server/src/infrastructure/sync/CanonicalJson';
import type {
  PocketbaseStationReplicaRepository,
  StationReplicaExport,
} from '../../../server/src/infrastructure/repositories/PocketbaseStationReplicaRepository';
import { StationReplicaStaleError } from '../../../server/src/infrastructure/repositories/PocketbaseStationReplicaRepository';
import {
  StationHttpError,
  StationRemoteClient,
  normalizeServerAddress,
} from './station-http';
import { StationSecretStore } from './station-secrets';
import type {
  DesktopConflictEntry,
  DesktopConflictResolution,
  DesktopConfirmConnectionRequest,
  DesktopConnectionPreviewRequest,
  DesktopDependentPolicy,
  DesktopExportResult,
  DesktopJsonObject,
  DesktopJsonValue,
  DesktopOutboxEntry,
  DesktopPairingAction,
  DesktopPairingPreview,
  DesktopSignOutResult,
  DesktopStationPhase,
  DesktopStationStatus
} from '../shared-rpc';

/** Bounded work per cycle; a later cycle continues a large backlog. */
const MAX_PULL_PAGES_PER_CYCLE = 200;
const MAX_PUSH_ROUNDS_PER_CYCLE = 20;
const PERIODIC_SYNC_INTERVAL_MS = 60_000;
const LOCAL_CHANGE_DEBOUNCE_MS = 1_500;

export interface DesktopStationSyncOptions {
  /** OS credential-store service name (the app identifier). */
  readonly serviceName: string;
  readonly deviceLabel: string;
  readonly platform: 'macos' | 'windows';
  /** Called with every truthful status change; used to publish over RPC. */
  readonly emit?: (status: DesktopStationStatus) => void;
}

/** One in-memory pairing preview; it never survives confirm/cancel/restart. */
interface PreviewSession {
  readonly address: string;
  readonly client: StationRemoteClient;
  readonly token: string;
  readonly handshake: SyncHandshakeResponse;
  readonly actions: readonly DesktopPairingAction[];
}

/** Coherent export document plus the receipt of the exact current dataset. */
interface PreparedExport {
  readonly document: Record<string, unknown>;
  readonly receipt: string;
  readonly dataRevision: number;
}

/** Fatal protocol states that require an explicit user decision. */
const BLOCKING_PROTOCOL_CODES: Readonly<Record<string, string>> = {
  ENDPOINT_MISMATCH:
    'This profile is bound to a different Obol server. Export your data and choose explicitly which copy to keep.',
  DATA_EPOCH_CHANGED:
    'The server data epoch changed (an administrative reset). Pending changes are preserved; export and choose explicitly.',
  SERVER_ROLLBACK_DETECTED:
    'The server journal is older than this profile (restored or reset). Nothing was pushed; export and choose explicitly.',
  PROTOCOL_UNSUPPORTED:
    'This Obol build does not speak the server protocol. Local finance remains available.'
};

/** Recursively projects a JSON value into the bridge's JSON type. */
function toDesktopJson(value: SyncJsonValue): DesktopJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toDesktopJson(entry));
  }
  const result: Record<string, DesktopJsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = toDesktopJson(entry);
  }
  return result;
}

function toDesktopObject(value: SyncJsonObject): DesktopJsonObject {
  const result: Record<string, DesktopJsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = toDesktopJson(entry);
  }
  return result;
}

/** Human summary of one local outbox row. */
function outboxEntryOf(operation: StationOutboxSnapshot): DesktopOutboxEntry {
  return {
    opId: operation.opId,
    type: operation.envelope.type,
    entityType: operation.envelope.entityType,
    entityId: operation.envelope.entityId,
    status: operation.status,
    effectiveAt: operation.envelope.effectiveAt,
    clientCreatedAt: operation.envelope.clientCreatedAt,
    attempts: operation.attempts,
    lastError: operation.lastError,
    payload: toDesktopObject(
      toSyncJsonObject(operation.envelope.payload, 'outbox payload'),
    ),
    baseRevisions: toDesktopObject(
      toSyncJsonObject(operation.envelope.baseRevisions, 'outbox baseRevisions'),
    ),
    beforeSnapshots: toDesktopJson(
      toSyncJsonValue(operation.beforeSnapshots, 'outbox beforeSnapshots'),
    ),
    dependsOn: [...operation.dependsOn]
  };
}

/** Exact JSON of one before-snapshot list (used by export). */
function beforeSnapshotsJson(snapshots: readonly SyncEntitySnapshot[]): SyncJsonValue {
  return toSyncJsonValue(snapshots, 'export beforeSnapshots');
}

export class DesktopStationSyncService {
  private readonly repository: PocketbaseStationReplicaRepository;
  private readonly secrets: StationSecretStore;
  private readonly options: DesktopStationSyncOptions;
  private readonly listeners = new Set<(status: DesktopStationStatus) => void>();
  private readonly abort = new AbortController();

  private timer: Timer | undefined;
  private debounce: Timer | undefined;
  private running: Promise<void> | null = null;
  private stopped = false;
  private preview: PreviewSession | null = null;
  private lastExport: { readonly receipt: string; readonly dataRevision: number } | null = null;

  private authRequired = false;
  private networkError: string | null = null;
  private fatalError: string | null = null;
  private lastSyncAt: string | null = null;
  private lastCycleClean = false;
  private serverName: string | null = null;

  constructor(
    repository: PocketbaseStationReplicaRepository,
    options: DesktopStationSyncOptions,
  ) {
    this.repository = repository;
    this.options = options;
    this.secrets = new StationSecretStore(options.serviceName);
  }

  // -----------------------------------------------------------------------
  // Lifecycle and status
  // -----------------------------------------------------------------------

  /** Starts periodic replication and resumes a paired binding when possible. */
  async start(): Promise<void> {
    this.stopped = false;
    if (this.timer === undefined) {
      this.timer = setInterval(() => {
        void this.synchronize().catch(() => undefined);
      }, PERIODIC_SYNC_INTERVAL_MS);
    }
    const state = await this.repository.readState();
    if (state.binding.mode === 'station' && state.binding.serverInstanceId !== '') {
      void this.synchronize().catch(() => undefined);
    }
    await this.publish();
  }

  /**
   * Stops timers and aborts in-flight requests. Already-frozen `in_flight`
   * rows stay durable for an exact retry after restart.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.debounce !== undefined) {
      clearTimeout(this.debounce);
      this.debounce = undefined;
    }
    await this.cancelConnectionPreview();
    this.abort.abort();
    const running = this.running;
    if (running !== null) await running.catch(() => undefined);
  }

  /** Registers a status listener and returns the unsubscribe function. */
  subscribe(callback: (status: DesktopStationStatus) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /** Requests a prompt replication after a successful local mutation. */
  noteLocalChange(): void {
    if (this.stopped) return;
    if (this.debounce !== undefined) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.synchronize().catch(() => undefined);
    }, LOCAL_CHANGE_DEBOUNCE_MS);
  }

  /** Computes the truthful status of the station. It contains no credential. */
  async status(): Promise<DesktopStationStatus> {
    const state = await this.repository.readState();
    const [counts, outbox, dataRevision] = await Promise.all([
      this.repository.readCounts(),
      this.repository.readOutbox(),
      this.repository.readDataRevision()
    ]);
    const outboxConflicts = outbox.filter((entry) => entry.status === 'conflict').length;
    const conflictCount = Math.max(counts.conflictCount, outboxConflicts);
    const isPaired = state.binding.mode === 'station' && state.binding.serverInstanceId !== '';
    const pendingCount = counts.operationCount;
    const phase = this.resolvePhase(
      isPaired,
      state.pendingImport !== null,
      pendingCount,
      conflictCount,
    );
    return {
      phase,
      isPaired,
      stationId: state.binding.stationId,
      serverUrl: state.binding.serverUrl === '' ? null : state.binding.serverUrl,
      serverName: this.serverName,
      detail: this.resolveDetail(
        phase,
        pendingCount,
        conflictCount,
        state.pendingImport !== null,
      ),
      lastSyncAt: this.lastSyncAt,
      pendingCount,
      conflictCount,
      dataRevision
    };
  }

  private resolvePhase(
    isPaired: boolean,
    hasPendingImport: boolean,
    pendingCount: number,
    conflictCount: number,
  ): DesktopStationPhase {
    if (hasPendingImport) return 'blocked';
    if (!isPaired) return 'standalone';
    if (this.running !== null) return 'syncing';
    if (conflictCount > 0) return 'conflict';
    if (this.authRequired) return 'authRequired';
    if (this.networkError !== null) return 'offline';
    if (this.fatalError !== null) return 'error';
    if (pendingCount > 0) return 'offline';
    if (this.lastCycleClean) return 'upToDate';
    return 'offline';
  }

  private resolveDetail(
    phase: DesktopStationPhase,
    pendingCount: number,
    conflictCount: number,
    hasPendingImport: boolean,
  ): string | null {
    switch (phase) {
      case 'standalone':
        return null;
      case 'blocked':
        if (!hasPendingImport) return null;
        return (
          this.fatalError ??
          'A snapshot import is waiting for the server. Retry after signing in; the frozen request is never replaced.'
        );
      case 'syncing':
        return `Synchronizing ${pendingCount} local change${pendingCount === 1 ? '' : 's'}.`;
      case 'conflict':
        return `${conflictCount} conflict${conflictCount === 1 ? '' : 's'} need an explicit decision.`;
      case 'authRequired':
        return 'Sign in to the server to resume synchronization. Local finance remains available.';
      case 'offline':
        return (
          this.networkError ??
          (pendingCount > 0
            ? `${pendingCount} local change${pendingCount === 1 ? '' : 's'} waiting to synchronize.`
            : 'Waiting for the next synchronization cycle.')
        );
      case 'error':
        return this.fatalError;
      case 'upToDate':
        return 'All local changes are synchronized.';
      default:
        return null;
    }
  }

  private async publish(): Promise<void> {
    if (this.stopped) return;
    const status = await this.status();
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch {
        // A view listener must never break replication.
      }
    }
    this.options.emit?.(status);
  }

  // -----------------------------------------------------------------------
  // Synchronization cycle
  // -----------------------------------------------------------------------

  /**
   * Runs one bounded replication cycle. Concurrent callers join the running
   * cycle; no busy loop is started and every failure is reflected truthfully
   * in the status instead of a false up-to-date claim.
   */
  async synchronize(): Promise<DesktopStationStatus> {
    if (this.stopped) throw new Error('Obol is closing.');
    if (this.running !== null) {
      await this.running.catch(() => undefined);
      return this.status();
    }
    const run = this.runCycle().finally(() => {
      this.running = null;
      void this.publish().catch(() => undefined);
    });
    this.running = run;
    await run.catch((error: unknown) => {
      this.recordError(error);
    });
    return this.status();
  }

  private async runCycle(): Promise<void> {
    const state = await this.repository.readState();
    if (state.binding.mode !== 'station' || state.binding.serverInstanceId === '') {
      return;
    }
    const token = await this.secrets.read(state.binding);
    if (token === null) {
      this.authRequired = true;
      return;
    }

    const client = new StationRemoteClient(
      state.binding.serverUrl,
      token,
      this.abort.signal,
    );
    try {
      const renewed = await client.renew();
      await this.secrets.write(state.binding, renewed.token);
    } catch (error) {
      this.recordError(error);
      return;
    }
    this.authRequired = false;

    const handshake = await client.handshake({
      protocolVersion: STATION_PROTOCOL_VERSION,
      stationId: state.binding.stationId,
      platform: this.options.platform,
      deviceLabel: this.options.deviceLabel,
      clientCursor: state.binding.cursor === 0 ? null : state.binding.cursor,
      clientCursorHash: state.binding.cursor === 0 ? null : state.binding.lastChainHash,
      dataEpoch: state.binding.dataEpoch === 0 ? null : state.binding.dataEpoch,
      serverInstanceId:
        state.binding.serverInstanceId === '' ? null : state.binding.serverInstanceId
    });
    this.serverName = handshake.serverName;
    this.validateHandshake(state.binding, handshake);
    this.networkError = null;

    let drained = true;
    if (state.pendingImport !== null) {
      await this.runPendingImport(client, state.pendingImport);
      const afterImport = await this.repository.readState();
      drained = await this.pullUntilDrained(client, afterImport.binding);
    } else {
      drained = await this.pullUntilDrained(client, state.binding);
      const pushed = await this.pushPending(client, state.binding);
      const afterPush = await this.repository.readState();
      const drainedAfterPush = await this.pullUntilDrained(client, afterPush.binding);
      drained = drained && pushed && drainedAfterPush;
    }

    const after = await this.repository.readState();
    const counts = await this.repository.readCounts();
    const unresolvedConflicts = counts.conflictCount;
    this.lastCycleClean =
      drained &&
      after.pendingImport === null &&
      counts.operationCount === 0 &&
      unresolvedConflicts === 0;
    if (drained) {
      this.lastSyncAt = new Date().toISOString();
    }
    if (this.lastCycleClean) {
      this.fatalError = null;
    }
  }

  /**
   * Validates the handshake identity and journal position before any local
   * write or push. Mismatches are explicit blocking states, never silent
   * rebases or blind pushes.
   */
  private validateHandshake(binding: StationBinding, handshake: SyncHandshakeResponse): void {
    if (handshake.serverInstanceId !== binding.serverInstanceId) {
      throw new StationHttpError(
        'The server instance no longer matches this station binding.',
        409,
        'ENDPOINT_MISMATCH',
      );
    }
    if (handshake.ownerFingerprint !== binding.ownerFingerprint) {
      throw new StationHttpError(
        'The server owner changed; this station refuses to sync until you choose explicitly.',
        409,
        'ENDPOINT_MISMATCH',
      );
    }
    if (handshake.dataEpoch !== binding.dataEpoch) {
      throw new StationHttpError(
        'The server data epoch changed; pending local changes are preserved.',
        409,
        'DATA_EPOCH_CHANGED',
      );
    }
    if (binding.cursor > handshake.cursor) {
      throw new StationHttpError(
        'The server journal is older than this station cursor.',
        409,
        'SERVER_ROLLBACK_DETECTED',
      );
    }
    if (
      binding.cursor > 0 &&
      handshake.cursor === binding.cursor &&
      handshake.cursorHash !== binding.lastChainHash
    ) {
      throw new StationHttpError(
        'The server journal hash at this station cursor does not match the stored chain hash.',
        409,
        'SERVER_ROLLBACK_DETECTED',
      );
    }
  }

  /** Pulls complete commit groups until the journal is drained or the bound is hit. */
  private async pullUntilDrained(
    client: StationRemoteClient,
    binding: StationBinding,
  ): Promise<boolean> {
    let cursor = binding.cursor;
    let chainHash = binding.lastChainHash;
    for (let pageIndex = 0; pageIndex < MAX_PULL_PAGES_PER_CYCLE; pageIndex += 1) {
      const page = await client.pull(cursor, STATION_PULL_LIMIT);
      if (page.serverInstanceId !== binding.serverInstanceId) {
        throw new StationHttpError(
          'A pull page belongs to a different server instance.',
          409,
          'ENDPOINT_MISMATCH',
        );
      }
      if (page.dataEpoch !== binding.dataEpoch) {
        throw new StationHttpError(
          'A pull page belongs to a different data epoch.',
          409,
          'DATA_EPOCH_CHANGED',
        );
      }
      if (page.events.length === 0) {
        if (page.hasMore) {
          throw new Error('The server reported more events but returned an empty page.');
        }
        return true;
      }
      const groups = validateStationPullPage(page.events, cursor);
      chainHash = this.verifyPageChain(page.events, chainHash, cursor);
      const lastEvent = page.events[page.events.length - 1]!;
      if (page.nextCursor !== lastEvent.seq) {
        throw new Error('The pull cursor does not name the last returned event.');
      }
      await this.repository.applyPullGroups(groups, new Date().toISOString());
      cursor = page.nextCursor;
      if (!page.hasMore) return true;
    }
    // Bounded progress: the cursor is already durable; the next cycle
    // continues from it instead of claiming an up-to-date state.
    return false;
  }

  /**
   * Verifies every event's canonical record and chain hash against the stored
   * chain before the page is applied. A mismatch rejects the whole page.
   */
  private verifyPageChain(
    events: readonly SyncChangeEvent[],
    expectedPrev: SyncHash,
    cursor: number,
  ): SyncHash {
    let previous = expectedPrev;
    let expectedSeq = cursor + 1;
    for (const event of events) {
      if (event.seq !== expectedSeq) {
        throw new Error('The pull page is not contiguous.');
      }
      expectedSeq += 1;
      if (!isSyncEntityId(event.entityId)) {
        throw new Error(`Pull event ${event.seq} carries an invalid entity id.`);
      }
      if (!Number.isInteger(event.revision) || event.revision < 1) {
        throw new Error(`Pull event ${event.seq} carries an invalid revision.`);
      }
      if (event.kind === 'upsert' && event.record === null) {
        throw new Error(`Pull event ${event.seq} is an upsert without a record.`);
      }
      if (event.kind === 'delete' && event.record !== null) {
        throw new Error(`Pull event ${event.seq} is a delete with a record.`);
      }
      if (event.prevHash !== previous) {
        throw new Error(`Pull event ${event.seq} does not continue the stored chain.`);
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
        prevHash: event.prevHash
      });
      if (expected !== event.chainHash) {
        throw new Error(`Pull event ${event.seq} has an invalid chain hash.`);
      }
      previous = parseSyncSha256Hash(
        event.chainHash,
        `pull event ${event.seq} chainHash`,
      );
    }
    return previous;
  }

  /** Pushes independent eligible operations in bounded, dependency-ordered batches. */
  private async pushPending(
    client: StationRemoteClient,
    binding: StationBinding,
  ): Promise<boolean> {
    for (let round = 0; round < MAX_PUSH_ROUNDS_PER_CYCLE; round += 1) {
      // Declare the stable base revisions of every side effect the queued use
      // cases write before their first send; a changed base is a conflict and
      // is never silently rebased here.
      await this.repository.prepareOutboxForSend(new Date().toISOString());
      const outbox = await this.repository.readOutbox();
      const accepted = acceptedOperationIds(outbox);
      const plan = planStationPushBatch(outbox, accepted, {
        wireBytesOf: (operation) =>
          canonicalJsonLength(toSyncJsonObject(operation.envelope, 'push envelope')),
        bodyBytesOf: (operations) =>
          canonicalJsonLength({
            protocolVersion: STATION_PROTOCOL_VERSION,
            stationId: binding.stationId,
            serverInstanceId: binding.serverInstanceId,
            dataEpoch: binding.dataEpoch,
            ops: operations.map((operation) =>
              toSyncJsonObject(operation.envelope, 'push envelope'),
            )
          })
      });
      if (plan.oversized.length > 0) {
        await this.repository.markOutboxRejected(
          plan.oversized.map((operation) => operation.opId),
          `The operation exceeds the ${STATION_OPERATION_MAX_BYTES} byte per-operation sync bound; export it and re-enter it.`,
          new Date().toISOString(),
        );
      }
      if (plan.batch.length === 0) return true;
      if (plan.batch.length > STATION_PUSH_MAX_OPERATIONS) {
        throw new Error('The push planner exceeded its operation bound.');
      }
      if (
        canonicalJsonLength({
          protocolVersion: STATION_PROTOCOL_VERSION,
          stationId: binding.stationId,
          serverInstanceId: binding.serverInstanceId,
          dataEpoch: binding.dataEpoch,
          ops: plan.batch.map((operation) =>
            toSyncJsonObject(operation.envelope, 'push envelope'),
          )
        }) > STATION_PUSH_MAX_BODY_BYTES
      ) {
        throw new Error('The push planner exceeded its request byte bound.');
      }

      const at = new Date().toISOString();
      await this.repository.markOutboxSending(
        plan.batch.map((operation) => operation.opId),
        at,
      );
      const response = await client.push({
        protocolVersion: STATION_PROTOCOL_VERSION,
        stationId: binding.stationId,
        serverInstanceId: binding.serverInstanceId,
        dataEpoch: binding.dataEpoch,
        ops: plan.batch.map((operation) => operation.envelope)
      });
      if (
        response.serverInstanceId !== binding.serverInstanceId ||
        response.dataEpoch !== binding.dataEpoch
      ) {
        throw new StationHttpError(
          'The push response identity does not match this station binding.',
          409,
          'ENDPOINT_MISMATCH',
        );
      }
      if (response.results.length !== plan.batch.length) {
        throw new Error(
          'The push response did not return one result per submitted operation; the frozen envelopes are kept.',
        );
      }
      for (let index = 0; index < plan.batch.length; index += 1) {
        const expectedOpId = plan.batch[index]!.opId;
        if (response.results[index]!.opId !== expectedOpId) {
          throw new Error(
            'The push response results are not in request order; the frozen envelopes are kept.',
          );
        }
      }
      await this.repository.applyPushResults(response.results, new Date().toISOString());

      const blocked = response.results.some((result) => result.status === 'blocked');
      if (blocked) return false;
      const progressed = response.results.some(
        (result: SyncOperationResult) =>
          result.status === 'applied' ||
          result.status === 'duplicate' ||
          result.status === 'conflict' ||
          result.status === 'rejected',
      );
      if (!progressed) return true;
    }
    return false;
  }

  /** Sends exactly the frozen checkpoint request, or preserves it on soft failure. */
  private async runPendingImport(
    client: StationRemoteClient,
    checkpoint: StationPendingImportCheckpoint,
  ): Promise<void> {
    let response: SyncImportResponse;
    try {
      response = await client.import(checkpoint.request);
    } catch (error) {
      if (
        error instanceof StationHttpError &&
        error.status === 409 &&
        error.code === 'IMPORT_ENTITY_ID_TAKEN'
      ) {
        await this.repository.dismissImportCheckpoint(true);
        throw new Error(
          'The server rejected the snapshot import because an id already exists; nothing was written. Local finance is intact.',
        );
      }
      throw error;
    }
    await this.repository.adoptImport(checkpoint, response, new Date().toISOString());
    this.lastCycleClean = false;
  }

  private recordError(error: unknown): void {
    if (error instanceof StationReplicaStaleError) {
      this.networkError = error.message;
      return;
    }
    if (error instanceof StationHttpError) {
      if (error.status === 401 || error.status === 403) {
        this.authRequired = true;
        return;
      }
      const blocking = error.code === null ? undefined : BLOCKING_PROTOCOL_CODES[error.code];
      if (blocking !== undefined) {
        this.fatalError = blocking;
        return;
      }
      if (error.status === 0) {
        this.networkError = error.message;
        return;
      }
      this.fatalError = error.message;
      return;
    }
    this.fatalError = error instanceof Error ? error.message : String(error);
  }

  // -----------------------------------------------------------------------
  // Pairing preview / confirmation
  // -----------------------------------------------------------------------

  /** Fresh, origin-bound pairing preview; sends no old token and no outbox. */
  async previewConnection(
    request: DesktopConnectionPreviewRequest,
  ): Promise<DesktopPairingPreview> {
    if (this.stopped) throw new Error('Obol is closing.');
    const state = await this.repository.readState();
    if (state.binding.stationId === '') {
      throw new Error('The local station identity is not initialized; unlock the local profile first.');
    }
    // A new preview replaces the previous ephemeral session; its token is
    // revoked so two origins are never held open at once.
    await this.cancelConnectionPreview();
    const address = normalizeServerAddress(request.serverAddress);
    const client = new StationRemoteClient(address, null, this.abort.signal);
    const login = await client.login(
      request.email,
      request.password,
      this.options.deviceLabel,
    );
    client.setToken(login.token);

    const handshake = await client.handshake({
      protocolVersion: STATION_PROTOCOL_VERSION,
      stationId: state.binding.stationId,
      platform: this.options.platform,
      deviceLabel: this.options.deviceLabel,
      clientCursor: null,
      clientCursorHash: null,
      dataEpoch: null,
      serverInstanceId: null
    });
    const counts = await this.repository.readCounts();
    const pendingImport = state.pendingImport;
    const canResumeImport =
      pendingImport !== null &&
      pendingImport.identity.serverInstanceId === handshake.serverInstanceId &&
      pendingImport.identity.ownerFingerprint === handshake.ownerFingerprint &&
      pendingImport.identity.dataEpoch === handshake.dataEpoch &&
      pendingImport.identity.stationId === state.binding.stationId;
    const actions = pendingImport === null
      ? this.pairingActions(state.binding, handshake, counts)
      : [
          ...(canResumeImport
            ? [{
                id: 'resume' as const,
                label: 'Resume the frozen snapshot import',
                isDestructive: false
              }]
            : []),
          {
            id: 'useServerData' as const,
            label: 'Use this server and replace the local copy',
            isDestructive: true
          },
          { id: 'stayLocal' as const, label: 'Stay local for now', isDestructive: false }
        ];
    const preview: DesktopPairingPreview = {
      serverName: handshake.serverName,
      serverAddress: address,
      hasServerData: handshake.hasFinancialData,
      localEntityCount: counts.entityCount,
      localOperationCount: counts.operationCount,
      isRePairing:
        state.binding.serverInstanceId !== '' &&
        state.binding.serverInstanceId === handshake.serverInstanceId &&
        state.binding.ownerFingerprint === handshake.ownerFingerprint,
      hasLocalData: counts.entityCount > 0,
      actions,
      warnings: state.pendingImport === null
        ? this.pairingWarnings(state.binding, handshake, counts, actions)
        : [
            'A snapshot import is pending. Sign in again on the same server to resume the frozen request; this profile never starts a second import. Choosing the server copy instead is destructive and requires a completed export.'
          ]
    };
    this.preview = {
      address,
      client,
      token: login.token,
      handshake,
      actions
    };
    await this.publish();
    return preview;
  }

  private pairingActions(
    binding: StationBinding,
    handshake: SyncHandshakeResponse,
    counts: { readonly entityCount: number; readonly operationCount: number; readonly hasOperationLog: boolean },
  ): DesktopPairingAction[] {
    const hasLocalData = counts.entityCount > 0;
    const sameServer =
      binding.serverInstanceId !== '' &&
      binding.serverInstanceId === handshake.serverInstanceId &&
      binding.ownerFingerprint === handshake.ownerFingerprint;
    const sameEpoch = binding.dataEpoch === handshake.dataEpoch;
    const serverAdvanced = binding.cursor <= handshake.cursor;
    const resumable = sameServer && sameEpoch && serverAdvanced;
    const actions: DesktopPairingAction[] = [];

    if (resumable) {
      actions.push({
        id: 'resume',
        label: binding.mode === 'station' ? 'Resume synchronization' : 'Reconnect this station',
        isDestructive: false
      });
      actions.push({ id: 'stayLocal', label: 'Stay local for now', isDestructive: false });
      return actions;
    }

    if (sameServer) {
      actions.push({
        id: 'useServerData',
        label: 'Use this server and replace the local copy',
        isDestructive: hasLocalData || counts.operationCount > 0
      });
      actions.push({ id: 'stayLocal', label: 'Stay local for now', isDestructive: false });
      return actions;
    }

    if (binding.serverInstanceId !== '') {
      actions.push({
        id: 'useServerData',
        label: 'Use this server and replace the local copy',
        isDestructive: hasLocalData || counts.operationCount > 0
      });
      actions.push({ id: 'stayLocal', label: 'Stay local for now', isDestructive: false });
      return actions;
    }

    if (handshake.hasFinancialData) {
      actions.push({
        id: 'useServerData',
        label: 'Use this server and replace the local copy',
        isDestructive: hasLocalData || counts.operationCount > 0
      });
      if (hasLocalData) {
        actions.push({
          id: 'importLocalData',
          label: 'Import this device as new records',
          isDestructive: false
        });
      }
      actions.push({ id: 'stayLocal', label: 'Stay local for now', isDestructive: false });
      return actions;
    }

    if (hasLocalData) {
      if (counts.hasOperationLog) {
        actions.push({
          id: 'importLocalData',
          label: 'Import this device as new records',
          isDestructive: false
        });
      } else {
        actions.push({
          id: 'seedEmptyServer',
          label: 'Seed this empty server with the local data',
          isDestructive: false
        });
      }
      actions.push({ id: 'useServerData', label: 'Use the empty server and replace the local copy', isDestructive: true });
      actions.push({ id: 'stayLocal', label: 'Stay local for now', isDestructive: false });
      return actions;
    }

    actions.push({
      id: 'resume',
      label: 'Pair this empty profile with the empty server',
      isDestructive: false
    });
    actions.push({ id: 'stayLocal', label: 'Stay local for now', isDestructive: false });
    return actions;
  }

  private pairingWarnings(
    binding: StationBinding,
    handshake: SyncHandshakeResponse,
    counts: { readonly entityCount: number; readonly operationCount: number; readonly hasOperationLog: boolean },
    actions: readonly DesktopPairingAction[],
  ): string[] {
    const warnings: string[] = [];
    if (counts.operationCount > 0) {
      warnings.push(
        `${counts.operationCount} local operation${counts.operationCount === 1 ? '' : 's'} are pending. A different server never receives this partial history; it is transferred only as a complete settled snapshot.`,
      );
    }
    if (binding.serverInstanceId !== '' && binding.serverInstanceId !== handshake.serverInstanceId) {
      warnings.push(
        'This profile was paired before. Its partial history is never replayed into a different server.',
      );
    }
    if (
      binding.serverInstanceId === handshake.serverInstanceId &&
      binding.dataEpoch !== handshake.dataEpoch
    ) {
      warnings.push('The server data epoch changed; pending local changes are preserved for an explicit decision.');
    }
    if (actions.some((action) => action.id === 'useServerData')) {
      warnings.push(
        'Replacing the local copy requires a completed export and the typed confirmation REPLACE.',
      );
    }
    if (actions.some((action) => action.id === 'importLocalData')) {
      warnings.push(
        'The import adds every local row as new server records with fresh ids; it does not merge or deduplicate equal payments.',
      );
      warnings.push(
        'Recurrence months already generated on the server can also arrive; review recurrence queue conflicts after the first pull.',
      );
    }
    if (actions.some((action) => action.id === 'seedEmptyServer')) {
      warnings.push('A seed is accepted only by an empty server and keeps the original local ids.');
    }
    return warnings;
  }

  /** Cancels the preview and revokes its ephemeral remote session. */
  async cancelConnectionPreview(): Promise<void> {
    const preview = this.preview;
    this.preview = null;
    if (preview === null) return;
    try {
      await preview.client.revoke();
    } catch {
      // The preview session may already be gone; no local state is affected.
    }
  }

  /**
   * Applies the explicit pairing choice. Destructive replacement requires a
   * completed, current export receipt and the literal `REPLACE`. Passwords
   * are never stored; only the session token enters the OS credential store.
   */
  async confirmConnection(
    request: DesktopConfirmConnectionRequest,
  ): Promise<DesktopStationStatus> {
    const preview = this.preview;
    if (preview === null) {
      throw new Error('Start a connection preview before confirming a choice.');
    }
    const action = preview.actions.find((entry) => entry.id === request.choice);
    if (action === undefined) {
      throw new Error('That pairing choice is not available for this server and local profile.');
    }
    if (request.choice === 'stayLocal') {
      await this.cancelConnectionPreview();
      return this.status();
    }

    if (request.choice === 'useServerData' && action.isDestructive) {
      if (request.confirmation !== 'REPLACE') {
        throw new Error('Type REPLACE to replace the local copy.');
      }
      await this.requireCurrentExport(request.exportReceipt);
    }

    const state = await this.repository.readState();
    const handshake = preview.handshake;
    const binding: StationBinding = {
      serverUrl: preview.address,
      serverInstanceId: handshake.serverInstanceId,
      ownerFingerprint: handshake.ownerFingerprint,
      stationId: state.binding.stationId,
      cursor:
        request.choice === 'resume' && state.binding.serverInstanceId === handshake.serverInstanceId
          ? state.binding.cursor
          : 0,
      lastChainHash:
        request.choice === 'resume' && state.binding.serverInstanceId === handshake.serverInstanceId
          ? state.binding.lastChainHash
          : '',
      dataEpoch: handshake.dataEpoch,
      protocolVersion: handshake.protocolVersion,
      mode: 'station'
    };

    // Persist the session before any local destructive step or network
    // mutation, so a credential-store failure cannot destroy local state.
    await this.secrets.write(binding, preview.token);

    switch (request.choice) {
      case 'resume':
        await this.repository.planBinding(
          binding,
          state.pendingImport === null ? null : state.pendingImport,
        );
        break;
      case 'useServerData':
        await this.repository.replaceLocalDataWithBinding(binding);
        this.lastExport = null;
        break;
      case 'seedEmptyServer': {
        const snapshot = await this.repository.readSnapshot();
        await preview.client.seed({
          protocolVersion: STATION_PROTOCOL_VERSION,
          stationId: binding.stationId,
          serverInstanceId: binding.serverInstanceId,
          dataEpoch: binding.dataEpoch,
          snapshot
        });
        await this.repository.planBinding(binding, null);
        break;
      }
      case 'importLocalData': {
        const existingCheckpoint = (await this.repository.readState()).pendingImport;
        if (existingCheckpoint !== null) {
          if (
            existingCheckpoint.identity.serverInstanceId !== binding.serverInstanceId ||
            existingCheckpoint.identity.stationId !== binding.stationId ||
            existingCheckpoint.identity.dataEpoch !== binding.dataEpoch
          ) {
            throw new Error(
              'The frozen import belongs to a different server identity. Keep the local copy and choose explicitly: export it, then replace it with this server data.',
            );
          }
          try {
            await this.runPendingImport(preview.client, existingCheckpoint);
          } catch (error) {
            this.recordError(error);
            throw new Error(
              `${error instanceof Error ? error.message : String(error)} The frozen import checkpoint is preserved for an exact retry.`,
            );
          }
          break;
        }
        const checkpoint = await this.repository.createImportCheckpoint({
          serverUrl: binding.serverUrl,
          serverInstanceId: binding.serverInstanceId,
          ownerFingerprint: handshake.ownerFingerprint,
          dataEpoch: binding.dataEpoch,
          stationId: binding.stationId,
          protocolVersion: binding.protocolVersion,
          at: new Date().toISOString()
        });
        try {
          await this.runPendingImport(preview.client, checkpoint);
        } catch (error) {
          if (error instanceof StationHttpError) {
            this.recordError(error);
            throw new Error(
              `${error.message} The frozen import checkpoint is preserved for an exact retry.`,
            );
          }
          throw error;
        }
        break;
      }
      default:
        throw new Error('Unsupported pairing choice.');
    }

    this.serverName = handshake.serverName;
    this.authRequired = false;
    this.networkError = null;
    this.fatalError = null;
    this.lastCycleClean = false;
    this.preview = null;

    const started = this.synchronize();
    void started.catch(() => undefined);
    return this.status();
  }

  /** Verifies that a completed export still describes the current dataset. */
  private async requireCurrentExport(exportReceipt: string | null): Promise<void> {
    if (exportReceipt === null || this.lastExport === null) {
      throw new Error(
        'Export the current data first. A canceled or failed save produces no receipt.',
      );
    }
    if (exportReceipt !== this.lastExport.receipt) {
      throw new Error('The export receipt is not the receipt of the last completed export.');
    }
    const current = await this.prepareExport();
    if (current.receipt !== exportReceipt || current.dataRevision !== this.lastExport.dataRevision) {
      throw new Error(
        'The exported copy is stale because data, pending intents or the binding changed. Export again.',
      );
    }
  }

  // -----------------------------------------------------------------------
  // Outbox, conflicts, export, sign out, disconnect
  // -----------------------------------------------------------------------

  /** Pending intents for the station panel; terminal rows are omitted. */
  async outbox(): Promise<DesktopOutboxEntry[]> {
    const outbox = await this.repository.readOutbox();
    return outbox
      .filter((operation) => operation.status !== 'accepted')
      .map(outboxEntryOf);
  }

  /**
   * Unresolved conflicts and visibly blocked dependents. A conflict row is the
   * durable decision source; a blocked dependent without a server conflict is
   * still surfaced with its real reason.
   */
  async conflicts(): Promise<DesktopConflictEntry[]> {
    const [rows, outbox] = await Promise.all([
      this.repository.readConflicts(),
      this.repository.readOutbox()
    ]);
    const entries: DesktopConflictEntry[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.resolution !== 'pending') continue;
      const operation = outbox.find((entry) => entry.opId === row.opId);
      if (operation === undefined) continue;
      const details = conflictDetailsOfRow(row);
      const detail = details[0];
      seen.add(row.opId);
      entries.push({
        opId: row.opId,
        entityType: operation.envelope.entityType,
        entityId: operation.envelope.entityId,
        message:
          conflictMessageOfRow(row) ??
          operation.lastError ??
          'The server has a newer revision for this record.',
        baseRevision: detail?.baseRevision ?? null,
        currentRevision: detail?.currentRevision ?? 0,
        currentRecord: detail === undefined ? null : toDesktopJson(detail.current),
        localIntent: toDesktopObject(
          toSyncJsonObject(operation.envelope.payload, 'conflict local intent'),
        )
      });
    }
    for (const operation of outbox) {
      if (operation.status !== 'conflict' || seen.has(operation.opId)) continue;
      entries.push({
        opId: operation.opId,
        entityType: operation.envelope.entityType,
        entityId: operation.envelope.entityId,
        message:
          operation.lastError ??
          'This queued change depends on an operation that needs an explicit decision.',
        baseRevision: null,
        currentRevision: 0,
        currentRecord: null,
        localIntent: toDesktopObject(
          toSyncJsonObject(operation.envelope.payload, 'conflict local intent'),
        )
      });
    }
    return entries;
  }

  /** Resolves one conflict, then schedules the next bounded cycle. */
  async resolveConflict(input: {
    readonly opId: string;
    readonly resolution: DesktopConflictResolution;
    readonly dependents: DesktopDependentPolicy;
  }): Promise<DesktopStationStatus> {
    await this.repository.resolveConflict({
      ...input,
      at: new Date().toISOString()
    });
    this.kickAfterResolution();
    return this.status();
  }

  /** Acknowledges one server rejection, then schedules the next cycle. */
  async acknowledgeRejected(input: {
    readonly opId: string;
    readonly dependents: DesktopDependentPolicy;
  }): Promise<DesktopStationStatus> {
    await this.repository.acknowledgeRejected({
      ...input,
      at: new Date().toISOString()
    });
    this.kickAfterResolution();
    return this.status();
  }

  private kickAfterResolution(): void {
    this.lastCycleClean = false;
    void this.synchronize().catch(() => undefined);
  }

  /**
   * Writes the coherent local dataset (finance plus pending intents, never a
   * secret) through a real native destination dialog and a real file write.
   * A canceled dialog or failed write produces no receipt. The receipt binds
   * the exact dataset and is invalidated by any later data/outbox/binding
   * change; `exportedAt` is excluded from it.
   */
  async exportSnapshot(): Promise<DesktopExportResult> {
    const prepared = await this.prepareExport();
    const chosen = await Utils.openFileDialog({
      startingFolder: '~/',
      allowedFileTypes: '*',
      canChooseFiles: false,
      canChooseDirectory: true,
      allowsMultipleSelection: false
    });
    const directory = chosen[0];
    if (directory === undefined) return { saved: false, receipt: null };
    const stamp = new Date().toISOString().replace(/[^0-9A-Za-z]+/g, '-');
    const path = join(directory, `obol-station-export-${stamp}.json`);
    await writeFile(path, JSON.stringify(prepared.document, null, 2), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
    this.lastExport = {
      receipt: prepared.receipt,
      dataRevision: prepared.dataRevision
    };
    return { saved: true, receipt: prepared.receipt };
  }

  /** Builds the coherent export document and its current-data receipt. */
  private async prepareExport(): Promise<PreparedExport> {
    const state = await this.repository.readState();
    const dataset: StationReplicaExport = await this.repository.readExport();
    const dataRevision = await this.repository.readDataRevision();
    const intents = dataset.outbox
      .filter((operation) => operation.status !== 'accepted')
      .map((operation) => ({
        opId: operation.opId,
        status: operation.status,
        type: operation.envelope.type,
        entityType: operation.envelope.entityType,
        entityId: operation.envelope.entityId,
        payload: operation.envelope.payload,
        baseRevisions: operation.envelope.baseRevisions,
        dependsOn: operation.envelope.dependsOn,
        effectiveAt: operation.envelope.effectiveAt,
        clientCreatedAt: operation.envelope.clientCreatedAt,
        payloadHash: operation.payloadHash,
        attempts: operation.attempts,
        lastError: operation.lastError,
        beforeSnapshots: beforeSnapshotsJson(operation.beforeSnapshots)
      }));
    const snapshotHash = canonicalHash(
      toSyncJsonValue(dataset.snapshot, 'export snapshot'),
    );
    const intentHash = canonicalHash(
      toSyncJsonValue(intents, 'export pending intents'),
    );
    const receipt = canonicalHash({
      format: 'obol-station-export-receipt',
      version: 1,
      dataRevision,
      snapshotHash,
      intentHash,
      pendingCount: dataset.counts.operationCount,
      conflictCount: dataset.counts.conflictCount,
      binding: {
        stationId: state.binding.stationId,
        serverInstanceId: state.binding.serverInstanceId,
        serverUrl: state.binding.serverUrl,
        ownerFingerprint: state.binding.ownerFingerprint,
        dataEpoch: state.binding.dataEpoch,
        mode: state.binding.mode
      }
    });
    return {
      document: {
        format: 'obol-station-export',
        version: 1,
        exportedAt: new Date().toISOString(),
        receipt,
        binding: {
          stationId: state.binding.stationId,
          serverInstanceId: state.binding.serverInstanceId,
          serverUrl: state.binding.serverUrl,
          ownerFingerprint: state.binding.ownerFingerprint,
          dataEpoch: state.binding.dataEpoch,
          mode: state.binding.mode
        },
        snapshot: dataset.snapshot,
        pendingIntents: intents,
        counts: dataset.counts
      },
      receipt,
      dataRevision
    };
  }

  /**
   * Removes this device's remote session. Local finance, pending intents and
   * the binding stay durable; the station shows `authRequired` until a new
   * sign-in.
   */
  async signOut(): Promise<DesktopSignOutResult> {
    const state = await this.repository.readState();
    const token = await this.secrets.read(state.binding);
    let remoteRevoked = false;
    let localCredentialRemoved = false;
    if (token !== null) {
      const client = new StationRemoteClient(
        state.binding.serverUrl,
        token,
        this.abort.signal,
      );
      try {
        await client.revoke();
        remoteRevoked = true;
      } catch {
        remoteRevoked = false;
      }
      localCredentialRemoved = await this.secrets.delete(state.binding);
      if (!localCredentialRemoved) {
        throw new Error(
          'The remote session was removed, but the OS credential store could not delete the local token. Retry sign out; local finance was not changed.',
        );
      }
    }
    this.authRequired = state.binding.mode === 'station';
    this.lastCycleClean = false;
    await this.publish();
    return { localCredentialRemoved, remoteRevoked };
  }

  /**
   * Unpairs this profile locally: stops replication, removes the session
   * credential and leaves every local finance row and pending intent intact.
   * The binding identity is retained so a later preview can offer an explicit
   * resume on the same server.
   */
  async disconnect(): Promise<DesktopStationStatus> {
    const state = await this.repository.readState();
    const token = await this.secrets.read(state.binding);
    if (token !== null) {
      const client = new StationRemoteClient(
        state.binding.serverUrl,
        token,
        this.abort.signal,
      );
      try {
        await client.revoke();
      } catch {
        // The server session may already be gone; disconnecting locally is
        // still safe and never touches finance.
      }
      await this.secrets.delete(state.binding);
    }
    if (state.binding.mode === 'station') {
      await this.repository.planBinding({ mode: 'standalone' }, undefined);
    }
    this.authRequired = false;
    this.networkError = null;
    this.fatalError = null;
    this.lastCycleClean = false;
    await this.publish();
    return this.status();
  }
}

/** One typed conflict detail stored beside a resolution row. */
interface StoredConflictDetail {
  readonly entityType: SyncEntityType;
  readonly entityId: string;
  readonly baseRevision: number | null;
  readonly currentRevision: number;
  readonly current: SyncJsonObject | null;
}

/** Narrows the JSON value union to a plain object without the array member. */
function isSyncJsonObject(value: SyncJsonValue): value is SyncJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseConflictDetails(entries: readonly SyncJsonValue[]): StoredConflictDetail[] {
  const details: StoredConflictDetail[] = [];
  for (const entry of entries) {
    if (!isSyncJsonObject(entry)) {
      throw new StationHttpError(
        'A conflict detail entry is not a JSON object.',
        0,
        'INVALID_RESPONSE',
      );
    }
    const entityType = entry['entityType'];
    const entityId = entry['entityId'];
    const currentRevision = entry['currentRevision'];
    if (typeof entityType !== 'string' || !isSyncEntityType(entityType)) {
      throw new StationHttpError(
        'A conflict detail carries an unknown entity type.',
        0,
        'INVALID_RESPONSE',
      );
    }
    if (typeof entityId !== 'string' || !isSyncEntityId(entityId)) {
      throw new StationHttpError(
        'A conflict detail carries an invalid entity id.',
        0,
        'INVALID_RESPONSE',
      );
    }
    if (
      typeof currentRevision !== 'number' ||
      !Number.isInteger(currentRevision) ||
      currentRevision < 1
    ) {
      throw new StationHttpError(
        'A conflict detail carries an invalid current revision.',
        0,
        'INVALID_RESPONSE',
      );
    }
    const baseRevision = entry['baseRevision'];
    if (
      baseRevision !== null &&
      baseRevision !== undefined &&
      (typeof baseRevision !== 'number' ||
        !Number.isInteger(baseRevision) ||
        baseRevision < 1)
    ) {
      throw new StationHttpError(
        'A conflict detail carries an invalid base revision.',
        0,
        'INVALID_RESPONSE',
      );
    }
    const current = entry['current'];
    if (
      current !== null &&
      current !== undefined &&
      !isSyncJsonObject(current)
    ) {
      throw new StationHttpError(
        'A conflict detail carries a non-object current record.',
        0,
        'INVALID_RESPONSE',
      );
    }
    details.push({
      entityType,
      entityId,
      baseRevision:
        typeof baseRevision === 'number' ? baseRevision : null,
      currentRevision,
      current: current === null || current === undefined
        ? null
        : toSyncJsonObject(current, 'conflict current record')
    });
  }
  return details;
}

/** Conflict details stored beside a resolution row. */
function conflictDetailsOfRow(row: StationConflictSnapshot): readonly StoredConflictDetail[] {
  if (row.conflict === null) return [];
  const conflicts = row.conflict['conflicts'];
  if (Array.isArray(conflicts)) return parseConflictDetails(conflicts);
  const entries = row.conflict['entries'];
  if (Array.isArray(entries)) return parseConflictDetails(entries);
  return [];
}

function conflictMessageOfRow(row: StationConflictSnapshot): string | null {
  if (row.conflict === null) return null;
  const message = row.conflict['message'];
  return typeof message === 'string' ? message : null;
}
