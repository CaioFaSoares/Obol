// D009 remote-auth coverage, against an in-memory PocketBase double that
// implements exactly the SDK surface the server touches. Deterministic: no
// sleeps, no network, and a controllable wall clock drives expiry, TTL and
// rate-limit windows.
import { describe, expect, test } from 'bun:test';
import type PocketBase from 'pocketbase';
import { Elysia } from 'elysia';
import { createServer } from '../src/index';
import type { RemoteServerAuth } from '../src/index';
import {
  MIN_SESSION_SECRET_LENGTH,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_COOKIE_NAME,
  SESSION_TOKEN_TTL_MS,
  SETUP_TOKEN_TTL_MS,
  buildSessionCookie,
  createRemoteAuthPlugin,
  createSetupToken,
  deriveServerName,
  parsePbDate,
  readBearerToken,
  readCookie,
  resolveRemoteAuthOptions,
  signSessionToken,
  toPbDate,
  verifySessionToken,
  type CredentialsClient,
  type RemoteAuthOptions,
} from '../src/infrastructure/plugins/remoteAuth';

// ---------------------------------------------------------------------------
// Deterministic PocketBase double
// ---------------------------------------------------------------------------

type FakeRecord = Record<string, string | number | boolean | undefined> & { id: string };

type FakePb = {
  baseUrl: string;
  authStore: { token: string; record: { id: string; email: string } };
  collection(name: string): unknown;
  collection(name: string, source: 'credentials'): unknown;
};

const FIXED_INSTANT_MS = 1_760_000_000_000;
const DAY_MS = 24 * 3600 * 1000;
const FAKE_OWNER_EMAIL = 'owner@obol.cash';
const FAKE_OWNER_PASSWORD = 'correct horse battery staple';
const FAKE_SUPERUSER = { token: 'superuser-token-fixed', record: { id: 'su_fixed', email: 'admin@obol.local' } };
const PB_RESET_TOKEN = 'pb-password-reset-token-fixed';

/** PocketBase-shaped response error thrown by the SDK boundary. */
function pbError(status: number, message: string) {
  return Object.assign(new Error(message), {
    status,
    response: { message },
    name: `ClientResponseError ${status}`,
  });
}

function createFakePb(
  seed: {
    owner?: { email: string; password: string };
    sessions?: Array<{ id: string; userId: string; expiresAt: string; createdAt: string; deviceLabel?: string }>;
  } = {},
) {
  const ownerRecords: FakeRecord[] = [];
  const sessionRecords = new Map<string, FakeRecord>();
  const state = {
    adminAuthAttempts: 0,
    credentialAuthAttempts: 0,
    sentResetEmails: [] as string[],
    lastSessionCreate: undefined as Record<string, unknown> | undefined,
    lastSessionListSort: undefined as string | undefined,
  };
  let idCounter = 1;

  if (seed.owner) {
    ownerRecords.push({
      id: `own_${idCounter++}`,
      email: seed.owner.email,
      password: seed.owner.password,
      verified: false,
    });
  }
  if (seed.sessions) {
    for (const session of seed.sessions) {
      sessionRecords.set(session.id, { ...session });
    }
  }

  /** `source` splits the counters: `shared` is the superuser-attached client
   * the BFF must keep untouched, while `credentials` is the throwaway
   * credentials-check client path of the plugin (D7). */
  function fakeCollection(name: string, source: 'shared' | 'credentials' = 'shared') {
    if (name === 'owner') {
      return {
        async authWithPassword(email: string, password: string) {
          if (source === 'shared') state.adminAuthAttempts += 1;
          else state.credentialAuthAttempts += 1;
          const record = ownerRecords.find((candidate) => candidate.email === email);
          if (!record || record.password !== password) {
            throw pbError(401, 'Failed to authenticate.');
          }
          // Real SDK shape: token lives at the top level, the record is nested.
          // A PB token is present so leak tests can prove the BFF filters it.
          return {
            record: { id: record.id, email: record.email },
            token: 'pb-credential-never-for-clients',
            meta: {},
          };
        },
        async getList(page: number, perPage: number) {
          return {
            page,
            perPage,
            totalItems: ownerRecords.length,
            items: ownerRecords.slice((page - 1) * perPage, page * perPage),
          };
        },
        async create(data: Record<string, unknown>) {
          const email = String(data.email);
          if (ownerRecords.some((record) => record.email === email)) {
            throw pbError(400, 'Failed to create record (duplicate).');
          }
          const record: FakeRecord = {
            id: `own_${idCounter++}`,
            email,
            password: String(data.password),
            verified: false,
          };
          ownerRecords.push(record);
          return { ...record };
        },
        async requestPasswordReset(email: string) {
          if (!ownerRecords.some((record) => record.email === email)) {
            throw pbError(404, 'Failed to request password reset.');
          }
          state.sentResetEmails.push(email);
          return true;
        },
        async confirmPasswordReset(token: string, password: string) {
          if (token !== PB_RESET_TOKEN) {
            throw pbError(400, 'Failed to confirm the password reset request.');
          }
          const record = ownerRecords[0];
          if (!record) throw pbError(404, 'Failed to confirm the password reset request.');
          record.password = password;
          return true;
        },
      };
    }

    if (name === 'sessions') {
      // PocketBase ships a reserved built-in `sessions` collection, so the BFF
      // must only ever touch the dedicated `obol_sessions` registry. Throwing
      // makes any regression to the reserved name fail loudly in every test
      // that exercises the session routes.
      throw new Error("PocketBase reserved collection 'sessions' must not be accessed by the BFF (use 'obol_sessions').");
    }

    if (name === 'obol_sessions') {
      return {
        async getOne(id: string) {
          const record = sessionRecords.get(id);
          if (!record) throw pbError(404, 'Missing record.');
          return { ...record };
        },
        async getList(page: number, perPage: number, options?: { sort?: string }) {
          state.lastSessionListSort = options?.sort;
          const all = [...sessionRecords.values()];
          if (options?.sort === '-createdAt') {
            all.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
          }
          return {
            page,
            perPage,
            totalItems: all.length,
            items: all.slice((page - 1) * perPage, page * perPage),
          };
        },
        async create(data: Record<string, unknown>) {
          state.lastSessionCreate = data;
          // Like PB 0.40 base collections, the double does not auto-inject
          // `created`: the server must persist its own `createdAt`.
          const record: FakeRecord = {
            id: `ses_${idCounter++}`,
            ...data,
          } as unknown as FakeRecord;
          sessionRecords.set(record.id, record);
          return { ...record };
        },
        async update(id: string, data: Record<string, unknown>) {
          const record = sessionRecords.get(id);
          if (!record) throw pbError(404, 'Missing record.');
          Object.assign(record, data);
          return { ...record };
        },
        async delete(id: string) {
          if (!sessionRecords.delete(id)) throw pbError(404, 'Missing record.');
          return true;
        },
      };
    }

    // Generic base collections (accounts, transactions, invoices, ...) used by
    // legacy-mode use cases and by the probe business route below.
    const genericRecords: FakeRecord[] = [];
    return {
      async getFullList() {
        return genericRecords.map((record) => ({ ...record }));
      },
      async getOne(id: string) {
        const record = genericRecords.find((candidate) => candidate.id === id);
        if (!record) throw pbError(404, 'Missing record.');
        return { ...record };
      },
      async create(data: Record<string, unknown>) {
        const record: FakeRecord = { id: `${name}_${idCounter++}`, ...data } as unknown as FakeRecord;
        genericRecords.push(record);
        return { ...record };
      },
      async update(id: string, data: Record<string, unknown>) {
        const record = genericRecords.find((candidate) => candidate.id === id);
        if (!record) throw pbError(404, 'Missing record.');
        Object.assign(record, data);
        return { ...record };
      },
      async delete(id: string) {
        const at = genericRecords.findIndex((candidate) => candidate.id === id);
        if (at === -1) throw pbError(404, 'Missing record.');
        genericRecords.splice(at, 1);
        return true;
      },
    };
  }

  const pb: FakePb = {
    baseUrl: 'http://127.0.0.1:8090',
    authStore: FAKE_SUPERUSER,
    collection: fakeCollection,
  };

  return {
    pb,
    state,
    ownerRecords,
    sessionRecords,
    sessionsList: () => [...sessionRecords.values()],
  };
}

/** Boundary cast with reason: the double implements the exact PocketBase SDK
 * surface the server uses (`baseUrl`, `authStore`, `collection`). */
function asPocketBase(fakePb: FakePb): PocketBase {
  return fakePb as unknown as PocketBase;
}

