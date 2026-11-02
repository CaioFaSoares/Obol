// Hosted sync protocol hostile acceptance suite.
//
// Every consumer-visible case is one concrete JSON result with pre/post
// finance, version, journal and import-receipt facts. The suite never derives
// a financial business result itself: it sends real HTTP operations, reads
// committed PocketBase state, and compares declared expected values.
//
// Failing cases are retained for diagnosis; dependent cases are marked UNRUN
// when their prerequisite did not pass. Any FAIL/UNRUN yields a non-zero exit.

import {
  canonicalHash,
  entityIdFactory,
  sha256HashOfText,
  uuidV4,
  uuidV7,
  utcDayOffset,
} from './canonical';
import {
  EnvironmentGapError,
  IsolationRefusedError,
  describeInvocation,
  displayUrl,
  readConfig,
  redactSecrets,
  type SyncHarnessConfig,
} from './config';
import {
  AcceptanceFailure,
  SyncHarness,
  describeUnexpectedError as describeHarnessError,
  type CaseResult,
  type Station,
  type WireOp,
} from './harness';
import {
  CLIENT_DTO_IMPORT_IDS,
  CLIENT_DTO_IMPORT_SNAPSHOT,
  EMPTY_IMPORT_IDS,
  EMPTY_IMPORT_SNAPSHOT,
  IMPORT_IDS,
  IMPORT_SNAPSHOT,
  SEED_IDS,
  SEED_SNAPSHOT,
  cloneSnapshot,
  flattenSnapshot,
  replaceAccountIdAt,
  snapshotRowCount,
  withFirstAccountName,
  withRecurrenceAccount,
} from './fixtures';
import { probeBatchAtomicity } from './pocketbase';
import type { HttpResponse } from './http';

// ---------------------------------------------------------------------------
// Small runtime narrowing helpers
// ---------------------------------------------------------------------------

function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function codeOf(body: unknown): string | null {
  const code = recordOf(body)?.code;
  return typeof code === 'string' ? code : null;
}

function pushResult(response: { json: unknown }, index: number): Record<string, unknown> {
  const results = arrayOf(recordOf(response.json)?.results);
  const result = recordOf(results[index]);
  if (result === null) {
    throw new AcceptanceFailure(
      `Push response has no object result at index ${index}.`,
    );
  }
  return result;
}

function statusOf(result: Record<string, unknown>): string {
  return typeof result.status === 'string' ? result.status : 'missing';
}

/**
 * Records the server's own answer for a non-200 seed/import reply, so a
 * rejected 501-row import reports the typed code and message instead of only
 * the HTTP status.
 */
function recordRejection(
  harness: SyncHarness,
  response: HttpResponse,
): void {
  if (response.status === 200) return;
  harness.fact('rejection', {
    status: response.status,
    body: response.json,
  });
}

function entityVersionsOf(result: Record<string, unknown>): readonly unknown[] {
  return arrayOf(result.entityVersions);
}

function firstRevisionOf(result: Record<string, unknown>): number | null {
  const versions = entityVersionsOf(result);
  const version = recordOf(versions[0]);
  const revision = version?.revision;
  return typeof revision === 'number' ? revision : null;
}

function eventCreatedAt(event: Record<string, unknown>): string {
  const raw = String(event.createdAt);
  const parsed = new Date(raw.replace(' ', 'T'));
  return parsed.toISOString();
}

function recomputeChainHash(event: Record<string, unknown>): string {
  return canonicalHash({
    seq: Number(event.seq),
    commitId: event.commitId,
    commitIndex: Number(event.commitIndex),
    commitSize: Number(event.commitSize),
    kind: event.kind,
    entityType: event.entityType,
    entityId: event.entityId,
    revision: Number(event.revision),
    recordHash: canonicalHash(event.record ?? null),
    origin: event.origin,
    stationId:
      typeof event.stationId === 'string' && event.stationId.length > 0
        ? event.stationId
        : null,
    opId:
      typeof event.opId === 'string' && event.opId.length > 0
        ? event.opId
        : null,
    createdAt: eventCreatedAt(event),
    prevHash: event.prevHash,
  });
}

interface PageValidation {
  readonly events: readonly Record<string, unknown>[];
  readonly nextCursor: number;
  readonly hasMore: boolean;
  readonly lastHash: string;
}

function validatePullPage(
  harness: SyncHarness,
  body: unknown,
  expectedCursor: number,
  expectedPrevHash: string,
  label: string,
): PageValidation {
  const box = recordOf(body);
  const rawEvents = arrayOf(box?.events);
  const nextCursor = box?.nextCursor;
  const hasMore = box?.hasMore;
  if (typeof nextCursor !== 'number' || !Number.isInteger(nextCursor)) {
    harness.fail(`${label}: nextCursor is not an integer.`);
  }
  if (typeof hasMore !== 'boolean') {
    harness.fail(`${label}: hasMore is not a boolean.`);
  }
  const events: Record<string, unknown>[] = [];
  for (const entry of rawEvents) {
    const event = recordOf(entry);
    if (event === null) {
      harness.fail(`${label}: a page event is not an object.`);
      continue;
    }
    events.push(event);
  }
  let expectedSeq = expectedCursor + 1;
  let previousHash = expectedPrevHash;
  let groupCommitId: string | null = null;
  let groupSize = 0;
  let groupCount = 0;
  for (const [index, event] of events.entries()) {
    if (Number(event.seq) !== expectedSeq) {
      harness.fail(
        `${label}: expected seq ${expectedSeq} actual ${String(event.seq)} at index ${index}.`,
      );
    }
    expectedSeq += 1;
    const commitId = event.commitId;
    if (typeof commitId !== 'string') {
      harness.fail(`${label}: event ${index} has no commitId.`);
      continue;
    }
    const commitIndex = Number(event.commitIndex);
    const commitSize = Number(event.commitSize);
    if (!Number.isInteger(commitSize) || commitSize < 1) {
      harness.fail(`${label}: event ${index} has commitSize ${String(event.commitSize)}.`);
    }
    if (groupCommitId === null || commitId !== groupCommitId) {
      if (commitIndex !== 0) {
        harness.fail(
          `${label}: group ${commitId} opens at commitIndex ${String(event.commitIndex)}.`,
        );
      }
      groupCommitId = commitId;
      groupSize = commitSize;
      groupCount = 0;
    } else {
      if (commitSize !== groupSize) {
        harness.fail(`${label}: group ${commitId} changes commitSize.`);
      }
      if (commitIndex !== groupCount) {
        harness.fail(
          `${label}: group ${commitId} has commitIndex ${String(event.commitIndex)} at position ${groupCount}.`,
        );
      }
    }
    if (event.prevHash !== previousHash) {
      harness.fail(
        `${label}: event ${String(event.seq)} prevHash ${String(event.prevHash)} does not link to ${previousHash}.`,
      );
    }
    const chainHash = String(event.chainHash);
    const recomputed = recomputeChainHash(event);
    if (chainHash !== recomputed) {
      harness.fail(
        `${label}: event ${String(event.seq)} chainHash does not recompute.`,
      );
    }
    previousHash = chainHash;
    groupCount += 1;
  }
  if (groupCommitId !== null && groupCount !== groupSize) {
    harness.fail(
      `${label}: page ends inside commit group ${groupCommitId} (${groupCount}/${groupSize}).`,
    );
  }
  const lastEvent = events[events.length - 1];
  const lastSeq =
    lastEvent === undefined ? expectedCursor : Number(lastEvent.seq);
  if (nextCursor !== lastSeq) {
    harness.fail(
      `${label}: nextCursor ${String(nextCursor)} does not name the last event ${lastSeq}.`,
    );
  }
  return {
    events,
    nextCursor: typeof nextCursor === 'number' ? nextCursor : lastSeq,
    hasMore: hasMore === true,
    lastHash: previousHash,
  };
}

interface SuiteState {
  readonly stationA: Station;
  readonly stationB: Station;
  readonly stationC: Station;
  readonly accountIds: (() => string);
  readonly transactionIds: (() => string);
  readonly cardIds: (() => string);
  seedCommit?: { first: number; last: number; commitId: string; size: number };
  importBody?: Record<string, unknown>;
  importResponse?: unknown;
  importId?: string;
  checkingId?: string;
  savingsId?: string;
  acceptedAccountOp?: WireOp;
  t2Id?: string;
  conflictedEditOpId?: string;
  rejectedParentOpId?: string;
  transfer?: { first: number; last: number; commitId: string; size: number };
  invoiceId?: string;
  invoicePeriod?: string;
  finalResetOldEpoch?: number;
  finalResetNewEpoch?: number;
}

// ---------------------------------------------------------------------------
// Protocol and handshake
// ---------------------------------------------------------------------------

