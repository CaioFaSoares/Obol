import { randomBytes } from 'node:crypto';
import { chmod, link, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserView, BrowserWindow, BuildConfig, Utils } from 'electrobun/main';
import { RESOURCES_FOLDER } from 'electrobun/main/paths';
import { electrobunEventEmitter } from 'electrobun/main/events';
import type { ElectrobunEvent } from 'electrobun/main/events';
import appConfig from '../../app.json';
import { createServer } from '../../../server/src/index';
import { createPocketBaseClient } from '../../../server/src/infrastructure/plugins/pocketbase';
import { createLocalAccount, parseLocalAccountProfile, verifyLocalAccount } from './local-auth';
import type { LocalAccountProfile } from './local-auth';
import type {
  ApiFetchRequest,
  ApiFetchResponse,
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
const pocketBaseBinary = join(resourcesDir, 'pocketbase');
const migrationsDir = join(RESOURCES_FOLDER, 'app', 'pb_migrations');
const pocketBaseUrl = 'http://127.0.0.1:13090';
const pocketBaseEmail = 'obol@localhost.invalid';
const localProfilePath = join(dataRoot, 'local_profile.json');
const legacyPasswordPath = join(dataRoot, 'pb_admin_password');
let pocketBaseProcess: Bun.Subprocess | undefined;
let apiServer: ReturnType<typeof createServer> | undefined;
let shuttingDown = false;
let runtimeReady = false;
let authenticationInProgress = false;

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
      const response = await fetch(`${pocketBaseUrl}/api/health`);
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
    const server = createServer(pb);
    server.listen({ hostname: '127.0.0.1', port: 13080 });
    if (!server.server) throw new Error('Could not bind Obol BFF to 127.0.0.1:13080');
    apiServer = server;
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

async function stopBackend(): Promise<void> {
  const server = apiServer;
  apiServer = undefined;
  server?.server?.stop(true);

  const child = pocketBaseProcess;
  pocketBaseProcess = undefined;
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([child.exited, Bun.sleep(3000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  runtimeReady = false;
}

async function stopRuntime(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await stopBackend();
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
  const response = await apiServer.handle(apiRequest(request));
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Array.from(response.headers.entries()),
    body: await response.text()
  };
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

  const mainRpc = BrowserView.defineRPC<ObolBridgeSchema>({
    maxRequestTime: 120_000,
    handlers: {
      requests: {
        'api.fetch': dispatchApiRequest,
        'auth.status': localAuthStatus,
        'auth.setup': setupLocalAccount,
        'auth.unlock': unlockLocalAccount
      },
      messages: {}
    }
  });
  const preload = await bridgePreload();
  const mainUrl = isDev
    ? process.env.OBOL_MAIN_URL || 'http://127.0.0.1:3303/'
    : 'views://mainview/index.html';

  new BrowserWindow({
    title: appConfig.title,
    frame: { width: appFrame().width, height: appFrame().height },
    url: mainUrl,
    preload,
    rpc: mainRpc,
    renderer: 'native',
    allowedProtocols: { views: true, appData: false }
  });
  console.log(`Obol local login ready (${identifier}); data: ${dataRoot}`);
}


electrobunEventEmitter.on(
  'before-quit',
  (event: ElectrobunEvent<Record<string, never>, { allow: boolean }>) => {
    if (shuttingDown) {
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
