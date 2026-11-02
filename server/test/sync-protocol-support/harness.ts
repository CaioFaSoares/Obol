// Hosted sync acceptance harness: guarded setup, bounded HTTP, real PocketBase
// inspection and per-case evidence records.
//
// The harness owns no product behavior. It creates synthetic input through the
// public BFF, reads committed state through the authenticated PocketBase SDK,
// and reports exactly what the deployment did.

import type PocketBase from 'pocketbase';

import {
  canonicalHash,
  sha256HashOfBytes,
  uuidV7,
  sameInstant,
  sameJson,
} from './canonical';
import { DeadlineExceededError } from './async';
import {
  BffClient,
  type HttpResponse,
} from './http';
import {
  EnvironmentGapError,
  IsolationRefusedError,
  displayUrl,
  readConfig,
  redactSecrets,
  type SyncHarnessConfig,
} from './config';
import {
  connectGuardedPocketBase,
  countRows,
  findVersion,
  listRows,
  readMeta,
  readOwnerId,
  readRow,
  readServerState,
  updateRow,
  type FinanceCollection,
  type ServerState,
} from './pocketbase';
import type { JsonRecord, Snapshot } from './fixtures';

export type CaseStatus = 'PASS' | 'FAIL' | 'UNRUN';

export interface CaseResult {
  readonly id: string;
  readonly status: CaseStatus;
  readonly facts: Record<string, unknown>;
  readonly failures: readonly string[];
}

export class AcceptanceFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcceptanceFailure';
  }
}

export interface Station {
  readonly id: string;
  readonly platform: 'ios' | 'macos' | 'windows';
  readonly label: string;
}

export interface WireOp {
  readonly protocolVersion: number;
  readonly stationId: string;
  readonly opId: string;
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly payload: Record<string, unknown>;
  readonly baseRevisions: Record<string, number>;
  readonly dependsOn: readonly string[];
  readonly clientCreatedAt: string;
  readonly effectiveAt: string;
  readonly payloadHash: string;
}

export interface OpInput {
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly payload: Record<string, unknown>;
  readonly baseRevisions?: Record<string, number>;
  readonly dependsOn?: readonly string[];
  readonly effectiveAt?: string;
  readonly clientCreatedAt?: string;
  readonly opId?: string;
  readonly stationId?: string;
}

export interface ServerIdentity {
  instanceId: string;
  dataEpoch: number;
  cursor: number;
  headHash: string;
  protocolMin: number;
  protocolMax: number;
}

interface CurrentCase {
  facts: Record<string, unknown>;
  failures: string[];
}

const ENVELOPE_HASH_FIELDS = [
  'protocolVersion',
  'stationId',
  'opId',
  'type',
  'entityType',
  'entityId',
  'payload',
  'baseRevisions',
  'dependsOn',
  'clientCreatedAt',
  'effectiveAt',
] as const;

function hashInputOf(envelope: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const field of ENVELOPE_HASH_FIELDS) {
    input[field] = envelope[field];
  }
  return input;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function bodyCode(body: unknown): string | null {
  const box = objectRecord(body);
  const code = box?.code;
  return typeof code === 'string' ? code : null;
}

function resultsOf(body: unknown): readonly unknown[] | null {
  const box = objectRecord(body);
  const results = box?.results;
  return Array.isArray(results) ? results : null;
}

function resultAt(body: unknown, index: number): Record<string, unknown> {
  const results = resultsOf(body);
  const candidate = results?.[index];
  const result = objectRecord(candidate);
  if (result === null) {
    throw new AcceptanceFailure(
      `The push response has no object result at index ${index}.`,
    );
  }
  return result;
}

export class SyncHarness {
  readonly config: SyncHarnessConfig;
  readonly bff: BffClient;
  pb!: PocketBase;
  token = '';
  ownerId = '';
  ownerFingerprint = '';
  serverName = '';
  server!: ServerIdentity;
  setupFacts: Record<string, unknown> = {};
  anchors: Record<string, unknown> = {};
  private readonly results: CaseResult[] = [];
  private byId = new Map<string, CaseResult>();
  private current: CurrentCase | null = null;