async function protocolCases(harness: SyncHarness, state: SuiteState): Promise<void> {
  await harness.run('protocol.handshake-v4', [], async () => {
    const stationId = uuidV4();
    const response = await harness.handshake({
      id: stationId,
      platform: 'macos',
      label: 'durable uuid v4 station',
    });
    harness.fact('stationId', stationId);
    harness.fact('httpStatus', response.status);
    harness.fact('body', response.json);
    const rows = await harness.rows(
      'obol_sync_stations',
      `stationId = '${stationId}'`,
    );
    harness.fact('stationRows', rows.length);
    if (response.status === 200) {
      harness.expect(rows.length === 1, 'a successful v4 handshake must register the station');
      return;
    }
    if (response.status === 409 && codeOf(response.json) === 'PAGE_INVALID') {
      harness.fail(
        'D016 requires durable UUIDv4 stationIds (native keychain UUID()); the current handshake/validator rejects a v4 station with PAGE_INVALID because it requires UUIDv7. This is a product defect, not a harness limitation.',
      );
      return;
    }
    harness.fail(
      `a UUIDv4 station handshake failed with HTTP ${response.status} (${codeOf(response.json) ?? 'no code'}) instead of succeeding.`,
    );
  });

  await harness.run('protocol.handshake-v7', [], async () => {
    const response = await harness.handshake(state.stationA);
    harness.expectStatus(response, 200, 'v7 station handshake');
    const body = recordOf(response.json);
    if (body === null) throw new AcceptanceFailure('handshake body is not an object');
    const current = await harness.state();
    harness.expectEqual(body.serverInstanceId, harness.server.instanceId, 'handshake.serverInstanceId');
    harness.expectEqual(body.ownerFingerprint, harness.ownerFingerprint, 'handshake.ownerFingerprint');
    harness.expectEqual(body.dataEpoch, harness.server.dataEpoch, 'handshake.dataEpoch');
    harness.expectEqual(body.cursor, current.cursor, 'handshake.cursor');
    harness.expectEqual(body.cursorHash, current.headHash, 'handshake.cursorHash');
    harness.expectEqual(body.headHash, current.headHash, 'handshake.headHash');
    harness.expectEqual(body.protocolMin, harness.server.protocolMin, 'handshake.protocolMin');
    harness.expectEqual(body.protocolMax, harness.server.protocolMax, 'handshake.protocolMax');
    harness.expectEqual(body.hasFinancialData, false, 'handshake.hasFinancialData on the empty baseline');
    harness.expect(
      typeof body.serverName === 'string' && body.serverName.length > 0,
      'handshake.serverName must be a non-empty deployment name',
    );
    if (harness.serverName.length > 0) {
      harness.expectEqual(body.serverName, harness.serverName, 'handshake.serverName vs login');
    }
    const stations = await harness.rows(
      'obol_sync_stations',
      `stationId = '${state.stationA.id}'`,
    );
    harness.expect(stations.length === 1, 'the handshake must register exactly one station row');
    harness.fact('identity', {
      serverInstanceId: body.serverInstanceId,
      ownerFingerprint: body.ownerFingerprint,
      dataEpoch: body.dataEpoch,
      cursor: body.cursor,
      cursorHash: body.cursorHash,
      serverName: body.serverName,
    });

    const second = await harness.handshake(state.stationB);
    harness.expectStatus(second, 200, 'second v7 station handshake');
  });

  await harness.run('protocol.handshake-unsupported', [], async () => {
    const response = await harness.handshake(state.stationA, { protocolVersion: 2 });
    harness.expectCode(response, 409, 'PROTOCOL_UNSUPPORTED', 'unsupported protocol handshake');
  });

  await harness.run('protocol.handshake-endpoint', [], async () => {
    const response = await harness.handshake(state.stationA, {
      serverInstanceId: uuidV7(),
    });
    harness.expectCode(response, 409, 'ENDPOINT_MISMATCH', 'foreign server instance handshake');
  });

  await harness.run('protocol.handshake-epoch', [], async () => {
    const response = await harness.handshake(state.stationA, {
      dataEpoch: harness.server.dataEpoch + 1,
    });
    harness.expectCode(response, 409, 'DATA_EPOCH_CHANGED', 'stale data epoch handshake');
  });

  await harness.run('protocol.handshake-cursor-rollback', [], async () => {
    const response = await harness.handshake(state.stationA, {
      clientCursor: harness.server.cursor + 5,
      clientCursorHash: sha256HashOfText('beyond-the-head'),
    });
    harness.expectCode(
      response,
      409,
      'SERVER_ROLLBACK_DETECTED',
      'cursor beyond the journal head',
    );
  });

  await harness.run('protocol.push-station-unregistered', [], async () => {
    const response = await harness.push(
      { id: uuidV7(), platform: 'macos', label: 'never handshaken' },
      [],
    );
    harness.expectCode(response, 409, 'STATION_NOT_REGISTERED', 'push before handshake');
  });

  await harness.run('protocol.push-endpoint-mismatch', [], async () => {
    const response = await harness.push(state.stationA, [], {
      serverInstanceId: uuidV7(),
    });
    harness.expectCode(response, 409, 'ENDPOINT_MISMATCH', 'push to a foreign instance');
  });

  await harness.run('protocol.push-epoch-changed', [], async () => {
    const response = await harness.push(state.stationA, [], {
      dataEpoch: harness.server.dataEpoch + 1,
    });
    harness.expectCode(response, 409, 'DATA_EPOCH_CHANGED', 'push with a stale epoch');
  });
}

// ---------------------------------------------------------------------------
// Seed (empty-server migration)
// ---------------------------------------------------------------------------

async function seedCases(harness: SyncHarness, state: SuiteState): Promise<void> {
  const seedCount = snapshotRowCount(SEED_SNAPSHOT);

  await harness.run('seed.invalid-relation', ['protocol.handshake-v7'], async () => {
    const before = await harness.state();
    const invalid = withRecurrenceAccount(
      cloneSnapshot(SEED_SNAPSHOT),
      'z00000000000000',
    );
    const response = await harness.seed(state.stationA, invalid);
    recordRejection(harness, response);
    harness.expectCode(response, 409, 'PAGE_INVALID', 'seed with a dangling relation');
    const after = await harness.state();
    harness.expectEqual(after.finance, before.finance, 'invalid seed left no finance rows');
    harness.expectEqual(after.journalEvents, before.journalEvents, 'invalid seed left no journal events');
    harness.expectEqual(after.versions, before.versions, 'invalid seed left no versions');
    harness.expectEqual(after.cursor, before.cursor, 'invalid seed did not advance the cursor');
    harness.fact('body', response.json);
  });

  await harness.run('seed.valid-seven', ['seed.invalid-relation'], async () => {
    const before = await harness.state();
    harness.expectEqual(before.journalEvents, 0, 'the server is empty before the seed');
    const response = await harness.seed(state.stationA, SEED_SNAPSHOT);
    recordRejection(harness, response);
    harness.expectStatus(response, 200, 'valid seven-collection seed');
    const body = recordOf(response.json);
    if (body === null) throw new AcceptanceFailure('seed response is not an object');
    const expectedCounts = {
      account: 1,
      card: 1,
      category: 1,
      invoice: 1,
      project: 1,
      recurrence: 1,
      transaction: 2,
    };
    harness.expectEqual(body.counts, expectedCounts, 'seed counts');
    harness.expectEqual(body.cursor, seedCount, 'seed cursor');
    harness.expectEqual(body.serverInstanceId, harness.server.instanceId, 'seed serverInstanceId');
    harness.expectEqual(body.dataEpoch, harness.server.dataEpoch, 'seed dataEpoch');
    harness.fact('httpStatus', response.status);
    harness.fact('counts', body.counts);

    for (const row of flattenSnapshot(SEED_SNAPSHOT)) {
      await harness.expectDeclaredRow(row.collection, row.record, 'seed');
      const revision = await harness.revisionOf(row.entityType, row.id);
      harness.expectEqual(revision, 1, `seed version ${row.entityType}:${row.id}`);
    }

    const group = await harness.expectCommitGroup(
      'seed commit',
      1,
      seedCount,
      'seed',
    );
    harness.fact('commit', group);
    await harness.refreshIdentity();

    const after = await harness.state();
    harness.expectEqual(after.cursor, seedCount, 'meta cursor after seed');
    harness.expectEqual(after.headHash, group.headHash, 'meta head after seed');
    harness.expectEqual(after.versions, seedCount, 'version rows after seed');
    harness.expectEqual(after.operations, 0, 'a seed writes no operation receipts');
    harness.expectEqual(after.importReceipts, 0, 'a seed writes no import receipts');
    const transactionRows = await harness.rows(
      'transactions',
      `invoice_id = '${SEED_IDS.invoice}'`,
    );
    harness.expectEqual(transactionRows.length, 2, 'the seed preserved both historical transactions');
    const invoice = await harness.financeRow('invoices', SEED_IDS.invoice);
    harness.expectEqual(invoice?.['total_amount'], 120, 'seed invoice gross is not recomputed');
    harness.expectEqual(invoice?.['paid_amount'], 50, 'seed invoice paid is not recomputed');
    const account = await harness.financeRow('accounts', SEED_IDS.account);
    harness.expectEqual(account?.['initial_balance'], 950, 'seed cash is not recomputed');
    harness.expectEqual(
      Number(invoice?.['total_amount']) - Number(invoice?.['paid_amount']),
      70,
      'declared seed invoice debt',
    );
    state.seedCommit = {
      first: 1,
      last: seedCount,
      commitId: String(group.commitId),
      size: seedCount,
    };
  });

  await harness.run('seed.nonempty-409', ['seed.valid-seven'], async () => {
    const before = await harness.state();
    const response = await harness.seed(state.stationA, SEED_SNAPSHOT);
    recordRejection(harness, response);
    harness.expectCode(response, 409, 'SERVER_NOT_EMPTY', 'second seed on a populated server');
    const after = await harness.state();
    harness.expectEqual(after.finance, before.finance, 'non-empty seed left finance untouched');
    harness.expectEqual(after.journalEvents, before.journalEvents, 'non-empty seed left the journal untouched');
    harness.expectEqual(after.cursor, before.cursor, 'non-empty seed left the cursor untouched');
    harness.expectEqual(after.versions, before.versions, 'non-empty seed left versions untouched');
  });

  await harness.run('protocol.handshake-cursor-hash', ['seed.valid-seven'], async () => {
    const good = await harness.handshake(state.stationA, {
      clientCursor: state.seedCommit!.last,
      clientCursorHash: harness.server.headHash,
    });
    harness.expectStatus(good, 200, 'handshake at the seed commit boundary');
    const bad = await harness.handshake(state.stationA, {
      clientCursor: state.seedCommit!.last,
      clientCursorHash: sha256HashOfText('stored-cursor-does-not-match'),
    });
    harness.expectCode(
      bad,
      409,
      'SERVER_ROLLBACK_DETECTED',
      'cursor hash mismatch handshake',
    );
  });
}

// ---------------------------------------------------------------------------
// Snapshot import-as-new
// ---------------------------------------------------------------------------

