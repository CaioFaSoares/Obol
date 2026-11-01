// Handshake policy (D016 D4 handshake, canon §12.3). Framework-free.
//
// The policy validates the wire identity, the protocol range, endpoint
// binding, data epoch, and cursor rollback/hash continuity before it lets the
// station registry refresh the durable station row. Every failure is the
// uniform `SyncProtocolRequestError`; the HTTP adapter owns the status mapping
// and the `{ code, message }` body.

import type { SyncClock } from '../../../domain/sync/MutationContext';
import {
  SYNC_GENESIS_CURSOR,
  isCommitBoundary,
} from '../../../domain/sync/SyncChange';
import {
  SYNC_STATION_PLATFORMS,
  SyncProtocolRequestError,
  isSyncUuid,
  type SyncHandshakeRequest,
  type SyncHandshakeResponse,
  type SyncStationPlatform,
} from '../../../domain/sync/SyncProtocol';
import type {
  SyncServerStateView,
  SyncStationRegistry,
} from '../../ports/sync/SyncPorts';

const MAX_DEVICE_LABEL_LENGTH = 200;

export class SyncHandshakeUseCase {
  constructor(
    private readonly stateView: SyncServerStateView,
    private readonly stationRegistry: SyncStationRegistry,
    private readonly clock: SyncClock,
  ) {}

