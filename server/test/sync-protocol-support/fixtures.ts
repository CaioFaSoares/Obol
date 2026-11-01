// Declared synthetic financial inputs for the hosted sync acceptance runner.
//
// These rows are INPUT fixtures, not a business model: the seed/import paths
// must store them byte-for-byte (IDs, statuses, realized dates, paid amounts)
// without recomputing balances, invoices or histories. Every operation case
// afterwards goes through the real HTTP use cases.
//
// Values are intentionally explicit:
// - seed: one checking account with 950, one card, one invoice gross 120 /
//   paid 50 / debt 70, a realized purchase 50 and a pending 70 line;
// - populated import: a second profile with fresh ids, account 950 and invoice
//   gross 200 / paid 50 (partial) plus paid, silent and pending history;
// - empty-context import: 501 rows in one commit (six parents plus 495
//   pending card lines) so a pull page must return more than 500 events;
// - native DTO import: the same shape plus the optional created/updated dates
//   the Swift FinancialSnapshot encodes.

import { fixedEntityId } from './canonical';

export type JsonRecord = Record<string, unknown>;

export interface Snapshot {
  readonly accounts: readonly JsonRecord[];
  readonly cards: readonly JsonRecord[];
  readonly categories: readonly JsonRecord[];
  readonly projects: readonly JsonRecord[];
  readonly recurrences: readonly JsonRecord[];
  readonly invoices: readonly JsonRecord[];
  readonly transactions: readonly JsonRecord[];
}

/** Commit ordering used by the server: entity type order, id order. */
export const SNAPSHOT_ENTITY_ORDER = [
  'account',
  'card',
  'category',
  'invoice',
  'project',
  'recurrence',
  'transaction',
] as const;

export const ENTITY_COLLECTION: Readonly<Record<string, keyof Snapshot>> = {
  account: 'accounts',
  card: 'cards',
  category: 'categories',
  invoice: 'invoices',
  project: 'projects',
  recurrence: 'recurrences',
  transaction: 'transactions',
};

export const SEED_IDS = {
  account: fixedEntityId('seedacc', 1),
  card: fixedEntityId('seedcard', 1),
  category: fixedEntityId('seedcat', 1),
  project: fixedEntityId('seedprj', 1),
  recurrence: fixedEntityId('seedrec', 1),
  invoice: fixedEntityId('seedinv', 1),
  paidTransaction: fixedEntityId('seedtxn', 1),
  silentTransaction: fixedEntityId('seedtxn', 2),
} as const;

export const SEED_SNAPSHOT: Snapshot = {
  accounts: [
    {
      id: SEED_IDS.account,
      name: 'Seed Cash',
      type: 'checking',
      initial_balance: 950,
    },
  ],
  cards: [
    {
      id: SEED_IDS.card,
      name: 'Seed Card',
      closing_day: 15,
      due_day: 25,
      limit: 2000,
    },
  ],
  categories: [
    {
      id: SEED_IDS.category,
      name: 'Seed Variable',
      type: 'variable',
      monthly_budget: 100,
    },
  ],
  projects: [
    {
      id: SEED_IDS.project,
      name: 'Seed Project',
      total_value: 5000,
      status: 'active',
    },
  ],
  recurrences: [
    {
      id: SEED_IDS.recurrence,
      name: 'Seed Rent',
      amount: 100,
      payday: 5,
      type: 'expense',
      status: 'paused',
      account_id: SEED_IDS.account,
      category_id: SEED_IDS.category,
    },
  ],
  invoices: [
    {
      id: SEED_IDS.invoice,
      card_id: SEED_IDS.card,
      period: '2026-02',
      due_date: '2026-02-10',
      status: 'CLOSED',
      total_amount: 120,
      paid_amount: 50,
    },
  ],
  transactions: [
    {
      id: SEED_IDS.paidTransaction,
      title: 'Seed Card Purchase Paid',
      amount: 50,
      type: 'expense',
      status: 'realized',
      expected_date: '2026-02-10T00:00:00.000Z',
      realized_date: '2026-02-10T10:00:00.000Z',
      purchase_date: '2026-01-20T00:00:00.000Z',
      is_silent: false,
      card_id: SEED_IDS.card,
      invoice_id: SEED_IDS.invoice,
    },
    {
      id: SEED_IDS.silentTransaction,
      title: 'Seed Outstanding Seventy',
      amount: 70,
      type: 'expense',
      status: 'pending',
      expected_date: '2026-02-10T00:00:00.000Z',
      purchase_date: '2026-01-20T00:00:00.000Z',
      card_id: SEED_IDS.card,
      invoice_id: SEED_IDS.invoice,
    },
  ],
};