async function importCases(harness: SyncHarness, state: SuiteState): Promise<void> {
  const importCount = snapshotRowCount(IMPORT_SNAPSHOT);

  await harness.run('import.populated', ['seed.valid-seven'], async () => {
    const before = await harness.state();
    const importId = uuidV7();
    const { response, body } = await harness.importSnapshot(
      state.stationA,
      IMPORT_SNAPSHOT,
      importId,
    );
    recordRejection(harness, response);
    harness.expectStatus(response, 200, 'import into a populated server');
    const responseBox = recordOf(response.json);
    if (responseBox === null) throw new AcceptanceFailure('import response is not an object');
    harness.expectEqual(responseBox.importId, importId, 'import response importId');
    harness.expectEqual(responseBox.serverInstanceId, harness.server.instanceId, 'import serverInstanceId');
    harness.expectEqual(responseBox.dataEpoch, harness.server.dataEpoch, 'import dataEpoch');
    harness.expectEqual(responseBox.cursor, before.cursor + importCount, 'import cursor');
    const expectedCounts = {
      account: 1,
      card: 1,
      category: 1,
      invoice: 1,
      project: 1,
      recurrence: 1,
      transaction: 3,
    };
    harness.expectEqual(responseBox.counts, expectedCounts, 'import counts');
    harness.expectEqual(body.payloadHash, canonicalHash({
      protocolVersion: body.protocolVersion,
      stationId: body.stationId,
      serverInstanceId: body.serverInstanceId,
      dataEpoch: body.dataEpoch,
      importId: body.importId,
      snapshot: body.snapshot,
    }), 'six-field import hash');
    harness.fact('httpStatus', response.status);
    harness.fact('response', response.json);

    for (const row of flattenSnapshot(IMPORT_SNAPSHOT)) {
      await harness.expectDeclaredRow(row.collection, row.record, 'import');
      harness.expectEqual(
        await harness.revisionOf(row.entityType, row.id),
        1,
        `import version ${row.entityType}:${row.id}`,
      );
    }

    const group = await harness.expectCommitGroup(
      'import commit',
      before.cursor + 1,
      importCount,
      'seed',
    );
    harness.fact('commit', group);
    const after = await harness.state();
    harness.expectEqual(after.cursor, before.cursor + importCount, 'meta cursor after import');
    harness.expectEqual(after.headHash, group.headHash, 'meta head after import');
    harness.expectEqual(after.importReceipts, 1, 'one import receipt');
    harness.expectEqual(after.operations, 0, 'a snapshot import writes no operation receipts');

    const receipts = await harness.rows('obol_sync_snapshot_imports');
    const receipt = receipts[0];
    harness.expectEqual(receipt?.['importId'], importId, 'receipt importId');
    harness.expectEqual(receipt?.['stationId'], state.stationA.id, 'receipt stationId');
    harness.expectEqual(receipt?.['payloadHash'], body.payloadHash, 'receipt payloadHash');
    harness.expectEqual(receipt?.['serverInstanceId'], harness.server.instanceId, 'receipt serverInstanceId');
    harness.expectEqual(receipt?.['dataEpoch'], harness.server.dataEpoch, 'receipt dataEpoch');

    const seedAccount = await harness.financeRow('accounts', SEED_IDS.account);
    const importedAccount = await harness.financeRow('accounts', IMPORT_IDS.account);
    harness.expectEqual(seedAccount?.['initial_balance'], 950, 'seed cash remains 950');
    harness.expectEqual(importedAccount?.['initial_balance'], 950, 'imported cash is 950');
    harness.expectEqual(
      await harness.count('accounts'),
      2,
      '950 + 950 is not a duplicated historical debit',
    );
    const importedInvoice = await harness.financeRow('invoices', IMPORT_IDS.invoice);
    harness.expectEqual(importedInvoice?.['total_amount'], 200, 'partial invoice gross preserved');
    harness.expectEqual(importedInvoice?.['paid_amount'], 50, 'partial invoice paid preserved');
    const silent = await harness.financeRow('transactions', IMPORT_IDS.silentTransaction);
    harness.expectEqual(silent?.['is_silent'], true, 'silent history preserved');
    const paid = await harness.financeRow('transactions', IMPORT_IDS.paidTransaction);
    harness.expectEqual(paid?.['status'], 'realized', 'paid history preserved');
    harness.expectEqual(paid?.['realized_date'] !== '', true, 'realized date preserved');

    state.importBody = body;
    state.importResponse = response.json;
    state.importId = importId;
  });

  await harness.run('import.exact-retry', ['import.populated'], async () => {
    const before = await harness.state();
    const response = await harness.bff.post(
      '/api/sync/import',
      state.importBody,
      harness.token,
    );
    harness.expectStatus(response, 200, 'exact same-body import retry');
    harness.expectEqual(response.json, state.importResponse, 'retry replays the stored original result');
    const after = await harness.state();
    harness.expectEqual(after.cursor, before.cursor, 'retry did not advance the cursor');
    harness.expectEqual(after.finance, before.finance, 'retry produced no finance effects');
    harness.expectEqual(after.journalEvents, before.journalEvents, 'retry produced no journal events');
    harness.expectEqual(after.importReceipts, before.importReceipts, 'retry produced no second receipt');
    harness.expectEqual(after.versions, before.versions, 'retry produced no version rows');
  });

  await harness.run('import.reused', ['import.populated'], async () => {
    const before = await harness.state();
    const changed = withFirstAccountName(
      cloneSnapshot(IMPORT_SNAPSHOT),
      'Changed Frozen Content',
    );
    const body = harness.importBody(
      state.stationA,
      changed,
      state.importId!,
    );
    harness.expect(
      body.payloadHash !== state.importBody?.['payloadHash'],
      'the changed body must carry a different six-field hash',
    );
    const response = await harness.bff.post('/api/sync/import', body, harness.token);
    harness.expectCode(response, 409, 'IMPORT_ID_REUSED', 'same importId with changed content');
    const after = await harness.state();
    harness.expectEqual(after.finance, before.finance, 'IMPORT_ID_REUSED left finance untouched');
    harness.expectEqual(after.cursor, before.cursor, 'IMPORT_ID_REUSED left the cursor untouched');
    harness.expectEqual(after.importReceipts, before.importReceipts, 'IMPORT_ID_REUSED left receipts untouched');
  });

  await harness.run('import.collision', ['import.populated'], async () => {
    const before = await harness.state();
    const collision = replaceAccountIdAt(
      cloneSnapshot(EMPTY_IMPORT_SNAPSHOT),
      EMPTY_IMPORT_IDS.account,
      SEED_IDS.account,
    );
    const body = harness.importBody(state.stationA, collision, uuidV7());
    const response = await harness.bff.post('/api/sync/import', body, harness.token);
    harness.expectCode(response, 409, 'IMPORT_ENTITY_ID_TAKEN', 'import colliding with an existing financial id');
    const after = await harness.state();
    harness.expectEqual(after.finance, before.finance, 'collision left no partial financial insert');
    harness.expectEqual(after.journalEvents, before.journalEvents, 'collision left the journal untouched');
    harness.expectEqual(after.importReceipts, before.importReceipts, 'collision wrote no receipt');
    harness.expectEqual(after.versions, before.versions, 'collision wrote no version rows');
    const rows = await harness.rows('transactions', `card_id = '${EMPTY_IMPORT_IDS.card}'`);
    harness.expectEqual(rows.length, 0, 'collision inserted none of the other collection rows');
  });

  await harness.run('import.tampered-hash', ['import.populated'], async () => {
    const before = await harness.state();
    const body = harness.importBody(
      state.stationA,
      EMPTY_IMPORT_SNAPSHOT,
      uuidV7(),
    );
    body.payloadHash = canonicalHash({ tampered: 'import-envelope' });
    const response = await harness.bff.post('/api/sync/import', body, harness.token);
    harness.expectCode(response, 409, 'PAGE_INVALID', 'tampered import hash');
    const after = await harness.state();
    harness.expectEqual(after.finance, before.finance, 'tampered import left no finance rows');
    harness.expectEqual(after.importReceipts, before.importReceipts, 'tampered import wrote no receipt');
  });
}

// ---------------------------------------------------------------------------
// Real financial operations through the 18 sync intents
// ---------------------------------------------------------------------------