// Throwaway credentials-client factory, mirroring the production boundary
// (`new PocketBase(baseUrl)` per credentials check): the shared superuser
// client's authStore is never used to check owner credentials.
function createCredentialsDouble() {
  const clients: Array<{ baseUrl: string }> = [];
  /** The double must address the PocketBase-shaped object (`fake.pb`), not the
   * outer harness wrapper: `authWithPassword` on the credentials surface is
   * what increments `credentialAuthAttempts` (D7). */
  let fakeRef!: FakePb;
  const createCredentialsClient = (baseUrl: string): CredentialsClient => {
    const client = {
      baseUrl,
      autoCancellation() {
        return client;
      },
      collection: (name: string) => fakeRef.collection(name, 'credentials'),
    };
    clients.push(client);
    // The double implements the exact CredentialsClient surface the plugin
    // touches (`baseUrl`, `autoCancellation`, `collection`), nothing more.
    return client as unknown as CredentialsClient;
  };
  return {
    clients,
    bind: (fake: ReturnType<typeof createFakePb>) => {
      fakeRef = fake.pb;
    },
    createCredentialsClient,
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const FAKE_OPTIONS: RemoteAuthOptions = {
  sessionSecret: 'k'.repeat(32),
  publicUrl: 'https://app.example.com',
  clientOrigins: ['https://ios.example.com'],
  smtpConfigured: false,
  serverName: 'obol-central',
};

const SETUP_TOKEN = 'a'.repeat(32);
const SETUP_BODY = { setupToken: SETUP_TOKEN, email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD };
const TEST_ACCOUNT = { name: 'Main', type: 'checking', initial_balance: 100 };

const clock = {
  value: FIXED_INSTANT_MS,
  advanceBy(ms: number) {
    this.value += ms;
  },
  reset() {
    this.value = FIXED_INSTANT_MS;
  },
};

const jsonRequest = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const bodyJson = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

/** Full-composition app through the real exported `createServer`. */
function bootServer(
  fake: ReturnType<typeof createFakePb>,
  overrides: Partial<RemoteAuthOptions> = {},
) {
  clock.reset();
  const double = createCredentialsDouble();
  double.bind(fake);
  const options = { ...FAKE_OPTIONS, setupToken: SETUP_TOKEN, ...overrides };
  const remoteDeps: RemoteServerAuth = {
    options,
    now: () => clock.value,
    createCredentialsClient: double.createCredentialsClient,
  };
  const app = createServer(asPocketBase(fake.pb), remoteDeps);
  return {
    double,
    handle: (request: Request) => app.handle(request),
    options,
  };
}

function jwtPayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

async function login(handle: (request: Request) => Promise<Response>, body: Record<string, unknown> = {}) {
  return handle(jsonRequest('/api/auth/login', 'POST', {
    email: FAKE_OWNER_EMAIL,
    password: FAKE_OWNER_PASSWORD,
    ...body,
  }));
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get('set-cookie') ?? '';
  expect(setCookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBeTrue();
  return readCookie(setCookie, SESSION_COOKIE_NAME);
}

/** Boot with an existing owner and perform one successful login. */
async function bootedSession(fakeSeed?: Parameters<typeof createFakePb>[0]) {
  const fake = createFakePb(fakeSeed ?? { owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
  const boot = bootServer(fake);
  const response = await login(boot.handle);
  const token = cookieFrom(response);
  return { fake, handle: boot.handle, token };
}

describe('JWT primitives (HS256, D2)', () => {
  test('round trip binds signature, claims and expiry together', async () => {
    const token = await signSessionToken('k'.repeat(32), { sub: 'own_1', sid: 'ses_1' }, FIXED_INSTANT_MS);
    const verified = await verifySessionToken('k'.repeat(32), token, FIXED_INSTANT_MS + 1000);
    expect(verified.ok).toBeTrue();
    if (verified.ok) {
      expect(verified.sub).toBe('own_1');
      expect(verified.sid).toBe('ses_1');
      expect(verified.exp).toBe(Math.floor((FIXED_INSTANT_MS + SESSION_TOKEN_TTL_MS) / 1000));
    }
  });

  test('expired tokens answer EXPIRED, not malformed', async () => {
    const token = await signSessionToken(
      'k'.repeat(32),
      { sub: 'own_1', sid: 'ses_1' },
      FIXED_INSTANT_MS - SESSION_TOKEN_TTL_MS - 10_000,
    );
    expect(await verifySessionToken('k'.repeat(32), token, FIXED_INSTANT_MS)).toEqual({
      ok: false,
      reason: 'EXPIRED',
    });
  });

  test('wrong signing secret (rotation) answers INVALID_SIGNATURE', async () => {
    const token = await signSessionToken('k'.repeat(32), { sub: 'own_1', sid: 'ses_1' }, FIXED_INSTANT_MS);
    expect(await verifySessionToken('t'.repeat(32), token, FIXED_INSTANT_MS + 1000)).toEqual({
      ok: false,
      reason: 'INVALID_SIGNATURE',
    });
  });

  test('tampered payload cannot revalidate', async () => {
    const token = await signSessionToken('k'.repeat(32), { sub: 'own_1', sid: 'ses_1' }, FIXED_INSTANT_MS);
    const forged = token.slice(0, -1) + (token.startsWith('a') ? 'x' : 'a');
    expect(await verifySessionToken('k'.repeat(32), forged, FIXED_INSTANT_MS + 1000)).toEqual({
      ok: false,
      reason: 'INVALID_SIGNATURE',
    });
  });

  test('garbage input answers MALFORMED without throwing', async () => {
    expect(await verifySessionToken('k'.repeat(32), 'not-a-jwt', FIXED_INSTANT_MS)).toEqual({
      ok: false,
      reason: 'MALFORMED',
    });
    expect(await verifySessionToken('k'.repeat(32), '', FIXED_INSTANT_MS)).toEqual({
      ok: false,
      reason: 'MALFORMED',
    });
  });
});

describe('environment resolution (D7 fail closed, D10 legacy switch)', () => {
  test('no OBOL_SESSION_SECRET keeps remote auth off', () => {
    expect(resolveRemoteAuthOptions({} as NodeJS.ProcessEnv)).toBeUndefined();
  });

  test('a too-short secret refuses to start (fail closed)', () => {
    const fake = createFakePb();
    expect(() =>
      createRemoteAuthPlugin({
        pb: asPocketBase(fake.pb),
        options: { ...FAKE_OPTIONS, sessionSecret: 'short' },
      }),
    ).toThrow();
  });

  test('a configured environment maps to remote options with an exact origin list', () => {
    const options = resolveRemoteAuthOptions({
      OBOL_SESSION_SECRET: 'k'.repeat(MIN_SESSION_SECRET_LENGTH),
      OBOL_PUBLIC_URL: 'https://api.example.com/',
      OBOL_CLIENT_ORIGINS: 'https://a.example.com , https://b.example.com,',
      OBOL_SETUP_TOKEN: 'b'.repeat(32),
      PB_SMTP_HOST: 'smtp.example.com',
    });
    expect(options).toEqual({
      sessionSecret: 'k'.repeat(MIN_SESSION_SECRET_LENGTH),
      publicUrl: 'https://api.example.com',
      clientOrigins: ['https://a.example.com', 'https://b.example.com'],
      smtpConfigured: true,
      setupToken: 'b'.repeat(32),
      setupTokenIssuedAtMs: expect.any(Number),
      setupTokenTtlMs: SETUP_TOKEN_TTL_MS,
    });
  });

  test('setup tokens are 32 hex characters and cookies keep the host prefix (D4/D6)', () => {
    expect(createSetupToken()).toMatch(/^[0-9a-f]{32}$/);
    expect(buildSessionCookie('jwt', 60)).toBe(
      `${SESSION_COOKIE_NAME}=jwt; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60`,
    );
    expect(deriveServerName('https://api.example.com/')).toBe('api.example.com');
  });

  test('a missing or non-https public URL refuses to boot with remote auth (D7/D9)', () => {
    const base = { OBOL_SESSION_SECRET: 'k'.repeat(MIN_SESSION_SECRET_LENGTH) };
    expect(() => resolveRemoteAuthOptions(base as unknown as NodeJS.ProcessEnv)).toThrow(/OBOL_PUBLIC_URL/);
    expect(() => resolveRemoteAuthOptions({ ...base, OBOL_PUBLIC_URL: 'http://api.example.com' } as unknown as NodeJS.ProcessEnv)).toThrow(
      /OBOL_PUBLIC_URL/,
    );
    expect(() => resolveRemoteAuthOptions({ ...base, OBOL_PUBLIC_URL: 'https://api.example.com/sub' } as unknown as NodeJS.ProcessEnv)).toThrow(
      /OBOL_PUBLIC_URL/,
    );
    expect(() => resolveRemoteAuthOptions({ ...base, OBOL_PUBLIC_URL: 'https://api.example.com/?x=1' } as unknown as NodeJS.ProcessEnv)).toThrow(
      /OBOL_PUBLIC_URL/,
    );
    expect(() => resolveRemoteAuthOptions({ ...base, OBOL_PUBLIC_URL: 'https://api.example.com#y' } as unknown as NodeJS.ProcessEnv)).toThrow(
      /OBOL_PUBLIC_URL/,
    );
    expect(() => resolveRemoteAuthOptions({ ...base, OBOL_PUBLIC_URL: 'https://user@api.example.com' } as unknown as NodeJS.ProcessEnv)).toThrow(
      /OBOL_PUBLIC_URL/,
    );
    // Bare origins default to `/` and are the only accepted shape.
    expect(
      resolveRemoteAuthOptions({ ...base, OBOL_PUBLIC_URL: 'https://api.example.com' } as unknown as NodeJS.ProcessEnv),
    ).toBeDefined();
  });

  test('the plugin itself fail-closes on an injected non-https public URL (D7/D9)', () => {
    const fake = createFakePb();
    expect(() =>
      createRemoteAuthPlugin({
        pb: asPocketBase(fake.pb),
        options: { ...FAKE_OPTIONS, publicUrl: 'http://api.example.com' },
      }),
    ).toThrow(/OBOL_PUBLIC_URL/);
  });
});

describe('setup state on the real composition (D3/D4/D8)', () => {
  test('pre-setup: status and health are public and expose no user data', async () => {
    const fake = createFakePb();
    const { handle } = bootServer(fake);

    const status = await handle(jsonRequest('/api/setup/status', 'GET'));
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ setupRequired: true, serverName: 'obol-central', smtpConfigured: false });

    const health = await handle(jsonRequest('/', 'GET'));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'Online', message: 'BFF connected to PocketBase' });
  });

  test('setup init requires the token, creates one owner, then closes permanently', async () => {
    const fake = createFakePb();
    const { handle } = bootServer(fake);

    const missing = await handle(jsonRequest('/api/setup/init', 'POST', {
      email: FAKE_OWNER_EMAIL,
      password: FAKE_OWNER_PASSWORD,
    }));
    expect(missing.status).toBe(403);
    expect((await bodyJson(missing)).code).toBe('INVALID_SETUP_TOKEN');
    expect(fake.ownerRecords).toHaveLength(0);

    const replayed = await handle(jsonRequest('/api/setup/init', 'POST', SETUP_BODY));
    expect(replayed.status).toBe(200);
    expect((await bodyJson(replayed)).serverName).toBe('obol-central');
    expect(fake.ownerRecords).toHaveLength(1);
    expect(fake.ownerRecords[0].email).toBe(FAKE_OWNER_EMAIL);

    const closed = await handle(jsonRequest('/api/setup/init', 'POST', SETUP_BODY));
    expect(closed.status).toBe(403);
    expect((await bodyJson(closed)).code).toBe('FORBIDDEN');
    expect(fake.ownerRecords).toHaveLength(1);

    const finalStatus = await handle(jsonRequest('/api/setup/status', 'GET'));
    expect((await bodyJson(finalStatus)).setupRequired).toBeFalse();
  });

  test('setup init enforces the D5 password policy before touching PocketBase', async () => {
    const fake = createFakePb();
    const { handle } = bootServer(fake);

    const weak = await handle(jsonRequest('/api/setup/init', 'POST', { ...SETUP_BODY, password: 'shortPw' }));
    expect(weak.status).toBe(400);
    const weakBody = await bodyJson(weak);
    expect(weakBody.code).toBe('VALIDATION_ERROR');
    expect(weakBody.message).toContain('10');
    expect(fake.ownerRecords).toHaveLength(0);
  });

  test('an owner created aside closes setup even with an open token window (D4)', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle } = bootServer(fake); // setup token is inside its window here
    const response = await handle(jsonRequest('/api/setup/init', 'POST', SETUP_BODY));
    expect(response.status).toBe(403);
    expect((await bodyJson(response)).code).toBe('FORBIDDEN');
    expect(fake.ownerRecords).toHaveLength(1);
  });

  test('concurrent setup inits are single-flighted: exactly one owner record ever exists (D1)', async () => {
    const fake = createFakePb();
    const { handle } = bootServer(fake);

    // Two racing requests with different emails and one usable setup token:
    // the second must re-check owner existence inside the critical section.
    const [aliceResponse, bobResponse] = await Promise.all([
      handle(jsonRequest('/api/setup/init', 'POST', { ...SETUP_BODY, email: 'alice@obol.cash' })),
      handle(jsonRequest('/api/setup/init', 'POST', { ...SETUP_BODY, email: 'bob@obol.cash' })),
    ]);

    const statuses = [aliceResponse.status, bobResponse.status].sort();
    expect(statuses).toEqual([200, 403]);
    const loserStatus = aliceResponse.status === 403 ? aliceResponse : bobResponse;
    expect((await bodyJson(loserStatus)).code).toBe('FORBIDDEN');

    expect(fake.ownerRecords).toHaveLength(1);
    expect(['alice@obol.cash', 'bob@obol.cash']).toContain(fake.ownerRecords[0].email);

    const finalStatus = await handle(jsonRequest('/api/setup/status', 'GET'));
    expect((await bodyJson(finalStatus)).setupRequired).toBeFalse();
    const late = await handle(jsonRequest('/api/setup/init', 'POST', SETUP_BODY));
    expect(late.status).toBe(403);
  });

  test('setup tokens expire with the boot window', async () => {
    const fake = createFakePb();
    const { handle } = bootServer(fake, {
      setupTokenIssuedAtMs: FIXED_INSTANT_MS,
      setupTokenTtlMs: 5000,
    });
    clock.advanceBy(SETUP_TOKEN_TTL_MS + 1);
    const response = await handle(jsonRequest('/api/setup/init', 'POST', SETUP_BODY));
    expect(response.status).toBe(403);
    expect((await bodyJson(response)).code).toBe('INVALID_SETUP_TOKEN');
    expect(fake.ownerRecords).toHaveLength(0);
  });

  test('stale-token init does not create the owner even when credentials look fine', async () => {
    const fake = createFakePb();
    const { handle } = bootServer(fake);
    const wrongToken = await handle(jsonRequest('/api/setup/init', 'POST', {
      ...SETUP_BODY,
      setupToken: 'f'.repeat(32),
    }));
    expect(wrongToken.status).toBe(403);
    expect((await bodyJson(wrongToken)).code).toBe('INVALID_SETUP_TOKEN');
    expect(fake.ownerRecords).toHaveLength(0);
  });

  test('closed probes run before body parsing and validation, even for malformed bodies', async () => {
    const fake = createFakePb();
    const { handle } = bootServer(fake);
    // A schema-invalid and a syntactically broken body must still be answered
    // by the authorization guard, never by body parsing or validation:
    // unauthenticated callers learn uniform auth responses only.
    const probes = [
      jsonRequest('/api/accounts', 'POST', { name: 123 }),
      new Request('http://localhost/api/accounts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"broken":',
      }),
      new Request('http://localhost/api/jobs/recurrence', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"broken":',
      }),
    ];
    for (const probe of probes) {
      const response = await handle(probe);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ code: 'SETUP_REQUIRED', message: expect.any(String) });
    }
  });

  test('every /api/... route is closed without a session while setup is pending', async () => {
    const fake = createFakePb();
    const { handle } = bootServer(fake);
    const probes = [
      jsonRequest('/api/accounts', 'GET'),
      jsonRequest('/api/forecast', 'GET'),
      jsonRequest('/api/transactions', 'GET'),
      jsonRequest('/api/jobs/recurrence', 'POST', {}),
      jsonRequest('/api/jobs/reconcile', 'POST', {}),
    ];
    for (const probe of probes) {
      const response = await handle(probe);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ code: 'SETUP_REQUIRED', message: expect.any(String) });
    }
  });

  test('after setup the same routes answer UNAUTHENTICATED instead', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle } = bootServer(fake);
    const response = await handle(jsonRequest('/api/accounts', 'GET'));
    expect(response.status).toBe(401);
    expect((await bodyJson(response)).code).toBe('UNAUTHENTICATED');

    const jobs = await handle(jsonRequest('/api/jobs/recurrence', 'POST', {}));
    expect((await bodyJson(jobs)).code).toBe('UNAUTHENTICATED');
  });
});

