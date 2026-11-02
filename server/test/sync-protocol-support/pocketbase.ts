// Guarded raw PocketBase access used only for isolation proof, synthetic
// fixture inspection and the deterministic atomic-batch probe.
//
// The order is deliberate: authenticate the raw SDK and read the deployment
// marker BEFORE the runner performs any dataset write. The marker is never
// patched here; if it is not the exact isolated value the runner exits before
// touching a row.

import PocketBase, { ClientResponseError } from 'pocketbase';

import { withTimeout } from './async';
import {
  EnvironmentGapError,
  ISOLATED_APP_NAME,
  IsolationRefusedError,
  type SyncHarnessConfig,
} from './config';

export const FINANCE_COLLECTIONS = [
  'accounts',
  'cards',
  'categories',
  'invoices',
  'projects',
  'recurrences',
  'transactions',
] as const;

export type FinanceCollection = (typeof FINANCE_COLLECTIONS)[number];

export interface MetaRow {
  readonly id: string;
  readonly instanceId: string;
  readonly dataEpoch: number;
  readonly protocolMin: number;
  readonly protocolMax: number;
  readonly cursor: number;
  readonly headHash: string;
}

export interface ServerState {
  readonly finance: Record<FinanceCollection, number>;
  readonly journalEvents: number;
  readonly versions: number;
  readonly operations: number;
  readonly importReceipts: number;
  readonly stations: number;
  readonly sessions: number;
  readonly cursor: number;
  readonly headHash: string;
  readonly instanceId: string | null;
  readonly dataEpoch: number | null;
  readonly protocolMin: number | null;
  readonly protocolMax: number | null;
  readonly metaPresent: boolean;
}

/** Validated JSON-object boundary: returns a record for non-array objects. */
function objectRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function statusSuffix(error: unknown): string {
  if (error instanceof ClientResponseError && typeof error.status === 'number') {
    return ` (SDK status ${error.status})`;
  }
  return '';
}

/**
 * Authenticates the raw SDK, reads `settings.meta.appName` and requires the
 * EXACT isolated marker. Any other marker refuses the run with exit code 2
 * before a write; an unreachable/misauthenticated PB is an environment gap.
 */
export async function connectGuardedPocketBase(
  config: SyncHarnessConfig,
): Promise<PocketBase> {
  const pb = new PocketBase(config.pbUrl);
  pb.autoCancellation(false);

  try {
    await withTimeout(
      pb.collection('_superusers').authWithPassword(
        config.pbAdminEmail,
        config.pbAdminPassword,
      ),
      config.ioTimeoutMs,
      'PocketBase superuser authentication',
    );
  } catch (error) {
    throw new EnvironmentGapError(
      `PocketBase superuser authentication failed${statusSuffix(error)}.`,
    );
  }

  let settings: unknown;
  try {
    settings = await withTimeout(
      pb.settings.getAll(),
      config.ioTimeoutMs,
      'PocketBase settings read',
    );
  } catch (error) {
    throw new EnvironmentGapError(
      `Could not read PocketBase settings${statusSuffix(error)}.`,
    );
  }

  const settingsBox = objectRecord(settings);
  const metaBox = objectRecord(settingsBox?.meta);
  const appName = metaBox?.appName;
  if (appName !== ISOLATED_APP_NAME) {
    throw new IsolationRefusedError(
      `Refusing to run: PocketBase meta.appName is ${JSON.stringify(appName)}; expected exactly ${JSON.stringify(ISOLATED_APP_NAME)}. No dataset write was attempted.`,
    );
  }
  return pb;
}

export async function countRows(
  pb: PocketBase,
  collection: string,
  timeoutMs: number,
): Promise<number> {
  const page = await withTimeout(
    pb.collection(collection).getList(1, 1, { fields: 'id' }),
    timeoutMs,
    `count ${collection}`,
  );
  const totalItems = objectRecord(page)?.totalItems;
  if (typeof totalItems !== 'number') {
    throw new EnvironmentGapError(
      `PocketBase did not return a totalItems count for "${collection}".`,
    );
  }
  return totalItems;
}

export async function listRows(
  pb: PocketBase,
  collection: string,
  options: {
    readonly filter?: string;
    readonly sort?: string;
  },
  timeoutMs: number,
): Promise<Array<Record<string, unknown>>> {
  const rows = (await withTimeout(
    pb.collection(collection).getFullList({
      ...(options.filter === undefined ? {} : { filter: options.filter }),
      ...(options.sort === undefined ? {} : { sort: options.sort }),
    }),
    timeoutMs,
    `list ${collection}`,
  )) as unknown as Array<Record<string, unknown>>;
  return rows;
}

