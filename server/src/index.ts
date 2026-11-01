import { Elysia } from 'elysia';
import type PocketBase from 'pocketbase';
import { createPocketBaseClient } from './infrastructure/plugins/pocketbase';
import { createContainer } from './infrastructure/di/container';
import { errorPlugin } from './infrastructure/plugins/errorPlugin';
import { createScheduler } from './infrastructure/scheduler';
import { transactionController } from './infrastructure/controllers/TransactionController';
import { forecastController } from './infrastructure/controllers/ForecastController';
import { cardController } from './infrastructure/controllers/CardController';
import { recurrenceController } from './infrastructure/controllers/RecurrenceController';
import { categoryController } from './infrastructure/controllers/CategoryController';
import { projectController } from './infrastructure/controllers/ProjectController';
import { accountController } from './infrastructure/controllers/AccountController';
import { jobController } from './infrastructure/controllers/JobController';
import { adminController } from './infrastructure/controllers/AdminController';
import { createSyncController } from './infrastructure/controllers/SyncController';
import { FinancialMutationRuntime } from './infrastructure/sync/FinancialMutationRuntime';
import {
  SETUP_TOKEN_TTL_MS,
  createSetupToken,
  createRemoteAuthPlugin,
  formatSetupWindow,
  ownerRecordExistsIn,
  pocketBaseStatusOf,
  resolveRemoteAuthOptions,
  resolveServerName,
  type CredentialsClient,
  type RemoteAuthOptions,
} from './infrastructure/plugins/remoteAuth';

/** `createServer` remote-auth wiring: either raw options (defaults for clock
 * and credentials client) or a full dependency set used by the test harness. */
export interface RemoteServerAuth {
  options: RemoteAuthOptions;
  now?: () => number;
  createCredentialsClient?: (baseUrl: string) => CredentialsClient;
}

/**
 * Builds the BFF around an already authenticated PocketBase client.
 *
 * `remoteAuth`:
 * - `undefined` (default): remote auth activates only when
 *   `OBOL_SESSION_SECRET` is configured; otherwise the composition runs the
 *   local runtime for desktop and legacy runtimes.
 * - `null`: force the legacy, unauthenticated local composition regardless of
 *   env (the explicit trusted local-desktop factory).
 * - `RemoteAuthOptions` / `RemoteServerAuth`: force remote/central mode.
 *
 * `mutationRuntime` is the shared FIFO runtime. Public startup callers create
 * it, await `initialize()` before listening and pass it here; when omitted the
 * function constructs the role implied by the effective auth. Construction is
 * synchronous; initialization stays lazy for direct `.handle` users.
 */
export function createServer(
  pb: PocketBase,
  remoteAuth?: RemoteAuthOptions | null | RemoteServerAuth,
  mutationRuntime?: FinancialMutationRuntime,
) {
  const remoteAuthDeps = remoteAuth === null
    ? { options: undefined }
    : remoteAuth === undefined
      ? { options: resolveRemoteAuthOptions() }
      : 'options' in remoteAuth
        ? remoteAuth
        : { options: remoteAuth };

  const runtime = mutationRuntime ?? new FinancialMutationRuntime(pb, {
    role: remoteAuthDeps.options === undefined ? 'local' : 'central',
  });
  const container = createContainer(pb, runtime.mutationContext());

  const remoteAuthPlugin = createRemoteAuthPlugin({ pb, ...remoteAuthDeps });
  // The scheduler owns a live cron handle from the installed plugin; the
  // application exposes its typed stop lifecycle so desktop/hosted shutdown
  // can stop the timer and drain a run already inside the FIFO gate.
  const scheduler = createScheduler(container);

  return new Elysia()
    .decorate('schedulerLifecycle', scheduler.lifecycle)
    .use(errorPlugin)
    .use(remoteAuthPlugin)
    // D009 authenticates before the sync surface mounts.
    .use(createSyncController(runtime))
    .use(scheduler.plugin)
    .use(transactionController(container))
    .use(forecastController(container))
    .use(cardController(container))
    .use(recurrenceController(container))
    .use(categoryController(container))
    .use(projectController(container))
    .use(accountController(container))
    .use(jobController(container))
    .use(adminController(container))
    // D009 requirement 4: the superuser email disclosure is removed in the
    // same change, in every mode (D8).
    .get('/', () => ({
      status: 'Online',
      message: 'BFF connected to PocketBase',
    }));
}

export type App = ReturnType<typeof createServer>;

/**
 * Prints the D009 setup credentials at boot (D4): when the deployment runs in
 * remote mode, has no `OBOL_SETUP_TOKEN` override and no owner exists yet, a
 * 32-hex-character token is generated here and printed to container logs with
 * a 30-minute window. When an owner exists setup is not announced.
 */
async function bootSetupCredentials(pb: PocketBase, options: RemoteAuthOptions): Promise<RemoteAuthOptions> {
  if (options.setupToken) {
    console.log(`🔐 Obol setup token from OBOL_SETUP_TOKEN is active for this boot (${formatSetupWindow(SETUP_TOKEN_TTL_MS)}): received via the environment, not reprinted.`);
    return options;
  }
  let ownerExists: boolean;
  try {
    ownerExists = await ownerRecordExistsIn(pb);
  } catch (pbError) {
    console.error('🚨 Obol could not read the owner state at boot (PocketBase status:', pocketBaseStatusOf(pbError), '); refusing to start with an unclear setup state.');
    throw new Error('Obol could not read the owner state at boot; setup stays closed until the cause is resolved.');
  }
  if (ownerExists) return options;

  const setupToken = createSetupToken();
  console.log('🔐 Obol server is in first-run setup mode.');
  console.log(`🔐 Setup token (${formatSetupWindow(SETUP_TOKEN_TTL_MS)}): ${setupToken}`);
  console.log('🔐 Use it with POST /api/setup/init to create the single owner; the token is deleted once setup completes.');
  return {
    ...options,
    setupToken,
    setupTokenIssuedAtMs: Date.now(),
    setupTokenTtlMs: SETUP_TOKEN_TTL_MS,
  };
}

export async function startHostedServer() {
  const pb = await createPocketBaseClient({
    url: process.env.POCKETBASE_URL ?? '',
    adminEmail: process.env.PB_ADMIN_EMAIL ?? '',
    adminPassword: process.env.PB_ADMIN_PASSWORD ?? ''
  });

  // Fail closed (D7/D10): a hosted deployment without a session secret never
  // starts. The trusted local-desktop factory uses `createServer(pb, null)`
  // explicitly and is unaffected.
  const resolved = resolveRemoteAuthOptions();
  if (!resolved) {
    throw new Error(
      'OBOL_SESSION_SECRET is required to start the hosted Obol server; refusing to listen without authenticated sessions.',
    );
  }
  const options = await bootSetupCredentials(pb, resolved);

  const runtime = new FinancialMutationRuntime(pb, {
    role: 'central',
    // The same `${options.serverName ?? deriveServerName(options.publicUrl)}`
    // result the auth plugin surfaces at login, so the sync handshake
    // (`/api/sync/handshake`) and the HTTP auth metadata can never disagree.
    serverName: resolveServerName(options),
  });
  // The durable identity, meta and deterministic backfill finish BEFORE the
  // port binds, so no served mutation can observe half-initialized metadata.
  await runtime.initialize();

  const app = createServer(pb, options, runtime);
  const port = Number(process.env.PORT) || 8080;
  app.listen({ port, hostname: '0.0.0.0' });
  console.log(`🚀 Obol BFF running at ${app.server?.hostname}:${app.server?.port}`);
  return app;
}

if (import.meta.main) await startHostedServer();