describe('login (D2/D7: throwaway credential client; PB stays private)', () => {
  test('failed login answers INVALID_CREDENTIALS with no PB details', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle, double } = bootServer(fake);

    const response = await login(handle, { password: 'definitely-not-it' });
    expect(response.status).toBe(401);
    const body = await bodyJson(response);
    expect(body).toEqual({ code: 'INVALID_CREDENTIALS', message: expect.any(String) });

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('pb-credential-never-for-clients');
    expect(serialized).not.toContain('Failed to authenticate');

    expect(double.clients).toHaveLength(1);
    expect(fake.state.adminAuthAttempts).toBe(0);
    expect(fake.state.credentialAuthAttempts).toBe(1);
    expect(fake.pb.authStore.token).toBe(FAKE_SUPERUSER.token);
    expect(fake.pb.authStore.record).toEqual(FAKE_SUPERUSER.record);
  });

  test('successful bearer login mints a BFF session and never returns a PB credential', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle, double } = bootServer(fake);

    const response = await login(handle, { deviceLabel: 'MacBook Pro', transport: 'bearer' });
    expect(response.status).toBe(200);
    const body = await bodyJson(response);
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'serverName', 'token']);
    expect(body.serverName).toBe('obol-central');
    expect(typeof body.token).toBe('string');

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('pb-credential-never-for-clients');
    expect(serialized).not.toContain(FAKE_SUPERUSER.token);

    const session = fake.sessionsList()[0];
    expect(session.deviceLabel).toBe('MacBook Pro');
    // The immutable creation timestamp is app-owned and persisted explicitly
    // by the login create; PB 0.40 base collections inject no `created` (D009).
    expect(fake.state.lastSessionCreate?.createdAt).toBe(toPbDate(FIXED_INSTANT_MS));
    expect(fake.state.lastSessionCreate?.expiresAt).toBe(toPbDate(FIXED_INSTANT_MS + SESSION_TOKEN_TTL_MS));
    expect(session.createdAt).toBe(toPbDate(FIXED_INSTANT_MS));
    // The reported expiry is the 7-day token window hedged by the immutable
    // 30-day cap, never the cap itself (D2/D9).
    expect(parsePbDate(session.expiresAt)).toBe(FIXED_INSTANT_MS + SESSION_TOKEN_TTL_MS);
    expect(body.expiresAt).toBe(new Date(FIXED_INSTANT_MS + SESSION_TOKEN_TTL_MS).toISOString());
    // The registry row persists exactly the ISO `T` form the PB date-field API
    // accepts, not the space-separated stored/returned representation.
    expect(session.expiresAt).toBe(new Date(FIXED_INSTANT_MS + SESSION_TOKEN_TTL_MS).toISOString());

    const claims = jwtPayload(String(body.token));
    expect(claims.sub).toBe(fake.ownerRecords[0].id);
    expect(claims.sid).toBe(session.id);
    expect(claims.exp).toBe(Math.floor((FIXED_INSTANT_MS + SESSION_TOKEN_TTL_MS) / 1000));

    // Bearer login never issues the session cookie (D9).
    expect(response.headers.get('set-cookie')).toBeNull();

    expect(double.clients).toHaveLength(1);
    expect(fake.state.adminAuthAttempts).toBe(0);
    expect(fake.state.credentialAuthAttempts).toBe(1);
    expect(fake.pb.authStore.token).toBe(FAKE_SUPERUSER.token);
    expect(fake.pb.authStore.record).toEqual(FAKE_SUPERUSER.record);
  });

  test('hosted cookie login returns no token in the body, only the httpOnly cookie (D9)', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle } = bootServer(fake);

    const explicit = await login(handle, { deviceLabel: 'Browser', transport: 'cookie' });
    // Default when `transport` is omitted is the hosted cookie transport.
    const omitted = await login(handle, { deviceLabel: 'Omitted' });
    expect(fake.sessionsList()).toHaveLength(2);

    for (const response of [explicit, omitted]) {
      expect(response.status).toBe(200);
      const body = await bodyJson(response);
      expect(Object.keys(body).sort()).toEqual(['expiresAt', 'serverName']);
      expect(JSON.stringify(body)).not.toContain('token');
      expect(body.expiresAt).toBe(new Date(FIXED_INSTANT_MS + SESSION_TOKEN_TTL_MS).toISOString());

      const setCookie = response.headers.get('set-cookie') ?? '';
      expect(setCookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBeTrue();
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).toContain('Path=/');
    }

    // The cookie's token alone reaches the (safe) business routes.
    const cookieToken = readCookie(explicit.headers.get('set-cookie') ?? '', SESSION_COOKIE_NAME);
    const use = await handle(jsonRequest('/api/accounts', 'GET', undefined, { cookie: `${SESSION_COOKIE_NAME}=${cookieToken}` }));
    expect(use.status).toBe(200);
  });

  test('the admin authStore is untouched after failed and successful logins alike', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle } = bootServer(fake);
    await login(handle, { password: 'wrong' });
    await login(handle);
    await login(handle, { password: 'wrong' });
    expect(fake.state.adminAuthAttempts).toBe(0);
    expect(fake.state.credentialAuthAttempts).toBe(3);
    expect(fake.pb.authStore.token).toBe(FAKE_SUPERUSER.token);
    expect(fake.pb.authStore.record).toEqual(FAKE_SUPERUSER.record);
  });

  test('two logins create two independent sessions', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle } = bootServer(fake);
    await login(handle, { deviceLabel: 'Desktop' });
    await login(handle, { deviceLabel: 'iPhone' });
    expect(fake.sessionsList()).toHaveLength(2);
    expect(new Set(fake.sessionsList().map((session) => session.id)).size).toBe(2);
  });

  test('session records are stored under obol_sessions, never the reserved PocketBase sessions collection', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    // The double models PocketBase 0.40.x: the built-in reserved `sessions`
    // collection cannot hold the BFF registry, so touching it throws.
    expect(() => fake.pb.collection('sessions')).toThrow(/obol_sessions/);

    // Realistic CRUD flows (login create, guarded list read, bearer logout
    // delete) all use the dedicated `obol_sessions` collection: any access to
    // the reserved collection would throw the error above and fail this
    // whole scenario.
    const { handle } = bootServer(fake);
    const loginResponse = await login(handle, { deviceLabel: 'Registry check', transport: 'bearer' });
    expect(loginResponse.status).toBe(200);
    const token = String((await bodyJson(loginResponse)).token);
    expect(fake.sessionsList()).toHaveLength(1);

    const listResponse = await handle(jsonRequest('/api/auth/session', 'GET', undefined, bearer(token)));
    expect(listResponse.status).toBe(200);
    const listed = (await bodyJson(listResponse)).sessions as Array<{ deviceLabel?: string }>;
    expect(listed).toHaveLength(1);
    expect(listed[0].deviceLabel).toBe('Registry check');

    const logoutResponse = await handle(jsonRequest('/api/auth/session', 'DELETE', undefined, bearer(token)));
    expect(logoutResponse.status).toBe(200);
    expect(fake.sessionsList()).toHaveLength(0);
  });
});