export async function readRow(
  pb: PocketBase,
  collection: string,
  id: string,
  timeoutMs: number,
): Promise<Record<string, unknown> | null> {
  try {
    const row = await withTimeout(
      pb.collection(collection).getOne(id),
      timeoutMs,
      `read ${collection}/${id}`,
    );
    return row as unknown as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ClientResponseError && error.status === 404) {
      return null;
    }
    throw new EnvironmentGapError(
      `Could not read ${collection}/${id}${statusSuffix(error)}.`,
    );
  }
}

export async function updateRow(
  pb: PocketBase,
  collection: string,
  id: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<void> {
  try {
    await withTimeout(
      pb.collection(collection).update(id, body),
      timeoutMs,
      `update ${collection}/${id}`,
    );
  } catch (error) {
    throw new EnvironmentGapError(
      `Could not update ${collection}/${id}${statusSuffix(error)}.`,
    );
  }
}

function integerField(
  row: Record<string, unknown>,
  field: string,
  fallback: number,
): number {
  const value = row[field];
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}

export async function readMeta(
  pb: PocketBase,
  timeoutMs: number,
): Promise<MetaRow | null> {
  const rows = await listRows(pb, 'obol_sync_meta', {}, timeoutMs);
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new EnvironmentGapError(
      `obol_sync_meta carries ${rows.length} rows; the ledger is a singleton.`,
    );
  }
  const row = rows[0]!;
  const instanceId = row['serverInstanceId'];
  if (typeof instanceId !== 'string' || instanceId.length === 0) {
    throw new EnvironmentGapError(
      'obol_sync_meta carries no serverInstanceId.',
    );
  }
  return {
    id: String(row['id']),
    instanceId,
    dataEpoch: integerField(row, 'dataEpoch', 0),
    protocolMin: integerField(row, 'protocolMin', 0),
    protocolMax: integerField(row, 'protocolMax', 0),
    cursor: integerField(row, 'lastSeq', 0),
    headHash: typeof row['headHash'] === 'string' ? row['headHash'] : '',
  };
}

export async function readOwnerId(
  pb: PocketBase,
  timeoutMs: number,
): Promise<string | null> {
  const rows = await listRows(pb, 'owner', {}, timeoutMs);
  if (rows.length === 0) return null;
  const id = rows[0]!['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new EnvironmentGapError('The owner row carries no record id.');
  }
  return id;
}

export async function readServerState(
  pb: PocketBase,
  timeoutMs: number,
): Promise<ServerState> {
  const finance = {} as Record<FinanceCollection, number>;
  const counts = await Promise.all([
    ...FINANCE_COLLECTIONS.map((collection) =>
      countRows(pb, collection, timeoutMs),
    ),
    countRows(pb, 'obol_sync_changes', timeoutMs),
    countRows(pb, 'obol_sync_entity_versions', timeoutMs),
    countRows(pb, 'obol_sync_operations', timeoutMs),
    countRows(pb, 'obol_sync_snapshot_imports', timeoutMs),
    countRows(pb, 'obol_sync_stations', timeoutMs),
    countRows(pb, 'obol_sessions', timeoutMs),
  ]);
  FINANCE_COLLECTIONS.forEach((collection, index) => {
    finance[collection] = counts[index]!;
  });
  let offset = FINANCE_COLLECTIONS.length;
  const journalEvents = counts[offset++]!;
  const versions = counts[offset++]!;
  const operations = counts[offset++]!;
  const importReceipts = counts[offset++]!;
  const stations = counts[offset++]!;
  const sessions = counts[offset++]!;
  const meta = await readMeta(pb, timeoutMs);
  return {
    finance,
    journalEvents,
    versions,
    operations,
    importReceipts,
    stations,
    sessions,
    cursor: meta?.cursor ?? 0,
    headHash: meta?.headHash ?? '',
    instanceId: meta?.instanceId ?? null,
    dataEpoch: meta?.dataEpoch ?? null,
    protocolMin: meta?.protocolMin ?? null,
    protocolMax: meta?.protocolMax ?? null,
    metaPresent: meta !== null,
  };
}

export async function findVersion(
  pb: PocketBase,
  entityType: string,
  entityId: string,
  timeoutMs: number,
): Promise<{ revision: number; deleted: boolean } | null> {
  const rows = await listRows(
    pb,
    'obol_sync_entity_versions',
    {
      filter: `entityType = '${entityType}' && entityId = '${entityId}'`,
    },
    timeoutMs,
  );
  if (rows.length === 0) return null;
  if (rows.length !== 1) {
    throw new EnvironmentGapError(
      `The version ledger repeats ${entityType}:${entityId}.`,
    );
  }
  const row = rows[0]!;
  const revision = row['revision'];
  if (typeof revision !== 'number' || !Number.isInteger(revision)) {
    throw new EnvironmentGapError(
      `The version ledger row ${entityType}:${entityId} has no integer revision.`,
    );
  }
  return { revision, deleted: row['deleted'] === true };
}

