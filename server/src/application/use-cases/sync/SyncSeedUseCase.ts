// Seed policy (D016 D4 seed, canon §12.3). Framework-free.
//
// One-time migration of a legacy, operation-log-free snapshot into an EMPTY
// server. The presence check here fails fast; the authoritative empty-state
// check runs inside the seed gateway's exclusive gate, in the same scope as
// the snapshot write, so a concurrent mutation can never slip between the
// emptiness observation and the commit.

import {
  SyncProtocolRequestError,
  SYNC_SEED_MAX_ROWS,
  isSyncUuid,
  type SyncSeedRequest,
  type SyncSeedResponse,
} from '../../../domain/sync/SyncProtocol';
import {
  SYNC_COLLECTIONS,
  SYNC_ENTITY_TYPES,
} from '../../../domain/sync/SyncRevision';
import type {
  SyncSeedGateway,
  SyncServerStateView,
} from '../../ports/sync/SyncPorts';

export class SyncSeedUseCase {
  constructor(
    private readonly stateView: SyncServerStateView,
    private readonly seedGateway: SyncSeedGateway,
  ) {}

  async execute(request: SyncSeedRequest): Promise<SyncSeedResponse> {
    this.acceptWireIdentity(request);

    const ledger = await this.stateView.readLedger();
    if (ledger === null) {
      throw new Error(
        'obol_sync_meta is missing; the mutation runtime must initialize before serving sync',
      );
    }
    if (
      request.protocolVersion < ledger.protocolMin ||
      request.protocolVersion > ledger.protocolMax
    ) {
      throw new SyncProtocolRequestError(
        'PROTOCOL_UNSUPPORTED',
        `Protocol ${request.protocolVersion} is outside the supported range ${ledger.protocolMin}..${ledger.protocolMax}.`,
      );
    }
    if (request.serverInstanceId !== ledger.serverInstanceId) {
      throw new SyncProtocolRequestError(
        'ENDPOINT_MISMATCH',
        'This store is bound to a different server instance; the seed never reaches a foreign endpoint.',
      );
    }
    if (request.dataEpoch !== ledger.dataEpoch) {
      throw new SyncProtocolRequestError(
        'DATA_EPOCH_CHANGED',
        `The server data epoch is ${ledger.dataEpoch}; the store keeps ${request.dataEpoch}.`,
      );
    }

    const station = await this.stateView.readStation(request.stationId);
    if (station === null) {
      throw new SyncProtocolRequestError(
        'STATION_NOT_REGISTERED',
        'This seed arrived before a successful handshake registered the station.',
      );
    }

    if (snapshotRowCount(request.snapshot) > SYNC_SEED_MAX_ROWS) {
      throw new SyncProtocolRequestError(
        'REQUEST_TOO_LARGE',
        `The snapshot carries more than ${SYNC_SEED_MAX_ROWS} rows.`,
        413,
      );
    }

    // Fast fail on a clearly populated server. The authoritative check
    // (finance rows, version rows and journal events) re-runs inside the
    // gateway's exclusive gate.
    const financeRowCounts = await this.stateView.financeRowCounts();
    if (Object.values(financeRowCounts).some((count) => count > 0)) {
      throw new SyncProtocolRequestError(
        'SERVER_NOT_EMPTY',
        'The server already holds financial data; a seed is never merged into an existing server.',
      );
    }

    const applied = await this.seedGateway.seed({
      protocolVersion: request.protocolVersion,
      stationId: request.stationId,
      serverInstanceId: request.serverInstanceId,
      dataEpoch: request.dataEpoch,
      snapshot: request.snapshot,
    });

    return {
      serverInstanceId: applied.serverInstanceId,
      dataEpoch: applied.dataEpoch,
      cursor: applied.cursor,
      counts: applied.counts,
    };
  }

  private acceptWireIdentity(request: SyncSeedRequest): void {
    if (
      !Number.isInteger(request.protocolVersion) ||
      request.protocolVersion < 1
    ) {
      throw new SyncProtocolRequestError(
        'PROTOCOL_UNSUPPORTED',
        `protocolVersion must be a positive integer, got ${JSON.stringify(request.protocolVersion)}.`,
      );
    }
    if (typeof request.stationId !== 'string' || !isSyncUuid(request.stationId)) {
      throw new SyncProtocolRequestError(
        'PAGE_INVALID',
        'stationId must be a lowercase hyphenated UUID.',
      );
    }
    if (
      typeof request.serverInstanceId !== 'string' ||
      !isSyncUuid(request.serverInstanceId)
    ) {
      throw new SyncProtocolRequestError(
        'ENDPOINT_MISMATCH',
        'serverInstanceId must be a lowercase hyphenated UUID.',
      );
    }
    if (!Number.isInteger(request.dataEpoch) || request.dataEpoch < 1) {
      throw new SyncProtocolRequestError(
        'PAGE_INVALID',
        `dataEpoch must be a positive integer, got ${JSON.stringify(request.dataEpoch)}.`,
      );
    }
  }
}

/** Total rows across the seven financial collections. */
export function snapshotRowCount(
  snapshot: SyncSeedRequest['snapshot'],
): number {
  return SYNC_ENTITY_TYPES.reduce<number>(
    (total, entityType) =>
      total + snapshot[SYNC_COLLECTIONS[entityType]].length,
    0,
  );
}