describe('bearer authorization, expiry and revocation (D2)', () => {
  test('an authorized session reaches the real business use case', async () => {
    const { handle, token } = await bootedSession();
    const response = await handle(jsonRequest('/api/accounts', 'GET', undefined, bearer(token)));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  test('an authorized write reaches the real business use case (protected POST)', async () => {
    const { handle, token } = await bootedSession();
    const response = await handle(jsonRequest('/api/accounts', 'POST', TEST_ACCOUNT, bearer(token)));
    expect(response.status).toBe(201);
    expect((await bodyJson(response)).name).toBe('Main');
  });

  test('schema validation runs after authorization: a signed-in malformed write answers 400', async () => {
    const { handle, token } = await bootedSession();
    const response = await handle(jsonRequest('/api/accounts', 'POST', { name: 123 }, bearer(token)));
    expect(response.status).toBe(400);
    expect((await bodyJson(response)).error).toBe('Bad Request');
  });

  test('invalid/expired/unknown/mismatched session tokens answer SESSION_EXPIRED', async () => {
    const { fake, handle, token } = await bootedSession();
    const valid = await handle(jsonRequest('/api/accounts', 'GET', undefined, bearer(token)));
    expect(valid.status).toBe(200);

    const ownerId = String(fake.ownerRecords[0].id);
    const sid = String(jwtPayload(token).sid);

    const tampered = token.slice(0, -1) + 'z2';
    const wrongSecret = await signSessionToken('r'.repeat(32), { sub: ownerId, sid }, FIXED_INSTANT_MS - 1_000);
    const expiredJwt = await signSessionToken(
      FAKE_OPTIONS.sessionSecret,
      { sub: ownerId, sid },
      FIXED_INSTANT_MS - 2 * SESSION_TOKEN_TTL_MS,
    );
    const unknownSid = await signSessionToken(FAKE_OPTIONS.sessionSecret, { sub: ownerId, sid: 'ses_missing' }, FIXED_INSTANT_MS - 1_000);
    const mismatchedOwner = await signSessionToken(FAKE_OPTIONS.sessionSecret, { sub: 'own_other', sid }, FIXED_INSTANT_MS - 1_000);
    const malformed = 'garbage-not-a-jwt';

    // Structurally broken input: the client only learns there is no session.
    for (const candidate of [malformed]) {
      const response = await handle(jsonRequest('/api/accounts', 'GET', undefined, bearer(candidate)));
      expect(response.status).toBe(401);
      expect((await bodyJson(response)).code).toBe('UNAUTHENTICATED');
    }
    // Structurally valid but unusable tokens (forged signature, rotation,
    // expiry, dead or foreign sid): clients that stored a session delete it.
    for (const candidate of [tampered, wrongSecret, expiredJwt, unknownSid, mismatchedOwner]) {
      const response = await handle(jsonRequest('/api/accounts', 'GET', undefined, bearer(candidate)));
      expect(response.status).toBe(401);
      expect((await bodyJson(response)).code).toBe('SESSION_EXPIRED');
    }
    expect(fake.sessionsList()).toHaveLength(1);
  });

  test('deleting the session record revokes the session on the next call', async () => {
    const { fake, handle, token } = await bootedSession();
    fake.sessionRecords.clear();
    const response = await handle(jsonRequest('/api/accounts', 'GET', undefined, bearer(token)));
    expect(response.status).toBe(401);
    expect((await bodyJson(response)).code).toBe('SESSION_EXPIRED');
  });

  test('an expired expiresAt row is rejected and cleaned up on the same request', async () => {
    const fake = createFakePb({
      owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD },
    });
    const { handle } = bootServer(fake);
    const ownerId = String(fake.ownerRecords[0].id);

    await login(handle);
    const live = fake.sessionsList()[0];
    fake.sessionRecords.set(live.id, { ...live, expiresAt: toPbDate(clock.value - 1000) });

    const stale = await signSessionToken(FAKE_OPTIONS.sessionSecret, { sub: ownerId, sid: live.id }, FIXED_INSTANT_MS - 1000);
    const response = await handle(jsonRequest('/api/accounts', 'GET', undefined, bearer(stale)));
    expect(response.status).toBe(401);
    expect((await bodyJson(response)).code).toBe('SESSION_EXPIRED');
    expect(fake.sessionsList()).toHaveLength(0);
  });

  test('bearer logout revokes only the calling session and emits no Set-Cookie', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle } = bootServer(fake);
    const first = await login(handle, { deviceLabel: 'One', transport: 'bearer' });
    const second = await login(handle, { deviceLabel: 'Two', transport: 'bearer' });

    const firstToken = String((await bodyJson(first)).token);
    const secondToken = String((await bodyJson(second)).token);

    const bye = await handle(jsonRequest('/api/auth/session', 'DELETE', undefined, bearer(firstToken)));
    expect(bye.status).toBe(200);
    expect(await bye.json()).toEqual({ success: true });
    // A bearer logout never carries a session cookie, so it must never emit
    // one — not even an empty clear-cookie (D9).
    expect(bye.headers.get('set-cookie')).toBeNull();

    expect(fake.sessionsList()).toHaveLength(1);
    const [remaining] = fake.sessionsList();
    expect(remaining.deviceLabel).toBe('Two');

    const revokedUse = await handle(jsonRequest('/api/accounts', 'GET', undefined, bearer(firstToken)));
    expect(revokedUse.status).toBe(401);
    expect((await bodyJson(revokedUse)).code).toBe('SESSION_EXPIRED');

    const otherUse = await handle(jsonRequest('/api/accounts', 'GET', undefined, bearer(secondToken)));
    expect(otherUse.status).toBe(200);
  });

  test('cookie logout additionally clears the session cookie', async () => {
    const { handle, token } = await bootedSession();

    const bye = await handle(jsonRequest('/api/auth/session', 'DELETE', undefined,
      { cookie: `${SESSION_COOKIE_NAME}=${token}`, origin: FAKE_OPTIONS.publicUrl }));
    expect(bye.status).toBe(200);
    expect(await bye.json()).toEqual({ success: true });
    expect(bye.headers.get('set-cookie')).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(bye.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  test('Bearer transport wins over the cookie when both are present', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle } = bootServer(fake);
    const cookieLogin = await login(handle, { deviceLabel: 'cookie' });
    const bearerLogin = await login(handle, { deviceLabel: 'bearer', transport: 'bearer' });
    const cookieToken = cookieFrom(cookieLogin);
    const bearerToken = String((await bodyJson(bearerLogin)).token);

    const fed = await handle(
      jsonRequest('/api/auth/session', 'DELETE', undefined, { ...bearer(bearerToken), cookie: `${SESSION_COOKIE_NAME}=${cookieToken}` }),
    );
    expect(fed.status).toBe(200);

    const survivors = fake.sessionsList();
    expect(survivors).toHaveLength(1);
    expect(String(jwtPayload(bearerToken).sid) !== survivors[0].id).toBeTrue();
  });

  test('DELETE /api/auth/session/{id} revokes any session of the owner; foreign ids stay NOT_FOUND', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle } = bootServer(fake);
    const first = await login(handle, { deviceLabel: 'Laptop', transport: 'bearer' });
    const second = await login(handle, { deviceLabel: 'Tablet', transport: 'bearer' });
    const firstToken = String((await bodyJson(first)).token);
    const secondToken = String((await bodyJson(second)).token);
    const secondSessionId = String(jwtPayload(secondToken).sid);

    const revoke = await handle(jsonRequest(`/api/auth/session/${secondSessionId}`, 'DELETE', undefined, bearer(firstToken)));
    expect(revoke.status).toBe(200);
    // Revoking another session never touches the caller's cookie.
    expect(revoke.headers.get('set-cookie')).toBeNull();
    expect(fake.sessionsList().some((session) => session.id === secondSessionId)).toBeFalse();

    const callerAfter = await handle(jsonRequest('/api/auth/session', 'GET', undefined, bearer(firstToken)));
    expect(callerAfter.status).toBe(200);
    expect(((await bodyJson(callerAfter)).sessions as unknown[])).toHaveLength(1);

    const foreign = await handle(jsonRequest('/api/auth/session/ses_missing', 'DELETE', undefined, bearer(firstToken)));
    expect(foreign.status).toBe(404);
    expect((await bodyJson(foreign)).code).toBe('NOT_FOUND');

    const revokedUse = await handle(jsonRequest('/api/accounts', 'GET', undefined, bearer(secondToken)));
    expect(revokedUse.status).toBe(401);
  });
});

