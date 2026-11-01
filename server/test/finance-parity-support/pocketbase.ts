// Isolated-PocketBase guard, case seeding, cleanup and snapshot reads.
//
// The runner refuses to write anywhere except a database whose settings carry
// the exact parity appName. All persistence calls are bounded and serial.

import PocketBase, { ClientResponseError } from 'pocketbase';

import { syncRevisionKey, type SyncRevisionKey } from '../../src/domain/sync/SyncRevision';
import { createContainer } from '../../src/infrastructure/di/container';
import { createPocketBaseClient } from '../../src/infrastructure/plugins/pocketbase';
import { PocketbaseSyncRepository } from '../../src/infrastructure/repositories/PocketbaseSyncRepository';
import { isPlainObject, mapRecordForStorage } from './canonical';
import { withTimeout } from './timeout';
import {
  CLEAR_FINANCE_ORDER,
  COLLECTION_NAMES,
  ISOLATED_APP_NAME,
  SEED_ORDER,
  SYNC_COLLECTIONS,
  SYNC_ENTITY_BY_COLLECTION,
  type CollectionName,
  type RawRecord,
  type RawSnapshot,
  type RuntimeConfig,
} from './types';

const MAX_CLEAR_ROWS = 1000;
const MAX_SEED_RECORDS = 200;
const PROBE_ENTITY_ID = 'zzparityprobe01';

export class IsolationRefusedError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, message: string) {
    super(message);
    this.name = 'IsolationRefusedError';
    this.exitCode = exitCode;
  }
}

export class EnvironmentGapError extends Error {
  readonly exitCode: number;

  constructor(exitCode: number, message: string) {
    super(message);
    this.name = 'EnvironmentGapError';
    this.exitCode = exitCode;
  }
}