  constructor() {
    this.config = readConfig(process.env);
    this.bff = new BffClient(this.config.bffUrl, this.config.httpTimeoutMs);
  }

  // -----------------------------------------------------------------------
  // Guarded setup
  // -----------------------------------------------------------------------

  async initialize(): Promise<void> {
    this.pb = await connectGuardedPocketBase(this.config);

    const status = await this.bff.get('/api/setup/status');
    if (status.status !== 200 || status.json === null) {
      throw new EnvironmentGapError(
        `GET /api/setup/status returned ${status.status}; the BFF is not ready for the guarded run.`,
      );
    }
    const statusBox = objectRecord(status.json);
    if (statusBox === null) {
      throw new EnvironmentGapError(
        'GET /api/setup/status returned a non-object body.',
      );
    }
    let setupRequired = statusBox.setupRequired === true;
    this.setupFacts.setupStatusBefore = {
      setupRequired,
      serverName: typeof statusBox.serverName === 'string' ? statusBox.serverName : null,
    };
    if (setupRequired) {
      if (this.config.setupToken === null) {
        throw new EnvironmentGapError(
          'The guarded server has no owner and OBOL_SYNC_SETUP_TOKEN is absent; refusing to create an owner without the setup token.',
        );
      }
      const initialised = await this.bff.post('/api/setup/init', {
        setupToken: this.config.setupToken,
        email: this.config.ownerEmail,
        password: this.config.ownerPassword,
      });
      if (initialised.status !== 200) {
        throw new EnvironmentGapError(
          `POST /api/setup/init failed with HTTP ${initialised.status} (${bodyCode(initialised.json) ?? 'no code'}).`,
        );
      }
      this.setupFacts.ownerCreated = true;
      setupRequired = false;
    }

    const login = await this.bff.post('/api/auth/login', {
      email: this.config.ownerEmail,
      password: this.config.ownerPassword,
      transport: 'bearer',
    });
    if (login.status !== 200) {
      throw new EnvironmentGapError(
        `POST /api/auth/login failed with HTTP ${login.status} (${bodyCode(login.json) ?? 'no code'}).`,
      );
    }
    const loginBox = objectRecord(login.json);
    if (loginBox === null || typeof loginBox.token !== 'string' || loginBox.token.length === 0) {
      throw new EnvironmentGapError(
        'The bearer login response carried no token.',
      );
    }
    this.token = loginBox.token;
    if (typeof loginBox.serverName === 'string') {
      this.serverName = loginBox.serverName;
    }

    const ownerId = await readOwnerId(this.pb, this.config.ioTimeoutMs);
    if (ownerId === null) {
      throw new EnvironmentGapError(
        'The deployment has no owner record after setup/login.',
      );
    }
    this.ownerId = ownerId;
    this.ownerFingerprint = sha256HashOfBytes(
      new TextEncoder().encode(ownerId),
    );

    const meta = await readMeta(this.pb, this.config.ioTimeoutMs);
    if (meta === null) {
      throw new EnvironmentGapError(
        'obol_sync_meta is missing; the hosted BFF must initialize its central runtime before serving sync.',
      );
    }
    this.server = {
      instanceId: meta.instanceId,
      dataEpoch: meta.dataEpoch,
      cursor: meta.cursor,
      headHash: meta.headHash,
      protocolMin: meta.protocolMin,
      protocolMax: meta.protocolMax,
    };

    // Guarded baseline: the volume is the dedicated isolated stack (marker
    // proven above, OBOL_SYNC_ISOLATED=1). If a previous interrupted run left
    // synthetic rows, one explicit admin reset on this wholly own volume
    // restores the expected empty start. This is never a hidden cleanup of
    // someone else's data.
    const state = await readServerState(this.pb, this.config.ioTimeoutMs);
    const dirty =
      Object.values(state.finance).some((count) => count > 0) ||
      state.journalEvents > 0 ||
      state.versions > 0 ||
      state.operations > 0 ||
      state.importReceipts > 0;
    if (dirty) {
      const reset = await this.bff.post(
        '/api/admin/reset',
        { confirm: 'LIMPAR' },
        this.token,
      );
      if (reset.status !== 200) {
        throw new EnvironmentGapError(
          `The guarded baseline reset failed with HTTP ${reset.status}.`,
        );
      }
      const refreshed = await readMeta(this.pb, this.config.ioTimeoutMs);
      if (refreshed === null) {
        throw new EnvironmentGapError(
          'obol_sync_meta disappeared during the baseline reset.',
        );
      }
      this.server = {
        instanceId: refreshed.instanceId,
        dataEpoch: refreshed.dataEpoch,
        cursor: refreshed.cursor,
        headHash: refreshed.headHash,
        protocolMin: refreshed.protocolMin,
        protocolMax: refreshed.protocolMax,
      };
      this.setupFacts.baselineReset = {
        beforeEpoch: meta.dataEpoch,
        afterEpoch: refreshed.dataEpoch,
        reason: 'previous synthetic rows on the dedicated isolated volume',
      };
    } else {
      this.setupFacts.baselineReset = false;
    }

    this.setupFacts.ownerFingerprint = this.ownerFingerprint;
    this.setupFacts.dataEpoch = this.server.dataEpoch;
    this.setupFacts.cursor = this.server.cursor;
    this.setupFacts.headHash = this.server.headHash;
    this.setupFacts.protocolMin = this.server.protocolMin;
    this.setupFacts.protocolMax = this.server.protocolMax;
    this.setupFacts.appNameGuard = 'exact isolated marker verified via raw PocketBase settings';
    this.setupFacts.datasource = displayUrl(this.config.pbUrl);
  }

