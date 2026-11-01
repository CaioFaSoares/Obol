// Destructive reset persistence: ONE real PocketBase batch clears the seven
// finance collections plus the role-appropriate sync metadata, while central
// keeps the deployment identity and local keeps the durable station identity
// (D016 D13, E007 reset decision).
//
// - central: delete finance rows, entity versions, journal events, accepted
//   operation receipts and snapshot-import receipts; increment `dataEpoch`,
//   rewind `lastSeq` to 0 with the empty genesis head and clear the backfill
//   marker. `serverInstanceId`, protocol bounds and the owner stay untouched.
// - local: delete finance rows, conflicts, outbox intents, local/base version
//   rows and the pending-import checkpoint; clear every pairing field on
//   `obol_station_state` while retaining `stationId`. Nothing is ever queued
//   remotely, and the whole reset commits atomically or not at all.
//
// No fallback partial delete exists: when the batch is refused (for example a
// PB batch-size setting), the call fails loudly.

import type PocketBase from 'pocketbase';
import type { BatchService } from 'pocketbase';
import type {
  ClearedFinancialData,
  DatabaseMaintenanceRepository,
} from '../../domain/interfaces/DatabaseMaintenanceRepository';
import { SYNC_GENESIS_HASH } from '../../domain/sync/SyncRevision';
import { BACKFILL_MARKER_VERSION } from '../sync/JournalBackfill';

/**
 * Children before parents: transactions reference invoices, recurrences,
 * accounts, cards, categories and projects; invoices reference cards; and
 * recurrences reference accounts/cards/categories. Deleting in this order
 * avoids cascade surprises and leaves no orphans.
 */
const CLEAR_ORDER: ReadonlyArray<keyof ClearedFinancialData> = [
  'transactions',
  'invoices',
  'recurrences',
  'cards',
  'accounts',
  'categories',
  'projects',
];

/** Sync metadata rows the central reset clears under the epoch rotation. */
const CENTRAL_METADATA_CLEAR_ORDER: readonly string[] = [
  'obol_sync_entity_versions',
  'obol_sync_changes',
  'obol_sync_operations',
  'obol_sync_snapshot_imports',
];

/** Station rows a local reset clears: queue, conflicts, base versions. */
const LOCAL_METADATA_CLEAR_ORDER: readonly string[] = [
  'obol_station_conflicts',
  'obol_station_outbox',
  'obol_station_versions',
];

/** Role of the deployment owning this repository instance. */
export type MaintenanceRole = 'central' | 'local';

interface PocketRecordRef {
  readonly id: string;
}

export class PocketbaseDatabaseMaintenanceRepository
  implements DatabaseMaintenanceRepository
{
  constructor(
    private readonly pb: PocketBase,
    private readonly maintenanceRole: MaintenanceRole = 'central',
  ) {}

  async clearFinancialData(): Promise<ClearedFinancialData> {
    const cleared: ClearedFinancialData = {
      transactions: 0,
      invoices: 0,
      recurrences: 0,
      cards: 0,
      accounts: 0,
      categories: 0,
      projects: 0,
    };

    const batch = this.pb.createBatch();

    for (const collection of CLEAR_ORDER) {
      const records = await this.listRecordIds(collection);
      cleared[collection] = records.length;
      for (const record of records) {
        batch.collection(collection).delete(record.id);
      }
    }

    const metadataCollections =
      this.maintenanceRole === 'central'
        ? CENTRAL_METADATA_CLEAR_ORDER
        : LOCAL_METADATA_CLEAR_ORDER;
    for (const collection of metadataCollections) {
      for (const record of await this.listRecordIds(collection)) {
        batch.collection(collection).delete(record.id);
      }
    }

    if (this.maintenanceRole === 'central') {
      await this.planCentralEpochRotation(batch);
    } else {
      await this.planLocalUnpair(batch);
    }

    await batch.send();
    return cleared;
  }

  /**
   * Central: increments the data epoch, rewinds the journal cursor to seq 0
   * with an empty head hash and clears the backfill marker, preserving
   * `serverInstanceId` and everything outside sync/finance (the owner).
   */
  private async planCentralEpochRotation(batch: BatchService): Promise<void> {
    const meta = (await this.pb
      .collection('obol_sync_meta')
      .getList(1, 1)) as unknown as { items: Array<Record<string, unknown>> };
    const row = meta.items[0];
    if (!row) {
      throw new Error(
        'obol_sync_meta is missing; a reset without a server identity is never valid',
      );
    }
    const dataEpoch = row['dataEpoch'];
    if (typeof dataEpoch !== 'number' || !Number.isInteger(dataEpoch) || dataEpoch < 1) {
      throw new Error(
        'obol_sync_meta carries a corrupt dataEpoch; the reset refuses to rotate a broken epoch',
      );
    }
    batch.collection('obol_sync_meta').update(String(row['id']), {
      dataEpoch: dataEpoch + 1,
      lastSeq: 0,
      headHash: SYNC_GENESIS_HASH,
      // The cleared base is fully journaled from genesis: mark it complete so
      // a later boot never restamps revisions of rows created after reset.
      journalBackfilledAt: new Date().toISOString(),
      journalBackfillVersion: BACKFILL_MARKER_VERSION,
    });
  }

  /**
   * Local: clears every pairing field on `obol_station_state` (queue,
   * conflicts and base versions are deleted above) while retaining the
   * durable station identity and rewinding cursor/epoch to standalone state.
   * An uncertain pending import is part of the cleared pairing state, never a
   * marker left behind to resume against a different server.
   */
  private async planLocalUnpair(batch: BatchService): Promise<void> {
    for (const state of await this.listRecordIds('obol_station_state')) {
      batch.collection('obol_station_state').update(state.id, {
        serverUrl: '',
        serverInstanceId: '',
        ownerFingerprint: '',
        cursor: 0,
        lastChainHash: '',
        dataEpoch: 0,
        protocolVersion: 1,
        mode: 'standalone',
        pendingImport: null,
        // `stationId` is deliberately preserved: the device identity is
        // durable even across unpairing.
      });
    }
  }

  /** Bounded id listing used only to build the reset batch (reads only). */
  private async listRecordIds(collection: string): Promise<PocketRecordRef[]> {
    const rows = (await this.pb
      .collection(collection)
      .getFullList({ fields: 'id' })) as unknown as Array<{ id: string }>;
    return rows.map((row) => ({ id: String(row.id) }));
  }
}