async function operationCases(harness: SyncHarness, state: SuiteState): Promise<void> {
  const LIQUID_CASH = 950 + 950 + 1000 + 200;
  const OVERDUE_DEBT = 70 + 150;

  await harness.run('ops.accounts-create', ['protocol.handshake-v7'], async () => {
    const checkingId = state.accountIds();
    const savingsId = state.accountIds();
    const investmentId = state.accountIds();
    state.checkingId = checkingId;
    state.savingsId = savingsId;
    const ops = [
      harness.makeOp(state.stationA, {
        type: 'account.create',
        entityType: 'account',
        entityId: checkingId,
        payload: { name: 'Acceptance Checking', type: 'checking', initial_balance: 1000 },
      }),
      harness.makeOp(state.stationA, {
        type: 'account.create',
        entityType: 'account',
        entityId: savingsId,
        payload: { name: 'Acceptance Savings', type: 'savings', initial_balance: 200 },
      }),
      harness.makeOp(state.stationA, {
        type: 'account.create',
        entityType: 'account',
        entityId: investmentId,
        payload: { name: 'Acceptance Investment', type: 'investment', initial_balance: 5000 },
      }),
    ];
    const response = await harness.push(state.stationA, ops);
    harness.expectStatus(response, 200, 'three account.create operations');
    for (const [index, op] of ops.entries()) {
      harness.expectApplied(response, index, `account create ${index}`);
      const result = pushResult(response, index);
      harness.expectEqual(firstRevisionOf(result), 1, `account create ${index} revision`);
      harness.expectEqual(op.entityId, (recordOf(arrayOf(result.entityVersions)[0])?.entityId), `account create ${index} entity id`);
    }
    harness.fact('results', (recordOf(response.json) ?? {})['results']);
    const checking = await harness.financeRow('accounts', checkingId);
    const savings = await harness.financeRow('accounts', savingsId);
    const investment = await harness.financeRow('accounts', investmentId);
    harness.expectEqual(checking?.['initial_balance'], 1000, 'created checking balance');
    harness.expectEqual(savings?.['initial_balance'], 200, 'created savings balance');
    harness.expectEqual(investment?.['initial_balance'], 5000, 'created investment balance');
    state.acceptedAccountOp = ops[0]!;
  });

  await harness.run('ops.forecast-current-vs-projected', ['ops.accounts-create'], async () => {
    const yesterday = utcDayOffset(-1);
    const today = utcDayOffset(0);
    const current = await harness.bff.get(
      `/api/forecast?startDate=${yesterday}&endDate=${yesterday}`,
      harness.token,
    );
    harness.expectStatus(current, 200, 'current-cash forecast');
    const currentBox = recordOf(current.json);
    const currentTimeline = arrayOf(currentBox?.timeline);
    harness.expectEqual(currentTimeline.length, 1, 'current-cash timeline length');
    const currentDay = recordOf(currentTimeline[0]);
    harness.expectEqual(currentDay?.date, yesterday, 'current-cash timeline date');
    harness.expectEqual(currentDay?.balance, LIQUID_CASH, 'current cash excludes the investment account and equals liquid balances');

    const projected = await harness.bff.get(
      `/api/forecast?startDate=${today}&endDate=${today}`,
      harness.token,
    );
    harness.expectStatus(projected, 200, 'projected-cash forecast');
    const projectedBox = recordOf(projected.json);
    const projectedTimeline = arrayOf(projectedBox?.timeline);
    const projectedDay = recordOf(projectedTimeline[0]);
    harness.expectEqual(projectedDay?.date, today, 'projected timeline date');
    harness.expectEqual(
      projectedDay?.balance,
      LIQUID_CASH - OVERDUE_DEBT,
      'projected cash includes the two overdue declared invoice debts on today',
    );
    const invoiceAmounts = arrayOf(projectedBox?.upcomingInvoices)
      .map((entry) => Number(recordOf(entry)?.amount))
      .sort((left, right) => left - right);
    harness.expectEqual(invoiceAmounts, [70, 150], 'upcoming invoice debt amounts');
    harness.fact('currentCash', {
      date: yesterday,
      balance: currentDay?.balance,
      source: 'forecast timeline, non-investment accounts',
    });
    harness.fact('projectedCash', {
      date: today,
      balance: projectedDay?.balance,
      upcomingInvoiceDebts: invoiceAmounts,
    });
  });

  await harness.run('ops.pending-realize-effective-at', ['ops.accounts-create'], async () => {
    const transactionId = state.transactionIds();
    const create = harness.makeOp(state.stationA, {
      type: 'transaction.create',
      entityType: 'transaction',
      entityId: transactionId,
      payload: {
        title: 'Offline Pending Expense',
        amount: 100,
        type: 'expense',
        status: 'pending',
        expected_date: '2026-03-05T09:00:00.000Z',
        account_id: state.checkingId,
      },
      effectiveAt: '2026-03-05T09:00:00.000Z',
    });
    const createResponse = await harness.push(state.stationA, [create]);
    harness.expectApplied(createResponse, 0, 'pending expense create');
    const pendingAccount = await harness.financeRow('accounts', state.checkingId!);
    harness.expectEqual(pendingAccount?.['initial_balance'], 1000, 'a pending expense does not move the balance');

    const accountRevision = await harness.revisionOf('account', state.checkingId!);
    const realize = harness.makeOp(state.stationA, {
      type: 'transaction.realize',
      entityType: 'transaction',
      entityId: transactionId,
      payload: { update_balance: true },
      baseRevisions: {
        [`transaction:${transactionId}`]: 1,
        [`account:${state.checkingId}`]: accountRevision,
      },
      effectiveAt: '2026-03-05T10:00:00.000Z',
    });
    const realizeResponse = await harness.push(state.stationA, [realize]);
    harness.expectApplied(realizeResponse, 0, 'offline realization');
    const realized = await harness.financeRow('transactions', transactionId);
    harness.expectEqual(realized?.['status'], 'realized', 'realized status');
    harness.expect(
      sameInstantValue(realized?.['realized_date'], '2026-03-05T10:00:00.000Z'),
      `realized_date must be the operation effectiveAt, got ${String(realized?.['realized_date'])}`,
    );
    const account = await harness.financeRow('accounts', state.checkingId!);
    harness.expectEqual(account?.['initial_balance'], 900, 'the offline expense debits exactly once');
    const events = await harness.rows('obol_sync_changes', `opId = '${realize.opId}'`);
    harness.expectEqual(events.length, 2, 'realize writes the transaction and the account in one commit');
    for (const event of events) {
      harness.expect(
        sameInstantValue(event['createdAt'], '2026-03-05T10:00:00.000Z'),
        `journal createdAt must be the effectiveAt, got ${String(event['createdAt'])}`,
      );
    }
    harness.fact('realized', {
      transactionId,
      realizedDate: realized?.['realized_date'],
      checkingBalance: account?.['initial_balance'],
      journalEvents: events.length,
    });
  });

  await harness.run('ops.two-station-conflict', ['ops.pending-realize-effective-at'], async () => {
    const editId = state.transactionIds();
    state.t2Id = editId;
    const create = harness.makeOp(state.stationA, {
      type: 'transaction.create',
      entityType: 'transaction',
      entityId: editId,
      payload: {
        title: 'Conflict Edit Subject',
        amount: 10,
        type: 'expense',
        status: 'pending',
        expected_date: '2026-03-07T09:00:00.000Z',
        account_id: state.checkingId,
      },
      effectiveAt: '2026-03-07T09:00:00.000Z',
    });
    harness.expectApplied(
      await harness.push(state.stationA, [create]),
      0,
      'conflict subject create',
    );
    const edited = harness.makeOp(state.stationA, {
      type: 'transaction.update',
      entityType: 'transaction',
      entityId: editId,
      payload: { title: 'A Edit Accepted' },
      baseRevisions: { [`transaction:${editId}`]: 1 },
      effectiveAt: '2026-03-07T10:00:00.000Z',
    });
    harness.expectApplied(
      await harness.push(state.stationA, [edited]),
      0,
      'first edit on base revision 1',
    );
    const staleEdit = harness.makeOp(state.stationB, {
      type: 'transaction.update',
      entityType: 'transaction',
      entityId: editId,
      payload: { title: 'B Edit Stale' },
      baseRevisions: { [`transaction:${editId}`]: 1 },
      effectiveAt: '2026-03-07T10:05:00.000Z',
    });
    const conflictResponse = await harness.push(state.stationB, [staleEdit]);
    harness.expectStatus(conflictResponse, 200, 'stale edit response');
    const conflictResult = pushResult(conflictResponse, 0);
    harness.expectEqual(statusOf(conflictResult), 'conflict', 'second edit conflicts');
    const conflict = recordOf(arrayOf(conflictResult.conflicts)[0]);
    harness.expectEqual(conflict?.entityType, 'transaction', 'conflict entity type');
    harness.expectEqual(conflict?.entityId, editId, 'conflict entity id');
    harness.expectEqual(conflict?.baseRevision, 1, 'conflict declared revision');
    harness.expectEqual(conflict?.currentRevision, 2, 'conflict current revision');
    harness.expectEqual(recordOf(conflict?.current)?.['title'], 'A Edit Accepted', 'conflict current record');
    state.conflictedEditOpId = staleEdit.opId;
    harness.fact('editConflict', conflictResult);

    const realizeId = state.transactionIds();
    const realizeCreate = harness.makeOp(state.stationA, {
      type: 'transaction.create',
      entityType: 'transaction',
      entityId: realizeId,
      payload: {
        title: 'Conflict Realize Subject',
        amount: 20,
        type: 'expense',
        status: 'pending',
        expected_date: '2026-03-07T11:00:00.000Z',
        account_id: state.checkingId,
      },
      effectiveAt: '2026-03-07T11:00:00.000Z',
    });
    harness.expectApplied(
      await harness.push(state.stationA, [realizeCreate]),
      0,
      'realize subject create',
    );
    const accountRevision = await harness.revisionOf('account', state.checkingId!);
    const realize = harness.makeOp(state.stationA, {
      type: 'transaction.realize',
      entityType: 'transaction',
      entityId: realizeId,
      payload: { update_balance: true },
      baseRevisions: {
        [`transaction:${realizeId}`]: 1,
        [`account:${state.checkingId}`]: accountRevision,
      },
      effectiveAt: '2026-03-07T12:00:00.000Z',
    });
    harness.expectApplied(
      await harness.push(state.stationA, [realize]),
      0,
      'first realize',
    );
    const staleRealize = harness.makeOp(state.stationB, {
      type: 'transaction.realize',
      entityType: 'transaction',
      entityId: realizeId,
      payload: { update_balance: true },
      baseRevisions: {
        [`transaction:${realizeId}`]: 1,
        [`account:${state.checkingId}`]: accountRevision,
      },
      effectiveAt: '2026-03-07T12:05:00.000Z',
    });
    const staleResponse = await harness.push(state.stationB, [staleRealize]);
    harness.expectStatus(staleResponse, 200, 'stale realize response');
    const staleResult = pushResult(staleResponse, 0);
    harness.expectEqual(statusOf(staleResult), 'conflict', 'second realize conflicts');
    const account = await harness.financeRow('accounts', state.checkingId!);
    harness.expectEqual(account?.['initial_balance'], 880, 'the conflict did not debit the account twice');
    const realized = await harness.financeRow('transactions', realizeId);
    harness.expectEqual(realized?.['status'], 'realized', 'realize subject remains realized');
    harness.fact('realizeConflict', staleResult);
  });

  await harness.run('ops.transfer-atomic-neutral', ['ops.two-station-conflict'], async () => {
    const checkingRevision = await harness.revisionOf('account', state.checkingId!);
    const savingsRevision = await harness.revisionOf('account', state.savingsId!);
    const transactionId = state.transactionIds();
    const op = harness.makeOp(state.stationA, {
      type: 'transaction.create',
      entityType: 'transaction',
      entityId: transactionId,
      payload: {
        title: 'Atomic Transfer',
        amount: 50,
        type: 'transfer',
        status: 'realized',
        expected_date: '2026-03-06T12:00:00.000Z',
        account_id: state.checkingId,
        destination_account_id: state.savingsId,
      },
      baseRevisions: {
        [`account:${state.checkingId}`]: checkingRevision,
        [`account:${state.savingsId}`]: savingsRevision,
      },
      effectiveAt: '2026-03-06T12:00:00.000Z',
    });
    const response = await harness.push(state.stationA, [op]);
    harness.expectApplied(response, 0, 'atomic transfer');
    const result = pushResult(response, 0);
    harness.expectEqual(entityVersionsOf(result).length, 3, 'a realized transfer touches two accounts and one transaction');
    const checking = await harness.financeRow('accounts', state.checkingId!);
    const savings = await harness.financeRow('accounts', state.savingsId!);
    harness.expectEqual(checking?.['initial_balance'], 830, 'transfer source debit');
    harness.expectEqual(savings?.['initial_balance'], 250, 'transfer destination credit');
    const events = await harness.rows('obol_sync_changes', `opId = '${op.opId}'`);
    events.sort((left, right) => Number(left.seq) - Number(right.seq));
    harness.expectEqual(events.length, 3, 'transfer commit group size');
    const commitId = events[0]?.['commitId'];
    for (const [index, event] of events.entries()) {
      harness.expectEqual(event['commitId'], commitId, 'one commitId for the transfer group');
      harness.expectEqual(event['commitIndex'], index, 'contiguous transfer commitIndex');
      harness.expectEqual(event['commitSize'], 3, 'transfer commitSize');
    }
    state.transfer = {
      first: Number(events[0]?.['seq']),
      last: Number(events[2]?.['seq']),
      commitId: String(commitId),
      size: 3,
    };
    harness.fact('transfer', {
      source: checking?.['initial_balance'],
      destination: savings?.['initial_balance'],
      group: state.transfer,
    });
  });

  await harness.run('ops.card-purchases-additive', ['ops.transfer-atomic-neutral'], async () => {
    const cardId = state.cardIds();
    const cardCreate = harness.makeOp(state.stationA, {
      type: 'card.create',
      entityType: 'card',
      entityId: cardId,
      payload: {
        name: 'Acceptance Card',
        closing_day: 15,
        due_day: 25,
        limit: 5000,
      },
    });
    harness.expectApplied(
      await harness.push(state.stationA, [cardCreate]),
      0,
      'card create',
    );
    const first = harness.makeOp(state.stationA, {
      type: 'transaction.create',
      entityType: 'transaction',
      entityId: state.transactionIds(),
      payload: {
        title: 'Offline Card Purchase A',
        amount: 60,
        type: 'expense',
        status: 'pending',
        expected_date: '2026-04-10T12:00:00.000Z',
        card_id: cardId,
      },
      effectiveAt: '2026-04-10T12:00:00.000Z',
    });
    harness.expectApplied(
      await harness.push(state.stationA, [first]),
      0,
      'first same-period card purchase',
    );
    const second = harness.makeOp(state.stationB, {
      type: 'transaction.create',
      entityType: 'transaction',
      entityId: state.transactionIds(),
      payload: {
        title: 'Offline Card Purchase B',
        amount: 40,
        type: 'expense',
        status: 'pending',
        expected_date: '2026-04-10T18:00:00.000Z',
        card_id: cardId,
      },
      effectiveAt: '2026-04-10T18:00:00.000Z',
    });
    harness.expectApplied(
      await harness.push(state.stationB, [second]),
      0,
      'second same-period card purchase',
    );
    const invoices = await harness.rows(
      'invoices',
      `card_id = '${cardId}' && period = '2026-04'`,
    );
    harness.expectEqual(invoices.length, 1, 'one additive invoice for the card period');
    const invoice = invoices[0];
    harness.expectEqual(invoice?.['total_amount'], 100, 'additive invoice gross sum');
    const lines = await harness.rows('transactions', `card_id = '${cardId}'`);
    harness.expectEqual(lines.length, 2, 'both offline purchases stored');
    for (const line of lines) {
      harness.expectEqual(line?.['invoice_id'], invoice?.['id'], 'both purchases route to the same invoice');
    }
    state.invoiceId = typeof invoice?.['id'] === 'string' ? invoice['id'] : undefined;
    state.invoicePeriod = '2026-04';
    harness.fact('invoice', invoice);
  });

  await harness.run('ops.invoice-partial-pay-stale', ['ops.card-purchases-additive'], async () => {
    const invoiceId = state.invoiceId!;
    const invoiceRevision = await harness.revisionOf('invoice', invoiceId);
    const accountRevision = await harness.revisionOf('account', state.checkingId!);
    const realizedExpenseFilter = `account_id = '${state.checkingId}' && type = 'expense' && status = 'realized'`;
    const realizedExpensesBefore = (
      await harness.rows('transactions', realizedExpenseFilter)
    ).length;
    const pay = harness.makeOp(state.stationA, {
      type: 'invoice.pay',
      entityType: 'invoice',
      entityId: invoiceId,
      payload: {
        period: state.invoicePeriod,
        account_id: state.checkingId,
        amount_paid: 20,
      },
      baseRevisions: {
        [`invoice:${invoiceId}`]: invoiceRevision,
        [`account:${state.checkingId}`]: accountRevision,
      },
      effectiveAt: '2026-04-20T10:00:00.000Z',
    });
    harness.expectApplied(
      await harness.push(state.stationA, [pay]),
      0,
      'first partial invoice payment',
    );
    const invoiceAfterFirst = await harness.financeRow('invoices', invoiceId);
    const accountAfterFirst = await harness.financeRow('accounts', state.checkingId!);
    harness.expectEqual(invoiceAfterFirst?.['paid_amount'], 20, 'partial paid amount');
    harness.expectEqual(accountAfterFirst?.['initial_balance'], 810, 'first partial payment debits once');
    const paymentRows = await harness.rows(
      'transactions',
      realizedExpenseFilter,
    );
    harness.expectEqual(
      paymentRows.length,
      realizedExpensesBefore + 1,
      'one payment transaction was created',
    );
    const realizedExpensesAfterFirst = paymentRows.length;

    const stale = harness.makeOp(state.stationB, {
      type: 'invoice.pay',
      entityType: 'invoice',
      entityId: invoiceId,
      payload: {
        period: state.invoicePeriod,
        account_id: state.checkingId,
        amount_paid: 20,
      },
      baseRevisions: {
        [`invoice:${invoiceId}`]: invoiceRevision,
        [`account:${state.checkingId}`]: accountRevision,
      },
      effectiveAt: '2026-04-20T10:05:00.000Z',
    });
    const staleResponse = await harness.push(state.stationB, [stale]);
    harness.expectStatus(staleResponse, 200, 'stale partial payment response');
    const staleResult = pushResult(staleResponse, 0);
    harness.expectEqual(statusOf(staleResult), 'conflict', 'second partial payment conflicts');
    const invoiceAfter = await harness.financeRow('invoices', invoiceId);
    const accountAfter = await harness.financeRow('accounts', state.checkingId!);
    harness.expectEqual(invoiceAfter?.['paid_amount'], 20, 'stale payment did not change paid amount');
    harness.expectEqual(accountAfter?.['initial_balance'], 810, 'stale payment did not debit twice');
    const paymentRowsAfter = await harness.rows(
      'transactions',
      realizedExpenseFilter,
    );
    harness.expectEqual(
      paymentRowsAfter.length,
      realizedExpensesAfterFirst,
      'stale payment created no second payment row',
    );
    harness.fact('stalePayment', staleResult);
  });

  await harness.run('ops.delete-tombstone', ['ops.accounts-create'], async () => {
    const transactionId = state.transactionIds();
    const create = harness.makeOp(state.stationA, {
      type: 'transaction.create',
      entityType: 'transaction',
      entityId: transactionId,
      payload: {
        title: 'Tombstone Subject',
        amount: 5,
        type: 'expense',
        status: 'pending',
        expected_date: '2026-03-08T09:00:00.000Z',
        account_id: state.checkingId,
      },
      effectiveAt: '2026-03-08T09:00:00.000Z',
    });
    harness.expectApplied(
      await harness.push(state.stationA, [create]),
      0,
      'tombstone subject create',
    );
    const remove = harness.makeOp(state.stationA, {
      type: 'transaction.delete',
      entityType: 'transaction',
      entityId: transactionId,
      payload: {},
      baseRevisions: { [`transaction:${transactionId}`]: 1 },
      effectiveAt: '2026-03-08T10:00:00.000Z',
    });
    harness.expectApplied(
      await harness.push(state.stationA, [remove]),
      0,
      'transaction delete',
    );
    harness.expectEqual(
      await harness.financeRow('transactions', transactionId),
      null,
      'deleted row is absent',
    );
    const version = await harness.rows(
      'obol_sync_entity_versions',
      `entityType = 'transaction' && entityId = '${transactionId}'`,
    );
    harness.expectEqual(version[0]?.['deleted'], true, 'delete writes a tombstone');
    harness.expectEqual(version[0]?.['revision'], 2, 'tombstone revision');

    const resurrect = harness.makeOp(state.stationA, {
      type: 'transaction.create',
      entityType: 'transaction',
      entityId: transactionId,
      payload: {
        title: 'Resurrected',
        amount: 5,
        type: 'expense',
        status: 'pending',
        expected_date: '2026-03-08T11:00:00.000Z',
      },
      effectiveAt: '2026-03-08T11:00:00.000Z',
    });
    harness.expectRejected(
      await harness.push(state.stationA, [resurrect]),
      0,
      'ENTITY_ID_TAKEN',
      'create over a tombstone',
    );
    harness.expectEqual(
      await harness.financeRow('transactions', transactionId),
      null,
      'create over a tombstone did not resurrect the row',
    );

    const edit = harness.makeOp(state.stationA, {
      type: 'transaction.update',
      entityType: 'transaction',
      entityId: transactionId,
      payload: { title: 'Tombstone Edit Attempt' },
      baseRevisions: { [`transaction:${transactionId}`]: 2 },
      effectiveAt: '2026-03-08T12:00:00.000Z',
    });
    const editResponse = await harness.push(state.stationA, [edit]);
    if (editResponse.status !== 200) {
      harness.fail(
        `editing a tombstoned entity returned HTTP ${editResponse.status} instead of a typed per-operation rejection; no row was resurrected.`,
      );
    } else {
      const result = pushResult(editResponse, 0);
      harness.expect(
        statusOf(result) !== 'applied',
        `editing a tombstoned entity must not apply; got ${JSON.stringify(result)}`,
      );
    }
    harness.expectEqual(
      await harness.financeRow('transactions', transactionId),
      null,
      'edit of a tombstone did not resurrect the row',
    );
    harness.fact('tombstone', {
      revision: version[0]?.['revision'],
      deleted: version[0]?.['deleted'],
      editHttpStatus: editResponse.status,
    });
  });

  await harness.run('ops.id-collision', ['ops.accounts-create'], async () => {
    const checkingId = state.checkingId;
    if (checkingId === undefined) {
      throw new Error(
        'ops.id-collision requires checkingId recorded by ops.accounts-create.',
      );
    }
    // Earlier cases in this sequence already debit this same account (1000 ->
    // 900 -> 880 -> 830 -> 810), so the creation-time balance is not this
    // case's invariant. The invariant is that the rejected create changes
    // NOTHING, so the comparison uses the values captured immediately before
    // the attempt, never a literal that earlier accepted operations moved.
    const before = await harness.financeRow('accounts', checkingId);
    if (before === null) {
      throw new AcceptanceFailure(
        `ops.id-collision needs account/${checkingId} to exist before the attempt.`,
      );
    }
    const tracked = ['name', 'type', 'initial_balance'] as const;
    const op = harness.makeOp(state.stationA, {
      type: 'account.create',
      entityType: 'account',
      entityId: checkingId,
      payload: { name: 'Overwrite Attempt', type: 'checking', initial_balance: 1 },
    });
    harness.expectRejected(
      await harness.push(state.stationA, [op]),
      0,
      'ENTITY_ID_TAKEN',
      'create over an existing id',
    );
    const account = await harness.financeRow('accounts', checkingId);
    if (account === null) {
      throw new AcceptanceFailure(
        `ops.id-collision lost account/${checkingId} after the rejected create.`,
      );
    }
    for (const field of tracked) {
      harness.expectEqual(
        account[field],
        before[field],
        `existing account ${field} was not overwritten`,
      );
    }
    harness.fact('untouched', {
      initial_balance: account['initial_balance'],
      name: account['name'],
    });
  });

  await harness.run('ops.dependency-block', ['ops.accounts-create'], async () => {
    const missingAccount = 'z00000000000000';
    const parent = harness.makeOp(state.stationA, {
      type: 'transaction.create',
      entityType: 'transaction',
      entityId: state.transactionIds(),
      payload: {
        title: 'Missing Parent Account',
        amount: 5,
        type: 'expense',
        status: 'pending',
        expected_date: '2026-03-09T09:00:00.000Z',
        account_id: missingAccount,
      },
      effectiveAt: '2026-03-09T09:00:00.000Z',
    });
    const childAccountId = state.accountIds();
    const child = harness.makeOp(state.stationA, {
      type: 'account.create',
      entityType: 'account',
      entityId: childAccountId,
      payload: { name: 'Blocked Child', type: 'savings', initial_balance: 1 },
      dependsOn: [parent.opId],
    });
    const response = await harness.push(state.stationA, [parent, child]);
    harness.expectStatus(response, 200, 'parent rejection and child block');
    harness.expectRejected(response, 0, 'MISSING_ENTITY', 'rejected parent');
    harness.expectBlocked(response, 1, 'dependent child');
    harness.expectEqual(
      await harness.financeRow('accounts', childAccountId),
      null,
      'the blocked child wrote nothing',
    );
    state.rejectedParentOpId = parent.opId;
    harness.fact('results', (recordOf(response.json) ?? {})['results']);
  });

  await harness.run('ops.batch-order', ['ops.accounts-create'], async () => {
    const entityId = state.accountIds();
    const valid = harness.makeOp(state.stationA, {
      type: 'account.create',
      entityType: 'account',
      entityId,
      payload: { name: 'Batch First Valid', type: 'checking', initial_balance: 20 },
    });
    const invalid = harness.makeOp(state.stationA, {
      type: 'account.create',
      entityType: 'account',
      entityId,
      payload: { name: 'Batch Second Invalid', type: 'checking', initial_balance: 30 },
    });
    const response = await harness.push(state.stationA, [valid, invalid]);
    harness.expectStatus(response, 200, 'valid then invalid batch');
    harness.expectApplied(response, 0, 'first valid operation');
    harness.expectRejected(response, 1, 'ENTITY_ID_TAKEN', 'second invalid operation');
    const result = pushResult(response, 1);
    const rows = await harness.rows('accounts', `id = '${entityId}'`);
    harness.expectEqual(rows.length, 1, 'the first commit survived the second rejection');
    harness.expectEqual(rows[0]?.['initial_balance'], 20, 'the surviving account is the valid one');
    harness.fact('orderedStatuses', [
      statusOf(pushResult(response, 0)),
      statusOf(result),
    ]);
  });

  await harness.run('ops.unknown-payload', ['ops.accounts-create'], async () => {
    const unknownField = harness.makeOp(state.stationA, {
      type: 'account.create',
      entityType: 'account',
      entityId: state.accountIds(),
      payload: {
        name: 'Unknown Payload Field',
        type: 'checking',
        initial_balance: 1,
        unexpected: 'x',
      },
    });
    const unknownType = harness.makeOp(state.stationA, {
      type: 'account.explode',
      entityType: 'account',
      entityId: state.accountIds(),
      payload: {},
    });
    const response = await harness.push(state.stationA, [unknownField, unknownType]);
    harness.expectStatus(response, 200, 'unknown payload operations return per-operation results');
    harness.expectRejected(response, 0, 'INVALID_PAYLOAD', 'unknown payload field');
    harness.expectRejected(response, 1, 'UNKNOWN_OPERATION_TYPE', 'unknown operation type');
    harness.expectEqual(
      await harness.financeRow('accounts', unknownField.entityId),
      null,
      'unknown payload wrote nothing',
    );
    harness.expectEqual(
      await harness.financeRow('accounts', unknownType.entityId),
      null,
      'unknown type wrote nothing',
    );
    harness.fact('results', (recordOf(response.json) ?? {})['results']);
  });
}