  // -----------------------------------------------------------------------
  // Case recording
  // -----------------------------------------------------------------------

  fact(key: string, value: unknown): void {
    if (this.current === null) {
      throw new Error('A fact was recorded outside a case.');
    }
    this.current.facts[key] = value;
  }

  expect(condition: unknown, message: string): void {
    if (!condition) this.fail(message);
  }

  expectEqual(actual: unknown, expected: unknown, label: string): void {
    const shown = (value: unknown): unknown =>
      value === undefined ? '<undefined>' : value;
    if (!sameJson(shown(actual), shown(expected))) {
      this.fail(
        `${label}: expected ${JSON.stringify(shown(expected))} actual ${JSON.stringify(shown(actual))}`,
      );
    }
  }

  expectStatus(response: HttpResponse, status: number, label: string): void {
    if (response.status !== status) {
      this.fail(
        `${label}: expected HTTP ${status} actual ${response.status} (${bodyCode(response.json) ?? response.text.slice(0, 240)})`,
      );
    }
  }

  expectCode(response: HttpResponse, status: number, code: string, label: string): void {
    this.expectStatus(response, status, label);
    if (bodyCode(response.json) !== code) {
      this.fail(
        `${label}: expected code ${code} actual ${bodyCode(response.json) ?? 'none'} (${response.text.slice(0, 240)})`,
      );
    }
  }

  fail(message: string): void {
    if (this.current === null) throw new AcceptanceFailure(message);
    this.current.failures.push(message);
  }

  allResults(): readonly CaseResult[] {
    return this.results;
  }

  async state(): Promise<ServerState> {
    return await readServerState(this.pb, this.config.ioTimeoutMs);
  }

  private async safeState(): Promise<ServerState | { error: string }> {
    try {
      return await this.state();
    } catch (error) {
      return {
        error: redactSecrets(
          error instanceof Error ? error.message : String(error),
          this.config,
        ),
      };
    }
  }

