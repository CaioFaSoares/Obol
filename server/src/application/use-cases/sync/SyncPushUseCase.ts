// Push policy (D016 D4 push, canon §12.3). Framework-free.
//
// Request-level protocol, instance, epoch and station preconditions live here.
// The complete ordered-batch machinery (per-operation structural validation,
// dependency blocking, idempotency-first receipts, coverage and independent
// commits) is the `SyncPushGateway` adapter.

import {
  SYNC_PUSH_MAX_OPERATIONS,
  SyncProtocolRequestError,
  isSyncUuid,
  type SyncPushRequest,
  type SyncPushResponse,
} from '../../../domain/sync/SyncProtocol';
import type {
  SyncPushGateway,
  SyncServerStateView,
} from '../../ports/sync/SyncPorts';

export class SyncPushUseCase {
  constructor(
    private readonly stateView: SyncServerStateView,
    private readonly pushGateway: SyncPushGateway,
  ) {}

  async execute(request: SyncPushRequest): Promise<SyncPushResponse> {
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
        'This store is bound to a different server instance; the push never reaches a foreign endpoint.',
      );
    }
    if (request.dataEpoch !== ledger.dataEpoch) {
      throw new SyncProtocolRequestError(
        'DATA_EPOCH_CHANGED',
        `The server data epoch is ${ledger.dataEpoch}; the store keeps ${request.dataEpoch}. Pending operations require an explicit choice.`,
      );
    }

    const station = await this.stateView.readStation(request.stationId);
    if (station === null) {
      throw new SyncProtocolRequestError(
        'STATION_NOT_REGISTERED',
        'This push arrived before a successful handshake registered the station.',
      );
    }

    const batch = await this.pushGateway.push({
      protocolVersion: request.protocolVersion,
      stationId: request.stationId,
      ops: request.ops,
    });

    return {
      serverInstanceId: batch.serverInstanceId,
      dataEpoch: batch.dataEpoch,
      cursor: batch.cursor,
      results: batch.results,
    };
  }

  private acceptWireIdentity(request: SyncPushRequest): void {
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
    if (!Array.isArray(request.ops)) {
      throw new SyncProtocolRequestError(
        'PAGE_INVALID',
        'A push body must carry an ops array.',
      );
    }
    if (request.ops.length > SYNC_PUSH_MAX_OPERATIONS) {
      throw new SyncProtocolRequestError(
        'REQUEST_TOO_LARGE',
        `A push batch carries ${request.ops.length} operations; the bound is ${SYNC_PUSH_MAX_OPERATIONS}.`,
        413,
      );
    }
  }
}
