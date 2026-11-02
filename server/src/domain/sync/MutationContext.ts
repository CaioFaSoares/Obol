// Framework-free time and mutation context contracts consumed by the future
// unit of work and station recorder (D016 D2/D9/D10/D13, canon §12.2).
//
// This module declares interfaces only. It is not a unit of work and applies
// nothing: the later infrastructure implementation buffers reads/writes, holds
// the mutation gate, assigns revisions/seq and commits one PocketBase batch.

import type { SyncChangeOrigin } from './SyncChange';
import type {
  SyncOperationEnvelope,
  SyncOperationType,
} from './SyncOperation';

// ---------------------------------------------------------------------------
// Clocks
// ---------------------------------------------------------------------------

/**
 * Time source for financial dates. `now()` returns an ISO UTC timestamp.
 *
 * Web requests, cron and online-only admin actions use the server clock. A
 * sync operation seeds `SyncOperationClock` from its `effectiveAt`, so an
 * offline realization, payment, project payment or recurrence launch keeps the
 * business date the user performed it and never moves to the reconnect date.
 */
export interface SyncClock {
  now(): string;
}

/** Scoped operation clock: `now()` is the operation's `effectiveAt`. */
export interface SyncOperationClock extends SyncClock {
  readonly effectiveAt: string;
}

/**
 * Default clock for use cases invoked outside a scoped operation (web, cron,
 * admin). It reads the real system time on every call. A unit-of-work scope
 * overrides it with a `SyncOperationClock` seeded from the operation's
 * `effectiveAt`.
 */
export const systemSyncClock: SyncClock = {
  now: (): string => new Date().toISOString(),
};

export default systemSyncClock;

// ---------------------------------------------------------------------------
// Operation descriptor
// ---------------------------------------------------------------------------

/**
 * What a call site contributes before an envelope exists: operation type,
 * target entity, payload, observed base revisions, dependencies and both
 * timestamps. The mutation boundary adds `protocolVersion`, `stationId` and a
 * new `opId`, then persists the immutable envelope and its complete-envelope
 * hash. Internal invoice, balance and reconciliation writes are effects of the
 * operation, never separate descriptors.
 */
export type SyncOperationDescriptor = {
  [K in SyncOperationType]: Omit<
    SyncOperationEnvelope<K>,
    'protocolVersion' | 'stationId' | 'opId'
  >;
}[SyncOperationType];

/** Descriptor helper for one operation type. */
export type SyncOperationDescriptorFor<K extends SyncOperationType> = Omit<
  SyncOperationEnvelope<K>,
  'protocolVersion' | 'stationId' | 'opId'
>;

// ---------------------------------------------------------------------------
// Mutation context
// ---------------------------------------------------------------------------

/**
 * Context of one financial mutation:
 * - web/cron/admin: `operation` is `null`, `stationId` is `null` and `clock`
 *   is the server clock;
 * - station mode: `operation` carries the local descriptor, `origin` is
 *   `station` and the recorded operation enters `obol_station_outbox`;
 * - sync push: the accepted envelope supplies `effectiveAt` to the scoped
 *   clock and `origin` is `sync`.
 */
export interface SyncMutationContext {
  readonly origin: SyncChangeOrigin;
  /** Registered station id for station/sync mutations; `null` otherwise. */
  readonly stationId: string | null;
  /**
   * Server clock for web/cron/admin, or a `SyncOperationClock` seeded from
   * `effectiveAt` for an applied sync operation.
   */
  readonly clock: SyncClock;
  /** `null` for a mutation that is not a synchronized operation. */
  readonly operation: SyncOperationDescriptor | null;
}
