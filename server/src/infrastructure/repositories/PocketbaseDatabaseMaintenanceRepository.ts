import type PocketBase from 'pocketbase';
import type {
  ClearedFinancialData,
  DatabaseMaintenanceRepository,
} from '../../domain/interfaces/DatabaseMaintenanceRepository';

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

const DELETE_BATCH_SIZE = 20;

export class PocketbaseDatabaseMaintenanceRepository implements DatabaseMaintenanceRepository {
  constructor(private readonly pb: PocketBase) {}

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

    for (const collection of CLEAR_ORDER) {
      const records = await this.pb.collection(collection).getFullList<{ id: string }>({
        fields: 'id',
      });

      for (let offset = 0; offset < records.length; offset += DELETE_BATCH_SIZE) {
        const batch = records.slice(offset, offset + DELETE_BATCH_SIZE);
        await Promise.all(
          batch.map((record) => this.pb.collection(collection).delete(record.id)),
        );
      }

      cleared[collection] = records.length;
    }

    return cleared;
  }
}