export const IMPORT_IDS = {
  account: fixedEntityId('impacc', 1),
  card: fixedEntityId('impcard', 1),
  category: fixedEntityId('impcat', 1),
  project: fixedEntityId('impprj', 1),
  recurrence: fixedEntityId('imprec', 1),
  invoice: fixedEntityId('impinv', 1),
  paidTransaction: fixedEntityId('imptxn', 1),
  silentTransaction: fixedEntityId('imptxn', 2),
  pendingTransaction: fixedEntityId('imptxn', 3),
} as const;

export const IMPORT_SNAPSHOT: Snapshot = {
  accounts: [
    {
      id: IMPORT_IDS.account,
      name: 'Imported Cash',
      type: 'checking',
      initial_balance: 950,
    },
  ],
  cards: [
    {
      id: IMPORT_IDS.card,
      name: 'Imported Card',
      closing_day: 15,
      due_day: 25,
      limit: 3000,
    },
  ],
  categories: [
    {
      id: IMPORT_IDS.category,
      name: 'Imported Variable',
      type: 'variable',
      monthly_budget: 250,
    },
  ],
  projects: [
    {
      id: IMPORT_IDS.project,
      name: 'Imported Project',
      total_value: 7000,
      status: 'active',
    },
  ],
  recurrences: [
    {
      id: IMPORT_IDS.recurrence,
      name: 'Imported Gym',
      amount: 80,
      payday: 10,
      type: 'expense',
      status: 'paused',
      account_id: IMPORT_IDS.account,
      category_id: IMPORT_IDS.category,
    },
  ],
  invoices: [
    {
      id: IMPORT_IDS.invoice,
      card_id: IMPORT_IDS.card,
      period: '2026-03',
      due_date: '2026-03-10',
      status: 'CLOSED',
      total_amount: 200,
      paid_amount: 50,
    },
  ],
  transactions: [
    {
      id: IMPORT_IDS.paidTransaction,
      title: 'Imported Paid Fifty',
      amount: 50,
      type: 'expense',
      status: 'realized',
      expected_date: '2026-03-10T00:00:00.000Z',
      realized_date: '2026-03-10T10:00:00.000Z',
      purchase_date: '2026-02-20T00:00:00.000Z',
      is_silent: false,
      card_id: IMPORT_IDS.card,
      invoice_id: IMPORT_IDS.invoice,
    },
    {
      id: IMPORT_IDS.silentTransaction,
      title: 'Imported Silent One Hundred',
      amount: 100,
      type: 'expense',
      status: 'realized',
      expected_date: '2026-03-10T00:00:00.000Z',
      realized_date: '2026-03-10T10:00:00.000Z',
      purchase_date: '2026-02-20T00:00:00.000Z',
      is_silent: true,
      card_id: IMPORT_IDS.card,
      invoice_id: IMPORT_IDS.invoice,
    },
    {
      id: IMPORT_IDS.pendingTransaction,
      title: 'Imported Pending Fifty',
      amount: 50,
      type: 'expense',
      status: 'pending',
      expected_date: '2026-03-10T00:00:00.000Z',
      purchase_date: '2026-02-20T00:00:00.000Z',
      card_id: IMPORT_IDS.card,
      invoice_id: IMPORT_IDS.invoice,
    },
  ],
};

export const EMPTY_IMPORT_IDS = {
  account: fixedEntityId('empacc', 1),
  card: fixedEntityId('empcard', 1),
  category: fixedEntityId('empcat', 1),
  project: fixedEntityId('empprj', 1),
  recurrence: fixedEntityId('emprc', 1),
  invoice: fixedEntityId('empinv', 1),
} as const;

/**
 * One complete seven-collection snapshot with 501 rows: six parent rows plus
 * 495 pending card purchases that all reference the same card and invoice.
 * Importing it is one real explicit operation whose single commit group
 * exceeds the pull `limit` maximum (500), so the whole group must be returned
 * by one page.
 */
const EMPTY_IMPORT_BULK_TRANSACTIONS: JsonRecord[] = Array.from(
  { length: 495 },
  (_, index) => ({
    id: fixedEntityId('emptxn', index + 1),
    title: `Empty Context Bulk ${index + 1}`,
    amount: 1,
    type: 'expense',
    status: 'pending',
    expected_date: '2026-05-01T00:00:00.000Z',
    purchase_date: '2026-05-01T00:00:00.000Z',
    card_id: EMPTY_IMPORT_IDS.card,
    invoice_id: EMPTY_IMPORT_IDS.invoice,
  }),
);