function sameInstantValue(left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftMs = Date.parse(left.replace(' ', 'T'));
  const rightMs = Date.parse(right.replace(' ', 'T'));
  return Number.isFinite(leftMs) && leftMs === rightMs;
}

// ---------------------------------------------------------------------------
// Idempotency and finality
// ---------------------------------------------------------------------------

async function idempotencyCases(harness: SyncHarness, state: SuiteState): Promise<void> {
  await harness.run('idem.duplicate', ['ops.accounts-create'], async () => {
    const before = await harness.state();
    const op = state.acceptedAccountOp!;
    const response = await harness.push(state.stationA, [op]);
    harness.expectStatus(response, 200, 'exact duplicate operation');
    const result = pushResult(response, 0);
    harness.expectEqual(statusOf(result), 'duplicate', 'duplicate result status');
    harness.expectEqual(result.opId, op.opId, 'duplicate result opId');
    const after = await harness.state();
    harness.expectEqual(after.cursor, before.cursor, 'duplicate did not advance the cursor');
    harness.expectEqual(after.journalEvents, before.journalEvents, 'duplicate wrote no journal events');
    harness.expectEqual(after.operations, before.operations, 'duplicate wrote no second receipt');
    harness.fact('duplicateResult', {
      status: result.status,
      entityVersions: result.entityVersions,
    });
  });

  await harness.run('idem.op-id-reused', ['ops.accounts-create'], async () => {
    const before = await harness.state();
    const op = state.acceptedAccountOp!;
    const payload = recordOf(op.payload) ?? {};
    const variants = [
      harness.remint(op, {
        payload: { ...payload, initial_balance: 1001 },
      }),
      harness.remint(op, { effectiveAt: '2026-01-01T00:00:00.000Z' }),
      harness.remint(op, {
        baseRevisions: { [`account:${state.savingsId}`]: 1 },
      }),
      harness.remint(op, { dependsOn: [state.acceptedAccountOp!.opId] }),
      harness.remint(op, { entityId: state.accountIds() }),
    ];
    const response = await harness.push(state.stationA, variants);
    harness.expectStatus(response, 200, 'changed envelopes under one opId');
    for (let index = 0; index < variants.length; index += 1) {
      harness.expectRejected(response, index, 'OP_ID_REUSED', `variant ${index}`);
    }
    const after = await harness.state();
    harness.expectEqual(after.cursor, before.cursor, 'OP_ID_REUSED did not advance the cursor');
    harness.expectEqual(after.journalEvents, before.journalEvents, 'OP_ID_REUSED wrote no events');
    harness.expectEqual(after.finance, before.finance, 'OP_ID_REUSED wrote no finance rows');
    harness.fact('results', (recordOf(response.json) ?? {})['results']);
  });

  await harness.run(
    'idem.finality',
    ['ops.two-station-conflict', 'ops.dependency-block'],
    async () => {
      const conflictSubjectId = state.t2Id!;
      const conflictedOpId = state.conflictedEditOpId!;
      const currentRevision = await harness.revisionOf(
        'transaction',
        conflictSubjectId,
      );
      const finalityEdit = harness.makeOp(state.stationA, {
        type: 'transaction.update',
        entityType: 'transaction',
        entityId: conflictSubjectId,
        payload: { title: 'Finality Edit Attempt' },
        baseRevisions: {
          [`transaction:${conflictSubjectId}`]: currentRevision,
        },
        effectiveAt: '2026-03-07T13:00:00.000Z',
        opId: conflictedOpId,
      });
      const editResponse = await harness.push(state.stationA, [finalityEdit]);
      harness.expectStatus(editResponse, 200, 'modified conflicted opId');
      const editResult = pushResult(editResponse, 0);
      if (statusOf(editResult) === 'applied') {
        harness.fail(
          'finality violation: an opId that was previously conflicted became accepted after its envelope changed; the accepted receipt is the only immutable outcome, but a conflicted envelope must not be re-minted under the same opId.',
        );
      }
      harness.fact('conflictedFinality', {
        opId: conflictedOpId,
        actualStatus: statusOf(editResult),
      });

      const rejectedOpId = state.rejectedParentOpId!;
      const freshAccount = state.accountIds();
      const finalityCreate = harness.makeOp(state.stationA, {
        type: 'account.create',
        entityType: 'account',
        entityId: freshAccount,
        payload: { name: 'Finality Account', type: 'checking', initial_balance: 1 },
        effectiveAt: '2026-03-09T13:00:00.000Z',
        opId: rejectedOpId,
      });
      const createResponse = await harness.push(state.stationA, [finalityCreate]);
      harness.expectStatus(createResponse, 200, 'modified rejected opId');
      const createResult = pushResult(createResponse, 0);
      if (statusOf(createResult) === 'applied') {
        harness.fail(
          'finality violation: an opId whose original envelope was rejected became accepted after the envelope changed; the rejected envelope must remain final for that opId.',
        );
      }
      harness.fact('rejectedFinality', {
        opId: rejectedOpId,
        actualStatus: statusOf(createResult),
      });
    },
  );

  await harness.run('idem.tampered-hash', ['ops.accounts-create'], async () => {
    const before = await harness.state();
    const op = harness.makeOp(state.stationA, {
      type: 'account.create',
      entityType: 'account',
      entityId: state.accountIds(),
      payload: { name: 'Tampered Hash', type: 'checking', initial_balance: 1 },
    });
    const tampered: WireOp = {
      ...op,
      payloadHash: canonicalHash({ tampered: 'operation-envelope' }),
    };
    const response = await harness.push(state.stationA, [tampered]);
    harness.expectRejected(
      response,
      0,
      'ENVELOPE_HASH_MISMATCH',
      'tampered operation hash',
    );
    const after = await harness.state();
    harness.expectEqual(after.finance, before.finance, 'tampered envelope wrote no finance rows');
    harness.expectEqual(after.journalEvents, before.journalEvents, 'tampered envelope wrote no journal events');
    harness.expectEqual(after.versions, before.versions, 'tampered envelope wrote no versions');
    harness.fact('result', pushResult(response, 0));
  });
}