describe('session renewal and listing (D2/D3)', () => {
  test('renew mints a fresh token, extends the row, and keeps the old token until its own exp', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle } = bootServer(fake);
    const loginResponse = await login(handle, { transport: 'bearer' });
    const originalToken = String((await bodyJson(loginResponse)).token);
    const originalExpiresAtMs = parsePbDate(fake.sessionsList()[0].expiresAt);
    expect(originalExpiresAtMs).toBe(FIXED_INSTANT_MS + SESSION_TOKEN_TTL_MS);

    clock.advanceBy(5 * DAY_MS); // old JWT still inside its 7-day exp; absolute cap still 25 days out

    const renewed = await handle(jsonRequest('/api/auth/session/renew', 'POST', undefined, bearer(originalToken)));
    expect(renewed.status).toBe(200);
    const body = await bodyJson(renewed);
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'token']);

    const recordExpiresAtMs = parsePbDate(fake.sessionsList()[0].expiresAt);
    expect(recordExpiresAtMs).toBe(FIXED_INSTANT_MS + 5 * DAY_MS + SESSION_TOKEN_TTL_MS); // 7 days, under the 30-day cap
    // Renewed writes persist the ISO `T` form, not the space-separated one.
    expect(fake.sessionsList()[0].expiresAt).toBe(new Date(recordExpiresAtMs as number).toISOString());
    expect(body.expiresAt).toBe(new Date(recordExpiresAtMs as number).toISOString());
    const claims = jwtPayload(String(body.token));
    expect(claims.exp).toBe(Math.floor((FIXED_INSTANT_MS + 5 * DAY_MS + SESSION_TOKEN_TTL_MS) / 1000));
    expect(claims.sid).toBe(fake.sessionsList()[0].id);

    // D2: the old token stays valid until its own exp during the swap.
    const overlap = await handle(jsonRequest('/api/accounts', 'GET', undefined, bearer(originalToken)));
    expect(overlap.status).toBe(200);
  });

  test('renewal slides inside the immutable 30-day cap and is refused past it', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle } = bootServer(fake);
    const loginResponse = await login(handle, { transport: 'bearer' });
    let token = String((await bodyJson(loginResponse)).token);
    const renew = async () => {
      const response = await handle(jsonRequest('/api/auth/session/renew', 'POST', undefined, bearer(token)));
      expect(response.status).toBe(200);
      return bodyJson(response) as unknown as { token: string; expiresAt: string };
    };

    clock.advanceBy(5 * DAY_MS);
    const first = await renew();
    expect(first.expiresAt).toBe(new Date(FIXED_INSTANT_MS + 5 * DAY_MS + SESSION_TOKEN_TTL_MS).toISOString());
    token = first.token;

    // Day 10: a fresh 7-day window, far from the cap.
    clock.advanceBy(5 * DAY_MS);
    const second = await renew();
    expect(second.expiresAt).toBe(new Date(FIXED_INSTANT_MS + 10 * DAY_MS + SESSION_TOKEN_TTL_MS).toISOString());
    token = second.token;

    // Day 15: still an unconstrained 7-day window.
    clock.advanceBy(5 * DAY_MS);
    const third = await renew();
    expect(third.expiresAt).toBe(new Date(FIXED_INSTANT_MS + 15 * DAY_MS + SESSION_TOKEN_TTL_MS).toISOString());
    token = third.token;

    // Day 20: still unconstrained (would end at day 27 < day 30).
    clock.advanceBy(5 * DAY_MS);
    const fourth = await renew();
    expect(fourth.expiresAt).toBe(new Date(FIXED_INSTANT_MS + 20 * DAY_MS + SESSION_TOKEN_TTL_MS).toISOString());
    token = fourth.token;

    // Day 25: a plain 7-day window would end at day 32 — pinned to the cap.
    clock.advanceBy(5 * DAY_MS);
    const capped = await renew();
    expect(capped.expiresAt).toBe(new Date(FIXED_INSTANT_MS + SESSION_ABSOLUTE_TTL_MS).toISOString());
    expect(jwtPayload(capped.token).exp).toBe(Math.floor((FIXED_INSTANT_MS + SESSION_ABSOLUTE_TTL_MS) / 1000));
    token = capped.token;

    // Day 28: still pinned exactly at the cap; expiry never escapes 30 days.
    clock.advanceBy(3 * DAY_MS);
    const stillPinned = await renew();
    expect(stillPinned.expiresAt).toBe(new Date(FIXED_INSTANT_MS + SESSION_ABSOLUTE_TTL_MS).toISOString());
    expect(parsePbDate(fake.sessionsList()[0].expiresAt)).toBe(FIXED_INSTANT_MS + SESSION_ABSOLUTE_TTL_MS);
    token = stillPinned.token;

    // Day 32: the session reached its absolute expiry; even a live row cannot renew.
    clock.advanceBy(5 * DAY_MS);
    const refused = await handle(jsonRequest('/api/auth/session/renew', 'POST', undefined, bearer(token)));
    expect(refused.status).toBe(401);
    expect((await bodyJson(refused)).code).toBe('SESSION_EXPIRED');
    expect(parsePbDate(fake.sessionsList()[0].expiresAt)).toBe(FIXED_INSTANT_MS + SESSION_ABSOLUTE_TTL_MS);
  });

  test('a JWT past its own exp cannot renew even with a live registry row', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle } = bootServer(fake);
    await login(handle);
    const record = fake.sessionsList()[0];

    clock.advanceBy(SESSION_TOKEN_TTL_MS + 3600_000);
    const stale = await signSessionToken(FAKE_OPTIONS.sessionSecret, {
      sub: String(record.userId),
      sid: record.id,
    }, clock.value - SESSION_TOKEN_TTL_MS - 3600_000);
    const response = await handle(jsonRequest('/api/auth/session/renew', 'POST', undefined, bearer(stale)));
    expect(response.status).toBe(401);
    expect((await bodyJson(response)).code).toBe('SESSION_EXPIRED');
  });

  test('renew returns no token and rotates only the cookie for the cookie transport', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle } = bootServer(fake);
    const cookieLogin = await login(handle, { deviceLabel: 'Browser' });
    const cookieToken = cookieFrom(cookieLogin);

    clock.advanceBy(DAY_MS);
    const renewedCookie = await handle(jsonRequest('/api/auth/session/renew', 'POST', undefined,
      { cookie: `${SESSION_COOKIE_NAME}=${cookieToken}`, origin: FAKE_OPTIONS.publicUrl }));
    expect(renewedCookie.status).toBe(200);
    const cookieBody = await bodyJson(renewedCookie);
    expect(Object.keys(cookieBody).sort()).toEqual(['expiresAt']);
    // The renewed token never reaches hosted-web JavaScript (D9).
    expect(JSON.stringify(cookieBody)).not.toContain('token');
    expect(cookieBody.expiresAt).toBe(new Date(FIXED_INSTANT_MS + DAY_MS + SESSION_TOKEN_TTL_MS).toISOString());
    expect(parsePbDate(fake.sessionsList()[0].expiresAt)).toBe(FIXED_INSTANT_MS + DAY_MS + SESSION_TOKEN_TTL_MS);

    const rotated = renewedCookie.headers.get('set-cookie') ?? '';
    expect(rotated.startsWith(`${SESSION_COOKIE_NAME}=`)).toBeTrue();
    const rotatedToken = readCookie(rotated, SESSION_COOKIE_NAME);
    expect(rotatedToken).not.toBe(cookieToken);
    // The rotated cookie alone keeps the session usable.
    const use = await handle(jsonRequest('/api/accounts', 'GET', undefined, { cookie: `${SESSION_COOKIE_NAME}=${rotatedToken}` }));
    expect(use.status).toBe(200);
  });

  test('renew returns a fresh bearer JWT and no cookie for the bearer transport', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle } = bootServer(fake);
    const bearerLogin = await login(handle, { deviceLabel: 'App', transport: 'bearer' });
    const bearerToken = String((await bodyJson(bearerLogin)).token);

    clock.advanceBy(2 * DAY_MS);
    // The hostile Origin proves the bearer transport is CSRF-exempt.
    const renewed = await handle(jsonRequest('/api/auth/session/renew', 'POST', undefined,
      { ...bearer(bearerToken), origin: 'https://evil.example.com' }));
    expect(renewed.status).toBe(200);
    const body = await bodyJson(renewed);
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'token']);
    expect(typeof body.token).toBe('string');
    expect(body.token).not.toBe(bearerToken);
    expect(body.expiresAt).toBe(new Date(FIXED_INSTANT_MS + 2 * DAY_MS + SESSION_TOKEN_TTL_MS).toISOString());
    expect(jwtPayload(String(body.token)).exp).toBe(Math.floor((FIXED_INSTANT_MS + 2 * DAY_MS + SESSION_TOKEN_TTL_MS) / 1000));
    expect(parsePbDate(fake.sessionsList()[0].expiresAt)).toBe(FIXED_INSTANT_MS + 2 * DAY_MS + SESSION_TOKEN_TTL_MS);

    expect(renewed.headers.get('set-cookie')).toBeNull();
  });

  test('renewal fails closed when the row has no createdAt timestamp (D009)', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle } = bootServer(fake);
    const loginResponse = await login(handle, { transport: 'bearer' });
    expect(loginResponse.status).toBe(200);
    const token = String((await bodyJson(loginResponse)).token);
    const record = fake.sessionRecords.get(fake.sessionsList()[0].id)!;
    expect(record.createdAt).toBe(toPbDate(FIXED_INSTANT_MS));

    // Real PB 0.40 base collections never auto-injected `created`; a row
    // without the app-owned `createdAt` cannot renew, with no fallback cap.
    delete record.createdAt;
    clock.advanceBy(5 * DAY_MS);
    const missing = await handle(jsonRequest('/api/auth/session/renew', 'POST', undefined, bearer(token)));
    expect(missing.status).toBe(401);
    expect((await bodyJson(missing)).code).toBe('SESSION_EXPIRED');
    // No expiry was slid while failing closed.
    expect(parsePbDate(fake.sessionsList()[0].expiresAt)).toBe(FIXED_INSTANT_MS + SESSION_TOKEN_TTL_MS);

    // A corrupted timestamp is treated exactly like a missing one.
    record.createdAt = 'not-a-date';
    const corrupted = await handle(jsonRequest('/api/auth/session/renew', 'POST', undefined, bearer(token)));
    expect(corrupted.status).toBe(401);
    expect((await bodyJson(corrupted)).code).toBe('SESSION_EXPIRED');
    expect(parsePbDate(fake.sessionsList()[0].expiresAt)).toBe(FIXED_INSTANT_MS + SESSION_TOKEN_TTL_MS);
  });

  test('renewal refusals and sliding stay anchored to the persisted createdAt (D009)', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle } = bootServer(fake);
    const loginResponse = await login(handle, { transport: 'bearer' });
    const token = String((await bodyJson(loginResponse)).token);
    const record = fake.sessionRecords.get(fake.sessionsList()[0].id)!;

    // The write hole of a synthetic old session: createdAt predates the row's
    // live `expiresAt`, so the cap expires before the token inside it.
    record.createdAt = toPbDate(FIXED_INSTANT_MS - SESSION_ABSOLUTE_TTL_MS - DAY_MS);
    const refused = await handle(jsonRequest('/api/auth/session/renew', 'POST', undefined, bearer(token)));
    expect(refused.status).toBe(401);
    expect((await bodyJson(refused)).code).toBe('SESSION_EXPIRED');

    // A createdAt exactly 25 days ago pins renewal to createdAt+30d, two days
    // before the token's natural 7-day window would end, proving the cap is
    // derived from createdAt alone.
    record.createdAt = toPbDate(FIXED_INSTANT_MS - 25 * DAY_MS);
    clock.advanceBy(DAY_MS);
    const pinned = await handle(jsonRequest('/api/auth/session/renew', 'POST', undefined, bearer(token)));
    expect(pinned.status).toBe(200);
    const body = ((await bodyJson(pinned)) as unknown) as { token: string; expiresAt: string };
    expect(body.expiresAt).toBe(new Date(FIXED_INSTANT_MS + 5 * DAY_MS).toISOString());
    expect(jwtPayload(body.token).exp).toBe(Math.floor((FIXED_INSTANT_MS + 5 * DAY_MS) / 1000));
    expect(parsePbDate(fake.sessionsList()[0].expiresAt)).toBe(FIXED_INSTANT_MS + 5 * DAY_MS);
  });

  test('the session list sorts by createdAt and maps the D009 `created` API field from it', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle } = bootServer(fake);
    await login(handle, { deviceLabel: 'Desktop' });
    await login(handle, { deviceLabel: 'iPad' });
    const loginResponse = await login(handle, { deviceLabel: 'Third', transport: 'bearer' });
    const token = String((await bodyJson(loginResponse)).token);

    const response = await handle(jsonRequest('/api/auth/session', 'GET', undefined, bearer(token)));
    expect(response.status).toBe(200);
    const list = (await bodyJson(response)).sessions as Array<Record<string, unknown>>;
    expect(list).toHaveLength(3);
    // The listing sorts by the app-owned `createdAt` field, not the PB
    // `created` system field PB 0.40 base collections lack (D009).
    expect(fake.state.lastSessionListSort).toBe('-createdAt');
    expect(new Set(list.map((entry) => String(entry.id))).size).toBe(3);
    for (const entry of list) {
      expect(Object.keys(entry).sort()).toEqual(['created', 'deviceLabel', 'id']);
      expect(typeof entry.id).toBe('string');
      expect(typeof entry.created).toBe('string');
      expect(typeof entry.deviceLabel).toBe('string');
      // The API key `created` mirrors the persisted `createdAt` verbatim.
      const record = fake.sessionRecords.get(String(entry.id))!;
      expect(entry.created).toBe(toPbDate(parsePbDate(record.createdAt) as number));
    }
    expect(list.some((entry) => entry.deviceLabel === 'iPad')).toBeTrue();
    expect(JSON.stringify(list)).not.toContain('superuser-token-fixed');
  });
});