  async execute(request: SyncHandshakeRequest): Promise<SyncHandshakeResponse> {
    this.acceptWireIdentity(request);

    const ledger = await this.stateView.readLedger();
    if (ledger === null) {
      // Runtime initialization is awaited before serving sync; a missing
      // singleton after that is a structural fault, never a wire state.
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
    if (
      request.serverInstanceId !== null &&
      request.serverInstanceId !== ledger.serverInstanceId
    ) {
      throw new SyncProtocolRequestError(
        'ENDPOINT_MISMATCH',
        'This store is bound to a different server instance; explicit pairing decisions are required.',
      );
    }
    if (request.dataEpoch !== null && request.dataEpoch !== ledger.dataEpoch) {
      throw new SyncProtocolRequestError(
        'DATA_EPOCH_CHANGED',
        `The server data epoch is ${ledger.dataEpoch}; the store keeps ${request.dataEpoch}. Pending operations require an explicit choice.`,
      );
    }

    // `acceptWireIdentity` rejects the mixed shape, so a stored cursor always
    // travels with its hash here.
    if (request.clientCursor !== null && request.clientCursorHash !== null) {
      await this.acceptStoredCursor(
        request.clientCursor,
        request.clientCursorHash,
        ledger.lastSeq,
      );
    }

    const at = this.clock.now();
    await this.stationRegistry.register({
      stationId: request.stationId,
      platform: request.platform,
      deviceLabel: request.deviceLabel,
      at,
      lastCursor: request.clientCursor,
    });

    const [ownerFingerprint, financeRowCounts] = await Promise.all([
      this.stateView.ownerFingerprint(),
      this.stateView.financeRowCounts(),
    ]);
    const hasFinancialData = Object.values(financeRowCounts).some(
      (count) => count > 0,
    );

    return {
      serverInstanceId: ledger.serverInstanceId,
      ownerFingerprint,
      protocolVersion: ledger.protocolMax,
      protocolMin: ledger.protocolMin,
      protocolMax: ledger.protocolMax,
      dataEpoch: ledger.dataEpoch,
      cursor: ledger.lastSeq,
      cursorHash: ledger.headHash,
      headHash: ledger.headHash,
      hasFinancialData,
      serverName: this.stateView.serverName(),
    };
  }

  private acceptWireIdentity(request: SyncHandshakeRequest): void {
    if (typeof request.stationId !== 'string' || !isSyncUuid(request.stationId)) {
      throw new SyncProtocolRequestError(
        'PAGE_INVALID',
        'stationId must be a lowercase hyphenated UUID.',
      );
    }
    if (
      !Number.isInteger(request.protocolVersion) ||
      request.protocolVersion < 1
    ) {
      throw new SyncProtocolRequestError(
        'PROTOCOL_UNSUPPORTED',
        `protocolVersion must be a positive integer, got ${JSON.stringify(request.protocolVersion)}.`,
      );
    }
    if (!SYNC_STATION_PLATFORMS.includes(request.platform)) {
      throw new SyncProtocolRequestError(
        'PAGE_INVALID',
        `platform must be one of ${SYNC_STATION_PLATFORMS.join(', ')}.`,
      );
    }
    if (
      typeof request.deviceLabel !== 'string' ||
      request.deviceLabel.length === 0 ||
      request.deviceLabel.length > MAX_DEVICE_LABEL_LENGTH
    ) {
      throw new SyncProtocolRequestError(
        'PAGE_INVALID',
        `deviceLabel must be a non-empty string of at most ${MAX_DEVICE_LABEL_LENGTH} characters.`,
      );
    }
    if (
      request.serverInstanceId !== null &&
      !isSyncUuid(request.serverInstanceId)
    ) {
      throw new SyncProtocolRequestError(
        'ENDPOINT_MISMATCH',
        'A resumed handshake must carry a valid serverInstanceId or null.',
      );
    }
    if (
      request.dataEpoch !== null &&
      (!Number.isInteger(request.dataEpoch) || request.dataEpoch < 1)
    ) {
      throw new SyncProtocolRequestError(
        'PAGE_INVALID',
        `dataEpoch must be a positive integer or null, got ${JSON.stringify(request.dataEpoch)}.`,
      );
    }

    const cursor = request.clientCursor;
    const cursorHash = request.clientCursorHash;
    if ((cursor === null) !== (cursorHash === null)) {
      throw new SyncProtocolRequestError(
        'PAGE_INVALID',
        'A resuming handshake must carry both clientCursor and clientCursorHash, or neither.',
      );
    }
    if (cursor !== null) {
      if (!Number.isInteger(cursor) || cursor < SYNC_GENESIS_CURSOR) {
        throw new SyncProtocolRequestError(
          'PAGE_INVALID',
          `clientCursor must be a non-negative integer, got ${JSON.stringify(cursor)}.`,
        );
      }
      if (typeof cursorHash !== 'string') {
        throw new SyncProtocolRequestError(
          'PAGE_INVALID',
          'clientCursorHash must be a hash string.',
        );
      }
      if (cursor === SYNC_GENESIS_CURSOR) {
        if (cursorHash !== '') {
          throw new SyncProtocolRequestError(
            'PAGE_INVALID',
            'The cursor hash at cursor 0 is the empty genesis hash.',
          );
        }
      } else if (!cursorHash.startsWith('sha256:')) {
        throw new SyncProtocolRequestError(
          'PAGE_INVALID',
          'clientCursorHash must be a sha256 hash at a non-genesis cursor.',
        );
      }
    }
  }

  /**
   * Cursor rollback rules exactly as D016 D4 lists them. Mid-group cursors,
   * missing events and hash mismatches are never repaired or silently
   * advanced.
   */
  private async acceptStoredCursor(
    clientCursor: number,
    clientCursorHash: string,
    serverCursor: number,
  ): Promise<void> {
    if (clientCursor > serverCursor) {
      throw new SyncProtocolRequestError(
        'SERVER_ROLLBACK_DETECTED',
        `The stored cursor ${clientCursor} is beyond the server journal head ${serverCursor}; the journal was restored or replaced.`,
      );
    }
    if (clientCursor === SYNC_GENESIS_CURSOR) {
      return;
    }
    const event = await this.stateView.readCursorEvent(clientCursor);
    if (event === null) {
      throw new SyncProtocolRequestError(
        'SERVER_ROLLBACK_DETECTED',
        `No journal event exists at stored cursor ${clientCursor}; the journal was restored or replaced.`,
      );
    }
    if (!isCommitBoundary(event)) {
      throw new SyncProtocolRequestError(
        'CURSOR_NOT_ON_COMMIT_BOUNDARY',
        `Stored cursor ${clientCursor} names commitIndex ${event.commitIndex} of ${event.commitSize}; the cursor must name the last event of a commit.`,
      );
    }
    if (event.chainHash !== clientCursorHash) {
      throw new SyncProtocolRequestError(
        'SERVER_ROLLBACK_DETECTED',
        `The event at stored cursor ${clientCursor} does not chain to the stored cursor hash; the journal was restored or replaced.`,
      );
    }
  }
}