// ---------------------------------------------------------------------------
// Pull semantics
// ---------------------------------------------------------------------------

async function pullCases(harness: SyncHarness, state: SuiteState): Promise<void> {
  await harness.run('pull.whole-group-limit-1', ['ops.transfer-atomic-neutral'], async () => {
    const transfer = state.transfer!;
    const boundaryRows = await harness.rows(
      'obol_sync_changes',
      `seq = ${transfer.first - 1}`,
    );
    const boundaryHash = String(boundaryRows[0]?.['chainHash'] ?? '');
    const response = await harness.pull(transfer.first - 1, 1);
    harness.expectStatus(response, 200, 'pull limit 1 at the transfer boundary');
    const page = validatePullPage(
      harness,
      response.json,
      transfer.first - 1,
      boundaryHash,
      'transfer page',
    );
    const events = page.events;
    harness.expectEqual(events.length, 3, 'limit 1 cannot split the three-event transfer commit');
    harness.expectEqual(page.nextCursor, transfer.last, 'nextCursor is the group boundary');
    harness.expectEqual(page.hasMore, true, 'more journal follows the transfer');
    for (const [index, event] of events.entries()) {
      harness.expectEqual(event['seq'], transfer.first + index, 'transfer event seq');
      harness.expectEqual(event['commitId'], transfer.commitId, 'transfer commitId');
      harness.expectEqual(event['commitIndex'], index, 'transfer commitIndex');
      harness.expectEqual(event['commitSize'], 3, 'transfer commitSize');
    }
    harness.fact('events', events.length);
  });

  await harness.run('pull.midgroup-cursor', ['pull.whole-group-limit-1'], async () => {
    const transfer = state.transfer!;
    const response = await harness.pull(transfer.first, 10);
    harness.expectCode(
      response,
      409,
      'CURSOR_NOT_ON_COMMIT_BOUNDARY',
      'cursor inside a commit group',
    );
  });

  await harness.run('pull.beyond-head', ['pull.midgroup-cursor'], async () => {
    const stateNow = await harness.state();
    const response = await harness.pull(stateNow.cursor + 100, 10);
    harness.expectCode(
      response,
      409,
      'SERVER_ROLLBACK_DETECTED',
      'cursor beyond the journal head',
    );
  });

  await harness.run('pull.complete-groups', ['pull.beyond-head'], async () => {
    const stateNow = await harness.state();
    let cursor = 0;
    let previousHash = '';
    let totalEvents = 0;
    let pages = 0;
    let hasMore = true;
    while (hasMore && pages < 20) {
      const response = await harness.pull(cursor, 500);
      harness.expectStatus(response, 200, `complete-groups page ${pages}`);
      const page = validatePullPage(
        harness,
        response.json,
        cursor,
        previousHash,
        `complete-groups page ${pages}`,
      );
      totalEvents += page.events.length;
      cursor = page.nextCursor;
      previousHash = page.lastHash;
      hasMore = page.hasMore;
      pages += 1;
    }
    harness.expectEqual(hasMore, false, 'the bounded page loop reached the journal head');
    harness.expectEqual(cursor, stateNow.cursor, 'the last complete group ends at the meta cursor');
    harness.expectEqual(totalEvents, stateNow.journalEvents, 'every journal event was pulled exactly once');
    harness.fact('pages', pages);
    harness.fact('events', totalEvents);
    harness.fact('lastChainHash', previousHash);
  });

  await harness.run('pull.broken-chain', ['pull.complete-groups'], async () => {
    const transfer = state.transfer!;
    const rows = await harness.rows(
      'obol_sync_changes',
      `seq = ${transfer.first}`,
    );
    const row = rows[0];
    if (row === undefined) {
      throw new AcceptanceFailure('the transfer commit event is missing');
    }
    const recordId = String(row['id']);
    const originalHash = String(row['chainHash']);
    const tamperedHash = sha256HashOfText('tampered-chain-event');
    try {
      await harness.overwriteRow('obol_sync_changes', recordId, {
        chainHash: tamperedHash,
      });
      const response = await harness.pull(transfer.first - 1, 10);
      harness.expectCode(
        response,
        409,
        'SERVER_ROLLBACK_DETECTED',
        'pull across a tampered chain hash',
      );
    } finally {
      await harness.overwriteRow('obol_sync_changes', recordId, {
        chainHash: originalHash,
      });
    }
    const restored = await harness.rows(
      'obol_sync_changes',
      `seq = ${transfer.first}`,
    );
    harness.expectEqual(restored[0]?.['chainHash'], originalHash, 'the synthetic chain row was restored');
    const response = await harness.pull(transfer.first - 1, 10);
    harness.expectStatus(response, 200, 'pull after restoring the chain');
    harness.fact('tamperedHash', tamperedHash);
    harness.fact('restoredHash', originalHash);
  });
}

