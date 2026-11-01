// Import policy (D7 snapshot import-as-new). Framework-free.
//
// A never-paired standalone profile transfers its complete settled snapshot
// with fresh ids into a server that is EMPTY OR POPULATED — never merged and
// never re-identified here. Same `importId` + hash + station + identity
// replays the stored original result; changed frozen content is
// `IMPORT_ID_REUSED`; any id collision is `IMPORT_ENTITY_ID_TAKEN`. The
// exclusive gate, collision checks, receipt accounting and the single PB
// transaction belong to the import gateway.

import {
  SyncProtocolRequestError,
  SYNC_IMPORT_MAX_ROWS,
  isSyncUuid,
  isSyncUuidV7,
  type SyncImportRequest,
  type SyncImportResponse,
} from '../../../domain/sync/SyncProtocol';
import { SYNC_HASH_PREFIX } from '../../../domain/sync/SyncRevision';
import type {
  SyncImportGateway,
  SyncServerStateView,
} from '../../ports/sync/SyncPorts';
import { snapshotRowCount } from './SyncSeedUseCase';

/** Unpadded base64url body of one SHA-256 digest. */
const SYNC_SHA256_BODY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Wire shape of a canonical sync hash: `sha256:` plus 43 unpadded base64url
 * characters. The policy only rejects a malformed *declared* hash here; the
 * import gateway recomputes the six-field hash before anything is written.
 */
function isCanonicalSha256Hash(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.startsWith(SYNC_HASH_PREFIX) &&
    SYNC_SHA256_BODY_PATTERN.test(value.slice(SYNC_HASH_PREFIX.length))
  );
}

export class SyncImportUseCase {
  constructor(
    private readonly stateView: SyncServerStateView,
    private readonly importGateway: SyncImportGateway,
  ) {}

  async execute(request: SyncImportRequest): Promise<SyncImportResponse> {
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
        'This store is bound to a different server instance; the import never reaches a foreign endpoint.',
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
        'This import arrived before a successful handshake registered the station.',
      );
    }

    if (snapshotRowCount(request.snapshot) > SYNC_IMPORT_MAX_ROWS) {
      throw new SyncProtocolRequestError(
        'REQUEST_TOO_LARGE',
        `The snapshot carries more than ${SYNC_IMPORT_MAX_ROWS} rows.`,
        413,
      );
    }

    const applied = await this.importGateway.import({
      protocolVersion: request.protocolVersion,
      stationId: request.stationId,
      serverInstanceId: request.serverInstanceId,
      dataEpoch: request.dataEpoch,
      importId: request.importId,
      snapshot: request.snapshot,
      payloadHash: request.payloadHash,
    });

    return {
      serverInstanceId: applied.serverInstanceId,
      dataEpoch: applied.dataEpoch,
      cursor: applied.cursor,
      counts: applied.counts,
      importId: applied.importId,
    };
  }

  private acceptWireIdentity(request: SyncImportRequest): void {
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
    if (typeof request.importId !== 'string' || !isSyncUuidV7(request.importId)) {
      throw new SyncProtocolRequestError(
        'PAGE_INVALID',
        'importId must be a lowercase hyphenated UUIDv7.',
      );
    }
    if (!isCanonicalSha256Hash(request.payloadHash)) {
      throw new SyncProtocolRequestError(
        'PAGE_INVALID',
        'payloadHash must be sha256: followed by 43 unpadded base64url characters.',
      );
    }
  }
}
