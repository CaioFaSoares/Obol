import { randomBytes } from 'node:crypto';
import { chmod, link, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserView, BrowserWindow, BuildConfig, Updater, Utils } from 'electrobun/main';
import type { UpdateStatusEntry } from 'electrobun/main';
import { RESOURCES_FOLDER } from 'electrobun/main/paths';
import { electrobunEventEmitter } from 'electrobun/main/events';
import type { ElectrobunEvent } from 'electrobun/main/events';
import appConfig from '../../app.json';
import { createServer } from '../../../server/src/index';
import { createPocketBaseClient } from '../../../server/src/infrastructure/plugins/pocketbase';
import { FinancialMutationRuntime } from '../../../server/src/infrastructure/sync/FinancialMutationRuntime';
import { PocketbaseStationReplicaRepository } from '../../../server/src/infrastructure/repositories/PocketbaseStationReplicaRepository';
import { createLocalAccount, parseLocalAccountProfile, verifyLocalAccount } from './local-auth';
import type { LocalAccountProfile } from './local-auth';
import { DesktopStationSyncService } from './station-sync';
import type {
  ApiFetchRequest,
  ApiFetchResponse,
  DesktopAcknowledgeRejectedRequest,
  DesktopConfirmConnectionRequest,
  DesktopConnectionPreviewRequest,
  DesktopResolveConflictRequest,
  DesktopStationStatus,
  DesktopUpdaterState,
  LocalAccountSummary,
  LocalAuthSetupRequest,
  LocalAuthStatus,
  LocalAuthUnlockRequest,
  ObolBridgeSchema
} from '../shared-rpc';

const isDev = BuildConfig.getSync().channel === 'dev';
const identifier = process.env.OBOL_APP_ID?.trim() || appConfig.id;
if (isDev && identifier === appConfig.id) {
  throw new Error('OBOL_APP_ID must use the isolated dev id copland.obol.eb-dev');
}

const dataRoot = join(Utils.paths.appData, identifier);
const pbDataDir = join(dataRoot, 'pb_data');
const resourcesDir = join(RESOURCES_FOLDER, 'app', 'resources');
const pocketBaseBinary = join(resourcesDir, process.platform === 'win32' ? 'pocketbase.exe' : 'pocketbase');
const migrationsDir = join(RESOURCES_FOLDER, 'app', 'pb_migrations');
const pocketBaseUrl = 'http://127.0.0.1:13090';
const pocketBaseEmail = 'obol@localhost.invalid';
const localProfilePath = join(dataRoot, 'local_profile.json');
const legacyPasswordPath = join(dataRoot, 'pb_admin_password');
let pocketBaseProcess: Bun.Subprocess | undefined;
let apiServer: ReturnType<typeof createServer> | undefined;
let stationService: DesktopStationSyncService | undefined;
let shuttingDown = false;
let runtimeReady = false;
let authenticationInProgress = false;
/** In-memory only; never persisted or logged. Lets a failed update handoff restore the unlocked backend. */
let activeBackendPassword: string | undefined;

async function readLocalProfile(): Promise<LocalAccountProfile | null> {
  try {
    return parseLocalAccountProfile(await readFile(localProfilePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}


async function waitForPocketBase(child: Bun.Subprocess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`PocketBase exited before becoming healthy (code ${child.exitCode})`);
    }
    try {
      const response = await fetch(`${pocketBaseUrl}/api/health`, {
        redirect: 'error',
        signal: AbortSignal.timeout(5_000)
      });
      // Release the response body; the health check does not read it.
      await response.body?.cancel().catch(() => undefined);
      if (response.ok) return;
    } catch {
      // The PocketBase child is still starting.
    }
    await Bun.sleep(250);
  }
  throw new Error('PocketBase did not become healthy within 30 seconds');
}
async function localAuthStatus(): Promise<LocalAuthStatus> {
  const profile = await readLocalProfile();
  return {
    setupRequired: profile === null,
    account: profile === null ? null : { name: profile.name, email: profile.email }
  };
}