describe('login rate limiting (D6: in-process counters)', () => {
  async function failingLogins(handle: (request: Request) => Promise<Response>, email: string, attempts: number, ip?: string) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const response = await handle(jsonRequest(
        '/api/auth/login',
        'POST',
        { email, password: 'wrong-password-9' },
        ip ? { 'x-forwarded-for': ip } : {},
      ));
      expect(response.status).toBe(401);
      expect((await bodyJson(response)).code).toBe('INVALID_CREDENTIALS');
    }
  }

  test('five failures block the identity for the whole window, regardless of IP or password', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle } = bootServer(fake);

    await failingLogins(handle, FAKE_OWNER_EMAIL, 5);
    const blockedCorrect = await handle(jsonRequest('/api/auth/login', 'POST',
      { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD }, { 'x-forwarded-for': '203.0.113.9' }));
    expect(blockedCorrect.status).toBe(429);
    expect((await bodyJson(blockedCorrect)).code).toBe('RATE_LIMITED');

    clock.advanceBy(15 * 60 * 1000 + 1); // window over
    const cleared = await login(handle);
    expect(cleared.status).toBe(200);
  });

  test('ten failures per IP block every identity from that IP; other IPs are unaffected', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle } = bootServer(fake);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await failingLogins(handle, `probe${attempt}@example.net`, 1, '198.51.100.7');
    }
    const blocked = await handle(jsonRequest('/api/auth/login', 'POST',
      { email: 'another@example.net', password: 'x'.repeat(12) }, { 'x-forwarded-for': '198.51.100.7' }));
    expect(blocked.status).toBe(429);
    expect((await bodyJson(blocked)).code).toBe('RATE_LIMITED');

    // Same credential from a different IP is only rate-limited by identity.
    const otherIp = await handle(jsonRequest('/api/auth/login', 'POST',
      { email: 'another@example.net', password: 'x'.repeat(12) }, { 'x-forwarded-for': '198.51.100.8' }));
    expect(otherIp.status).toBe(401);
    expect((await bodyJson(otherIp)).code).toBe('INVALID_CREDENTIALS');
  });
});

