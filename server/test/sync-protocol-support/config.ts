// Environment contract and isolation guards for the hosted sync acceptance
// runner. Nothing here touches the network; every value is read from the
// process environment the parent provides and every secret stays in memory.
//
// Guards applied BEFORE any write or settings change:
// - OBOL_SYNC_ISOLATED must be exactly "1";
// - both URLs must be absolute;
// - the raw PocketBase SDK must authenticate and read the settings marker
//   before the runner may write anything (see pocketbase.ts);
// - the settings marker `meta.appName` must be EXACTLY
//   "Obol sync protocol isolated". The runner never patches it: an operator
//   (the parent) owns that setting on the private volume.

export const ISOLATED_APP_NAME = 'Obol sync protocol isolated';

/** Refusal before any dataset write; exit code 2. */
export class IsolationRefusedError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = 'IsolationRefusedError';
  }
}

/** The guarded target exists but is not usable; exit code 3. */
export class EnvironmentGapError extends Error {
  readonly exitCode = 3;

  constructor(message: string) {
    super(message);
    this.name = 'EnvironmentGapError';
  }
}

export interface SyncHarnessConfig {
  readonly pbUrl: string;
  readonly bffUrl: string;
  readonly pbAdminEmail: string;
  readonly pbAdminPassword: string;
  readonly ownerEmail: string;
  readonly ownerPassword: string;
  readonly setupToken: string | null;
  readonly httpTimeoutMs: number;
  readonly ioTimeoutMs: number;
}

/** Synthetic strings never echoed by the runner. */
export function secretValues(config: SyncHarnessConfig): readonly string[] {
  return [
    config.pbAdminPassword,
    config.pbAdminEmail,
    config.ownerPassword,
    config.ownerEmail,
    ...(config.setupToken === null ? [] : [config.setupToken]),
  ].filter((value) => value.length > 0);
}

/** Removes every configured credential from text the runner prints. */
export function redactSecrets(
  text: string,
  config: SyncHarnessConfig,
): string {
  const secrets = [...secretValues(config)].sort(
    (left, right) => right.length - left.length,
  );
  let output = text;
  for (const secret of secrets) {
    output = output.split(secret).join('[redacted]');
  }
  return output;
}

/** Sanitized origin for the run report (userinfo removed). */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return '[invalid-url]';
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
      `${key} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  const value = Number(text);
  if (value < minimum || value > maximum) {
    throw new IsolationRefusedError(
      `${key} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function absoluteUrl(env: NodeJS.ProcessEnv, key: string): string {
  const raw = (env[key] ?? '').trim();
  if (raw.length === 0) {
    throw new IsolationRefusedError(`${key} is required for the guarded run.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new IsolationRefusedError(`${key} must be an absolute URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new IsolationRefusedError(`${key} must use http or https.`);
  }
  return raw.replace(/\/+$/, '');
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key] ?? '';
  if (value.length === 0) {
    throw new IsolationRefusedError(`${key} is required for the guarded run.`);
  }
  return value;
}

/**
 * Reads the complete guarded runtime contract. This function never writes and
 * never logs the values it reads.
 */
export function readConfig(env: NodeJS.ProcessEnv): SyncHarnessConfig {
  if (env.OBOL_SYNC_ISOLATED !== '1') {
    throw new IsolationRefusedError(
      'Refusing to run: set OBOL_SYNC_ISOLATED=1 only for the dedicated sync protocol database.',
    );
  }
  const setupToken = (env.OBOL_SYNC_SETUP_TOKEN ?? '').trim();
  return {
    pbUrl: absoluteUrl(env, 'OBOL_SYNC_PB_URL'),
    bffUrl: absoluteUrl(env, 'OBOL_SYNC_BFF_URL'),
    pbAdminEmail: required(env, 'OBOL_SYNC_PB_ADMIN_EMAIL'),
    pbAdminPassword: required(env, 'OBOL_SYNC_PB_ADMIN_PASSWORD'),
    ownerEmail: required(env, 'OBOL_SYNC_OWNER_EMAIL'),
    ownerPassword: required(env, 'OBOL_SYNC_OWNER_PASSWORD'),
    setupToken: setupToken.length > 0 ? setupToken : null,
    httpTimeoutMs: parseTimeout(
      env,
      'OBOL_SYNC_HTTP_TIMEOUT_MS',
      30_000,
      1_000,
      300_000,
    ),
    ioTimeoutMs: parseTimeout(
      env,
      'OBOL_SYNC_IO_TIMEOUT_MS',
      30_000,
      1_000,
      300_000,
    ),
  };
}

/** Invocation contract printed in the final run report (no secrets). */
export function describeInvocation(
  config: SyncHarnessConfig,
): Record<string, unknown> {
  return {
    command: 'bun server/test/sync-protocol.integration.ts',
    isolated: 'OBOL_SYNC_ISOLATED=1',
    pbUrl: displayUrl(config.pbUrl),
    bffUrl: displayUrl(config.bffUrl),
    httpTimeoutMs: config.httpTimeoutMs,
    ioTimeoutMs: config.ioTimeoutMs,
    credentials: 'synthetic values read from OBOL_SYNC_* environment only',
  };
}
