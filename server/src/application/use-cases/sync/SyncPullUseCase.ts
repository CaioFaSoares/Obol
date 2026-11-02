// Pull policy (D016 D4 pull, canon §12.3). Framework-free.
//
// Complete-group paging, cursor boundary validation and the page byte cap are
// enforced by the event-page reader port. This policy validates the query
// wire shape, exposes the served page identity and lets reader failures map to
// the uniform protocol errors.

import { SYNC_GENESIS_CURSOR } from '../../../domain/sync/SyncChange';
import {
  SYNC_PULL_LIMIT_MAX,
  SYNC_PULL_LIMIT_MIN,
  SyncProtocolRequestError,
  type SyncPullQuery,
  type SyncPullResponse,
} from '../../../domain/sync/SyncProtocol';
import type {
  SyncEventPageReader,
  SyncServerStateView,
} from '../../ports/sync/SyncPorts';

export class SyncPullUseCase {
  constructor(
    private readonly stateView: SyncServerStateView,
    private readonly pageReader: SyncEventPageReader,
  ) {}

  async execute(query: SyncPullQuery): Promise<SyncPullResponse> {
    this.acceptQuery(query);

    const ledger = await this.stateView.readLedger();
    if (ledger === null) {
      throw new Error(
        'obol_sync_meta is missing; the mutation runtime must initialize before serving sync',
      );
    }

    const page = await this.pageReader.pullPage({
      cursor: query.cursor,
      limit: query.limit,
    });

    return {
      serverInstanceId: ledger.serverInstanceId,
      dataEpoch: ledger.dataEpoch,
      events: page.events,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }

  private acceptQuery(query: SyncPullQuery): void {
    if (
      !Number.isInteger(query.cursor) ||
      query.cursor < SYNC_GENESIS_CURSOR
    ) {
      throw new SyncProtocolRequestError(
        'PAGE_INVALID',
        `pull cursor must be a non-negative integer, got ${JSON.stringify(query.cursor)}.`,
      );
    }
    if (
      !Number.isInteger(query.limit) ||
      query.limit < SYNC_PULL_LIMIT_MIN ||
      query.limit > SYNC_PULL_LIMIT_MAX
    ) {
      throw new SyncProtocolRequestError(
        'PAGE_INVALID',
        `pull limit must be an integer within ${SYNC_PULL_LIMIT_MIN}..${SYNC_PULL_LIMIT_MAX}, got ${JSON.stringify(query.limit)}.`,
      );
    }
  }
}
