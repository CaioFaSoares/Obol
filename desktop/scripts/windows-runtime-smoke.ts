// Native Windows x64 runtime acceptance for the packaged Obol desktop app.
//
// This is release evidence, not a build check. It installs the real Electrobun
// setup executable produced by this job, launches the installed app on the
// native runner, drives the real WebView UI and the real `window.obol` bridge,
// runs a dedicated central BFF + PocketBase pair, and records what it actually
// observed. It never substitutes a mock transport, a headless Chromium, or a
// manual file extraction for a real install.
//
// Hard refusals (not skips):
//   * only Windows x64; any other host exits non-zero before touching anything;
//   * `OBOL_WINDOWS_SMOKE_ISOLATED=1` must be set by the caller;
//   * the evidence base (`OBOL_WINDOWS_SMOKE_OUT`, default `$RUNNER_TEMP`) must
//     resolve inside the runner/user temp directory, and every profile, server
//     data directory and artifact lives under a unique run directory below it;
//   * the installer must be the one this job built, with its adjacent
//     `.installer` payload; extracting the ZIP into an install location instead
//     of running the setup executable is never accepted as an install.
//
// CDP environment boundary (verified against Electrobun 2.0.5 source): the
// Windows wrapper calls `put_AdditionalBrowserArguments(...)` with a fixed
// string, and WebView2 ignores `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` whenever
// the host supplies its own arguments. The smoke still launches the app with the
// documented test environment (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=
// --remote-debugging-port=... --remote-debugging-address=127.0.0.1`) and treats
// an unreachable loopback CDP endpoint as a failed step with a native
// screenshot, never as a pass or a skip.
//
// Everything the report carries is synthetic: no user data, no password, no
// token, no session cookie, no PocketBase credential. Child output is sanitized
// before it is written to the evidence directory.

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { SYNC_PROTOCOL_VERSION } from '../../server/src/domain/sync/SyncProtocol';
import {
  parseLocalAccountProfile,
  verifyLocalAccount
} from '../electrobun/bun/local-auth';

const DESKTOP_ROOT = join(import.meta.dir, '..');
const REPO_ROOT = join(DESKTOP_ROOT, '..');
const PROBE_PATH = join(import.meta.dir, 'windows-runtime-smoke', 'windows-probe.ps1');
const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL = join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const TAR_EXE = join(SYSTEM_ROOT, 'System32', 'tar.exe');
const TASKKILL_EXE = join(SYSTEM_ROOT, 'System32', 'taskkill.exe');

const LOCAL_POCKETBASE_URL = 'http://127.0.0.1:13090';
const LOCAL_POCKETBASE_EMAIL = 'obol@localhost.invalid';
const LOG_STREAM_LIMIT = 200_000;

type ChildProcess = Bun.Subprocess;

type StepStatus = 'passed' | 'failed' | 'unrun';

interface StepRecord {
  readonly id: string;
  status: StepStatus;
  readonly startedAt: string;
  finishedAt: string | null;
  detail: string | null;
  error: string | null;
}

interface ProcessEntry {
  readonly processId: number;
  readonly parentProcessId: number;
  readonly executablePath: string | null;
}

interface WindowEntry {
  readonly processId: number;
  readonly title: string;
  readonly visible: boolean;
}

interface AccountRecord {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly initial_balance: number;
}

interface TransactionRecord {
  readonly id: string;
  readonly title: string;
  readonly amount: number;
  readonly type: string;
  readonly status: string;
}

interface OutboxOperation {
  readonly opId: string;
  readonly payloadHash: string;
  readonly status: string;
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly effectiveAt: string;
  readonly attempts: number;
}

interface StationStateRecord {
  readonly stationId?: string;
  readonly serverInstanceId?: string;
  readonly dataEpoch?: number;
  readonly cursor?: number;
  readonly lastChainHash?: string;
  readonly mode?: string;
}

interface HandshakeIdentity {
  readonly serverInstanceId: string;
  readonly ownerFingerprint: string;
  readonly dataEpoch: number;
  readonly cursor: number;
  readonly cursorHash: string;
  readonly headHash: string;
  readonly hasFinancialData: boolean;
  readonly serverName: string;
}

interface DesktopStatus {
  readonly phase: string;
  readonly isPaired: boolean;
  readonly stationId: string;
  readonly detail: string | null;
  readonly pendingCount: number;
  readonly conflictCount: number;
  readonly lastSyncAt: string | null;
}

interface DesktopOutboxRow {
  readonly opId: string;
  readonly type: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly status: string;
  readonly effectiveAt: string;
  readonly attempts: number;
}

interface DesktopPreview {
  readonly serverName: string;
  readonly serverAddress: string;
  readonly hasServerData: boolean;
  readonly localEntityCount: number;
  readonly localOperationCount: number;
  readonly isRePairing: boolean;
  readonly hasLocalData: boolean;
  readonly actions: ReadonlyArray<{ readonly id: string; readonly label: string; readonly isDestructive: boolean }>;
  readonly warnings: readonly string[];
}

interface UpdaterState {
  readonly status: string;
  readonly message: string;
  readonly currentVersion: string;
  readonly availableVersion: string;
  readonly updateAvailable: boolean;
  readonly updateReady: boolean;
  readonly progress: number | null;
  readonly error: string | null;
}

interface ApiCallResult {
  readonly status: number;
  readonly body: string;
}

interface CentralService {
  readonly child: ChildProcess;
  readonly stdout: LogSink;
  readonly stderr: LogSink;
  readonly pumps: Promise<unknown>;
  readonly label: string;
  readonly path: string;
  readonly executablePath: string;
}

interface AppSession {
  readonly rootPid: number;
  readonly cdp: CdpClient | null;
}

interface AppLogPump {
  readonly sinks: readonly LogSink[];
  readonly pumps: Promise<unknown>;
  readonly path: string;
}

interface SmokeReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly ok: boolean;
  readonly failure: string | null;
  readonly platform: { readonly platform: string; readonly arch: string };
  readonly windows: unknown;
  readonly webview2: unknown;
  readonly installer: {
    readonly path: string;
    readonly fileName: string;
    readonly sha256: string | null;
    readonly bytes: number | null;
    readonly identifier: string | null;
    readonly channel: string | null;
    readonly builtAppVersion: string | null;
  };
  readonly isolation: {
    readonly runDirectory: string;
    readonly evidenceDirectory: string;
    readonly localAppData: string;
    readonly appId: string;
    readonly centralDataDirectory: string;
  };
  readonly pids: Record<string, number | number[] | null>;
  readonly steps: readonly StepRecord[];
  readonly finance: Record<string, unknown>;
  readonly operations: Record<string, unknown>;
  readonly sync: Record<string, unknown>;
  readonly updater: Record<string, unknown>;
  readonly observations: Record<string, unknown>;
  readonly artifacts: readonly string[];
  readonly boundaries: readonly string[];
}

const STEP_IDS = [
  'preflight',
  'installer.unpack',
  'installer.run',
  'installer.verify',
  'app.launch',
  'cdp.attach',
  'ui.first-run',
  'finance.local',
  'app.restart',
  'central.start',
  'pair.preview',
  'pair.import',
  'server.verify-import',
  'offline.stop-central',
  'offline.write',
  'outbox.freeze',
  'app.restart-offline',
  'outbox.verify-frozen',
  'central.restart',
  'sync.reconnect',
  'server.verify-final',
  'sync.cursor',
  'updater.check',
  'cleanup'
] as const;

type StepId = (typeof STEP_IDS)[number];

const steps: StepRecord[] = [];
const secrets: string[] = [];
const appLogPumps: AppLogPump[] = [];

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rememberSecret(value: string): string {
  if (value.length >= 4 && !secrets.includes(value)) secrets.push(value);
  return value;
}

function sanitize(value: string): string {
  let result = value;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    result = result.split(secret).join('<redacted>');
  }
  return result;
}

function syntheticToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Buffer.from(buffer).toString('base64url');
}

function syntheticHex(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, value => value.toString(16).padStart(2, '0')).join('');
}

async function step<T>(id: StepId, operation: () => Promise<T>): Promise<T> {
  const record: StepRecord = {
    id,
    status: 'passed',
    startedAt: nowIso(),
    finishedAt: null,
    detail: null,
    error: null
  };
  steps.push(record);
  try {
    const value = await operation();
    record.finishedAt = nowIso();
    return value;
  } catch (error) {
    record.status = 'failed';
    record.error = sanitize(errorMessage(error));
    record.finishedAt = nowIso();
    throw error;
  }
}

function describeStep(id: StepId, detail: string): void {
  const record = steps.find(entry => entry.id === id);
  if (record) record.detail = sanitize(detail);
}

function insideDirectory(parent: string, child: string): boolean {
  const parentPath = resolve(parent);
  const childPath = resolve(child);
  return childPath === parentPath || childPath.startsWith(parentPath + sep);
}

async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(path).stream()) {
    hasher.update(chunk);
  }
  return hasher.digest('hex');
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const { promise: timeout, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => {
    reject(new Error(`${label} did not finish within ${timeoutMs}ms`));
  }, timeoutMs);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

function arrayOf(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not a JSON array`);
  return value;
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === 'string' ? field : null;
}

function numberField(value: Record<string, unknown>, key: string): number | null {
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : null;
}

function readableOf(child: ChildProcess): ReadableStream<Uint8Array> | undefined {
  const stream: unknown = child.stdout;
  return stream instanceof ReadableStream ? stream : undefined;
}

function readableErrorOf(child: ChildProcess): ReadableStream<Uint8Array> | undefined {
  const stream: unknown = child.stderr;
  return stream instanceof ReadableStream ? stream : undefined;
}

// ---------------------------------------------------------------------------
// Sanitized child output
// ---------------------------------------------------------------------------

class LogSink {
  private readonly decoder = new TextDecoder();
  private text = '';
  private truncated = false;

  append(chunk: Uint8Array): void {
    if (this.text.length >= LOG_STREAM_LIMIT) {
      this.truncated = true;
      return;
    }
    this.text += this.decoder.decode(chunk, { stream: true });
  }

  finish(): string {
    const tail = this.decoder.decode();
    if (tail.length > 0 && this.text.length < LOG_STREAM_LIMIT) this.text += tail;
    return sanitize(this.text) + (this.truncated ? '\n<log truncated>\n' : '');
  }
}

async function pumpStream(
  stream: ReadableStream<Uint8Array> | undefined,
  sink: LogSink
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) sink.append(value);
    }
  } finally {
    reader.releaseLock();
  }
}

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runCommand(
  argv: readonly string[],
  options: {
    readonly label: string;
    readonly cwd?: string;
    readonly env?: Record<string, string | undefined>;
    readonly timeoutMs?: number;
    readonly logPath?: string;
  }
): Promise<CommandResult> {
  const child = Bun.spawn([...argv], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  });
  const stdoutSink = new LogSink();
  const stderrSink = new LogSink();
  const pumps = Promise.all([
    pumpStream(readableOf(child), stdoutSink),
    pumpStream(readableErrorOf(child), stderrSink)
  ]);
  try {
    const code = await withTimeout(
      child.exited,
      options.timeoutMs ?? 120_000,
      options.label
    );
    await pumps;
    const stdout = stdoutSink.finish();
    const stderr = stderrSink.finish();
    if (options.logPath) {
      await writeFile(
        options.logPath,
        `# ${options.label}\nexit=${code}\n\n[stdout]\n${stdout}\n[stderr]\n${stderr}\n`,
        'utf8'
      );
    }
    return { code, stdout, stderr };
  } catch (error) {
    await killOwnedProcess(child.pid, argv[0]);
    await child.exited.catch(() => undefined);
    await pumps.catch(() => undefined);
    throw error;
  }
}