// ---------------------------------------------------------------------------
// Request bounds
// ---------------------------------------------------------------------------

async function limitCases(harness: SyncHarness, state: SuiteState): Promise<void> {
  await harness.run('limits.101-operations', ['protocol.handshake-v7'], async () => {
    const before = await harness.state();
    const ops: WireOp[] = [];
    for (let index = 0; index < 101; index += 1) {
      ops.push(
        harness.makeOp(state.stationA, {
          type: 'account.create',
          entityType: 'account',
          entityId: state.accountIds(),
          payload: { name: `Bound ${index}`, type: 'checking', initial_balance: 1 },
        }),
      );
    }
    const response = await harness.push(state.stationA, ops);
    harness.expectCode(response, 413, 'REQUEST_TOO_LARGE', '101 operations');
    const after = await harness.state();
    harness.expectEqual(after.finance, before.finance, '101 operations wrote no finance rows');
    harness.expectEqual(after.journalEvents, before.journalEvents, '101 operations wrote no journal events');
  });

  await harness.run('limits.1mib-chunked', ['protocol.handshake-v7'], async () => {
    const before = await harness.state();
    const pad = 'a'.repeat(1_100_000);
    const body = JSON.stringify({
      protocolVersion: 1,
      stationId: state.stationA.id,
      serverInstanceId: harness.server.instanceId,
      dataEpoch: harness.server.dataEpoch,
      ops: [],
      pad,
    });
    const response = await harness.bff.postChunked(
      '/api/sync/push',
      body,
      harness.token,
    );
    harness.expectCode(response, 413, 'REQUEST_TOO_LARGE', 'chunked body over 1 MiB');
    const after = await harness.state();
    harness.expectEqual(after.finance, before.finance, 'oversized body wrote no finance rows');
    harness.expectEqual(after.journalEvents, before.journalEvents, 'oversized body wrote no journal events');
    harness.fact('bodyBytes', Buffer.byteLength(body, 'utf8'));
  });

  await harness.run('limits.operation-64kib', ['protocol.handshake-v7'], async () => {
    const before = await harness.state();
    const entityId = state.accountIds();
    const op = harness.makeOp(state.stationA, {
      type: 'account.create',
      entityType: 'account',
      entityId,
      payload: {
        name: 'a'.repeat(70_000),
        type: 'checking',
        initial_balance: 1,
      },
    });
    const response = await harness.push(state.stationA, [op]);
    harness.expectRejected(response, 0, 'INVALID_PAYLOAD', 'operation over 64 KiB');
    const after = await harness.state();
    harness.expectEqual(after.finance, before.finance, 'oversized operation wrote no finance rows');
    harness.expectEqual(after.journalEvents, before.journalEvents, 'oversized operation wrote no journal events');
    harness.expectEqual(
      await harness.financeRow('accounts', entityId),
      null,
      'oversized operation wrote no account',
    );
  });

  await harness.run('limits.malformed-json', ['protocol.handshake-v7'], async () => {
    const before = await harness.state();
    const response = await harness.bff.request({
      path: '/api/sync/push',
      method: 'POST',
      rawText: '{',
      token: harness.token,
    });
    harness.expectCode(response, 400, 'PAGE_INVALID', 'malformed JSON body');
    const after = await harness.state();
    harness.expectEqual(after.journalEvents, before.journalEvents, 'malformed JSON wrote nothing');
  });

  await harness.run('limits.scalar-json', ['protocol.handshake-v7'], async () => {
    const response = await harness.bff.request({
      path: '/api/sync/push',
      method: 'POST',
      rawText: '5',
      token: harness.token,
    });
    harness.expectCode(response, 409, 'PAGE_INVALID', 'scalar JSON body');
  });

  await harness.run('limits.unknown-field', ['protocol.handshake-v7'], async () => {
    const response = await harness.bff.post(
      '/api/sync/push',
      {
        protocolVersion: 1,
        stationId: state.stationA.id,
        serverInstanceId: harness.server.instanceId,
        dataEpoch: harness.server.dataEpoch,
        ops: [],
        pad: 'x',
      },
      harness.token,
    );
    harness.expectCode(response, 409, 'PAGE_INVALID', 'unknown frame field');
  });
}

// ---------------------------------------------------------------------------
// Atomic batch proof
// ---------------------------------------------------------------------------

async function atomicityCase(harness: SyncHarness): Promise<void> {
  await harness.run('atomicity.pb-batch-probe', [], async () => {
    const result = await probeBatchAtomicity(
      harness.pb,
      harness.config.ioTimeoutMs,
    );
    harness.fact('probe', result);
    harness.fact(
      'boundary',
      'PocketBase batch atomicity is proven with one financial account row plus a duplicate metadata constraint in the same batch; the product seed/import path is source-verified to use ONE createBatch(). A mid-commit process kill is not exercised because the producer exposes no fault injection.',
    );
  });
}

// ---------------------------------------------------------------------------
// Reset, empty-context import and final reset
// ---------------------------------------------------------------------------