const PROBE_ENTITY_ID = 'zzatomicprobe01';
const PROBE_ACCOUNT_ID = 'zzatomicacct001';

/**
 * Proves PocketBase rejects ONE constrained batch atomically across a
 * financial row plus its sync metadata row, using the unique
 * (entityType, entityId) index from migration 1700000020.
 *
 * The product seed/import path is source-verified to use one
 * `pb.createBatch()` for finance rows, revisions, journal, meta and receipt; a
 * mid-commit process kill is NOT exercised because the producer exposes no
 * fault injection. This probe proves the PB primitive, not the product batch.
 */
export async function probeBatchAtomicity(
  pb: PocketBase,
  timeoutMs: number,
): Promise<string> {
  const versions = 'obol_sync_entity_versions';
  const versionFilter = `entityType = 'account' && entityId = '${PROBE_ENTITY_ID}'`;
  const readVersionIds = async (): Promise<string[]> => {
    const rows = await listRows(pb, versions, { filter: versionFilter }, timeoutMs);
    return rows.map((row) => String(row['id']));
  };
  const accountExists = async (): Promise<boolean> => {
    try {
      await withTimeout(
        pb.collection('accounts').getOne(PROBE_ACCOUNT_ID),
        timeoutMs,
        'read probe account',
      );
      return true;
    } catch (error) {
      if (error instanceof ClientResponseError && error.status === 404) {
        return false;
      }
      throw new EnvironmentGapError(
        `Could not read the probe account${statusSuffix(error)}.`,
      );
    }
  };
  const cleanup = async (): Promise<void> => {
    const ids = await readVersionIds();
    if (ids.length > 0) {
      const batch = pb.createBatch();
      for (const id of ids) batch.collection(versions).delete(id);
      await withTimeout(batch.send(), timeoutMs, 'delete probe versions');
    }
    if (await accountExists()) {
      await withTimeout(
        pb.collection('accounts').delete(PROBE_ACCOUNT_ID),
        timeoutMs,
        'delete probe account',
      );
    }
  };

  const versionBody = {
    entityType: 'account',
    entityId: PROBE_ENTITY_ID,
    revision: 1,
    deleted: false,
    lastSeq: 0,
  };
  const accountBody = {
    id: PROBE_ACCOUNT_ID,
    name: 'Atomicity Probe',
    type: 'checking',
    initial_balance: 1,
  };

  await cleanup();

  try {
    const control = pb.createBatch();
    control.collection('accounts').create(accountBody);
    control.collection(versions).create(versionBody);
    await withTimeout(control.send(), timeoutMs, 'batch probe control write');
  } catch (error) {
    await cleanup();
    throw new EnvironmentGapError(
      `The financial+metadata batch probe control write was rejected${statusSuffix(error)}; atomicity is not proven.`,
    );
  }
  const controlVersionIds = await readVersionIds();
  if (!(await accountExists()) || controlVersionIds.length !== 1) {
    await cleanup();
    throw new EnvironmentGapError(
      'The probe control batch did not persist both the financial row and its metadata row.',
    );
  }
  await cleanup();

  let rejected = false;
  try {
    const duplicate = pb.createBatch();
    duplicate.collection('accounts').create(accountBody);
    duplicate.collection(versions).create(versionBody);
    duplicate.collection(versions).create({ ...versionBody, revision: 2 });
    await withTimeout(duplicate.send(), timeoutMs, 'financial+metadata constraint probe');
  } catch (error) {
    if (
      !(error instanceof ClientResponseError) ||
      (error.status !== 400 && error.status !== 409)
    ) {
      await cleanup();
      throw new EnvironmentGapError(
        `The financial+metadata probe did not receive a PocketBase validation rejection${statusSuffix(error)}.`,
      );
    }
    rejected = true;
  }

  const residueVersions = await readVersionIds();
  const residueAccount = await accountExists();
  await cleanup();
  if (!rejected) {
    throw new EnvironmentGapError(
      'PocketBase accepted a batch with a duplicate unique key; the unique indexes are not active.',
    );
  }
  if (residueVersions.length > 0 || residueAccount) {
    throw new EnvironmentGapError(
      'The rejected financial+metadata batch left residue; PocketBase batch atomicity is not proven.',
    );
  }
  return 'financial row plus duplicate metadata constraint rejected atomically by PocketBase';
}