describe('password lifecycle (D5)', () => {
  test('reset requests answer one identical generic body; unknown emails never hit PB', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle } = bootServer(fake, { smtpConfigured: true });

    const known = await handle(jsonRequest('/api/auth/request-password-reset', 'POST', { email: FAKE_OWNER_EMAIL }));
    const unknown = await handle(jsonRequest('/api/auth/request-password-reset', 'POST', { email: 'nobody@obol.cash' }));
    const knownBody = await known.json();
    const unknownBody = await unknown.json();
    expect(known.status).toBe(unknown.status);
    expect(knownBody).toEqual(unknownBody);
    expect(JSON.stringify(knownBody)).not.toContain(FAKE_OWNER_EMAIL);
    expect(fake.state.sentResetEmails).toEqual([FAKE_OWNER_EMAIL]);
  });

  test('SMTP-off deployments skip the PB call entirely but keep the same success body', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle } = bootServer(fake);
    const response = await handle(jsonRequest('/api/auth/request-password-reset', 'POST', { email: FAKE_OWNER_EMAIL }));
    expect(response.status).toBe(200);
    expect((await bodyJson(response)).message).toBeTypeOf('string');
    expect(fake.state.sentResetEmails).toHaveLength(0);
  });

  test('reset requests are rate limited', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle } = bootServer(fake);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await handle(jsonRequest('/api/auth/request-password-reset', 'POST', { email: FAKE_OWNER_EMAIL }));
      expect(response.status).toBe(200);
    }
    const blocked = await handle(jsonRequest('/api/auth/request-password-reset', 'POST', { email: FAKE_OWNER_EMAIL }));
    expect(blocked.status).toBe(429);
    expect((await bodyJson(blocked)).code).toBe('RATE_LIMITED');
  });

  test('confirm reset applies the new password, empties the registry, and kills old sessions', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle } = bootServer(fake, { smtpConfigured: true });
    const loginResponse = await login(handle);
    const oldToken = cookieFrom(loginResponse);

    const badToken = await handle(jsonRequest('/api/auth/confirm-password-reset', 'POST',
      { token: 'nope', password: 'a'.repeat(12) }));
    expect(badToken.status).toBe(400);
    expect((await bodyJson(badToken)).code).toBe('INVALID_RESET_TOKEN');
    expect(fake.sessionsList()).toHaveLength(1);

    const weak = await handle(jsonRequest('/api/auth/confirm-password-reset', 'POST',
      { token: PB_RESET_TOKEN, password: 'short' }));
    expect(weak.status).toBe(400);
    expect((await bodyJson(weak)).code).toBe('VALIDATION_ERROR');
    expect(fake.ownerRecords[0].password).toBe(FAKE_OWNER_PASSWORD);

    const confirmed = await handle(jsonRequest('/api/auth/confirm-password-reset', 'POST',
      { token: PB_RESET_TOKEN, password: 'a'.repeat(12) }));
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toEqual({ success: true });
    expect(fake.ownerRecords[0].password).toBe('a'.repeat(12));
    expect(fake.sessionsList()).toHaveLength(0);

    const oldSession = await handle(jsonRequest('/api/accounts', 'GET', undefined, bearer(oldToken)));
    expect(oldSession.status).toBe(401);
  });

  test('reset confirmation also goes through the throwaway client (admin authStore intact)', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle, double } = bootServer(fake, { smtpConfigured: true });
    await handle(jsonRequest('/api/auth/confirm-password-reset', 'POST', { token: PB_RESET_TOKEN, password: 'a'.repeat(12) }));
    expect(double.clients).toHaveLength(1);
    expect(fake.state.adminAuthAttempts).toBe(0);
    expect(fake.state.credentialAuthAttempts).toBe(0);
    expect(fake.pb.authStore.token).toBe(FAKE_SUPERUSER.token);
    expect(fake.pb.authStore.record).toEqual(FAKE_SUPERUSER.record);
  });
});