async function resetCases(harness: SyncHarness, state: SuiteState): Promise<void> {
  await harness.run('reset.empty-context', ['atomicity.pb-batch-probe'], async () => {
    const before = await harness.state();
    const ownerBefore = await harness.rows('owner');
    const response = await harness.bff.post(
      '/api/admin/reset',
      { confirm: 'LIMPAR' },
      harness.token,
    );
    harness.expectStatus(response, 200, 'mid-run guarded reset for the empty server context');
    const after = await harness.state();
    harness.expectEqual(after.dataEpoch, Number(before.dataEpoch) + 1, 'mid-run reset increments the epoch once');
    harness.expectEqual(after.cursor, 0, 'mid-run reset rewinds the cursor');
    harness.expectEqual(after.headHash, '', 'mid-run reset installs the genesis head');
    for (const [collection, count] of Object.entries(after.finance)) {
      harness.expectEqual(count, 0, `mid-run reset clears ${collection}`);
    }
    harness.expectEqual(after.journalEvents, 0, 'mid-run reset clears the journal');
    harness.expectEqual(after.versions, 0, 'mid-run reset clears versions');
    harness.expectEqual(after.operations, 0, 'mid-run reset clears operation receipts');
    harness.expectEqual(after.importReceipts, 0, 'mid-run reset clears import receipts');
    harness.expectEqual(after.sessions, before.sessions, 'mid-run reset preserves sessions');
    harness.expectEqual(after.stations, before.stations, 'mid-run reset preserves the station registry');
    harness.expectEqual((await harness.rows('owner'))[0]?.['id'], ownerBefore[0]?.['id'], 'mid-run reset preserves the owner');
    await harness.refreshIdentity();
    harness.fact('epoch', { before: before.dataEpoch, after: after.dataEpoch });
    harness.fact('cleared', (recordOf(response.json) ?? {})['cleared']);
  });

  await harness.run('import.empty-server', ['reset.empty-context'], async () => {
    const handshake = await harness.handshake(state.stationC);
    harness.expectStatus(handshake, 200, 'fresh station handshake on the new epoch');
    const before = await harness.state();
    const importId = uuidV7();
    const { response } = await harness.importSnapshot(
      state.stationC,
      EMPTY_IMPORT_SNAPSHOT,
      importId,
    );
    recordRejection(harness, response);
    harness.expectStatus(response, 200, '501-row import into the empty server context');
    const box = recordOf(response.json);
    const count = snapshotRowCount(EMPTY_IMPORT_SNAPSHOT);
    harness.expectEqual(count, 501, 'the empty-context snapshot carries 501 rows');
    harness.expectEqual(box?.cursor, count, 'import cursor after the 501-row commit');
    harness.expectEqual(box?.importId, importId, 'import response importId');
    harness.expectEqual(
      box?.counts,
      {
        account: 1,
        card: 1,
        category: 1,
        invoice: 1,
        project: 1,
        recurrence: 1,
        transaction: 495,
      },
      'empty-context import counts',
    );
    for (const row of flattenSnapshot(EMPTY_IMPORT_SNAPSHOT)) {
      harness.expectEqual(
        await harness.revisionOf(row.entityType, row.id),
        1,
        `empty-context version ${row.entityType}:${row.id}`,
      );
    }
    const account = await harness.financeRow('accounts', EMPTY_IMPORT_IDS.account);
    harness.expectEqual(account?.['initial_balance'], 500, 'empty-context account is stored byte-for-byte');
    harness.expectEqual(await harness.count('transactions'), 495, 'all 495 bulk transactions are stored');
    const group = await harness.expectCommitGroup(
      'empty-context import commit',
      1,
      count,
      'seed',
    );
    harness.fact('commit', group);
    await harness.refreshIdentity();
  });

  await harness.run('pull.large-commit-single-page', ['import.empty-server'], async () => {
    const response = await harness.pull(0, 1);
    harness.expectStatus(response, 200, 'pull limit 1 over a 501-event commit');
    const page = validatePullPage(harness, response.json, 0, '', 'large commit page');
    harness.expectEqual(page.events.length, 501, 'the whole 501-event commit is returned despite limit 1');
    const first = page.events[0];
    const last = page.events[page.events.length - 1];
    harness.expectEqual(first?.['commitId'], last?.['commitId'], 'one commit id for all 501 events');
    harness.expectEqual(first?.['commitSize'], 501, 'commitSize 501');
    harness.expectEqual(last?.['commitIndex'], 500, 'last commitIndex 500');
    harness.expectEqual(page.nextCursor, 501, 'nextCursor at the group boundary');
    harness.expectEqual(page.hasMore, false, 'no more journal after the single commit');
    harness.fact('events', page.events.length);
  });

  await harness.run('import.client-dto-created-updated', ['import.empty-server'], async () => {
    const before = await harness.state();
    const importId = uuidV7();
    const { response } = await harness.importSnapshot(
      state.stationA,
      CLIENT_DTO_IMPORT_SNAPSHOT,
      importId,
    );
    harness.fact('httpStatus', response.status);
    harness.fact('response', response.json);
    if (response.status === 200) {
      for (const row of flattenSnapshot(CLIENT_DTO_IMPORT_SNAPSHOT)) {
        const stored = await harness.financeRow(
          row.collection,
          row.id,
        );
        harness.expect(stored !== null, `${row.entityType}/${row.id} was stored`);
        if (stored !== null) {
          harness.expect(
            sameInstantValue(stored['created'], '2026-01-01T00:00:00.000Z'),
            `${row.entityType}/${row.id}.created was preserved`,
          );
          harness.expect(
            sameInstantValue(stored['updated'], '2026-01-02T00:00:00.000Z'),
            `${row.entityType}/${row.id}.updated was preserved`,
          );
        }
      }
      harness.expectEqual(
        await harness.financeRow('accounts', CLIENT_DTO_IMPORT_IDS.account) !== null,
        true,
        'client DTO account was imported',
      );
      return;
    }
    const after = await harness.state();
    harness.expectEqual(after.finance, before.finance, 'rejected client DTO import left finance untouched');
    harness.expectEqual(after.importReceipts, before.importReceipts, 'rejected client DTO import wrote no receipt');
    harness.fail(
      `the native FinancialSnapshot encodes optional created/updated dates on every record, but this import was rejected with HTTP ${response.status} (${codeOf(response.json) ?? 'no code'}) instead of accepting the complete client DTO.`,
    );
  });

  await harness.run('reset.wrong-confirmation', ['import.empty-server'], async () => {
    const before = await harness.state();
    const response = await harness.bff.post(
      '/api/admin/reset',
      { confirm: 'APAGAR' },
      harness.token,
    );
    harness.expectStatus(response, 400, 'wrong reset confirmation');
    const after = await harness.state();
    harness.expectEqual(after.dataEpoch, before.dataEpoch, 'wrong confirmation did not rotate the epoch');
    harness.expectEqual(after.finance, before.finance, 'wrong confirmation left finance untouched');
    harness.expectEqual(after.journalEvents, before.journalEvents, 'wrong confirmation left the journal untouched');
    harness.expectEqual(after.cursor, before.cursor, 'wrong confirmation left the cursor untouched');
  });

  await harness.run('reset.correct-LIMPAR', ['import.empty-server'], async () => {
    const before = await harness.state();
    const ownerBefore = await harness.rows('owner');
    const stationCountBefore = before.stations;
    const sessionCountBefore = before.sessions;
    const response = await harness.bff.post(
      '/api/admin/reset',
      { confirm: 'LIMPAR' },
      harness.token,
    );
    harness.expectStatus(response, 200, 'correct LIMPAR reset');
    const after = await harness.state();
    state.finalResetOldEpoch = before.dataEpoch ?? undefined;
    state.finalResetNewEpoch = after.dataEpoch ?? undefined;
    harness.expectEqual(after.dataEpoch, Number(before.dataEpoch) + 1, 'final reset increments the epoch exactly once');
    harness.expectEqual(after.instanceId, before.instanceId, 'final reset preserves the server instance');
    harness.expectEqual(after.protocolMin, before.protocolMin, 'final reset preserves protocolMin');
    harness.expectEqual(after.protocolMax, before.protocolMax, 'final reset preserves protocolMax');
    harness.expectEqual(after.cursor, 0, 'final reset rewinds the cursor');
    harness.expectEqual(after.headHash, '', 'final reset installs the genesis head');
    for (const [collection, count] of Object.entries(after.finance)) {
      harness.expectEqual(count, 0, `final reset clears ${collection}`);
    }
    harness.expectEqual(after.journalEvents, 0, 'final reset clears the journal');
    harness.expectEqual(after.versions, 0, 'final reset clears versions');
    harness.expectEqual(after.operations, 0, 'final reset clears operation receipts');
    harness.expectEqual(after.importReceipts, 0, 'final reset clears import receipts');
    harness.expectEqual(after.sessions, sessionCountBefore, 'final reset preserves sessions');
    harness.expectEqual(after.stations, stationCountBefore, 'final reset preserves the station registry');
    harness.expectEqual((await harness.rows('owner'))[0]?.['id'], ownerBefore[0]?.['id'], 'final reset preserves the owner');
    harness.fact('epoch', { before: before.dataEpoch, after: after.dataEpoch });
    harness.fact('cleared', (recordOf(response.json) ?? {})['cleared']);
  });

  await harness.run('reset.old-epoch-push', ['reset.correct-LIMPAR'], async () => {
    const oldEpoch = state.finalResetOldEpoch!;
    const stalePush = await harness.push(state.stationC, [], { dataEpoch: oldEpoch });
    harness.expectCode(
      stalePush,
      409,
      'DATA_EPOCH_CHANGED',
      'old station epoch push after reset',
    );
    const staleHandshake = await harness.handshake(state.stationC, {
      dataEpoch: oldEpoch,
    });
    harness.expectCode(
      staleHandshake,
      409,
      'DATA_EPOCH_CHANGED',
      'old station epoch handshake after reset',
    );
    const fresh = await harness.handshake(state.stationC);
    harness.expectStatus(fresh, 200, 'fresh epoch handshake after reset');
    harness.fact('oldEpoch', oldEpoch);
    harness.fact('newEpoch', state.finalResetNewEpoch);
  });
}

// ---------------------------------------------------------------------------
// Suite orchestration
// ---------------------------------------------------------------------------

const COVERAGE_BOUNDARIES: readonly string[] = [
  'Only the dedicated volume whose PocketBase settings meta.appName is exactly "Obol sync protocol isolated" is touched; no hosted user data.',
  'The v4 station failure is a real acceptance failure of the current server validator, reported without weakening the station to UUIDv7.',
  'PocketBase batch atomicity is proven with a financial account row plus a duplicate metadata constraint in one batch. The product seed/import batch is source-verified as one createBatch(); a mid-commit process kill is not exercised (no producer fault injection).',
  'Financial expected values are declared fixture inputs; the runner never recomputes a product business result to make a case pass.',
  'The native FinancialSnapshot created/updated dates are sent unchanged in a dedicated import case; a rejection is reported instead of stripping DTO fields to force a pass.',
  'Remote hosted multi-node contention, native clients, UI and deployment configuration are out of scope.',
  'The broken-chain case tampers one synthetic journal row and restores it in a finally block; it never touches a real deployment journal.',
];

function summary(
  config: SyncHarnessConfig | null,
  results: readonly CaseResult[],
  guard: CaseResult,
): Record<string, unknown> {
  const failures = results.filter((result) => result.status === 'FAIL');
  const unrun = results.filter((result) => result.status === 'UNRUN');
  return {
    command: 'bun server/test/sync-protocol.integration.ts',
    environment: config === null ? null : describeInvocation(config),
    guard,
    results,
    totals: {
      cases: results.length + 1,
      pass: results.filter((result) => result.status === 'PASS').length + (guard.status === 'PASS' ? 1 : 0),
      fail: failures.length + (guard.status === 'FAIL' ? 1 : 0),
      unrun: unrun.length,
    },
    failures: failures.map((result) => result.id),
    unrun: unrun.map((result) => result.id),
    coverageBoundaries: COVERAGE_BOUNDARIES,
    readinessClaim: 'none: this report is evidence of exercised behavior, not release readiness',
  };
}

export async function runSyncProtocolSuite(): Promise<number> {
  let config: SyncHarnessConfig | null = null;
  let harness: SyncHarness | null = null;
  let guard: CaseResult = {
    id: 'environment.guard',
    status: 'FAIL',
    facts: {},
    failures: [],
  };

  try {
    const loadedConfig = readConfig(process.env);
    config = loadedConfig;
    const created = new SyncHarness();
    harness = created;
    await created.initialize();
    guard = {
      id: 'environment.guard',
      status: 'PASS',
      facts: created.setupFacts,
      failures: [],
    };
    console.log(
      `RESULT environment.guard PASS ${redactSecrets(
        JSON.stringify(created.setupFacts),
        loadedConfig,
      )}`,
    );
  } catch (error) {
    const message = redactSecrets(
      error instanceof Error ? error.message : String(error),
      config ?? {
        pbUrl: '',
        bffUrl: '',
        pbAdminEmail: '',
        pbAdminPassword: '',
        ownerEmail: '',
        ownerPassword: '',
        setupToken: null,
        httpTimeoutMs: 0,
        ioTimeoutMs: 0,
      },
    );
    guard = {
      id: 'environment.guard',
      status: 'FAIL',
      facts: { displayUrl: config === null ? null : displayUrl(config.bffUrl) },
      failures: [message],
    };
    console.log(
      `RESULT environment.guard FAIL ${JSON.stringify({ failures: [message] })}`,
    );
    console.log(
      config === null
        ? JSON.stringify(summary(config, [], guard), null, 2)
        : redactSecrets(
            JSON.stringify(summary(config, [], guard), null, 2),
            config,
          ),
    );
    if (error instanceof IsolationRefusedError) return error.exitCode;
    if (error instanceof EnvironmentGapError) return error.exitCode;
    return 1;
  }

  if (harness === null) {
    return 1;
  }

  const state: SuiteState = {
    stationA: { id: uuidV7(), platform: 'macos', label: 'acceptance station A' },
    stationB: { id: uuidV7(), platform: 'macos', label: 'acceptance station B' },
    stationC: { id: uuidV7(), platform: 'macos', label: 'acceptance station C' },
    accountIds: entityIdFactory('synacc'),
    transactionIds: entityIdFactory('syntxn'),
    cardIds: entityIdFactory('syncard'),
  };

  let aborted = false;
  try {
    await protocolCases(harness, state);
    await seedCases(harness, state);
    await importCases(harness, state);
    await operationCases(harness, state);
    await idempotencyCases(harness, state);
    await pullCases(harness, state);
    await limitCases(harness, state);
    await atomicityCase(harness);
    await resetCases(harness, state);
  } catch (error) {
    aborted = true;
    console.error(
      `SYNC SUITE ABORTED (${describeHarnessError(error)}): ${redactSecrets(
        error instanceof Error ? error.message : String(error),
        harness.config,
      )}`,
    );
  }

  const results = harness.allResults();
  console.log('');
  console.log(
    config === null
      ? JSON.stringify(summary(config, results, guard), null, 2)
      : redactSecrets(
          JSON.stringify(summary(config, results, guard), null, 2),
          config,
        ),
  );
  const failed =
    aborted || results.some((result) => result.status !== 'PASS');
  return failed ? 1 : 0;
}