  async run(
    id: string,
    requires: readonly string[],
    body: () => Promise<void>,
  ): Promise<CaseResult> {
    if (this.byId.has(id)) {
      throw new Error(`Duplicate case id ${id}.`);
    }
    const blocked = requires.filter(
      (dependency) => this.byId.get(dependency)?.status !== 'PASS',
    );
    if (blocked.length > 0) {
      const result: CaseResult = {
        id,
        status: 'UNRUN',
        facts: { blockedBy: blocked },
        failures: [`not executed: prerequisite case(s) ${blocked.join(', ')} did not pass`],
      };
      this.results.push(result);
      this.byId.set(id, result);
      this.print(result);
      return result;
    }

    const before = await this.safeState();
    this.current = { facts: {}, failures: [] };
    try {
      await body();
    } catch (error) {
      if (error instanceof AcceptanceFailure) {
        this.fail(error.message);
      } else if (error instanceof DeadlineExceededError) {
        this.fail(`${error.label} timed out after ${error.timeoutMs} ms.`);
      } else if (error instanceof IsolationRefusedError) {
        this.fail(error.message);
      } else if (error instanceof EnvironmentGapError) {
        this.fail(error.message);
      } else {
        this.fail(
          `unexpected ${error instanceof Error ? error.name : typeof error}: ${redactSecrets(
            error instanceof Error ? error.message : String(error),
            this.config,
          )}`,
        );
      }
    }
    const after = await this.safeState();
    const result: CaseResult = {
      id,
      status: this.current.failures.length === 0 ? 'PASS' : 'FAIL',
      facts: { ...this.current.facts, before, after },
      failures: [...this.current.failures],
    };
    this.current = null;
    this.results.push(result);
    this.byId.set(id, result);
    this.print(result);
    return result;
  }

  private print(result: CaseResult): void {
    const text = JSON.stringify({
      facts: result.facts,
      failures: result.failures,
    });
    console.log(`RESULT ${result.id} ${result.status} ${redactSecrets(text, this.config)}`);
  }

  // -----------------------------------------------------------------------
  // Server identity and read helpers
  // -----------------------------------------------------------------------

  async refreshIdentity(): Promise<ServerIdentity> {
    const meta = await readMeta(this.pb, this.config.ioTimeoutMs);
    if (meta === null) {
      throw new AcceptanceFailure('obol_sync_meta is missing.');
    }
    this.server = {
      instanceId: meta.instanceId,
      dataEpoch: meta.dataEpoch,
      cursor: meta.cursor,
      headHash: meta.headHash,
      protocolMin: meta.protocolMin,
      protocolMax: meta.protocolMax,
    };
    return this.server;
  }

  async revisionOf(entityType: string, entityId: string): Promise<number> {
    const version = await findVersion(
      this.pb,
      entityType,
      entityId,
      this.config.ioTimeoutMs,
    );
    if (version === null) {
      throw new AcceptanceFailure(
        `${entityType}:${entityId} has no server revision to declare.`,
      );
    }
    return version.revision;
  }

  async financeRow(
    collection: FinanceCollection,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    return await readRow(
      this.pb,
      collection,
      id,
      this.config.ioTimeoutMs,
    );
  }

  async rows(
    collection: string,
    filter?: string,
  ): Promise<Array<Record<string, unknown>>> {
    return await listRows(
      this.pb,
      collection,
      filter === undefined ? {} : { filter },
      this.config.ioTimeoutMs,
    );
  }

  async count(collection: string): Promise<number> {
    return await countRows(this.pb, collection, this.config.ioTimeoutMs);
  }

  async overwriteRow(
    collection: string,
    id: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    await updateRow(
      this.pb,
      collection,
      id,
      body,
      this.config.ioTimeoutMs,
    );
  }

  // -----------------------------------------------------------------------
  // Sync wire helpers
  // -----------------------------------------------------------------------

  async handshake(
    station: Station,
    overrides: Record<string, unknown> = {},
  ): Promise<HttpResponse> {
    return await this.bff.post(
      '/api/sync/handshake',
      {
        protocolVersion: 1,
        stationId: station.id,
        platform: station.platform,
        deviceLabel: station.label,
        clientCursor: null,
        clientCursorHash: null,
        serverInstanceId: null,
        dataEpoch: null,
        ...overrides,
      },
      this.token,
    );
  }