async function flushAppLogs(): Promise<void> {
  for (const entry of appLogPumps.splice(0)) {
    await withTimeout(Promise.resolve(entry.pumps), 30_000, 'the app log pumps').catch(() => undefined);
    await writeFile(
      entry.path,
      `# Obol app process log\n${entry.sinks.map(sink => sink.finish()).join('\n---\n')}\n`,
      'utf8'
    );
  }
}

// ---------------------------------------------------------------------------
// Windows probes and owned process control
//
// PIDs are always resolved from a process table this run just read and are
// killed immediately, so an image name alone never selects a process.
// ---------------------------------------------------------------------------

async function probe(
  action: 'system' | 'processes' | 'windows' | 'screenshot' | 'webview2',
  extra: readonly string[] = []
): Promise<unknown> {
  const result = await runCommand(
    [POWERSHELL, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PROBE_PATH, '-Action', action, ...extra],
    { label: `Windows probe ${action}`, timeoutMs: 60_000 }
  );
  if (result.code !== 0) {
    throw new Error(`Windows probe ${action} failed: ${result.stderr || result.stdout}`.trim());
  }
  const text = result.stdout.replace(/^\uFEFF/, '').trim();
  if (text.length === 0) throw new Error(`Windows probe ${action} produced no output`);
  return JSON.parse(text) as unknown;
}

async function captureNativeScreenshot(path: string): Promise<void> {
  const outcome = recordOf(await probe('screenshot', ['-Path', path]), 'screenshot probe');
  if (stringField(outcome, 'path') !== path) {
    throw new Error('The native screenshot probe did not confirm the written file');
  }
}

async function listProcesses(): Promise<ProcessEntry[]> {
  const body = recordOf(await probe('processes'), 'process probe');
  return arrayOf(body.items ?? [], 'process probe items').map(item => {
    const entry = recordOf(item, 'process entry');
    const processId = numberField(entry, 'processId');
    const parentProcessId = numberField(entry, 'parentProcessId');
    if (processId === null || parentProcessId === null) {
      throw new Error('The process probe returned a non-numeric process id');
    }
    return {
      processId,
      parentProcessId,
      executablePath: stringField(entry, 'executablePath')
    };
  });
}

async function listWindows(): Promise<WindowEntry[]> {
  const body = recordOf(await probe('windows'), 'window probe');
  return arrayOf(body.items ?? [], 'window probe items').map(item => {
    const entry = recordOf(item, 'window entry');
    const processId = numberField(entry, 'processId');
    const title = stringField(entry, 'title');
    const visible = entry.visible;
    if (processId === null || title === null || typeof visible !== 'boolean') {
      throw new Error('The window probe returned an invalid entry');
    }
    return { processId, title, visible };
  });
}

function descendantProcessIds(rootPid: number, processes: readonly ProcessEntry[]): number[] {
  const pending = [rootPid];
  const seen = new Set<number>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const entry of processes) {
      if (entry.parentProcessId === current && !seen.has(entry.processId)) {
        pending.push(entry.processId);
      }
    }
  }
  return [...seen];
}

function processesUnder(appDir: string, processes: readonly ProcessEntry[]): number[] {
  if (appDir.length === 0) return [];
  const prefix = resolve(appDir).toLowerCase() + sep.toLowerCase();
  return processes
    .filter(entry => entry.executablePath !== null && entry.executablePath.toLowerCase().startsWith(prefix))
    .map(entry => entry.processId);
}

async function pidExists(pid: number): Promise<boolean> {
  return (await listProcesses()).some(entry => entry.processId === pid);
}

async function killProcessTree(pid: number): Promise<void> {
  if (!(await pidExists(pid))) return;
  const result = await runCommand(
    [TASKKILL_EXE, '/PID', String(pid), '/T', '/F'],
    { label: `taskkill ${pid}`, timeoutMs: 30_000 }
  );
  if (result.code !== 0 && (await pidExists(pid))) {
    throw new Error(`taskkill could not stop process ${pid}: ${result.stderr || result.stdout}`.trim());
  }
}

/**
 * Stops a PID this run started only after re-reading the process table and
 * matching the executable, so a recycled PID can never select an unrelated
 * program. A missing process is already stopped.
 */
async function killOwnedProcess(pid: number, expectedExecutable: string): Promise<void> {
  const entry = (await listProcesses()).find(candidate => candidate.processId === pid);
  if (!entry) return;
  if (entry.executablePath !== null && resolve(entry.executablePath).toLowerCase() !== resolve(expectedExecutable).toLowerCase()) {
    return;
  }
  await killProcessTree(pid);
}

async function waitForNoProcess(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(500);
  }
  throw new Error(`${label} did not settle within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// HTTP helpers (bounded, loopback)
// ---------------------------------------------------------------------------

interface HttpOutcome {
  readonly status: number;
  readonly body: unknown;
}

async function fetchJson(
  url: string,
  options: { readonly method?: string; readonly body?: unknown; readonly token?: string; readonly timeoutMs?: number } = {}
): Promise<HttpOutcome> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'error',
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000)
  });
  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed };
}

async function waitForHttpJson(
  url: string,
  timeoutMs: number,
  label: string
): Promise<HttpOutcome> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const outcome = await fetchJson(url, { timeoutMs: 5_000 });
      if (outcome.status >= 200 && outcome.status < 300) return outcome;
      lastError = `HTTP ${outcome.status}: ${JSON.stringify(outcome.body)}`;
    } catch (error) {
      lastError = errorMessage(error);
    }
    await Bun.sleep(500);
  }
  throw new Error(`${label} was not reachable within ${timeoutMs}ms (${sanitize(lastError)})`);
}

async function portIsClosed(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, {
      redirect: 'error',
      signal: AbortSignal.timeout(1_000)
    });
    return false;
  } catch {
    return true;
  }
}

async function reservePort(): Promise<number> {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('ok')
  });
  const port = server.port;
  server.stop(true);
  if (port === undefined) {
    throw new Error('The OS did not assign a port for the reservation server.');
  }
  return port;
}

// ---------------------------------------------------------------------------
// CDP client (loopback only)
// ---------------------------------------------------------------------------

interface CdpTarget {
  readonly id: string;
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

interface CdpWaiter {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: Timer;
}

class CdpClient {
  private readonly socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, CdpWaiter>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', event => this.handleMessage(event));
    socket.addEventListener('close', () => this.failAll(new Error('The CDP socket closed')));
  }

  static async connect(url: string, timeoutMs: number): Promise<CdpClient> {
    const socket = new WebSocket(url);
    const opened = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // The socket never opened; nothing to release.
      }
      opened.reject(new Error(`CDP WebSocket did not open within ${timeoutMs}ms`));
    }, timeoutMs);
    const onOpen = (): void => {
      clearTimeout(timer);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      opened.resolve();
    };
    const onError = (): void => {
      clearTimeout(timer);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      opened.reject(new Error('CDP WebSocket failed to open'));
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
    await opened.promise;
    return new CdpClient(socket);
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    const waiter = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      waiter.reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    this.pending.set(id, { resolve: waiter.resolve, reject: waiter.reject, timer });
    try {
      this.socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      this.pending.delete(id);
      clearTimeout(timer);
      waiter.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return waiter.promise;
  }

  async evaluate<T>(expression: string, timeoutMs = 30_000): Promise<T> {
    const result = (await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      timeoutMs
    )) as {
      result?: { value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'The page evaluation failed'
      );
    }
    return result.result?.value as T;
  }

  close(): void {
    try {
      this.socket.close();
    } catch {
      // Already closed.
    }
    this.failAll(new Error('CDP client closed'));
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data !== 'string') return;
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(event.data) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') return;
    const waiter = this.pending.get(message.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message ?? 'CDP error'));
    else waiter.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }
}

async function waitForCdpTarget(cdpPort: number, timeoutMs: number): Promise<CdpTarget> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const outcome = await fetchJson(`http://127.0.0.1:${cdpPort}/json/list`, { timeoutMs: 5_000 });
      const targets = arrayOf(outcome.body, 'CDP target list').map(item => recordOf(item, 'CDP target'));
      const page = targets.find(target => {
        const type = stringField(target, 'type');
        const socketUrl = stringField(target, 'webSocketDebuggerUrl');
        return type === 'page' && socketUrl !== null && socketUrl.length > 0;
      });
      if (page) {
        const socketUrl = stringField(page, 'webSocketDebuggerUrl');
        if (socketUrl === null || socketUrl.length === 0) {
          throw new Error('The CDP page target has no WebSocket debugger URL');
        }
        return {
          id: stringField(page, 'id') ?? '',
          type: stringField(page, 'type') ?? '',
          url: stringField(page, 'url') ?? '',
          webSocketDebuggerUrl: socketUrl
        };
      }
      lastError = `no page target among ${targets.map(target => stringField(target, 'type') ?? 'unknown').join(',') || 'none'}`;
    } catch (error) {
      lastError = errorMessage(error);
    }
    await Bun.sleep(500);
  }
  throw new Error(`No loopback CDP page target on 127.0.0.1:${cdpPort} within ${timeoutMs}ms (${sanitize(lastError)})`);
}

// ---------------------------------------------------------------------------
// In-page UI and bridge helpers
// ---------------------------------------------------------------------------