async function saveLocalProfile(profile: LocalAccountProfile): Promise<void> {
  const temporaryPath = `${localProfilePath}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(profile, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx'
  });
  if (process.platform !== 'win32') await chmod(temporaryPath, 0o600);
  try {
    await link(temporaryPath, localProfilePath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function ensurePocketBaseSuperuser(password: string): Promise<void> {
  const result = Bun.spawnSync([
    pocketBaseBinary,
    `--dir=${pbDataDir}`,
    `--migrationsDir=${migrationsDir}`,
    'superuser',
    'upsert',
    pocketBaseEmail,
    password
  ], {
    cwd: dataRoot,
    env: {
      ...process.env,
      PB_ADMIN_EMAIL: pocketBaseEmail,
      PB_ADMIN_PASSWORD: password
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  });
  if (result.exitCode !== 0) {
    console.error('PocketBase superuser upsert failed:', result.stderr.toString());
    throw new Error('Could not prepare local PocketBase access. Existing data was not deleted.');
  }
}

async function startLocalBackend(password: string): Promise<void> {
  if (runtimeReady) return;
  if (shuttingDown) throw new Error('Obol is closing.');
  activeBackendPassword = password;

  await ensurePocketBaseSuperuser(password);
  try {
    await unlink(legacyPasswordPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('Could not remove the obsolete PocketBase password file.');
    }
  }
  pocketBaseProcess = Bun.spawn([
    pocketBaseBinary,
    'serve',
    '--http=127.0.0.1:13090',
    `--dir=${pbDataDir}`,
    `--migrationsDir=${migrationsDir}`
  ], {
    cwd: dataRoot,
    env: {
      ...process.env,
      PB_ADMIN_EMAIL: pocketBaseEmail,
      PB_ADMIN_PASSWORD: password
    },
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit'
  });
  const child = pocketBaseProcess;
  void child.exited.then(code => {
    if (!runtimeReady || shuttingDown) return;
    const message = `The local PocketBase process exited unexpectedly (code ${code}). Obol will close.`;
    console.error(message);
    void Utils.showMessageBox({
      type: 'error',
      title: 'Obol data service stopped',
      message
    }).finally(() => Utils.quit());
  });

  try {
    await waitForPocketBase(child);
    const pb = await createPocketBaseClient({
      url: pocketBaseUrl,
      adminEmail: pocketBaseEmail,
      adminPassword: password,
      retries: 5,
      retryDelayMs: 500
    });
    // One local mutation runtime owns the FIFO gate, the unit of work and the
    // durable station identity. It finishes initialization (identity plus
    // journal prerequisites) before the profile is declared unlocked.
    const runtime = new FinancialMutationRuntime(pb, {
      role: 'local',
      serverName: 'Obol local'
    });
    await runtime.initialize();
    // The local BFF is consumed through `app.handle` only: no TCP listener is
    // required. Construction registers the standalone scheduler cron and
    // exposes its typed stop lifecycle on the server; shutdown stops that
    // timer and drains a scheduled run before PocketBase is killed. The cron
    // stays correct for an unpaired local profile, and a paired station skips
    // automatic shared recurrence generation through the runtime role check.
    const server = createServer(pb, null, runtime);
    apiServer = server;
    const station = new DesktopStationSyncService(
      new PocketbaseStationReplicaRepository(pb),
      {
        serviceName: identifier,
        deviceLabel: `${appConfig.title} on ${process.platform}`,
        platform: process.platform === 'win32' ? 'windows' : 'macos',
        emit: status => {
          try {
            mainRpc?.send['station.state'](status);
            mainRpc?.send['station.status'](status);
          } catch {
            // The webview transport is not connected; the next RPC status
            // call returns the same truthful state.
          }
        }
      }
    );
    stationService = station;
    try {
      await station.start();
    } catch (stationError) {
      // A corrupt station metadata row must never lock the user out of the
      // local finance that still opens; the station reports the failure on
      // its own surface instead.
      console.error(
        'Desktop station synchronization could not start:',
        stationError instanceof Error ? stationError.message : stationError
      );
    }
    runtimeReady = true;
    console.log(`Obol local profile unlocked (${identifier})`);
  } catch (error) {
    await stopBackend();
    throw error;
  }
}

async function withAuthentication<T>(operation: () => Promise<T>): Promise<T> {
  if (authenticationInProgress) throw new Error('Obol is already starting. Try again in a moment.');
  authenticationInProgress = true;
  try {
    return await operation();
  } finally {
    authenticationInProgress = false;
  }
}

async function setupLocalAccount(request: LocalAuthSetupRequest): Promise<LocalAccountSummary> {
  return withAuthentication(async () => {
    if (await readLocalProfile()) throw new Error('A local account already exists. Unlock it instead.');
    const created = await createLocalAccount(request);
    await saveLocalProfile(created.profile);
    await startLocalBackend(created.pocketBasePassword);
    return { name: created.profile.name, email: created.profile.email };
  });
}

async function unlockLocalAccount(request: LocalAuthUnlockRequest): Promise<LocalAccountSummary> {
  return withAuthentication(async () => {
    const profile = await readLocalProfile();
    if (!profile) throw new Error('Set up a local account to open this profile.');
    const password = await verifyLocalAccount(request, profile);
    if (!password) throw new Error('Invalid email or password.');
    await startLocalBackend(password);
    return { name: profile.name, email: profile.email };
  });
}

/**
 * Ordered, best-effort teardown shared by normal quit and the updater handoff.
 *
 * Sequence: stop and await the replicator, stop and await the scheduler (it
 * stops the registered cron handle and drains the job already inside the FIFO
 * mutation gate), then the Elysia surface, then the PocketBase child. Each
 * step is isolated so a failing resource cannot leave the others running next
 * to a backend that a failed update tries to restore. A stopped scheduler
 * handle is permanent, so a restored backend always gets a fresh one.
 */
async function stopBackend(): Promise<void> {
  // Detach the handles first: nothing new may attach to the resources that
  // are about to be torn down.
  const station = stationService;
  stationService = undefined;
  const server = apiServer;
  apiServer = undefined;
  const child = pocketBaseProcess;
  pocketBaseProcess = undefined;
  runtimeReady = false;

  if (station !== undefined) {
    // Abort and await replication before the scheduler/PocketBase disappear;
    // a frozen in-flight row stays durable for an exact retry after restart.
    try {
      await station.stop();
    } catch (error) {
      console.error('Desktop station replication did not stop cleanly:', error);
    }
  }

  if (server !== undefined) {
    // The cron handle belongs to this server instance; stop the timer and
    // wait for a scheduled job that already queued a financial mutation.
    try {
      await server.decorator.schedulerLifecycle.stop();
    } catch (error) {
      console.error('Desktop scheduler did not stop cleanly:', error);
    }
    try {
      const rawServer = server.server;
      if (rawServer !== undefined && rawServer !== null) {
        rawServer.stop(true);
      }
    } catch (error) {
      console.error('Desktop API surface did not stop cleanly:', error);
    }
  }

  if (child && child.exitCode === null) {
    try {
      child.kill('SIGTERM');
    } catch (error) {
      console.error('Could not ask PocketBase to stop gracefully:', error);
    }
    await Promise.race([child.exited, Bun.sleep(3000)]);
    if (child.exitCode === null) {
      try {
        child.kill('SIGKILL');
      } catch (error) {
        console.error('Could not force PocketBase to stop:', error);
      }
    }
  }
}

async function stopRuntime(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  activeBackendPassword = undefined;
  await stopBackend();
}

// ---------------------------------------------------------------------------
// Desktop auto-updater (packaged builds only)
// ---------------------------------------------------------------------------

/** Subset of the bun-side RPC instance used to publish updater state. */
interface UpdaterStatePublisher {
  send: {
    'updater.state': (state: DesktopUpdaterState) => void | PromiseLike<void>;
    'station.state': (state: DesktopStationStatus) => void | PromiseLike<void>;
    'station.status': (state: DesktopStationStatus) => void | PromiseLike<void>;
  };
}

let mainRpc: UpdaterStatePublisher | undefined;
let updateHandoffPending = false;
let updateHandoffApproved = false;
let updaterError: string | null = null;
let localUpdateVersion = '';
let lastUpdateStatus: UpdateStatusEntry | null = null;

function updaterPublishedState(): DesktopUpdaterState {
  const info = Updater.updateInfo();
  return {
    status: lastUpdateStatus?.status ?? 'idle',
    message: lastUpdateStatus?.message ?? '',
    currentVersion: localUpdateVersion,
    availableVersion: info.version,
    updateAvailable: info.updateAvailable,
    updateReady: info.updateReady,
    progress: lastUpdateStatus?.details?.progress ?? null,
    error: updaterError ?? (info.error || null)
  };
}

function publishUpdaterState(): void {
  if (!mainRpc) return;
  try {
    mainRpc.send['updater.state'](updaterPublishedState());
  } catch {
    // The webview transport is not connected yet; the initial `updater.status`
    // fetch covers whatever was missed.
  }
}

async function installUpdate(): Promise<void> {
  const info = Updater.updateInfo();
  if (!info.updateReady) {
    throw new Error(
      info.error || 'No downloaded update is ready to install yet.'
    );
  }
  if (shuttingDown) throw new Error('Obol is closing.');

  let backendWasStopped = false;
  updateHandoffPending = true;
  updateHandoffApproved = false;
  try {
    // Stop the replicator, scheduler, Elysia surface and PocketBase before the
    // native handoff so no backend resource survives the update replacement.
    // From here on the old resources are dismantled; a failure must restore
    // exactly ONE fresh set, and the stopped cron/scheduler handle is never
    // reused.
    backendWasStopped = true;
    await stopBackend();
    await Updater.applyUpdate();
    // Approval of the native before-quit request means the updater owns the
    // restart; this process must not restore the backend.
    if (updateHandoffApproved) return;
    throw new Error(
      info.error ||
        lastUpdateStatus?.message ||
        'The update could not be applied.'
    );
  } catch (error) {
    updateHandoffPending = false;
    updateHandoffApproved = false;
    updaterError = error instanceof Error ? error.message : String(error);
    if (backendWasStopped && activeBackendPassword) {
      try {
        await startLocalBackend(activeBackendPassword);
      } catch (restoreError) {
        console.error(
          'Could not restore the local profile after a failed update:',
          restoreError
        );
      }
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    publishUpdaterState();
  }
}

/** Check the release channel and start a background download when applicable. */
async function runUpdaterCheckCycle(): Promise<void> {
  updaterError = null;
  try {
    const info = await Updater.checkForUpdate();
    updaterError = info.error || null;
    if (info.updateAvailable && !info.updateReady && !updaterError) {
      void Updater.downloadUpdate().catch(error => {
        updaterError = error instanceof Error ? error.message : String(error);
        publishUpdaterState();
      });
    }
  } catch (error) {
    updaterError = error instanceof Error ? error.message : String(error);
    console.error('Update check failed:', error);
  } finally {
    publishUpdaterState();
  }
}

async function ensureUpdateServices(): Promise<void> {
  // Register first so statuses emitted by local-info reconciliation are seen.
  Updater.onStatusChange(entry => {
    lastUpdateStatus = entry;
    publishUpdaterState();
  });
  const local = await Updater.getLocalInfo();
  localUpdateVersion = local.version;
  publishUpdaterState();
  await runUpdaterCheckCycle();
}

async function updaterCheckRequest(): Promise<DesktopUpdaterState> {
  // Detection runs to completion; the download stays in the background.
  if (!isDev) await runUpdaterCheckCycle();
  return updaterPublishedState();
}

async function updaterInstallRequest(): Promise<void> {
  if (isDev) throw new Error('Updates are disabled in development builds.');
  await installUpdate();
}

async function startUpdaterServices(): Promise<void> {
  if (isDev) return;
  void ensureUpdateServices().catch(error => {
    console.error('Update services failed to start:', error);
  });
}

function appFrame(): { width: number; height: number } {
  const [width, height] = appConfig.size.split('x').map(Number);
  if (!width || !height) throw new Error(`Invalid desktop window size: ${appConfig.size}`);
  return { width, height };
}

async function bridgePreload(): Promise<string> {
  const path = join(RESOURCES_FOLDER, 'app', 'views', 'mainview', 'index.js');
  const bridge = Bun.file(path);
  if (!(await bridge.exists())) throw new Error('Electrobun view bridge is missing from the bundle');
  return bridge.text();
}

function apiRequest(request: ApiFetchRequest): Request {
  const url = new URL(request.path, 'http://obol.local');
  if (url.origin !== 'http://obol.local' || !url.pathname.startsWith('/api/')) {
    throw new Error('Desktop RPC only accepts Obol API paths');
  }
  const method = request.method.toUpperCase();
  const init: RequestInit = {
    method,
    headers: request.headers
  };
  if (method !== 'GET' && method !== 'HEAD' && request.body !== undefined) init.body = request.body;
  return new Request(url, init);
}

async function dispatchApiRequest(request: ApiFetchRequest): Promise<ApiFetchResponse> {
  if (!apiServer) throw new Error('Obol API is not ready');
  if (isDev) console.log(`[desktop api] ${request.method} ${request.path}`);
  const method = request.method.toUpperCase();
  const response = await apiServer.handle(apiRequest(request));
  const result: ApiFetchResponse = {
    status: response.status,
    statusText: response.statusText,
    headers: Array.from(response.headers.entries()),
    body: await response.text()
  };
  // A successful financial write is a real local change; ask the station to
  // replicate it after a short debounce. The station itself never copies
  // finance: the local runtime already recorded the durable intent.
  if (
    response.status >= 200 &&
    response.status < 300 &&
    method !== 'GET' &&
    method !== 'HEAD'
  ) {
    stationService?.noteLocalChange();
  }
  return result;
}

/** Station RPCs reject honestly until the local profile is unlocked. */
function requireStationService(): DesktopStationSyncService {
  if (stationService === undefined) {
    throw new Error('Unlock the local Obol profile before using station synchronization.');
  }
  return stationService;
}

async function main(): Promise<void> {
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  await mkdir(pbDataDir, { recursive: true, mode: 0o700 });
  if (!(await Bun.file(pocketBaseBinary).exists())) {
    throw new Error(`Bundled PocketBase executable is missing: ${pocketBaseBinary}`);
  }
  try {
    if (!(await stat(migrationsDir)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new Error(`Bundled PocketBase migrations are missing: ${migrationsDir}`);
  }

  const rpc = BrowserView.defineRPC<ObolBridgeSchema>({
    maxRequestTime: 120_000,
    handlers: {
      requests: {
        'api.fetch': dispatchApiRequest,
        'auth.status': localAuthStatus,
        'auth.setup': setupLocalAccount,
        'auth.unlock': unlockLocalAccount,
        'updater.status': () => updaterPublishedState(),
        'updater.check': updaterCheckRequest,
        'updater.install': updaterInstallRequest,
        'station.status': () => requireStationService().status(),
        'station.synchronize': () => requireStationService().synchronize(),
        'station.previewConnection': (request: DesktopConnectionPreviewRequest) =>
          requireStationService().previewConnection(request),
        'station.confirmConnection': (request: DesktopConfirmConnectionRequest) =>
          requireStationService().confirmConnection(request),
        'station.cancelConnectionPreview': () => requireStationService().cancelConnectionPreview(),
        'station.disconnect': () => requireStationService().disconnect(),
        'station.signOut': () => requireStationService().signOut(),
        'station.outbox': () => requireStationService().outbox(),
        'station.conflicts': () => requireStationService().conflicts(),
        'station.resolveConflict': (request: DesktopResolveConflictRequest) =>
          requireStationService().resolveConflict(request),
        'station.acknowledgeRejected': (request: DesktopAcknowledgeRejectedRequest) =>
          requireStationService().acknowledgeRejected(request),
        'station.exportSnapshot': () => requireStationService().exportSnapshot()
      },
      messages: {}
    }
  });
  mainRpc = rpc;
  const preload = await bridgePreload();
  const mainUrl = isDev
    ? process.env.OBOL_MAIN_URL || 'http://127.0.0.1:3303/'
    : 'views://mainview/index.html';

  new BrowserWindow({
    title: appConfig.title,
    frame: { width: appFrame().width, height: appFrame().height },
    url: mainUrl,
    preload,
    rpc,
    renderer: 'native',
    allowedProtocols: { views: true, appData: false }
  });
  await startUpdaterServices();
  console.log(`Obol local login ready (${identifier}); data: ${dataRoot}`);
}


electrobunEventEmitter.on(
  'before-quit',
  (event: ElectrobunEvent<Record<string, never>, { allow: boolean }>) => {
    // The updater's native handoff asks for quit approval after the backend
    // has already been stopped; the normal flow stops the backend first.
    if (shuttingDown || updateHandoffPending) {
      if (updateHandoffPending) updateHandoffApproved = true;
      event.response = { allow: true };
      return;
    }
    event.response = { allow: false };
    void stopRuntime()
      .then(() => Utils.quit())
      .catch(error => {
        console.error('Obol shutdown cleanup failed:', error);
        Utils.quit();
      });
  }
);
process.on('exit', () => {
  if (pocketBaseProcess && pocketBaseProcess.exitCode === null) {
    try {
      process.kill(pocketBaseProcess.pid, 'SIGTERM');
    } catch {
      // The child already exited.
    }
  }
});
process.on('SIGINT', () => Utils.quit());
process.on('SIGTERM', () => Utils.quit());

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  try {
    await Utils.showMessageBox({ type: 'error', title: 'Obol could not start', message });
  } catch {
    console.error(message);
  }
  await stopRuntime();
  throw error;
}