  async push(
    station: Station,
    ops: readonly WireOp[],
    overrides: Record<string, unknown> = {},
  ): Promise<HttpResponse> {
    return await this.bff.post(
      '/api/sync/push',
      {
        protocolVersion: 1,
        stationId: station.id,
        serverInstanceId: this.server.instanceId,
        dataEpoch: this.server.dataEpoch,
        ops,
        ...overrides,
      },
      this.token,
    );
  }

  async pull(cursor: number, limit: number): Promise<HttpResponse> {
    return await this.bff.get(
      `/api/sync/pull?cursor=${cursor}&limit=${limit}`,
      this.token,
    );
  }

  makeOp(station: Station, input: OpInput): WireOp {
    const effectiveAt = input.effectiveAt ?? new Date().toISOString();
    const envelope = {
      protocolVersion: 1,
      stationId: input.stationId ?? station.id,
      opId: input.opId ?? uuidV7(),
      type: input.type,
      entityType: input.entityType,
      entityId: input.entityId,
      payload: input.payload,
      baseRevisions: input.baseRevisions ?? {},
      dependsOn: input.dependsOn ?? [],
      clientCreatedAt: input.clientCreatedAt ?? effectiveAt,
      effectiveAt,
    };
    return {
      ...envelope,
      payloadHash: canonicalHash(hashInputOf(envelope)),
    };
  }

  /** Rebuilds one envelope with changed hashed fields and a fresh hash. */
  remint(op: WireOp, changes: Partial<WireOp>): WireOp {
    const changed = { ...op, ...changes };
    const envelope = {
      protocolVersion: changed.protocolVersion,
      stationId: changed.stationId,
      opId: changed.opId,
      type: changed.type,
      entityType: changed.entityType,
      entityId: changed.entityId,
      payload: changed.payload,
      baseRevisions: changed.baseRevisions,
      dependsOn: changed.dependsOn,
      clientCreatedAt: changed.clientCreatedAt,
      effectiveAt: changed.effectiveAt,
    };
    return {
      ...envelope,
      payloadHash: canonicalHash(hashInputOf(envelope)),
    };
  }

  seedBody(station: Station, snapshot: Snapshot): Record<string, unknown> {
    return {
      protocolVersion: 1,
      stationId: station.id,
      serverInstanceId: this.server.instanceId,
      dataEpoch: this.server.dataEpoch,
      snapshot,
    };
  }

  importBody(
    station: Station,
    snapshot: Snapshot,
    importId: string,
  ): Record<string, unknown> {
    const six = {
      protocolVersion: 1,
      stationId: station.id,
      serverInstanceId: this.server.instanceId,
      dataEpoch: this.server.dataEpoch,
      importId,
      snapshot,
    };
    return { ...six, payloadHash: canonicalHash(six) };
  }

  async seed(station: Station, snapshot: Snapshot): Promise<HttpResponse> {
    return await this.bff.post(
      '/api/sync/seed',
      this.seedBody(station, snapshot),
      this.token,
    );
  }

  async importSnapshot(
    station: Station,
    snapshot: Snapshot,
    importId: string,
  ): Promise<{ response: HttpResponse; body: Record<string, unknown> }> {
    const body = this.importBody(station, snapshot, importId);
    const response = await this.bff.post('/api/sync/import', body, this.token);
    return { response, body };
  }

  // -----------------------------------------------------------------------
  // Assertions on sync replies and committed state
  // -----------------------------------------------------------------------

  expectApplied(response: HttpResponse, index: number, label: string): void {
    this.expectStatus(response, 200, label);
    const result = resultAt(response.json, index);
    if (result.status !== 'applied') {
      this.fail(
        `${label}: expected result applied actual ${JSON.stringify(result)}`,
      );
    }
  }