export const EMPTY_IMPORT_SNAPSHOT: Snapshot = {
  accounts: [
    {
      id: EMPTY_IMPORT_IDS.account,
      name: 'Empty Context Savings',
      type: 'savings',
      initial_balance: 500,
    },
  ],
  cards: [
    {
      id: EMPTY_IMPORT_IDS.card,
      name: 'Empty Context Card',
      closing_day: 20,
      due_day: 5,
      limit: 1000,
    },
  ],
  categories: [
    {
      id: EMPTY_IMPORT_IDS.category,
      name: 'Empty Context Category',
      type: 'variable',
      monthly_budget: 10,
    },
  ],
  projects: [
    {
      id: EMPTY_IMPORT_IDS.project,
      name: 'Empty Context Project',
      total_value: 100,
      status: 'active',
    },
  ],
  recurrences: [
    {
      id: EMPTY_IMPORT_IDS.recurrence,
      name: 'Empty Context Paused',
      amount: 5,
      payday: 28,
      type: 'expense',
      status: 'paused',
      account_id: EMPTY_IMPORT_IDS.account,
      category_id: EMPTY_IMPORT_IDS.category,
    },
  ],
  invoices: [
    {
      id: EMPTY_IMPORT_IDS.invoice,
      card_id: EMPTY_IMPORT_IDS.card,
      period: '2026-05',
      due_date: '2026-05-05',
      status: 'OPEN',
      total_amount: 495,
      paid_amount: 0,
    },
  ],
  transactions: EMPTY_IMPORT_BULK_TRANSACTIONS,
};


/**
 * The same seven-collection shape as the native `FinancialSnapshot`, which
 * encodes optional `created`/`updated` dates on every record. The snapshot
 * validator currently rejects any row field outside its declared set, so this
 * is sent unchanged and the response is reported instead of stripping the
 * fields to force a pass.
 */
export const CLIENT_DTO_IMPORT_IDS = {
  account: fixedEntityId('dtoacc', 1),
  card: fixedEntityId('dtocard', 1),
  category: fixedEntityId('dtocat', 1),
  project: fixedEntityId('dtoprj', 1),
  recurrence: fixedEntityId('dtorec', 1),
  invoice: fixedEntityId('dtoinv', 1),
  transaction: fixedEntityId('dtotxn', 1),
} as const;

const DTO_CREATED = '2026-01-01T00:00:00.000Z';
const DTO_UPDATED = '2026-01-02T00:00:00.000Z';

function withStorageDates(row: JsonRecord): JsonRecord {
  return { ...row, created: DTO_CREATED, updated: DTO_UPDATED };
}

export const CLIENT_DTO_IMPORT_SNAPSHOT: Snapshot = {
  accounts: [
    withStorageDates({
      id: CLIENT_DTO_IMPORT_IDS.account,
      name: 'Client DTO Cash',
      type: 'checking',
      initial_balance: 700,
    }),
  ],
  cards: [
    withStorageDates({
      id: CLIENT_DTO_IMPORT_IDS.card,
      name: 'Client DTO Card',
      closing_day: 10,
      due_day: 20,
      limit: 800,
    }),
  ],
  categories: [
    withStorageDates({
      id: CLIENT_DTO_IMPORT_IDS.category,
      name: 'Client DTO Category',
      type: 'variable',
      monthly_budget: 20,
    }),
  ],
  projects: [
    withStorageDates({
      id: CLIENT_DTO_IMPORT_IDS.project,
      name: 'Client DTO Project',
      total_value: 200,
      status: 'active',
    }),
  ],
  recurrences: [
    withStorageDates({
      id: CLIENT_DTO_IMPORT_IDS.recurrence,
      name: 'Client DTO Paused',
      amount: 6,
      payday: 27,
      type: 'expense',
      status: 'paused',
      account_id: CLIENT_DTO_IMPORT_IDS.account,
      category_id: CLIENT_DTO_IMPORT_IDS.category,
    }),
  ],
  invoices: [
    withStorageDates({
      id: CLIENT_DTO_IMPORT_IDS.invoice,
      card_id: CLIENT_DTO_IMPORT_IDS.card,
      period: '2026-06',
      due_date: '2026-06-20',
      status: 'OPEN',
      total_amount: 30,
      paid_amount: 0,
    }),
  ],
  transactions: [
    withStorageDates({
      id: CLIENT_DTO_IMPORT_IDS.transaction,
      title: 'Client DTO Pending',
      amount: 30,
      type: 'expense',
      status: 'pending',
      expected_date: '2026-06-01T00:00:00.000Z',
      purchase_date: '2026-06-01T00:00:00.000Z',
      card_id: CLIENT_DTO_IMPORT_IDS.card,
      invoice_id: CLIENT_DTO_IMPORT_IDS.invoice,
    }),
  ],
};