async function waitForBoolean(
  cdp: CdpClient,
  expression: string,
  timeoutMs: number,
  label: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      if (await cdp.evaluate<boolean>(`Boolean(${expression})`, 15_000)) return;
    } catch (error) {
      lastError = errorMessage(error);
    }
    await Bun.sleep(400);
  }
  const alertText = await cdp
    .evaluate<string>(
      `(() => Array.from(document.querySelectorAll('[role="alert"]')).map(node => (node.textContent || '').trim()).filter(Boolean).join(' | '))()`,
      5_000
    )
    .catch(() => '');
  throw new Error(
    `${label} did not become true within ${timeoutMs}ms${lastError ? ` (${sanitize(lastError)})` : ''}${alertText ? `; page alerts: ${sanitize(alertText)}` : ''}`
  );
}

async function setInputValue(cdp: CdpClient, selector: string, value: string): Promise<void> {
  const applied = await cdp.evaluate<boolean>(
    `(() => {
       const input = document.querySelector(${JSON.stringify(selector)});
       if (!(input instanceof HTMLInputElement)) return false;
       const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
       if (!setter) return false;
       setter.call(input, ${JSON.stringify(value)});
       input.dispatchEvent(new Event('input', { bubbles: true }));
       return true;
     })()`,
    15_000
  );
  if (!applied) throw new Error(`The expected input ${selector} is not present`);
}

async function setPasswordValue(cdp: CdpClient, index: number, value: string): Promise<void> {
  const applied = await cdp.evaluate<boolean>(
    `(() => {
       const input = document.querySelectorAll('input[type="password"]')[${index}];
       if (!(input instanceof HTMLInputElement)) return false;
       const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
       if (!setter) return false;
       setter.call(input, ${JSON.stringify(value)});
       input.dispatchEvent(new Event('input', { bubbles: true }));
       return true;
     })()`,
    15_000
  );
  if (!applied) throw new Error(`Password input ${index} is not present`);
}

async function clickButton(cdp: CdpClient, label: string): Promise<void> {
  const clicked = await cdp.evaluate<boolean>(
    `(() => {
       const button = Array.from(document.querySelectorAll('button'))
         .find(candidate => (candidate.textContent || '').trim() === ${JSON.stringify(label)});
       if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
       button.click();
       return true;
     })()`,
    15_000
  );
  if (!clicked) throw new Error(`The button labelled "${label}" is not present or is disabled`);
}

async function pageText(cdp: CdpClient): Promise<string> {
  return await cdp.evaluate<string>('document.body ? document.body.innerText : ""', 15_000);
}

async function bridgeJson<T>(cdp: CdpClient, expression: string, timeoutMs = 120_000): Promise<T> {
  return await cdp.evaluate<T>(`(async () => { ${expression} })()`, timeoutMs);
}

async function captureWebView(cdp: CdpClient, path: string): Promise<void> {
  const outcome = (await cdp.send('Page.captureScreenshot', { format: 'png' }, 30_000)) as { data?: string };
  if (!outcome.data) throw new Error('CDP returned no screenshot payload');
  await writeFile(path, Buffer.from(outcome.data, 'base64'));
}

function parseAccounts(value: unknown): AccountRecord[] {
  return arrayOf(value, 'accounts').map(item => {
    const record = recordOf(item, 'account');
    const id = stringField(record, 'id');
    const type = stringField(record, 'type');
    const balance = numberField(record, 'initial_balance');
    if (id === null || type === null || balance === null) {
      throw new Error('An account record is missing id, type or initial_balance');
    }
    return { id, name: stringField(record, 'name') ?? '', type, initial_balance: balance };
  });
}

function parseTransactionPage(value: unknown): TransactionRecord[] {
  const page = recordOf(value, 'transaction page');
  return arrayOf(page.items ?? [], 'transaction items').map(item => {
    const record = recordOf(item, 'transaction');
    const id = stringField(record, 'id');
    const amount = numberField(record, 'amount');
    if (id === null || amount === null) {
      throw new Error('A transaction record is missing id or amount');
    }
    return {
      id,
      title: stringField(record, 'title') ?? '',
      amount,
      type: stringField(record, 'type') ?? '',
      status: stringField(record, 'status') ?? ''
    };
  });
}

function parseOutboxRows(items: unknown[]): OutboxOperation[] {
  return items.map(item => {
    const record = recordOf(item, 'outbox record');
    const opId = stringField(record, 'opId');
    const payloadHash = stringField(record, 'payloadHash');
    if (opId === null || payloadHash === null) {
      throw new Error('A station outbox row is missing opId or payloadHash');
    }
    return {
      opId,
      payloadHash,
      status: stringField(record, 'status') ?? '',
      type: stringField(record, 'type') ?? '',
      entityType: stringField(record, 'entityType') ?? '',
      entityId: stringField(record, 'entityId') ?? '',
      effectiveAt: stringField(record, 'effectiveAt') ?? '',
      attempts: numberField(record, 'attempts') ?? 0
    };
  });
}