describe('transport: cookies, CSRF origins, CORS (D6)', () => {
  test('the cookie alone is a valid GET transport', async () => {
    const { handle, token } = await bootedSession();
    const response = await handle(jsonRequest('/api/accounts', 'GET', undefined, { cookie: `${SESSION_COOKIE_NAME}=${token}` }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  test('cookie-backed unsafe methods require a nonempty Origin exactly matching the public URL; Bearer never does', async () => {
    const { handle, token } = await bootedSession();
    const renew = { cookie: `${SESSION_COOKIE_NAME}=${token}` };

    const hostile = await handle(jsonRequest('/api/auth/session/renew', 'POST', undefined,
      { ...renew, origin: 'https://evil.example.com' }));
    expect(hostile.status).toBe(403);
    expect((await bodyJson(hostile)).code).toBe('FORBIDDEN');

    // A configured CORS client origin is cross-site for the cookie CSRF
    // check: only the deployment's public URL counts as same-origin (D9).
    const clientOrigin = await handle(jsonRequest('/api/auth/session/renew', 'POST', undefined,
      { ...renew, origin: 'https://ios.example.com' }));
    expect(clientOrigin.status).toBe(403);

    // Absent Origin (non-browser client) can no longer mutate with a cookie.
    const missing = await handle(jsonRequest('/api/auth/session/renew', 'POST', undefined, renew));
    expect(missing.status).toBe(403);
    expect((await bodyJson(missing)).code).toBe('FORBIDDEN');

    // A nonempty Origin exactly matching the public URL is accepted.
    const allowed = await handle(jsonRequest('/api/auth/session/renew', 'POST', undefined,
      { ...renew, origin: FAKE_OPTIONS.publicUrl }));
    expect(allowed.status).toBe(200);

    // Bearer transport carries no CSRF risk: hostile origin does not block it.
    const bearerHostile = await handle(jsonRequest('/api/auth/session/renew', 'POST', undefined,
      { ...bearer(token), origin: 'https://evil.example.com' }));
    expect(bearerHostile.status).toBe(200);
  });

  test('CORS reflects only exact allow-list origins and answers allowed preflights', async () => {
    const { handle, token } = await bootedSession();

    const allowed = await handle(jsonRequest('/api/accounts', 'GET', undefined,
      { ...bearer(token), origin: 'https://ios.example.com' }));
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://ios.example.com');
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');
    expect(allowed.headers.get('vary')).toContain('Origin');

    const subdomain = await handle(jsonRequest('/api/accounts', 'GET', undefined,
      { ...bearer(token), origin: 'https://evil-ios.example.com' }));
    expect(subdomain.headers.get('access-control-allow-origin')).toBeNull();

    // The deployment's public URL is the hosted web's own origin (same-site,
    // no CORS involved); it is not implicitly added to the allow-list (D9).
    const publicUrlOrigin = await handle(jsonRequest('/api/accounts', 'GET', undefined,
      { ...bearer(token), origin: FAKE_OPTIONS.publicUrl }));
    expect(publicUrlOrigin.headers.get('access-control-allow-origin')).toBeNull();

    const preflight = await handle(new Request('http://localhost/api/accounts', {
      method: 'OPTIONS',
      headers: { origin: 'https://ios.example.com', 'access-control-request-method': 'GET' },
    }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://ios.example.com');
    expect(preflight.headers.get('access-control-allow-methods')).toContain('DELETE');
    expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');

    const darkPreflight = await handle(new Request('http://localhost/api/accounts', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'GET' },
    }));
    expect(darkPreflight.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('legacy mode and forced-off composition (D10)', () => {
  test('createServer(pb, null) keeps business routes open, exposes no D009 route, drops the admin email', async () => {
    const fake = createFakePb();
    const app = createServer(asPocketBase(fake.pb), null);

    const accounts = await app.handle(jsonRequest('/api/accounts', 'GET'));
    expect(accounts.status).toBe(200);
    expect(await accounts.json()).toEqual([]);
    expect(accounts.headers.get('set-cookie')).toBeNull();

    const created = await app.handle(jsonRequest('/api/accounts', 'POST', TEST_ACCOUNT));
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as Record<string, unknown>;
    expect(createdBody.name).toBe('Main');

    const health = await app.handle(jsonRequest('/', 'GET'));
    const healthBody = (await health.json()) as Record<string, unknown>;
    expect(Object.keys(healthBody)).not.toContain('admin');
    expect(Object.keys(healthBody)).not.toContain('email');

    const setupRoute = await app.handle(jsonRequest('/api/setup/status', 'GET'));
    expect(setupRoute.status).toBe(404);
    expect(await setupRoute.json()).toEqual({ error: 'Not Found', details: 'Route not found.' });
    const loginRoute = await app.handle(jsonRequest('/api/auth/login', 'POST', { email: 'x', password: 'y' }));
    expect(loginRoute.status).toBe(404);
    expect(await loginRoute.json()).toEqual({ error: 'Not Found', details: 'Route not found.' });
  });

  test('unmatched routes answer the error plugin mapping, HTTP 404 (not 500)', async () => {
    const fake = createFakePb({ owner: { email: FAKE_OWNER_EMAIL, password: FAKE_OWNER_PASSWORD } });
    const { handle } = bootServer(fake);
    const missing = await handle(jsonRequest('/unknown', 'GET'));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'Not Found', details: 'Route not found.' });
  });

  test('the direct plugin without options is inert: an added business route answers without any auth hook', async () => {
    const fake = createFakePb();
    const app = new Elysia()
      .use(createRemoteAuthPlugin({ pb: asPocketBase(fake.pb) }))
      .get('/api/preD009', () => ({ surface: 'legacy' }));
    const response = await app.handle(jsonRequest('/api/preD009', 'GET'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ surface: 'legacy' });
    expect(response.headers.get('set-cookie')).toBeNull();

    expect(MIN_SESSION_SECRET_LENGTH).toBe(32);
    expect(readBearerToken('Bearer abc')).toBe('abc');
    expect(readBearerToken('bearer abc')).toBe('abc');
    expect(readBearerToken('Basic abc')).toBe('');
    expect(readCookie(`${SESSION_COOKIE_NAME}=tok; other=1`, SESSION_COOKIE_NAME)).toBe('tok');
    expect(parsePbDate('2026-01-02 10:20:30.450Z')).toBe(Date.parse('2026-01-02T10:20:30.450Z'));
    // Writes must use RFC3339 with `T` (PB rejects the space form on input);
    // reads accept the space-separated stored form.
    expect(toPbDate(FIXED_INSTANT_MS)).toBe(new Date(FIXED_INSTANT_MS).toISOString());
    expect(toPbDate(FIXED_INSTANT_MS)).toContain('T');
    expect(toPbDate(FIXED_INSTANT_MS)).not.toContain(' ');
    expect(parsePbDate(new Date(FIXED_INSTANT_MS).toISOString())).toBe(FIXED_INSTANT_MS);
  });
});