export interface FlattenedRow {
  readonly entityType: (typeof SNAPSHOT_ENTITY_ORDER)[number];
  readonly collection: keyof Snapshot;
  readonly id: string;
  readonly record: JsonRecord;
}

/** Flattens a snapshot in the server's commit order. */
export function flattenSnapshot(snapshot: Snapshot): FlattenedRow[] {
  const rows: FlattenedRow[] = [];
  for (const entityType of SNAPSHOT_ENTITY_ORDER) {
    const collection = ENTITY_COLLECTION[entityType]!;
    const records = [...snapshot[collection]];
    records.sort((left, right) =>
      String(left.id).localeCompare(String(right.id)),
    );
    for (const record of records) {
      const id = record.id;
      if (typeof id !== 'string') {
        throw new TypeError('A snapshot row carries no string id.');
      }
      rows.push({ entityType, collection, id, record });
    }
  }
  return rows;
}

/**
 * Throws when one collection of `snapshot` repeats an id, naming the snapshot,
 * the collection and the duplicated id. The exported snapshots are checked at
 * module load, so an id-encoding regression fails here instead of arriving as a
 * server rejection of the whole import.
 */
export function assertUniqueSnapshotIds(
  label: string,
  snapshot: Snapshot,
): void {
  for (const entityType of SNAPSHOT_ENTITY_ORDER) {
    const collection = ENTITY_COLLECTION[entityType]!;
    const seen = new Set<string>();
    for (const record of snapshot[collection]) {
      const id = record.id;
      if (typeof id !== 'string') {
        throw new TypeError(
          `The ${label} snapshot ${collection} row carries no string id.`,
        );
      }
      if (seen.has(id)) {
        throw new TypeError(
          `The ${label} snapshot collection "${collection}" repeats the id "${id}".`,
        );
      }
      seen.add(id);
    }
  }
}

assertUniqueSnapshotIds('seed', SEED_SNAPSHOT);
assertUniqueSnapshotIds('populated import', IMPORT_SNAPSHOT);
assertUniqueSnapshotIds('empty-context import', EMPTY_IMPORT_SNAPSHOT);
assertUniqueSnapshotIds('client DTO import', CLIENT_DTO_IMPORT_SNAPSHOT);

export function snapshotRowCount(snapshot: Snapshot): number {
  return flattenSnapshot(snapshot).length;
}

export function cloneSnapshot(snapshot: Snapshot): Snapshot {
  return structuredClone(snapshot) as Snapshot;
}

/** Returns a clone with the first account's `name` set to the given value. */
export function withFirstAccountName(
  snapshot: Snapshot,
  name: string,
): Snapshot {
  if (snapshot.accounts.length === 0) {
    throw new TypeError('The snapshot carries no first account.');
  }
  return {
    ...cloneSnapshot(snapshot),
    accounts: snapshot.accounts.map((row, index) =>
      index === 0 ? { ...row, name } : row,
    ),
  };
}

/** Returns a clone with the first recurrence's `account_id` set to the given id. */
export function withRecurrenceAccount(
  snapshot: Snapshot,
  accountId: string,
): Snapshot {
  if (snapshot.recurrences.length === 0) {
    throw new TypeError('The snapshot carries no first recurrence.');
  }
  return {
    ...cloneSnapshot(snapshot),
    recurrences: snapshot.recurrences.map((row, index) =>
      index === 0 ? { ...row, account_id: accountId } : row,
    ),
  };
}

/** Replaces the account id of one snapshot and every declared reference. */
export function replaceAccountIdAt(
  snapshot: Snapshot,
  oldId: string,
  newId: string,
): Snapshot {
  return {
    ...snapshot,
    accounts: snapshot.accounts.map((row) =>
      row.id === oldId ? { ...row, id: newId } : row,
    ),
    recurrences: snapshot.recurrences.map((row) => ({
      ...row,
      ...(row.account_id === oldId ? { account_id: newId } : {}),
    })),
    transactions: snapshot.transactions.map((row) => ({
      ...row,
      ...(row.account_id === oldId ? { account_id: newId } : {}),
      ...(row.destination_account_id === oldId
        ? { destination_account_id: newId }
        : {}),
    })),
  };
}