function outboxOperations(value: unknown): OutboxOperation[] {
  return Array.isArray(value) ? parseOutboxRows(value) : [];
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

function unfinishedSteps(failure: string | null): void {
  const recorded = new Set(steps.map(record => record.id));
  for (const id of STEP_IDS) {
    if (recorded.has(id)) continue;
    steps.push({
      id,
      status: 'unrun',
      startedAt: nowIso(),
      finishedAt: null,
      detail: null,
      error: failure === null ? 'The run stopped before this step' : `Stopped after: ${sanitize(failure)}`
    });
  }
}

function spawnService(
  child: ChildProcess,
  label: string,
  path: string,
  executablePath: string
): CentralService {
  const stdout = new LogSink();
  const stderr = new LogSink();
  const pumps = Promise.all([
    pumpStream(readableOf(child), stdout),
    pumpStream(readableErrorOf(child), stderr)
  ]);
  return { child, stdout, stderr, pumps, label, path, executablePath };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const refusal = refusalReason();
  if (refusal !== null) {
    console.error(`REFUSED: ${refusal}`);
    process.exitCode = 2;
    return;
  }

  const nonce = crypto.randomUUID();
  const tempRoot = process.env.RUNNER_TEMP?.trim() || tmpdir();
  const outputBase = resolve(process.env.OBOL_WINDOWS_SMOKE_OUT?.trim() || join(tempRoot, 'obol-windows-smoke'));
  if (!insideDirectory(tempRoot, outputBase)) {
    console.error(`REFUSED: OBOL_WINDOWS_SMOKE_OUT (${outputBase}) is outside the runner temp directory (${tempRoot})`);
    process.exitCode = 2;
    return;
  }
  const runDirectory = join(outputBase, `run-${nonce}`);
  const evidenceDirectory = join(runDirectory, 'evidence');
  const screenshotsDirectory = join(evidenceDirectory, 'screenshots');
  const logsDirectory = join(evidenceDirectory, 'logs');
  await mkdir(screenshotsDirectory, { recursive: true });
  await mkdir(logsDirectory, { recursive: true });

  const localAppData = join(runDirectory, 'localappdata');
  const centralRoot = join(runDirectory, 'central');
  const centralPbData = join(centralRoot, 'pb_data');
  const stagingDirectory = join(runDirectory, 'installer-staging');
  await mkdir(localAppData, { recursive: true });
  await mkdir(centralRoot, { recursive: true });
  await mkdir(stagingDirectory, { recursive: true });

  let installerPath = '';
  let installerSha256 = '';
  let installerBytes = 0;
  let windowsInfo: unknown = null;
  let webview2Info: unknown = null;
  let appDir = '';
  let channelRoot = '';
  let installedVersion: string | null = null;
  let metadataIdentifier: string | null = null;
  let metadataChannel: string | null = null;
  let localPbToken: string | null = null;
  let centralBase = '';
  let centralPbPort = 0;
  let centralBffPort = 0;
  let ownerToken: string | null = null;
  let preStopIdentity: HandshakeIdentity | null = null;
  let app: AppSession | null = null;
  let centralPb: CentralService | null = null;
  let centralBff: CentralService | null = null;

  const localPassword = rememberSecret(syntheticToken(24));
  const centralPassword = rememberSecret(syntheticToken(24));
  const pbAdminPassword = rememberSecret(syntheticToken(32));
  const sessionSecret = rememberSecret(syntheticHex(32));
  const setupToken = rememberSecret(syntheticHex(16));
  const localEmail = `local-${nonce}@obol.invalid`;
  const centralEmail = `central-${nonce}@obol.invalid`;
  const pbAdminEmail = `pb-${nonce}@obol.invalid`;
  const appId = `copland.obol.smoke.${nonce}`;
  const cdpPort = await reservePort();

  const finance: Record<string, unknown> = {};
  const operations: Record<string, unknown> = {};
  const sync: Record<string, unknown> = {};
  const updater: Record<string, unknown> = {};
  const observations: Record<string, unknown> = {};
  const pids: Record<string, number | number[] | null> = {
    installer: null,
    uninstaller: null,
    app: [],
    centralPocketBase: null,
    centralBff: null
  };

  const appEnvironment = (): Record<string, string | undefined> => ({
    ...process.env,
    LOCALAPPDATA: localAppData,
    OBOL_APP_ID: appId,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort} --remote-debugging-address=127.0.0.1`
  });

  const requireCdp = (): CdpClient => {
    if (app === null || app.cdp === null) throw new Error('CDP is not attached');
    return app.cdp;
  };

  const requireOwnerToken = (): string => {
    if (ownerToken === null) throw new Error('The central owner token is not available');
    return ownerToken;
  };

  const startApp = async (): Promise<AppSession> => {
    const launcher = join(appDir, 'bin', 'launcher.exe');
    const child = Bun.spawn([launcher], {
      cwd: join(appDir, 'bin'),
      env: appEnvironment(),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe'
    });
    const stdoutSink = new LogSink();
    const stderrSink = new LogSink();
    const pumps = Promise.all([
      pumpStream(readableOf(child), stdoutSink),
      pumpStream(readableErrorOf(child), stderrSink)
    ]);
    appLogPumps.push({ sinks: [stdoutSink, stderrSink], pumps, path: join(logsDirectory, `app-${child.pid}.log`) });
    const recorded = Array.isArray(pids.app) ? pids.app : [];
    recorded.push(child.pid);
    pids.app = recorded;
    return { rootPid: child.pid, cdp: null };
  };

  const stopApp = async (): Promise<void> => {
    if (app === null) return;
    const processes = await listProcesses();
    const owned = descendantProcessIds(app.rootPid, processes);
    await killOwnedProcess(app.rootPid, join(appDir, 'bin', 'launcher.exe'));
    for (const pid of owned) {
      if (await pidExists(pid)) await killProcessTree(pid);
    }
    await waitForNoProcess(
      async () => {
        const current = await listProcesses();
        return current.every(entry => !owned.includes(entry.processId)) && processesUnder(appDir, current).length === 0;
      },
      30_000,
      'The owned Obol app process tree'
    );
    app = null;
    localPbToken = null;
    await flushAppLogs();
  };

  const stopService = async (service: CentralService | null): Promise<void> => {
    if (service === null) return;
    await killOwnedProcess(service.child.pid, service.executablePath);
    await service.pumps.catch(() => undefined);
    await writeFile(
      service.path,
      `# ${service.label}\n[stdout]\n${service.stdout.finish()}\n[stderr]\n${service.stderr.finish()}\n`,
      'utf8'
    );
  };

  const stopCentral = async (): Promise<void> => {
    await stopService(centralBff);
    centralBff = null;
    await stopService(centralPb);
    centralPb = null;
    if (centralBffPort > 0) {
      await waitForNoProcess(async () => await portIsClosed(centralBffPort), 30_000, 'The central BFF port to close');
    }
    if (centralPbPort > 0) {
      await waitForNoProcess(async () => await portIsClosed(centralPbPort), 30_000, 'The central PocketBase port to close');
    }
    pids.centralBff = null;
    pids.centralPocketBase = null;
  };

  const readLocalPbToken = async (): Promise<string> => {
    if (localPbToken !== null) return localPbToken;
    const profilePath = join(localAppData, appId, 'local_profile.json');
    const profile = parseLocalAccountProfile(await readFile(profilePath, 'utf8'));
    const pocketBasePassword = await verifyLocalAccount({ email: localEmail, password: localPassword }, profile);
    if (pocketBasePassword === null) {
      throw new Error('The local profile verifier rejected the smoke account; station state cannot be read');
    }
    rememberSecret(pocketBasePassword);
    const auth = await fetchJson(`${LOCAL_POCKETBASE_URL}/api/collections/_superusers/auth-with-password`, {
      method: 'POST',
      body: { identity: LOCAL_POCKETBASE_EMAIL, password: pocketBasePassword },
      timeoutMs: 30_000
    });
    if (auth.status !== 200) {
      throw new Error(`Local PocketBase superuser authentication returned HTTP ${auth.status}`);
    }
    const token = stringField(recordOf(auth.body, 'local PocketBase auth'), 'token');
    if (token === null || token.length === 0) throw new Error('Local PocketBase returned no token');
    rememberSecret(token);
    localPbToken = token;
    return token;
  };

  const readStationState = async (): Promise<StationStateRecord> => {
    const token = await readLocalPbToken();
    const outcome = await fetchJson(`${LOCAL_POCKETBASE_URL}/api/collections/obol_station_state/records?perPage=1`, {
      token,
      timeoutMs: 30_000
    });
    if (outcome.status !== 200) throw new Error(`Reading obol_station_state returned HTTP ${outcome.status}`);
    const page = recordOf(outcome.body, 'station state page');
    const items = arrayOf(page.items ?? [], 'station state items');
    if (items.length !== 1) throw new Error(`Expected one obol_station_state row, found ${items.length}`);
    const record = recordOf(items[0], 'station state');
    const cursor = numberField(record, 'cursor');
    return {
      stationId: stringField(record, 'stationId') ?? undefined,
      serverInstanceId: stringField(record, 'serverInstanceId') ?? undefined,
      dataEpoch: numberField(record, 'dataEpoch') ?? undefined,
      cursor: cursor === null ? undefined : cursor,
      lastChainHash: stringField(record, 'lastChainHash') ?? undefined,
      mode: stringField(record, 'mode') ?? undefined
    };
  };

  const readPendingOutbox = async (): Promise<OutboxOperation[]> => {
    const token = await readLocalPbToken();
    const filter = encodeURIComponent('status != "accepted"');
    const outcome = await fetchJson(
      `${LOCAL_POCKETBASE_URL}/api/collections/obol_station_outbox/records?perPage=200&sort=createdAt&filter=${filter}`,
      { token, timeoutMs: 30_000 }
    );
    if (outcome.status !== 200) throw new Error(`Reading obol_station_outbox returned HTTP ${outcome.status}`);
    const page = recordOf(outcome.body, 'outbox page');
    return parseOutboxRows(arrayOf(page.items ?? [], 'outbox items'));
  };

  const startCentralServices = async (reusePorts = false): Promise<void> => {
    if (reusePorts) {
      if (centralPbPort === 0 || centralBffPort === 0) {
        throw new Error('The central ports were not recorded before the restart');
      }
      if (!(await portIsClosed(centralPbPort)) || !(await portIsClosed(centralBffPort))) {
        throw new Error('The previous central ports are still open; the restart is not isolated');
      }
    } else {
      centralPbPort = await reservePort();
      centralBffPort = await reservePort();
    }
    if (
      centralPbPort === 13090 ||
      centralBffPort === 13090 ||
      centralPbPort === cdpPort ||
      centralBffPort === cdpPort ||
      centralPbPort === centralBffPort
    ) {
      throw new Error('Reserved central ports collide with the local PocketBase or CDP port');
    }
    const pocketBase = join(appDir, 'Resources', 'app', 'resources', 'pocketbase.exe');
    const migrations = join(appDir, 'Resources', 'app', 'pb_migrations');
    const upsert = await runCommand(
      [pocketBase, `--dir=${centralPbData}`, `--migrationsDir=${migrations}`, 'superuser', 'upsert', pbAdminEmail, pbAdminPassword],
      {
        label: 'central PocketBase superuser bootstrap',
        cwd: centralRoot,
        env: { ...process.env, PB_ADMIN_EMAIL: pbAdminEmail, PB_ADMIN_PASSWORD: pbAdminPassword },
        timeoutMs: 120_000,
        logPath: join(logsDirectory, 'central-superuser.log')
      }
    );
    if (upsert.code !== 0) throw new Error('The central PocketBase superuser bootstrap failed');

    const pbChild = Bun.spawn(
      [pocketBase, 'serve', `--http=127.0.0.1:${centralPbPort}`, `--dir=${centralPbData}`, `--migrationsDir=${migrations}`],
      {
        cwd: centralRoot,
        env: { ...process.env, PB_ADMIN_EMAIL: pbAdminEmail, PB_ADMIN_PASSWORD: pbAdminPassword },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe'
      }
    );
    centralPb = spawnService(pbChild, 'central PocketBase', join(logsDirectory, 'central-pocketbase.log'), pocketBase);
    pids.centralPocketBase = pbChild.pid;
    await waitForHttpJson(`http://127.0.0.1:${centralPbPort}/api/health`, 60_000, 'The central PocketBase health endpoint');

    const bffChild = Bun.spawn([process.execPath, join(REPO_ROOT, 'server', 'src', 'index.ts')], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PORT: String(centralBffPort),
        POCKETBASE_URL: `http://127.0.0.1:${centralPbPort}`,
        PB_ADMIN_EMAIL: pbAdminEmail,
        PB_ADMIN_PASSWORD: pbAdminPassword,
        OBOL_SESSION_SECRET: sessionSecret,
        OBOL_SETUP_TOKEN: setupToken
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe'
    });
    centralBff = spawnService(bffChild, 'central BFF', join(logsDirectory, 'central-bff.log'), process.execPath);
    pids.centralBff = bffChild.pid;
    centralBase = `http://127.0.0.1:${centralBffPort}`;
    await waitForHttpJson(`${centralBase}/`, 90_000, 'The central BFF root');
  };

  const loginOwner = async (): Promise<void> => {
    const setupStatus = await fetchJson(`${centralBase}/api/setup/status`, { timeoutMs: 30_000 });
    const setup = recordOf(setupStatus.body, 'setup status');
    if (setup.setupRequired !== false) {
      throw new Error('The central server still reports first-run setup required');
    }
    const login = await fetchJson(`${centralBase}/api/auth/login`, {
      method: 'POST',
      body: { email: centralEmail, password: centralPassword, deviceLabel: 'Windows smoke harness', transport: 'bearer' },
      timeoutMs: 30_000
    });
    if (login.status !== 200) throw new Error(`The central bearer login returned HTTP ${login.status}`);
    const token = stringField(recordOf(login.body, 'central login'), 'token');
    if (token === null || token.length === 0) throw new Error('The central login returned no bearer token');
    rememberSecret(token);
    ownerToken = token;
    sync.central = {
      serverName: stringField(setup, 'serverName'),
      pocketBasePort: centralPbPort,
      bffPort: centralBffPort
    };
  };

  const bootstrapOwner = async (): Promise<void> => {
    const setupStatus = await fetchJson(`${centralBase}/api/setup/status`, { timeoutMs: 30_000 });
    const setup = recordOf(setupStatus.body, 'setup status');
    if (setup.setupRequired !== true) throw new Error('The isolated central server is not in first-run setup mode');
    const init = await fetchJson(`${centralBase}/api/setup/init`, {
      method: 'POST',
      body: { setupToken, email: centralEmail, password: centralPassword },
      timeoutMs: 30_000
    });
    if (init.status !== 200) {
      throw new Error(`The central owner setup returned HTTP ${init.status}: ${JSON.stringify(init.body)}`);
    }
    await loginOwner();
  };

  const centralFetch = async (
    path: string,
    init?: { readonly method?: string; readonly body?: unknown }
  ): Promise<HttpOutcome> => {
    if (ownerToken === null) throw new Error('The central owner token is not available');
    return await fetchJson(`${centralBase}${path}`, { ...init, token: ownerToken, timeoutMs: 60_000 });
  };

  const currentStationId = async (session: AppSession | null): Promise<string> => {
    if (session === null || session.cdp === null) throw new Error('CDP is not attached');
    const status = await bridgeJson<DesktopStatus>(session.cdp, 'return await window.obol.sync.status();');
    if (typeof status.stationId !== 'string' || status.stationId.length === 0) {
      throw new Error('The desktop status carries no durable station id');
    }
    return status.stationId;
  };

  const handshake = async (
    token: string,
    stationId: string,
    clientCursor: number | null,
    clientCursorHash: string | null
  ): Promise<HandshakeIdentity> => {
    const outcome = await fetchJson(`${centralBase}/api/sync/handshake`, {
      method: 'POST',
      token,
      timeoutMs: 60_000,
      body: {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        stationId,
        platform: 'windows',
        deviceLabel: 'Obol Windows smoke',
        clientCursor,
        clientCursorHash,
        dataEpoch: null,
        serverInstanceId: null
      }
    });
    if (outcome.status !== 200) {
      throw new Error(`The sync handshake returned HTTP ${outcome.status}: ${JSON.stringify(outcome.body)}`);
    }
    const body = recordOf(outcome.body, 'handshake response');
    const serverInstanceId = stringField(body, 'serverInstanceId');
    const ownerFingerprint = stringField(body, 'ownerFingerprint');
    const dataEpoch = numberField(body, 'dataEpoch');
    const cursor = numberField(body, 'cursor');
    const cursorHash = stringField(body, 'cursorHash');
    const headHash = stringField(body, 'headHash');
    if (
      serverInstanceId === null ||
      ownerFingerprint === null ||
      dataEpoch === null ||
      cursor === null ||
      cursorHash === null ||
      headHash === null
    ) {
      throw new Error('The sync handshake response is missing its identity or cursor fields');
    }
    return {
      serverInstanceId,
      ownerFingerprint,
      dataEpoch,
      cursor,
      cursorHash,
      headHash,
      hasFinancialData: body.hasFinancialData === true,
      serverName: stringField(body, 'serverName') ?? ''
    };
  };

  const cleanup = async (): Promise<void> => {
    const failures: string[] = [];
    const attempt = async (label: string, work: () => Promise<void>): Promise<void> => {
      try {
        await work();
      } catch (error) {
        failures.push(`${label}: ${sanitize(errorMessage(error))}`);
      }
    };

    await attempt('app process tree', stopApp);
    await attempt('central BFF', () => stopService(centralBff));
    centralBff = null;
    await attempt('central PocketBase', () => stopService(centralPb));
    centralPb = null;
    await attempt('leftover app processes', async () => {
      for (const pid of processesUnder(appDir, await listProcesses())) {
        await killProcessTree(pid);
      }
    });
    const uninstaller = channelRoot.length > 0 ? join(channelRoot, 'uninstall.exe') : '';
    if (uninstaller.length > 0 && existsSync(uninstaller)) {
      await attempt('installed uninstaller', async () => {
        const child = Bun.spawn([uninstaller, '--quiet', '--delete-data'], {
          cwd: channelRoot,
          env: { ...process.env, LOCALAPPDATA: localAppData },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe'
        });
        pids.uninstaller = child.pid;
        const stdoutSink = new LogSink();
        const stderrSink = new LogSink();
        const pumps = Promise.all([
          pumpStream(readableOf(child), stdoutSink),
          pumpStream(readableErrorOf(child), stderrSink)
        ]);
        try {
          await withTimeout(child.exited, 120_000, 'The installed Windows uninstaller');
        } finally {
          await pumps.catch(() => undefined);
          await writeFile(
            join(logsDirectory, 'uninstaller.log'),
            `# Installed Windows uninstaller\n[stdout]\n${stdoutSink.finish()}\n[stderr]\n${stderrSink.finish()}\n`,
            'utf8'
          );
        }
      });
    }
    // Every app process is selected by the isolated install path, never by an
    // image name, so an unrelated Obol or PocketBase process is never touched.
    if (channelRoot.length > 0) {
      await attempt('uninstaller cleanup process', async () => {
        await waitForNoProcess(
          async () => processesUnder(channelRoot, await listProcesses()).length === 0,
          30_000,
          'The installed uninstaller cleanup process'
        );
      });
    }
    await attempt('owned process check', async () => {
      const surviving = [
        ...processesUnder(appDir, await listProcesses()),
        ...processesUnder(channelRoot, await listProcesses())
      ];
      if (surviving.length > 0) {
        throw new Error(`Owned app processes survived cleanup: ${surviving.join(',')}`);
      }
    });
    await attempt('installer staging', async () => {
      await rm(stagingDirectory, { recursive: true, force: true });
    });
    await attempt('isolated profile and server data', async () => {
      await rm(localAppData, { recursive: true, force: true });
      await rm(centralRoot, { recursive: true, force: true });
    });
    if (failures.length > 0) throw new Error(failures.join('; '));
  };

  let failure: string | null = null;
  let cleanupError: string | null = null;

  try {
    await step('preflight', async () => {
      const system = recordOf(await probe('system'), 'system probe');
      windowsInfo = system;
      const version = stringField(system, 'version');
      const buildNumber = stringField(system, 'buildNumber');
      const caption = stringField(system, 'caption') ?? version ?? 'Windows';
      if (version === null || buildNumber === null) {
        throw new Error('The Windows version could not be read');
      }
      if (!/64/.test(stringField(system, 'architecture') ?? '')) {
        throw new Error('The runner is not a 64-bit Windows installation');
      }
      const webview = recordOf(await probe('webview2'), 'WebView2 probe');
      webview2Info = webview;
      const webviewVersion = stringField(webview, 'version');
      if (webviewVersion === null || webviewVersion.length === 0) {
        throw new Error('No Evergreen WebView2 runtime is installed; the native WebView cannot run');
      }
      const appManifest = recordOf(
        JSON.parse(readFileSync(join(DESKTOP_ROOT, 'app.json'), 'utf8')) as unknown,
        'desktop/app.json'
      );
      const appName = (stringField(appManifest, 'name') ?? 'Obol').replace(/ /g, '');
      installerPath = resolve(join(DESKTOP_ROOT, 'artifacts', `win-x64-${appName}-Setup.zip`));
      const installerStat = await stat(installerPath);
      if (!installerStat.isFile() || installerStat.size === 0) {
        throw new Error(`The installer built by this job is missing or empty: ${installerPath}`);
      }
      installerSha256 = await sha256File(installerPath);
      installerBytes = installerStat.size;
      describeStep(
        'preflight',
        `${caption} build ${buildNumber}; WebView2 ${webviewVersion}; installer sha256 ${installerSha256} (${installerBytes} bytes)`
      );
    });

    await step('installer.unpack', async () => {
      const listing = await runCommand([TAR_EXE, '-tf', installerPath], {
        label: 'list the Windows setup ZIP',
        timeoutMs: 60_000,
        logPath: join(logsDirectory, 'installer-list.log')
      });
      if (listing.code !== 0) {
        throw new Error(`The setup ZIP is unreadable: ${listing.stderr || listing.stdout}`.trim());
      }
      const extracted = await runCommand([TAR_EXE, '-xf', installerPath, '-C', stagingDirectory], {
        label: 'extract the Windows setup ZIP to staging',
        timeoutMs: 120_000,
        logPath: join(logsDirectory, 'installer-extract.log')
      });
      if (extracted.code !== 0) {
        throw new Error(`The setup ZIP could not be staged: ${extracted.stderr || extracted.stdout}`.trim());
      }
      const stagedEntries = await readdir(stagingDirectory, { withFileTypes: true });
      const setupExecutable = stagedEntries.find(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'));
      const payloadDirectory = stagedEntries.find(entry => entry.isDirectory() && entry.name === '.installer');
      if (!setupExecutable) throw new Error('The setup ZIP has no setup executable');
      if (!payloadDirectory) {
        throw new Error('The setup ZIP has no adjacent .installer payload; this is not the Electrobun 2.0.5 installer contract');
      }
      const payloadEntries = await readdir(join(stagingDirectory, '.installer'));
      const metadataName = payloadEntries.find(name => name.toLowerCase().endsWith('.metadata.json'));
      if (!metadataName) {
        throw new Error('The installer payload has no metadata.json; the install identity cannot be verified');
      }
      const metadata = recordOf(
        JSON.parse(await readFile(join(stagingDirectory, '.installer', metadataName), 'utf8')) as unknown,
        'installer metadata'
      );
      const identifier = stringField(metadata, 'identifier');
      const channel = stringField(metadata, 'channel');
      if (identifier === null || !/^[A-Za-z0-9._-]+$/.test(identifier)) {
        throw new Error('The installer metadata has no safe identifier');
      }
      if (channel !== 'stable') {
        throw new Error(`The installer metadata channel is ${JSON.stringify(channel)}, not stable`);
      }
      metadataIdentifier = identifier;
      metadataChannel = channel;
      channelRoot = join(localAppData, identifier, channel);
      appDir = join(channelRoot, 'app');
      describeStep(
        'installer.unpack',
        `staged ${setupExecutable.name} with ${payloadEntries.length} adjacent payload entries; identifier ${identifier}, channel ${channel}`
      );
    });

    await step('installer.run', async () => {
      const stagedEntries = await readdir(stagingDirectory, { withFileTypes: true });
      const setupExecutable = stagedEntries.find(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'));
      if (!setupExecutable) throw new Error('The staged setup executable disappeared');
      const setupPath = join(stagingDirectory, setupExecutable.name);
      const child = Bun.spawn([setupPath], {
        cwd: stagingDirectory,
        env: {
          ...appEnvironment(),
          // Documented Electrobun 2.0.5 installer diagnostic: the native
          // TaskDialog closes itself once the terminal state is reached. This
          // is not a silent-install flag; the real installer still performs the
          // extraction, shell integration and application launch.
          ELECTROBUN_INSTALLER_UI_AUTOCLOSE: '1'
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe'
      });
      pids.installer = child.pid;
      const stdoutSink = new LogSink();
      const stderrSink = new LogSink();
      const pumps = Promise.all([
        pumpStream(readableOf(child), stdoutSink),
        pumpStream(readableErrorOf(child), stderrSink)
      ]);
      let code: number;
      try {
        code = await withTimeout(child.exited, 180_000, 'The Windows setup executable');
      } catch (error) {
        await killProcessTree(child.pid);
        await pumps.catch(() => undefined);
        throw error;
      }
      await pumps;
      await writeFile(
        join(logsDirectory, 'installer-run.log'),
        `# Windows setup executable\n[stdout]\n${stdoutSink.finish()}\n[stderr]\n${stderrSink.finish()}\n`,
        'utf8'
      );
      if (code !== 0) throw new Error(`The Windows installer exited with code ${code}`);
      describeStep('installer.run', `The real setup executable installed into ${channelRoot} and exited 0`);
    });

    await step('installer.verify', async () => {
      const launcher = join(appDir, 'bin', 'launcher.exe');
      const pocketBase = join(appDir, 'Resources', 'app', 'resources', 'pocketbase.exe');
      const migrations = join(appDir, 'Resources', 'app', 'pb_migrations');
      for (const required of [launcher, pocketBase]) {
        const entry = await stat(required);
        if (!entry.isFile() || entry.size === 0) throw new Error(`The installed file is missing or empty: ${required}`);
      }
      const migrationNames = await readdir(migrations);
      for (const prefix of ['1700000018', '1700000019', '1700000020', '1700000021']) {
        if (!migrationNames.some(name => name.startsWith(prefix))) {
          throw new Error(`The installed migrations do not include ${prefix}`);
        }
      }
      const versionFile = recordOf(
        JSON.parse(await readFile(join(appDir, 'Resources', 'version.json'), 'utf8')) as unknown,
        'installed version.json'
      );
      const version = stringField(versionFile, 'version');
      if (version === null || version.length === 0) throw new Error('The installed Resources/version.json has no version');
      installedVersion = version;
      // The installer launches the app after a successful install. It is
      // asynchronous relative to the installer process exit, so wait a bounded
      // window for it to appear and stop it before the script starts its own
      // env-controlled launch (otherwise the two would fight over the fixed
      // local PocketBase port).
      const drained = new Set<number>();
      const drainDeadline = Date.now() + 15_000;
      while (Date.now() < drainDeadline) {
        const autoLaunched = processesUnder(appDir, await listProcesses());
        if (autoLaunched.length === 0 && drained.size > 0) break;
        for (const pid of autoLaunched) {
          drained.add(pid);
          await killOwnedProcess(pid, join(appDir, 'bin', 'launcher.exe'));
        }
        await Bun.sleep(500);
      }
      await waitForNoProcess(
        async () => processesUnder(appDir, await listProcesses()).length === 0,
        30_000,
        'The installer auto-launched app processes'
      );
      describeStep(
        'installer.verify',
        `launcher, bundled PocketBase, migrations 0018-0021 and version ${installedVersion} verified; ${drained.size} auto-launched process(es) stopped`
      );
    });

    await step('app.launch', async () => {
      const launched = await startApp();
      app = launched;
      const deadline = Date.now() + 90_000;
      let observed: WindowEntry | null = null;
      while (Date.now() < deadline) {
        const processes = await listProcesses();
        const tree = new Set(descendantProcessIds(launched.rootPid, processes));
        observed = (await listWindows()).find(
          entry => entry.visible && tree.has(entry.processId) && entry.title.length > 0
        ) ?? null;
        if (observed) break;
        await Bun.sleep(1_000);
      }
      if (!observed) throw new Error('No visible Obol window appeared for the owned process tree');
      await captureNativeScreenshot(join(screenshotsDirectory, '01-launch-native.png'));
      observations.launchWindow = { title: observed.title, processId: observed.processId };
      describeStep('app.launch', `Observed window "${observed.title}" (pid ${observed.processId})`);
    });

    await step('cdp.attach', async () => {
      if (app === null) throw new Error('The app is not running');
      const target = await waitForCdpTarget(cdpPort, 45_000);
      const cdp = await CdpClient.connect(target.webSocketDebuggerUrl, 20_000);
      await cdp.send('Page.enable', {}, 15_000);
      await cdp.send('Runtime.enable', {}, 15_000);
      app = { rootPid: app.rootPid, cdp };
      observations.cdpTarget = { id: target.id, type: target.type, url: target.url };
      describeStep('cdp.attach', `Attached to ${target.type} target ${target.id}`);
      await captureWebView(cdp, join(screenshotsDirectory, '02-launch-webview.png'));
    });

    await step('ui.first-run', async () => {
      const cdp = requireCdp();
      await waitForBoolean(
        cdp,
        `typeof window.obol === 'object' && Array.from(document.querySelectorAll('button')).some(candidate => ['Create local account', 'Unlock'].includes((candidate.textContent || '').trim()))`,
        120_000,
        'The local auth gate'
      );
      const text = await pageText(cdp);
      const isSetup = text.includes('Set up this Obol profile');
      if (!isSetup && !text.includes('Unlock Obol')) {
        throw new Error('The local auth gate is neither in first-run setup nor unlock mode');
      }
      if (isSetup) {
        await setInputValue(cdp, 'input[autocomplete="name"]', 'Windows Smoke Owner');
        await setInputValue(cdp, 'input[type="email"]', localEmail);
        await setPasswordValue(cdp, 0, localPassword);
        await setPasswordValue(cdp, 1, localPassword);
        await clickButton(cdp, 'Create local account');
        await waitForBoolean(cdp, `document.body && document.body.innerText.includes('Saldo disponível')`, 240_000, 'The first-run profile dashboard');
        describeStep('ui.first-run', 'Created the local profile through the first-run labels and reached the dashboard');
      } else {
        await setPasswordValue(cdp, 0, localPassword);
        await clickButton(cdp, 'Unlock');
        await waitForBoolean(cdp, `document.body && document.body.innerText.includes('Saldo disponível')`, 180_000, 'The unlocked dashboard');
        describeStep('ui.first-run', 'Unlocked the existing local profile through the unlock labels');
      }
      await captureWebView(cdp, join(screenshotsDirectory, '03-unlocked-webview.png'));
      await captureNativeScreenshot(join(screenshotsDirectory, '03-unlocked-native.png'));
    });

    await step('finance.local', async () => {
      const cdp = requireCdp();
      const account = await bridgeJson<ApiCallResult>(
        cdp,
        `const response = await window.obol.apiFetch({ path: '/api/accounts', method: 'POST', headers: [['content-type', 'application/json']], body: JSON.stringify({ name: 'Windows smoke checking', type: 'checking', initial_balance: 1000 }) }); return { status: response.status, body: response.body };`
      );
      if (account.status !== 201) {
        throw new Error(`Creating the account through window.obol.apiFetch returned HTTP ${account.status}: ${sanitize(account.body)}`);
      }
      const accountRecord = recordOf(JSON.parse(account.body) as unknown, 'created account');
      const accountId = stringField(accountRecord, 'id');
      if (accountId === null || accountId.length === 0) throw new Error('The created account has no id');
      const transaction = await bridgeJson<ApiCallResult>(
        cdp,
        `const response = await window.obol.apiFetch({ path: '/api/transactions', method: 'POST', headers: [['content-type', 'application/json']], body: JSON.stringify({ title: 'Windows smoke expense', amount: 20, type: 'expense', status: 'realized', expected_date: ${JSON.stringify(new Date().toISOString())}, account_id: ${JSON.stringify(accountId)} }) }); return { status: response.status, body: response.body };`
      );
      if (transaction.status !== 201) {
        throw new Error(`Creating the transaction through window.obol.apiFetch returned HTTP ${transaction.status}: ${sanitize(transaction.body)}`);
      }
      const accounts = parseAccounts(
        JSON.parse(
          (await bridgeJson<ApiCallResult>(
            cdp,
            `const response = await window.obol.apiFetch({ path: '/api/accounts', method: 'GET', headers: [] }); return { status: response.status, body: response.body };`
          )).body
        ) as unknown
      );
      if (accounts.length !== 1) throw new Error(`Expected exactly one smoke account, found ${accounts.length}`);
      const balance = accounts[0].initial_balance;
      if (balance !== 980) {
        throw new Error(`The product account balance is ${balance}, not 980 after the realized 20 expense`);
      }
      const status = await bridgeJson<DesktopStatus>(cdp, 'return await window.obol.sync.status();');
      const outbox = await bridgeJson<DesktopOutboxRow[]>(cdp, 'return await window.obol.sync.outbox();');
      if (status.pendingCount < 1) {
        throw new Error('The local outbox reports no pending operation after two local writes');
      }
      const dashboard = await cdp.evaluate<string | null>(
        `(() => { const match = document.body.innerText.match(/Saldo disponível\\s*\\n?\\s*([^\\n]+)/); return match ? match[1].trim() : null; })()`,
        15_000
      );
      finance.local = {
        accountBalance: balance,
        accountCount: accounts.length,
        dashboardCashText: dashboard,
        pendingCount: status.pendingCount,
        outbox: outbox.map(entry => ({ opId: entry.opId, type: entry.type, status: entry.status }))
      };
      describeStep(
        'finance.local',
        `Account 1000 and realized expense 20 materialized ${balance} in the real local API; pending ${status.pendingCount}`
      );
      await captureWebView(cdp, join(screenshotsDirectory, '04-local-finance-webview.png'));
      await captureNativeScreenshot(join(screenshotsDirectory, '04-local-finance-native.png'));
    });

    await step('app.restart', async () => {
      const cdp = requireCdp();
      const beforeAccounts = await bridgeJson<ApiCallResult>(
        cdp,
        `const response = await window.obol.apiFetch({ path: '/api/accounts', method: 'GET', headers: [] }); return { status: response.status, body: response.body };`
      );
      const beforeStatus = await bridgeJson<DesktopStatus>(cdp, 'return await window.obol.sync.status();');
      const beforeOutbox = await bridgeJson<DesktopOutboxRow[]>(cdp, 'return await window.obol.sync.outbox();');
      const persistedAccounts = parseAccounts(JSON.parse(beforeAccounts.body) as unknown);
      await stopApp();
      const launched = await startApp();
      app = launched;
      const target = await waitForCdpTarget(cdpPort, 60_000);
      const restarted = await CdpClient.connect(target.webSocketDebuggerUrl, 20_000);
      await restarted.send('Page.enable', {}, 15_000);
      await restarted.send('Runtime.enable', {}, 15_000);
      app = { rootPid: launched.rootPid, cdp: restarted };
      await waitForBoolean(
        restarted,
        `typeof window.obol === 'object' && Array.from(document.querySelectorAll('button')).some(candidate => (candidate.textContent || '').trim() === 'Unlock')`,
        120_000,
        'The unlock labels after restart'
      );
      await setPasswordValue(restarted, 0, localPassword);
      await clickButton(restarted, 'Unlock');
      await waitForBoolean(restarted, `document.body && document.body.innerText.includes('Saldo disponível')`, 240_000, 'The dashboard after restart');
      const accounts = await bridgeJson<ApiCallResult>(
        restarted,
        `const response = await window.obol.apiFetch({ path: '/api/accounts', method: 'GET', headers: [] }); return { status: response.status, body: response.body };`
      );
      const status = await bridgeJson<DesktopStatus>(restarted, 'return await window.obol.sync.status();');
      const outbox = await bridgeJson<DesktopOutboxRow[]>(restarted, 'return await window.obol.sync.outbox();');
      const afterAccounts = parseAccounts(JSON.parse(accounts.body) as unknown);
      if (afterAccounts.length !== 1 || afterAccounts[0].initial_balance !== 980) {
        throw new Error('The restarted profile does not report the same 980 balance');
      }
      if (status.stationId !== beforeStatus.stationId) {
        throw new Error('The durable station identity changed across restart');
      }
      const beforeIds = beforeOutbox.map(row => row.opId).sort();
      const afterIds = outbox.map(row => row.opId).sort();
      if (beforeIds.join(',') !== afterIds.join(',')) {
        throw new Error('The pending operation ids changed across restart');
      }
      if (persistedAccounts.length !== 1 || persistedAccounts[0].id !== afterAccounts[0].id) {
        throw new Error('The account identity changed across restart');
      }
      finance.afterRestart = {
        accountBalance: afterAccounts[0].initial_balance,
        pendingCount: status.pendingCount,
        opIds: afterIds
      };
      describeStep(
        'app.restart',
        `Unlocked the same profile after a forced restart; ${afterAccounts[0].initial_balance} and ${afterIds.length} pending operation(s) survived`
      );
      await captureWebView(restarted, join(screenshotsDirectory, '05-restart-webview.png'));
    });

    await step('central.start', async () => {
      await startCentralServices();
      await bootstrapOwner();
      describeStep(
        'central.start',
        `Central PocketBase ${centralPbPort} and BFF ${centralBffPort} started from the installed package; D009 setup created the owner`
      );
    });

    await step('pair.preview', async () => {
      const cdp = requireCdp();
      const preview = await bridgeJson<DesktopPreview>(
        cdp,
        `return await window.obol.sync.previewConnection({ serverAddress: ${JSON.stringify(centralBase)}, email: ${JSON.stringify(centralEmail)}, password: ${JSON.stringify(centralPassword)} });`,
        120_000
      );
      const actionIds = preview.actions.map(action => action.id);
      if (!actionIds.includes('importLocalData')) {
        throw new Error(`The pairing preview did not offer importLocalData; it offered ${actionIds.join(',') || 'nothing'}`);
      }
      if (preview.localOperationCount < 1) {
        throw new Error('The pairing preview reports no local operation log for a never-paired profile with local finance');
      }
      sync.preview = {
        serverName: preview.serverName,
        serverAddress: preview.serverAddress,
        hasServerData: preview.hasServerData,
        localEntityCount: preview.localEntityCount,
        localOperationCount: preview.localOperationCount,
        isRePairing: preview.isRePairing,
        hasLocalData: preview.hasLocalData,
        actions: preview.actions,
        warnings: preview.warnings
      };
      describeStep(
        'pair.preview',
        `Fresh preview offered ${actionIds.join(', ')}; local ${preview.localEntityCount} entities and ${preview.localOperationCount} operations`
      );
    });

    await step('pair.import', async () => {
      const cdp = requireCdp();
      const confirmed = await bridgeJson<DesktopStatus>(
        cdp,
        `return await window.obol.sync.confirmConnection({ choice: 'importLocalData', confirmation: null, exportReceipt: null });`,
        240_000
      );
      if (!confirmed.isPaired) throw new Error('The snapshot import did not pair the station');
      const deadline = Date.now() + 120_000;
      let latest = confirmed;
      while (Date.now() < deadline) {
        latest = await bridgeJson<DesktopStatus>(cdp, 'return await window.obol.sync.status();');
        if (latest.pendingCount === 0) break;
        await Bun.sleep(1_000);
      }
      if (latest.pendingCount !== 0) {
        throw new Error(`The imported station still reports ${latest.pendingCount} pending operations`);
      }
      sync.afterImport = latest;
      describeStep('pair.import', `Snapshot import accepted; paired=${latest.isPaired}, pending=${latest.pendingCount}`);
      await captureWebView(cdp, join(screenshotsDirectory, '06-paired-webview.png'));
      await captureNativeScreenshot(join(screenshotsDirectory, '06-paired-native.png'));
    });

    await step('server.verify-import', async () => {
      const accountsOutcome = await centralFetch('/api/accounts');
      if (accountsOutcome.status !== 200) throw new Error(`The central accounts endpoint returned HTTP ${accountsOutcome.status}`);
      const accounts = parseAccounts(accountsOutcome.body);
      if (accounts.length !== 1) throw new Error(`The central server has ${accounts.length} accounts, not 1`);
      const balance = accounts[0].initial_balance;
      if (balance !== 980) throw new Error(`The central account balance is ${balance}, not 980`);
      const transactionsOutcome = await centralFetch('/api/transactions?perPage=200&page=1');
      if (transactionsOutcome.status !== 200) {
        throw new Error(`The central transactions endpoint returned HTTP ${transactionsOutcome.status}`);
      }
      const items = parseTransactionPage(transactionsOutcome.body);
      const amounts = items.map(item => item.amount).sort((left, right) => left - right);
      if (amounts.length !== 1 || amounts[0] !== 20) {
        throw new Error(`The central history is not exactly one 20 expense: ${JSON.stringify(amounts)}`);
      }
      finance.serverAfterImport = {
        accountBalance: balance,
        accountCount: accounts.length,
        transactionAmounts: amounts,
        transactionCount: items.length
      };
      describeStep('server.verify-import', `Server materialized balance ${balance} with ${items.length} imported transaction`);
    });

    await step('offline.stop-central', async () => {
      if (centralBff === null || centralPb === null) throw new Error('The central services are not running');
      preStopIdentity = await handshake(requireOwnerToken(), await currentStationId(app), null, null);
      await stopCentral();
      describeStep(
        'offline.stop-central',
        `Stopped only the owned central PIDs; identity ${preStopIdentity.serverInstanceId} epoch ${preStopIdentity.dataEpoch} cursor ${preStopIdentity.cursor}`
      );
    });

    await step('offline.write', async () => {
      const cdp = requireCdp();
      const accountsBefore = parseAccounts(
        JSON.parse(
          (await bridgeJson<ApiCallResult>(
            cdp,
            `const response = await window.obol.apiFetch({ path: '/api/accounts', method: 'GET', headers: [] }); return { status: response.status, body: response.body };`
          )).body
        ) as unknown
      );
      if (accountsBefore.length !== 1 || accountsBefore[0].initial_balance !== 980) {
        throw new Error('The local balance drifted before the offline write');
      }
      const offlineTransaction = await bridgeJson<ApiCallResult>(
        cdp,
        `const response = await window.obol.apiFetch({ path: '/api/transactions', method: 'POST', headers: [['content-type', 'application/json']], body: JSON.stringify({ title: 'Windows smoke offline expense', amount: 5, type: 'expense', status: 'realized', expected_date: ${JSON.stringify(new Date().toISOString())}, account_id: ${JSON.stringify(accountsBefore[0].id)} }) }); return { status: response.status, body: response.body };`
      );
      if (offlineTransaction.status !== 201) {
        throw new Error(`The offline write returned HTTP ${offlineTransaction.status}: ${sanitize(offlineTransaction.body)}`);
      }
      const accounts = parseAccounts(
        JSON.parse(
          (await bridgeJson<ApiCallResult>(
            cdp,
            `const response = await window.obol.apiFetch({ path: '/api/accounts', method: 'GET', headers: [] }); return { status: response.status, body: response.body };`
          )).body
        ) as unknown
      );
      if (accounts.length !== 1 || accounts[0].initial_balance !== 975) {
        throw new Error('The offline write did not materialize 975');
      }
      const status = await bridgeJson<DesktopStatus>(cdp, 'return await window.obol.sync.status();');
      if (status.pendingCount < 1) throw new Error('The offline write did not leave a durable pending operation');
      finance.offline = {
        accountBalance: accounts[0].initial_balance,
        pendingCount: status.pendingCount,
        phase: status.phase,
        detail: status.detail
      };
      describeStep('offline.write', `Offline expense 5 materialized ${accounts[0].initial_balance} with ${status.pendingCount} pending operation(s)`);
      await captureWebView(cdp, join(screenshotsDirectory, '07-offline-webview.png'));
      await captureNativeScreenshot(join(screenshotsDirectory, '07-offline-native.png'));
    });

    await step('outbox.freeze', async () => {
      const pending = await readPendingOutbox();
      if (pending.length === 0) throw new Error('The local outbox has no pending row to freeze');
      operations.beforeRestart = pending;
      describeStep('outbox.freeze', `Froze ${pending.length} pending operation row(s) with their envelope hashes`);
    });

    await step('app.restart-offline', async () => {
      await stopApp();
      const launched = await startApp();
      app = launched;
      const target = await waitForCdpTarget(cdpPort, 60_000);
      const cdp = await CdpClient.connect(target.webSocketDebuggerUrl, 20_000);
      await cdp.send('Page.enable', {}, 15_000);
      await cdp.send('Runtime.enable', {}, 15_000);
      app = { rootPid: launched.rootPid, cdp };
      await waitForBoolean(
        cdp,
        `typeof window.obol === 'object' && Array.from(document.querySelectorAll('button')).some(candidate => (candidate.textContent || '').trim() === 'Unlock')`,
        120_000,
        'The unlock labels after the offline restart'
      );
      await setPasswordValue(cdp, 0, localPassword);
      await clickButton(cdp, 'Unlock');
      await waitForBoolean(cdp, `document.body && document.body.innerText.includes('Saldo disponível')`, 240_000, 'The dashboard after the offline restart');
      const accounts = parseAccounts(
        JSON.parse(
          (await bridgeJson<ApiCallResult>(
            cdp,
            `const response = await window.obol.apiFetch({ path: '/api/accounts', method: 'GET', headers: [] }); return { status: response.status, body: response.body };`
          )).body
        ) as unknown
      );
      if (accounts.length !== 1 || accounts[0].initial_balance !== 975) {
        throw new Error('The relaunched offline profile does not report 975');
      }
      const status = await bridgeJson<DesktopStatus>(cdp, 'return await window.obol.sync.status();');
      finance.afterOfflineRestart = {
        accountBalance: accounts[0].initial_balance,
        pendingCount: status.pendingCount,
        phase: status.phase
      };
      describeStep(
        'app.restart-offline',
        `Relaunched the same profile; ${accounts[0].initial_balance} and ${status.pendingCount} pending operation(s) survived the forced kill`
      );
      await captureWebView(cdp, join(screenshotsDirectory, '08-offline-restart-webview.png'));
    });

    await step('outbox.verify-frozen', async () => {
      const pending = await readPendingOutbox();
      const previous = outboxOperations(operations.beforeRestart);
      const previousById = new Map(previous.map(row => [row.opId, row] as const));
      if (pending.length !== previous.length) {
        throw new Error(`The pending operation count changed from ${previous.length} to ${pending.length} across the forced restart`);
      }
      for (const row of pending) {
        const before = previousById.get(row.opId);
        if (!before) throw new Error(`A pending operation ${row.opId} was minted after the checkpoint`);
        if (before.payloadHash !== row.payloadHash) {
          throw new Error(`Operation ${row.opId} carries a different envelope hash after restart`);
        }
      }
      operations.afterRestart = pending;
      operations.frozenIdentical = true;
      describeStep('outbox.verify-frozen', `All ${pending.length} pending opId/envelope-hash pairs are identical after the forced restart`);
    });

    await step('central.restart', async () => {
      if (preStopIdentity === null) throw new Error('The pre-stop central identity was not recorded');
      await startCentralServices(true);
      await loginOwner();
      const restarted = await handshake(
        requireOwnerToken(),
        await currentStationId(app),
        null,
        null
      );
      if (restarted.serverInstanceId !== preStopIdentity.serverInstanceId) {
        throw new Error('The restarted central server has a different instance id');
      }
      if (restarted.dataEpoch !== preStopIdentity.dataEpoch) {
        throw new Error('The restarted central server has a different data epoch');
      }
      sync.centralRestart = { before: preStopIdentity, after: restarted };
      describeStep(
        'central.restart',
        `Restarted the same volume; identity ${restarted.serverInstanceId} and epoch ${restarted.dataEpoch} are unchanged`
      );
    });

    await step('sync.reconnect', async () => {
      const cdp = requireCdp();
      const token = requireOwnerToken();
      const stationId = await currentStationId(app);
      const before = await handshake(token, stationId, null, null);
      await bridgeJson<DesktopStatus>(cdp, 'return await window.obol.sync.synchronize();', 180_000);
      const deadline = Date.now() + 180_000;
      let status = await bridgeJson<DesktopStatus>(cdp, 'return await window.obol.sync.status();');
      while (Date.now() < deadline) {
        status = await bridgeJson<DesktopStatus>(cdp, 'return await window.obol.sync.status();');
        if (status.pendingCount === 0 && status.phase === 'upToDate') break;
        if (status.phase === 'error' || status.phase === 'blocked' || status.phase === 'authRequired') {
          throw new Error(`Replication stopped in ${status.phase}: ${status.detail ?? 'no detail'}`);
        }
        await Bun.sleep(1_000);
      }
      if (status.pendingCount !== 0 || status.phase !== 'upToDate') {
        throw new Error(`Replication did not reach upToDate; phase ${status.phase}, ${status.pendingCount} operation(s) remain`);
      }
      const outbox = await bridgeJson<DesktopOutboxRow[]>(cdp, 'return await window.obol.sync.outbox();');
      if (outbox.length !== 0) throw new Error(`The outbox still exposes ${outbox.length} row(s) after synchronization`);
      const after = await handshake(token, stationId, null, null);
      sync.reconnect = {
        status,
        serverCursorBefore: before.cursor,
        serverCursorAfter: after.cursor,
        serverHeadHashAfter: after.headHash
      };
      describeStep(
        'sync.reconnect',
        `Reconnected over real HTTP to the same server; pending 0, outbox empty, cursor ${before.cursor} to ${after.cursor}`
      );
    });

    await step('server.verify-final', async () => {
      const cdp = requireCdp();
      const accountsOutcome = await centralFetch('/api/accounts');
      const accounts = parseAccounts(accountsOutcome.body);
      if (accounts.length !== 1) throw new Error(`The central server has ${accounts.length} accounts after sync`);
      const balance = accounts[0].initial_balance;
      if (balance !== 975) throw new Error(`The central balance is ${balance}, not 975`);
      const transactionsOutcome = await centralFetch('/api/transactions?perPage=200&page=1');
      const items = parseTransactionPage(transactionsOutcome.body);
      const amounts = items.map(item => item.amount).sort((left, right) => left - right);
      if (amounts.length !== 2 || amounts[0] !== 5 || amounts[1] !== 20) {
        throw new Error(`The central history is not exactly one 20 and one 5: ${JSON.stringify(amounts)}`);
      }
      const reconcile = await bridgeJson<DesktopStatus>(cdp, 'return await window.obol.sync.synchronize();', 180_000);
      const secondAccounts = parseAccounts((await centralFetch('/api/accounts')).body);
      const secondItems = parseTransactionPage((await centralFetch('/api/transactions?perPage=200&page=1')).body);
      if (secondAccounts[0].initial_balance !== 975 || secondItems.length !== 2) {
        throw new Error('A second synchronization changed the server balances or duplicated history');
      }
      finance.serverFinal = {
        accountBalance: balance,
        accountCount: accounts.length,
        transactionAmounts: amounts,
        transactionCount: items.length,
        afterSecondSync: {
          accountBalance: secondAccounts[0].initial_balance,
          transactionCount: secondItems.length,
          phase: reconcile.phase
        }
      };
      describeStep('server.verify-final', `Server shows ${balance} with exactly one 20 and one 5; a second sync left both unchanged`);
    });

    await step('sync.cursor', async () => {
      const token = requireOwnerToken();
      const state = await readStationState();
      if (typeof state.cursor !== 'number' || typeof state.lastChainHash !== 'string') {
        throw new Error('The local station state has no cursor or chain hash');
      }
      const identity = await handshake(token, await currentStationId(app), state.cursor, state.lastChainHash);
      if (identity.cursor !== state.cursor) {
        throw new Error(`The server cursor ${identity.cursor} differs from the stored commit boundary ${state.cursor}`);
      }
      if (identity.cursorHash !== state.lastChainHash) {
        throw new Error('The server cursor hash differs from the stored chain hash');
      }
      if (state.serverInstanceId !== undefined && state.serverInstanceId !== '' && identity.serverInstanceId !== state.serverInstanceId) {
        throw new Error('The station state is bound to a different server instance than the restarted central server');
      }
      if (state.dataEpoch !== undefined && identity.dataEpoch !== state.dataEpoch) {
        throw new Error('The station state data epoch differs from the central server epoch');
      }
      sync.cursor = {
        storedCursor: state.cursor,
        storedChainHash: state.lastChainHash,
        serverCursor: identity.cursor,
        serverCursorHash: identity.cursorHash,
        serverHeadHash: identity.headHash,
        serverInstanceId: identity.serverInstanceId,
        dataEpoch: identity.dataEpoch,
        stationMode: state.mode ?? null
      };
      describeStep('sync.cursor', `Stored cursor ${state.cursor} is a server-accepted commit boundary with matching chain hash`);
    });

    await step('updater.check', async () => {
      const cdp = requireCdp();
      const state = await bridgeJson<UpdaterState>(cdp, 'return await window.obol.updater.check();', 120_000);
      if (typeof state.status !== 'string' || typeof state.currentVersion !== 'string') {
        throw new Error('The updater bridge returned no truthful state');
      }
      updater.state = { ...state, installRequested: false };
      describeStep(
        'updater.check',
        `Updater check: status ${state.status}, current ${state.currentVersion}, available ${state.availableVersion || 'none'}, updateAvailable ${state.updateAvailable}; no update applied`
      );
    });
  } catch (error) {
    failure = sanitize(errorMessage(error));
    process.exitCode = 1;
  }

  try {
    await cleanup();
    steps.push({
      id: 'cleanup',
      status: 'passed',
      startedAt: nowIso(),
      finishedAt: nowIso(),
      detail: 'Stopped owned processes, ran the installed uninstaller, and removed the isolated staging/profile/server directories',
      error: null
    });
  } catch (error) {
    cleanupError = sanitize(errorMessage(error));
    if (failure === null) {
      failure = cleanupError;
      process.exitCode = 1;
    }
    steps.push({
      id: 'cleanup',
      status: 'failed',
      startedAt: nowIso(),
      finishedAt: nowIso(),
      detail: null,
      error: cleanupError
    });
  }

  unfinishedSteps(failure);

  const artifacts: string[] = [];
  try {
    for (const name of await readdir(screenshotsDirectory)) artifacts.push(join('screenshots', name));
    for (const name of await readdir(logsDirectory)) artifacts.push(join('logs', name));
  } catch {
    // Evidence listing is best-effort after an early failure.
  }

  const report: SmokeReport = {
    schemaVersion: 1,
    generatedAt: nowIso(),
    ok: failure === null && cleanupError === null && steps.every(record => record.status === 'passed'),
    failure,
    platform: { platform: process.platform, arch: process.arch },
    windows: windowsInfo,
    webview2: webview2Info,
    installer: {
      path: installerPath,
      fileName: installerPath === '' ? '' : installerPath.split(/[\\/]/).pop() ?? '',
      sha256: installerSha256 === '' ? null : installerSha256,
      bytes: installerBytes === 0 ? null : installerBytes,
      identifier: metadataIdentifier,
      channel: metadataChannel,
      builtAppVersion: installedVersion
    },
    isolation: {
      runDirectory,
      evidenceDirectory,
      localAppData,
      appId,
      centralDataDirectory: centralPbData
    },
    pids,
    steps,
    finance,
    operations,
    sync,
    updater,
    observations,
    artifacts,
    boundaries: [
      'Only Windows x64 is accepted; the script exits non-zero on every other host and without OBOL_WINDOWS_SMOKE_ISOLATED=1.',
      'Electrobun 2.0.5 passes a fixed WebView2 AdditionalBrowserArguments string, so WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS is ignored by that WebView2 host. An unreachable loopback CDP endpoint fails the run with native evidence; it is never skipped or replaced by another browser engine.',
      'The installer is the locally built, unsigned setup executable. SmartScreen is not exercised because the file has no Mark-of-the-Web.',
      'The central BFF binds as the product does; this smoke reaches it only through 127.0.0.1. PocketBase runs on a separate loopback port with isolated data.',
      'The updater check reads the build-embedded release channel and never calls install, so no uncontrolled public release is applied.',
      'The station session credential is written by the real app to the ephemeral runner user’s Windows Credential Manager under the nonce service name; it is never copied into evidence.',
      'The installed uninstaller and shell-integration entries belong to the ephemeral runner user; the cleanup step runs the uninstaller and removes the isolated directories.',
      'The real installer creates the Start Menu/Desktop shortcuts and HKCU uninstall entry for the ephemeral runner account, and the same uninstaller removes them; no real user profile is read or modified.'
    ]
  };

  await writeFile(join(evidenceDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        failure: report.failure,
        evidence: evidenceDirectory,
        steps: steps.map(record => ({ id: record.id, status: record.status, error: record.error ?? undefined }))
      },
      null,
      2
    )
  );
  if (!report.ok) process.exitCode = 1;
}

function refusalReason(): string | null {
  if (typeof Bun === 'undefined') return 'the script must run under Bun';
  if (process.platform !== 'win32') return `this smoke is native Windows x64 only (host ${process.platform})`;
  if (process.arch !== 'x64') return `this smoke is native Windows x64 only (host arch ${process.arch})`;
  if (process.env.OBOL_WINDOWS_SMOKE_ISOLATED !== '1') {
    return 'OBOL_WINDOWS_SMOKE_ISOLATED=1 is required to protect the runner and the user profile';
  }
  return null;
}

await main();