  expectRejected(
    response: HttpResponse,
    index: number,
    code: string,
    label: string,
  ): void {
    this.expectStatus(response, 200, label);
    const result = resultAt(response.json, index);
    if (result.status !== 'rejected' || result.code !== code) {
      this.fail(
        `${label}: expected rejected/${code} actual ${JSON.stringify(result)}`,
      );
    }
  }

  expectBlocked(response: HttpResponse, index: number, label: string): void {
    this.expectStatus(response, 200, label);
    const result = resultAt(response.json, index);
    if (result.status !== 'blocked' || result.code !== 'DEPENDENCY_NOT_ACCEPTED') {
      this.fail(
        `${label}: expected blocked/DEPENDENCY_NOT_ACCEPTED actual ${JSON.stringify(result)}`,
      );
    }
  }

  /** Compares every declared field of one snapshot row with PocketBase. */
  async expectDeclaredRow(
    collection: FinanceCollection,
    declared: JsonRecord,
    label: string,
  ): Promise<void> {
    const id = declared.id;
    if (typeof id !== 'string') {
      this.fail(`${label}: the declared row has no id.`);
      return;
    }
    const stored = await this.financeRow(collection, id);
    if (stored === null) {
      this.fail(`${label}: ${collection}/${id} was not stored.`);
      return;
    }
    for (const [field, expected] of Object.entries(declared)) {
      if (field === 'id') continue;
      const actual = stored[field];
      if (field === 'expected_date' || field === 'realized_date' || field === 'purchase_date' || field === 'due_date' || field === 'end_date') {
        if (actual === '' && expected === undefined) continue;
        if (!sameInstant(actual, expected)) {
          this.fail(
            `${label}: ${collection}/${id}.${field} expected ${JSON.stringify(expected)} actual ${JSON.stringify(actual)}`,
          );
        }
        continue;
      }
      if (!sameJson(actual ?? null, expected ?? null)) {
        this.fail(
          `${label}: ${collection}/${id}.${field} expected ${JSON.stringify(expected)} actual ${JSON.stringify(actual)}`,
        );
      }
    }
  }

  /** Asserts the exact commit-group shape of the journal tail. */
  async expectCommitGroup(
    label: string,
    firstSeq: number,
    size: number,
    expectedOrigin: string,
  ): Promise<Record<string, unknown>> {
    const events = await this.rows(
      'obol_sync_changes',
      `seq >= ${firstSeq}`,
    );
    events.sort((left, right) => Number(left.seq) - Number(right.seq));
    if (events.length !== size) {
      this.fail(
        `${label}: expected ${size} journal events from seq ${firstSeq}, found ${events.length}.`,
      );
      return { events: events.length };
    }
    const commitId = events[0]!['commitId'];
    const fact: Record<string, unknown> = {
      firstSeq,
      lastSeq: Number(events[size - 1]!['seq']),
      commitId,
      commitSize: size,
      origin: expectedOrigin,
    };
    let previousHash = firstSeq === 1 ? '' : String(events[0]!['prevHash']);
    for (const [index, event] of events.entries()) {
      if (Number(event['seq']) !== firstSeq + index) {
        this.fail(`${label}: non-contiguous seq at index ${index}.`);
      }
      if (Number(event['commitIndex']) !== index) {
        this.fail(`${label}: commitIndex ${String(event['commitIndex'])} at ${index}.`);
      }
      if (Number(event['commitSize']) !== size) {
        this.fail(`${label}: commitSize ${String(event['commitSize'])} instead of ${size}.`);
      }
      if (event['commitId'] !== commitId) {
        this.fail(`${label}: commit id changed inside the group.`);
      }
      if (event['origin'] !== expectedOrigin) {
        this.fail(`${label}: origin ${String(event['origin'])} instead of ${expectedOrigin}.`);
      }
      if (index > 0 && event['prevHash'] !== previousHash) {
        this.fail(`${label}: event ${String(event['seq'])} does not link to the previous chain hash.`);
      }
      previousHash = String(event['chainHash']);
    }
    fact['headHash'] = previousHash;
    return fact;
  }

}

export function describeUnexpectedError(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}