function parseTimeout(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    throw new IsolationRefusedError(
      2,
      `${key} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  const value = Number(text);
  if (value < minimum || value > maximum) {
    throw new IsolationRefusedError(
      2,
      `${key} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

export function readRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  if (env.OBOL_PARITY_ISOLATED !== '1') {
    throw new IsolationRefusedError(
      2,
      'Refusing to run: set OBOL_PARITY_ISOLATED=1 only for the dedicated parity database.',
    );
  }

  const url = (env.POCKETBASE_URL ?? '').trim();
  const adminEmail = env.PB_ADMIN_EMAIL ?? '';
  const adminPassword = env.PB_ADMIN_PASSWORD ?? '';
  if (url.length === 0 || adminEmail.length === 0 || adminPassword.length === 0) {
    throw new IsolationRefusedError(
      2,
      'Refusing to run: POCKETBASE_URL, PB_ADMIN_EMAIL and PB_ADMIN_PASSWORD are required.',
    );
  }
  try {
    new URL(url);
  } catch {
    throw new IsolationRefusedError(2, 'Refusing to run: POCKETBASE_URL must be an absolute URL.');
  }

  const fixturesDir = (env.OBOL_PARITY_FIXTURES_DIR ?? '').trim();

  return {
    url,
    adminEmail,
    adminPassword,
    ioTimeoutMs: parseTimeout(env, 'OBOL_PARITY_IO_TIMEOUT_MS', 20_000, 1_000, 300_000),
    commandTimeoutMs: parseTimeout(
      env,
      'OBOL_PARITY_COMMAND_TIMEOUT_MS',
      120_000,
      5_000,
      3_600_000,
    ),
    ...(fixturesDir.length > 0 ? { fixturesDir } : {}),
  };
}

/** Prints only the datasource origin; any URL userinfo is removed. */
export function displayDatasource(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

/** Removes the configured credentials from any text the runner prints. */
export function redactSecrets(text: string, config: RuntimeConfig): string {
  const secrets = [config.adminPassword, config.adminEmail]
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length);
  let output = text;
  for (const secret of secrets) {
    output = output.split(secret).join('[redacted]');
  }
  return output;
}

function statusSuffix(error: unknown): string {
  if (error instanceof ClientResponseError && typeof error.status === 'number') {
    return ` (SDK status ${error.status})`;
  }
  return '';
}

/**
 * Renders a PocketBase rejection's own response details: request URL,
 * server message, and per-field validation errors. PocketBase response
 * bodies are server-generated and carry no credential material.
 */
export function describePbError(error: unknown): string {
  if (!(error instanceof ClientResponseError)) return '';
  const response = isPlainObject(error.response) ? error.response : {};
  const segments: string[] = [];
  if (typeof error.url === 'string' && error.url.length > 0) {
    segments.push(`request ${error.url}`);
  }
  if (typeof response['message'] === 'string' && response['message'].length > 0) {
    segments.push(`server message: ${response['message']}`);
  }
  const data = response['data'];
  if (isPlainObject(data)) {
    for (const [field, issue] of Object.entries(data)) {
      if (isPlainObject(issue) && typeof issue['message'] === 'string') {
        const code = typeof issue['code'] === 'string' ? ` (${issue['code']})` : '';
        segments.push(`field ${field}: ${issue['message']}${code}`);
      } else if (typeof issue === 'string' || typeof issue === 'number') {
        segments.push(`field ${field}: ${String(issue)}`);
      }
    }
  } else if (data !== undefined && data !== null) {
    try {
      segments.push(`server data: ${JSON.stringify(data)}`);
    } catch {
      segments.push('server data: <unserializable>');
    }
  }
  return segments.length > 0 ? ` [${segments.join('; ')}]` : '';
}

export async function connectIsolatedPocketBase(
  config: RuntimeConfig,
): Promise<PocketBase> {
  const guard = new PocketBase(config.url);
  guard.autoCancellation(false);

  try {
    await withTimeout(
      guard.collection('_superusers').authWithPassword(
        config.adminEmail,
        config.adminPassword,
      ),
      config.ioTimeoutMs,
      'PocketBase superuser authentication',
    );
  } catch (error) {
    throw new EnvironmentGapError(
      3,
      `PocketBase superuser authentication failed${statusSuffix(error)}.`,
    );
  }

  let settings: unknown;
  try {
    settings = await withTimeout(
      guard.settings.getAll(),
      config.ioTimeoutMs,
      'PocketBase settings read',
    );
  } catch (error) {
    throw new EnvironmentGapError(
      3,
      `Could not read PocketBase settings${statusSuffix(error)}.`,
    );
  }

  const meta = isPlainObject(settings) ? settings.meta : undefined;
  const appName = isPlainObject(meta) ? meta.appName : undefined;
  if (appName !== ISOLATED_APP_NAME) {
    throw new IsolationRefusedError(
      2,
      `Refusing to run: PocketBase meta.appName is ${JSON.stringify(appName)}; expected exactly ${JSON.stringify(ISOLATED_APP_NAME)}. No dataset write was attempted.`,
    );
  }

  // The product client applies and verifies the atomic-batch capability before
  // it is returned. This runs only after the appName guard has passed.
  try {
    return await withTimeout(
      createPocketBaseClient({
        url: config.url,
        adminEmail: config.adminEmail,
        adminPassword: config.adminPassword,
        retries: 3,
        retryDelayMs: 1000,
      }),
      config.commandTimeoutMs,
      'product PocketBase client',
    );
  } catch (error) {
    throw new EnvironmentGapError(
      3,
      `The product PocketBase client could not verify the atomic-batch capability${statusSuffix(error)}.`,
    );
  }
}

const REQUIRED_COLLECTIONS: readonly string[] = [
  ...COLLECTION_NAMES,
  ...SYNC_COLLECTIONS,
];

export async function requireCollections(
  pb: PocketBase,
  timeoutMs: number,
): Promise<void> {
  const missing: string[] = [];
  for (const name of REQUIRED_COLLECTIONS) {
    try {
      await withTimeout(
        pb.collections.getOne(name),
        timeoutMs,
        `collection ${name}`,
      );
    } catch (error) {
      if (error instanceof ClientResponseError && error.status === 404) {
        missing.push(name);
        continue;
      }
      throw new EnvironmentGapError(
        3,
        `Could not verify PocketBase collection "${name}"${statusSuffix(error)}.`,
      );
    }
  }
  if (missing.length > 0) {
    throw new EnvironmentGapError(
      3,
      `Missing PocketBase collections: ${missing.join(', ')}. Apply db/pb_migrations before running the parity suite.`,
    );
  }
}

async function readCollectionRows(
  pb: PocketBase,
  collection: string,
  timeoutMs: number,
): Promise<Array<{ id: string }>> {
  const rows = (await withTimeout(
    pb.collection(collection).getFullList({ fields: 'id' }),
    timeoutMs,
    `read ${collection} ids`,
  )) as unknown[];
  return rows.map((row) => {
    const id = isPlainObject(row) ? row.id : undefined;
    return { id: typeof id === 'string' ? id : '' };
  });
}

async function deleteRows(
  pb: PocketBase,
  collection: string,
  ids: readonly string[],
  timeoutMs: number,
): Promise<void> {
  if (ids.length === 0) return;
  const batch = pb.createBatch();
  for (const id of ids) {
    batch.collection(collection).delete(id);
  }
  await withTimeout(batch.send(), timeoutMs, `delete ${collection} rows`);
}

async function clearCollection(
  pb: PocketBase,
  collection: string,
  timeoutMs: number,
): Promise<void> {
  const rows = await readCollectionRows(pb, collection, timeoutMs);
  if (rows.length > MAX_CLEAR_ROWS) {
    throw new EnvironmentGapError(
      3,
      `Refusing to clear ${rows.length} rows from "${collection}"; the runner expects its own small isolated dataset (bound ${MAX_CLEAR_ROWS}).`,
    );
  }
  await deleteRows(
    pb,
    collection,
    rows.map((row) => row.id).filter((id) => id.length > 0),
    timeoutMs,
  );
}

export async function clearFinancialAndSync(
  pb: PocketBase,
  timeoutMs: number,
): Promise<void> {
  const order: readonly string[] = [...CLEAR_FINANCE_ORDER, ...SYNC_COLLECTIONS];
  for (const collection of order) {
    await clearCollection(pb, collection, timeoutMs);
  }
}

/**
 * Proves PocketBase rejects a constrained batch atomically, using the unique
 * (entityType, entityId) index from migration 1700000020. No schema artifact is
 * created and no finance row is touched.
 */
export async function probeBatchAtomicity(
  pb: PocketBase,
  timeoutMs: number,
): Promise<string> {
  const collection = 'obol_sync_entity_versions';
  const filter = `entityType = 'account' && entityId = '${PROBE_ENTITY_ID}'`;
  const readProbeRows = async (): Promise<Array<{ id: string }>> => {
    const rows = (await withTimeout(
      pb.collection(collection).getFullList({ filter, fields: 'id' }),
      timeoutMs,
      'read batch-probe rows',
    )) as unknown[];
    return rows.map((row) => ({
      id: isPlainObject(row) && typeof row.id === 'string' ? row.id : '',
    }));
  };

  const residueBefore = await readProbeRows();
  await deleteRows(
    pb,
    collection,
    residueBefore.map((row) => row.id).filter((id) => id.length > 0),
    timeoutMs,
  );

  const body = {
    entityType: 'account',
    entityId: PROBE_ENTITY_ID,
    revision: 1,
    deleted: false,
    lastSeq: 0,
  };

  // Control write: proves the payload and the collection schema accept this
  // batch shape, so the only reason the next batch can fail is the duplicate
  // unique key.
  try {
    const control = pb.createBatch();
    control.collection(collection).create(body);
    await withTimeout(control.send(), timeoutMs, 'batch probe control write');
  } catch (error) {
    throw new EnvironmentGapError(
      3,
      `The batch probe control write was rejected${statusSuffix(error)}; atomicity is not proven.`,
    );
  }

  const controlRows = await readProbeRows();
  if (controlRows.length !== 1) {
    await deleteRows(
      pb,
      collection,
      controlRows.map((row) => row.id).filter((id) => id.length > 0),
      timeoutMs,
    );
    throw new EnvironmentGapError(
      3,
      `The batch probe control write produced ${controlRows.length} row(s) instead of one; atomicity is not proven.`,
    );
  }
  await deleteRows(
    pb,
    collection,
    controlRows.map((row) => row.id).filter((id) => id.length > 0),
    timeoutMs,
  );

  let rejected = false;
  try {
    const duplicate = pb.createBatch();
    duplicate.collection(collection).create(body);
    duplicate.collection(collection).create({ ...body, revision: 2 });
    await withTimeout(duplicate.send(), timeoutMs, 'batch constraint-failure probe');
  } catch (error) {
    if (
      !(error instanceof ClientResponseError) ||
      (error.status !== 400 && error.status !== 409)
    ) {
      throw new EnvironmentGapError(
        3,
        `The batch probe did not receive a PocketBase validation rejection${statusSuffix(error)}; atomicity is not proven.`,
      );
    }
    rejected = true;
  }

  const residueAfter = await readProbeRows();
  if (!rejected) {
    if (residueAfter.length > 0) {
      await deleteRows(
        pb,
        collection,
        residueAfter.map((row) => row.id).filter((id) => id.length > 0),
        timeoutMs,
      );
    }
    throw new EnvironmentGapError(
      3,
      'PocketBase accepted a batch with a duplicate unique key; the unique indexes from migration 1700000020 are not active.',
    );
  }

  if (residueAfter.length > 0) {
    await deleteRows(
      pb,
      collection,
      residueAfter.map((row) => row.id).filter((id) => id.length > 0),
      timeoutMs,
    );
    throw new EnvironmentGapError(
      3,
      `The rejected probe batch left ${residueAfter.length} row(s); PocketBase batch atomicity is not proven.`,
    );
  }

  return 'duplicate unique key rejected atomically';
}

/**
 * Writes the settled initial snapshot and the sync metadata the product unit of
 * work needs, in one PocketBase batch. Business create effects and create-time
 * validation are never replayed; this installs storage rows only.
 */
export async function seedCase(
  pb: PocketBase,
  syncRepository: PocketbaseSyncRepository,
  initial: RawSnapshot,
  timeoutMs: number,
): Promise<void> {
  const recordCount = COLLECTION_NAMES.reduce(
    (total, collection) => total + initial[collection].length,
    0,
  );
  if (recordCount > MAX_SEED_RECORDS) {
    throw new EnvironmentGapError(
      3,
      `Refusing to seed ${recordCount} records; the runner bound is ${MAX_SEED_RECORDS}.`,
    );
  }

  const batch = pb.createBatch();
  const seededRows: string[] = [];
  for (const collection of SEED_ORDER) {
    for (const record of initial[collection]) {
      if (typeof record.id === 'string' && record.id.length > 0) {
        seededRows.push(`${collection}:${record.id}`);
      }
      batch.collection(collection).create(mapRecordForStorage(record, collection));
    }
  }

  batch.collection('obol_sync_meta').create({
    serverInstanceId: 'obol-finance-parity-runner',
    dataEpoch: 1,
    protocolMin: 1,
    protocolMax: 1,
    lastSeq: 0,
    headHash: '',
  });

  const keys: SyncRevisionKey[] = [];
  for (const collection of SEED_ORDER) {
    for (const record of initial[collection]) {
      const id = record.id;
      if (typeof id !== 'string' || id.length === 0) {
        throw new EnvironmentGapError(3, `Initial ${collection} record is missing its id.`);
      }
      const entityType = SYNC_ENTITY_BY_COLLECTION[collection];
      keys.push(syncRevisionKey(entityType, id));
      batch.collection('obol_sync_entity_versions').create({
        entityType,
        entityId: id,
        revision: 1,
        deleted: false,
        lastSeq: 0,
      });
    }
  }

  try {
    await withTimeout(batch.send(), timeoutMs, 'case seed batch');
  } catch (error) {
    // PocketBase batch rejections name the failing op in their payload; probe
    // the seeded ids against the rejection text and annotate in place so the
    // original error identity (name, status) survives to the caller.
    let rejectionText = '';
    if (error instanceof ClientResponseError) {
      try {
        rejectionText = JSON.stringify(error.response?.data ?? null) ?? '';
      } catch {
        rejectionText = '';
      }
    }
    const candidates = seededRows.filter((row) => {
      const id = row.slice(row.lastIndexOf(':') + 1);
      return id.length > 0 && rejectionText.includes(id);
    });
    const detail = `; case seed batch rows were ${seededRows.join(', ')}`;
    const matched =
      candidates.length > 0
        ? `; ids named in the PocketBase rejection payload: ${candidates.join(', ')}`
        : '';
    if (error instanceof Error) {
      error.message =
        error.message.length > 0
          ? `${error.message}${detail}${matched}`
          : `${error.name} rejected the case seed batch${detail}${matched}`;
      throw error;
    }
    throw new Error(`case seeding failed${detail}${matched}`);
  }

  const meta = await withTimeout(
    syncRepository.readSyncMeta(),
    timeoutMs,
    'seed meta verification',
  );
  if (meta === null || meta.lastSeq !== 0 || meta.headHash !== '') {
    throw new EnvironmentGapError(
      3,
      'Seed verification failed: obol_sync_meta is missing or not at genesis (lastSeq 0, empty headHash).',
    );
  }

  const versions = await withTimeout(
    syncRepository.readEntityVersions(keys),
    timeoutMs,
    'seed version verification',
  );
  if (versions.size !== keys.length) {
    throw new EnvironmentGapError(
      3,
      `Seed verification failed: expected ${keys.length} version rows, found ${versions.size}.`,
    );
  }
  for (const key of keys) {
    const version = versions.get(key);
    if (!version || version.revision !== 1 || version.deleted) {
      throw new EnvironmentGapError(
        3,
        `Seed verification failed: version row for ${key} is missing, deleted, or not at revision 1.`,
      );
    }
  }
}

interface ReadRepository {
  listAll(): Promise<unknown[]>;
}

/** Reads all seven finance collections through the real repositories. */
export function createSnapshotReader(
  pb: PocketBase,
  timeoutMs: number,
): () => Promise<RawSnapshot> {
  const container = createContainer(pb);
  const repositories: Record<CollectionName, ReadRepository> = {
    accounts: container.resolve<ReadRepository>('accountRepository'),
    cards: container.resolve<ReadRepository>('cardRepository'),
    categories: container.resolve<ReadRepository>('categoryRepository'),
    invoices: container.resolve<ReadRepository>('invoiceRepository'),
    projects: container.resolve<ReadRepository>('projectRepository'),
    recurrences: container.resolve<ReadRepository>('recurrenceRepository'),
    transactions: container.resolve<ReadRepository>('transactionRepository'),
  };

  return async (): Promise<RawSnapshot> => {
    const snapshot = {} as RawSnapshot;
    for (const collection of COLLECTION_NAMES) {
      const rows = await withTimeout(
        repositories[collection].listAll(),
        timeoutMs,
        `snapshot ${collection}`,
      );
      snapshot[collection] = rows as RawRecord[];
    }
    return snapshot;
  };
}
