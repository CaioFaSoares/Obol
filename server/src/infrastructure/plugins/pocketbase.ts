import PocketBase from 'pocketbase';

export interface PocketBaseClientOptions {
  url: string;
  adminEmail: string;
  adminPassword: string;
  retries?: number;
  retryDelayMs?: number;
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Creates and authenticates one PocketBase client after its server is reachable. */
export async function createPocketBaseClient(options: PocketBaseClientOptions): Promise<PocketBase> {
  if (!options.url || !options.adminEmail || !options.adminPassword) {
    throw new Error('PocketBase URL and superuser credentials are required');
  }

  const pb = new PocketBase(options.url);
  pb.autoCancellation(false);

  const retries = options.retries ?? 5;
  const retryDelayMs = options.retryDelayMs ?? 2000;
  let lastError: unknown;

  let authenticated = false;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      console.log(`🔄 Authenticating PocketBase superuser (attempt ${attempt}/${retries})...`);
      await pb.collection('_superusers').authWithPassword(
        options.adminEmail,
        options.adminPassword
      );
      console.log('✅ PocketBase superuser authenticated');
      authenticated = true;
      break;
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await delay(retryDelayMs);
      }
    }
  }

  if (!authenticated) {
    const details = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Could not authenticate PocketBase superuser after ${retries} attempts: ${details}`);
  }

  // Operator settings run after the retry loop: a rejected settings update is
  // not an authentication failure and must not trigger repeated re-login.
  await applyPocketBaseOperatorSettings(pb);
  return pb;
}

/**
 * Operator settings applied through the authenticated PocketBase settings API
 * (D5). Verified against the PocketBase settings API (v0.23+,
 * `core/settings_model.go` plus the binding behavior of `PATCH /api/settings`):
 * the server binds the submitted JSON onto a clone of the current settings, so
 * every key absent from the payload keeps its stored value. Sending only
 * `meta.appURL` and the `smtp` object below therefore never overwrites
 * unrelated settings: other `meta.*` fields (appName, senderName, ...) and SMTP
 * secrets not given through the environment stay as they are.
 */
interface PocketBaseSettingsPatch {
  meta?: { appURL: string };
  smtp?: {
    enabled: boolean;
    host: string;
    port: number;
    authMethod: string;
    tls: boolean;
    localName: string;
    username?: string;
    password?: string;
  };
}

/** Static literals for `PB_SMTP_AUTH_METHOD`. */
const SMTP_AUTH_METHOD_ENABLED: Record<string, boolean> = {
  PLAIN: true,
  LOGIN: true,
};

/**
 * Builds the `smtp` settings patch from `PB_SMTP_*` environment variables.
 * An empty `PB_SMTP_HOST` leaves any existing SMTP configuration untouched
 * (password reset stays unavailable, D5). A set host with a missing port, an
 * invalid port, TLS flag or auth method throws before anything is updated: the
 * BFF fails closed instead of serving while it would report an SMTP setup it
 * cannot actually use.
 */
function buildSmtpPatch(env: NodeJS.ProcessEnv): PocketBaseSettingsPatch['smtp'] {
  const host = (env.PB_SMTP_HOST ?? '').trim();
  if (host.length === 0) return undefined;

  if (/[\s/]+/.test(host) || host.toLowerCase().startsWith('http')) {
    throw new Error(
      'PB_SMTP_HOST must be an SMTP server hostname or IP address (no URL, slashes or whitespace); refusing to start (fail closed).',
    );
  }

  const rawPort = (env.PB_SMTP_PORT ?? '').trim();
  if (rawPort.length === 0) {
    throw new Error('PB_SMTP_PORT is required when PB_SMTP_HOST is set; refusing to start (fail closed).');
  }
  const port = Number(rawPort);
  if (rawPort !== String(port) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `PB_SMTP_PORT must be an integer between 1 and 65535; got ${rawPort}. Refusing to start (fail closed).`,
    );
  }

  const tlsRaw = (env.PB_SMTP_TLS ?? '').trim().toLowerCase();
  if (tlsRaw.length > 0 && tlsRaw !== 'true' && tlsRaw !== 'false') {
    throw new Error('PB_SMTP_TLS must be "true" or "false"; refusing to start (fail closed).');
  }
  // PocketBase semantics (core/settings_model.go): `tls: true` enforces TLS
  // negotiation from the first bytes; `tls: false` (the upstream default)
  // leaves the decision to the StartTLS exchange. Most relays on 587 want
  // false, on 465 true.
  const tls = tlsRaw === 'true';

  const authMethod = (env.PB_SMTP_AUTH_METHOD ?? '').trim().toUpperCase() || 'PLAIN';
  if (!SMTP_AUTH_METHOD_ENABLED[authMethod]) {
    throw new Error('PB_SMTP_AUTH_METHOD must be "PLAIN" or "LOGIN"; refusing to start (fail closed).');
  }

  const localName = (env.PB_SMTP_LOCAL_NAME ?? '').trim() || 'localhost';

  const smtp: NonNullable<PocketBaseSettingsPatch['smtp']> = {
    enabled: true,
    host,
    port,
    authMethod,
    tls,
    localName,
  };
  // Credentials are sent only when provided: the settings API preserves
  // omitted fields, so a previously stored secret from an earlier boot is
  // never erased by an empty environment value. Neither is ever logged.
  const username = (env.PB_SMTP_USERNAME ?? '').trim();
  if (username.length > 0) smtp.username = username;
  const password = env.PB_SMTP_PASSWORD ?? '';
  if (password.length > 0) smtp.password = password;
  return smtp;
}

/** Builds the `meta.appURL` patch from `OBOL_PUBLIC_URL` (D5: PocketBase
 * renders password-reset links against this URL). Trailing slashes trimmed. */
function buildMetaPatch(env: NodeJS.ProcessEnv): PocketBaseSettingsPatch['meta'] {
  const appURL = (env.OBOL_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  if (appURL.length === 0) return undefined;
  return { appURL };
}

/**
 * Applies one authenticated settings update with the operator-provided subset
 * after the superuser client has authenticated. Nothing to apply (no
 * `OBOL_PUBLIC_URL`, no `PB_SMTP_HOST`) is a no-op, so local and legacy
 * runtimes are unaffected. A rejected update fails the boot closed (D7
 * posture): the deployment never keeps serving while it would report a mail
 * setup it cannot use. Credential values are never logged.
 */
async function applyPocketBaseOperatorSettings(pb: PocketBase): Promise<void> {
  const env = process.env;
  const patch: PocketBaseSettingsPatch = {};
  const meta = buildMetaPatch(env);
  const smtp = buildSmtpPatch(env);
  if (meta?.appURL) patch.meta = meta;
  if (smtp) patch.smtp = smtp;
  if (!patch.meta && !patch.smtp) return;

  try {
    await pb.settings.update(patch);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Applying PocketBase operator settings (OBOL_PUBLIC_URL / PB_SMTP_*) failed; refusing to start (fail closed): ${details}`,
    );
  }
  console.log('✅ PocketBase operator settings applied');
  if (patch.meta?.appURL) {
    console.log(`✅ PocketBase meta.appURL set to ${patch.meta.appURL}`);
  }
  if (patch.smtp) {
    // Host, port and flag names only: never usernames or passwords.
    console.log(
      `✅ PocketBase SMTP configured for ${patch.smtp.host}:${patch.smtp.port} (authMethod ${patch.smtp.authMethod}${patch.smtp.tls ? ', enforced TLS' : ', StartTLS allowed'})`,
    );
  }
}
