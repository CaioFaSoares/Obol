import { Elysia, status, t, type ElysiaCustomStatusResponse } from 'elysia';
import PocketBase from 'pocketbase';

// D009 - Single-owner remote identity and session contract.
//
// The BFF owns end-user identity: PocketBase stays a private credential
// checker, the BFF mints revocable HS256 session tokens backed by a
// `obol_sessions` registry record. Everything here is infrastructure: no domain
// imports besides the shared error types.
//
// Legacy compatibility (D10): when no `OBOL_SESSION_SECRET` is configured the
// plugin composes as an inert Elysia plugin - the app behaves exactly as it
// did before D009, and none of the D009 routes exist. When the secret is
// present, every `/api/**` route (including GETs and scheduler/job routes) is
// session-gated, and this plugin additionally provides the D009 setup, auth
// and session routes.

/** httpOnly host-prefixed cookie used by the hosted web client (D6). */
export const SESSION_COOKIE_NAME = '__Host-obol_session';

/** Each minted token lives at most 7 days (D2). */
export const SESSION_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_TOKEN_TTL_MS = SESSION_TOKEN_TTL_SECONDS * 1000;

/** Sessions hard-expire 30 days after creation regardless of renewal (D2). */
export const SESSION_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Secret must represent at least 32 random bytes (D7). */
export const MIN_SESSION_SECRET_LENGTH = 32;

/** Setup tokens: 16 random bytes, hex-encoded into a 32-hex string (D4). */
const SETUP_TOKEN_BYTES = 16;

/** Setup window: token accepted until used or 30 minutes after boot (D4). */
export const SETUP_TOKEN_TTL_MS = 30 * 60 * 1000;

/** D5 password policy: minimum length 10; bcrypt accepts at most 71 bytes. */
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 71;

/** D009 requirement 5: in-process counters, 10 failures per IP and 5 per
 * identity per 15 minutes. */
export const LOGIN_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_IP_FAILURE_LIMIT = 10;
export const LOGIN_IDENTITY_FAILURE_LIMIT = 5;

/** Device labels are truncated to 100 characters. */
const MAX_DEVICE_LABEL_LENGTH = 100;

/**
 * D009 session registry collection. PocketBase ships a reserved built-in
 * `sessions` collection (seen on PB 0.40.x), so the deployment-owned registry
 * lives in the dedicated `obol_sessions` collection (migration 1700000014).
 * Internal persistence only: the HTTP `/api/auth/session*` contract and the
 * JWT claims are unaffected.
 */
const SESSION_COLLECTION = 'obol_sessions';

// ---------------------------------------------------------------------------
// Typed request/response schemas (Eden-compatible D3 contract)
// ---------------------------------------------------------------------------

export const AuthErrorDTO = t.Object({
  code: t.String(),
  message: t.String(),
});

export const SetupStatusResponseDTO = t.Object({
  setupRequired: t.Boolean(),
  serverName: t.String(),
  smtpConfigured: t.Boolean(),
});

export const SetupInitDTO = t.Object({
  // Optional at the schema level on purpose: a missing token is a setup-state
  // violation (INVALID_SETUP_TOKEN), not a payload validation error (D4).
  setupToken: t.Optional(t.String()),
  email: t.String(),
  password: t.String(),
});

export const SetupInitResponseDTO = t.Object({
  serverName: t.String(),
});

export const LoginRequestDTO = t.Object({
  email: t.String(),
  password: t.String(),
  deviceLabel: t.Optional(t.String()),
  /** Session transport for this login (D6/D9): `cookie` (default) issues only
   * the httpOnly session cookie and returns no token; `bearer` returns the
   * JWT and issues no cookie. */
  transport: t.Optional(
    t.Union([t.Literal('cookie'), t.Literal('bearer')]),
  ),
});

export const LoginResponseDTO = t.Object({
  /** Present only for the bearer transport; the hosted cookie transport
   * never receives an XSS-readable token (D9). */
  token: t.Optional(t.String()),
  expiresAt: t.String(),
  serverName: t.String(),
});

export const SessionRenewResponseDTO = t.Object({
  /** Present only for the bearer transport (D9). */
  token: t.Optional(t.String()),
  expiresAt: t.String(),
});

export const AuthSessionEntryDTO = t.Object({
  id: t.String(),
  created: t.String(),
  deviceLabel: t.String(),
});

export const SessionListResponseDTO = t.Object({
  sessions: t.Array(AuthSessionEntryDTO),
});

export const SessionRevokedResponseDTO = t.Object({
  success: t.Boolean(),
});

export const PasswordResetRequestDTO = t.Object({
  email: t.String(),
});

export const PasswordResetResponseDTO = t.Object({
  message: t.String(),
});

export const PasswordResetConfirmDTO = t.Object({
  token: t.String(),
  password: t.String(),
});

// ---------------------------------------------------------------------------
// Error bodies: uniform `{ code, message }` per D3. Auth failures never carry
// PocketBase details, tokens, credentials or user-identifying data.
// ---------------------------------------------------------------------------

export interface AuthErrorCode {
  code: string;
  message: string;
}

export const AUTH_ERRORS = {
  UNAUTHENTICATED: { code: 'UNAUTHENTICATED', message: 'Authentication is required.' },
  SESSION_EXPIRED: { code: 'SESSION_EXPIRED', message: 'The session is no longer valid; sign in again.' },
  SETUP_REQUIRED: { code: 'SETUP_REQUIRED', message: 'This server is waiting for first-run setup.' },
  INVALID_CREDENTIALS: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' },
  RATE_LIMITED: { code: 'RATE_LIMITED', message: 'Too many attempts; slow down and try again later.' },
  FORBIDDEN: { code: 'FORBIDDEN', message: 'The request was refused.' },
  INVALID_SETUP_TOKEN: { code: 'INVALID_SETUP_TOKEN', message: 'The setup token is missing, invalid, or expired.' },
  INVALID_RESET_TOKEN: { code: 'INVALID_RESET_TOKEN', message: 'The password reset link is invalid or expired; request a new one.' },
  VALIDATION_ERROR: { code: 'VALIDATION_ERROR', message: 'The request payload is invalid.' },
  INTERNAL: { code: 'INTERNAL', message: 'The request could not be completed.' },
} as const satisfies Record<string, AuthErrorCode>;
type AuthErrorName = keyof typeof AUTH_ERRORS;

/** Uniform `{code, message}` error bodies for route handlers, returned via
 * Elysia's `status()` (D3): each route's `response` schema declares the exact
 * error statuses it can emit (`AuthErrorDTO` per branch), so no response
 * validator ever rewrites (or leaks) the body, Eden keeps the error statuses
 * in its inference, and the body/status reach the client byte-identical to
 * the raw-`Response` form. */
function errorResponse<const Code extends number>(
  error: AuthErrorName | AuthErrorCode,
  statusCode: Code,
): ElysiaCustomStatusResponse<Code, AuthErrorCode> {
  const body = typeof error === 'string' ? AUTH_ERRORS[error] : error;
  return status(statusCode, { code: body.code, message: body.message });
}

/** Raw `Response` variant with the identical body and status, for the
 * pre-route `onRequest` guards: they run before any route schema exists and
 * Elysia's lifecycle typing only accepts a native `Response` as an early
 * return there. */
function rawErrorResponse(error: AuthErrorName | AuthErrorCode, statusCode: number): Response {
  const body = typeof error === 'string' ? AUTH_ERRORS[error] : error;
  return new Response(JSON.stringify({ code: body.code, message: body.message }), {
    status: statusCode,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Small primitives (base64url, HMAC tokens, PB dates, cookies, origins)
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function base64UrlToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}

const JWT_HEADER_SEGMENT = base64UrlEncodeBytes(textEncoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));

function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(data));
  return new Uint8Array(signature);
}

export interface SessionTokenClaims {
  sub: string;
  sid: string;
}

/** HS256-signed session JWT (D2): claims are the owner id (`sub`), the
 * session record id (`sid`), `iat`, and `exp`. */
export async function signSessionToken(
  secret: string,
  claims: SessionTokenClaims,
  issuedAtMs: number,
  expiresAtMs: number = issuedAtMs + SESSION_TOKEN_TTL_MS,
): Promise<string> {
  const issuedAt = Math.floor(issuedAtMs / 1000);
  const expiresAt = Math.floor(expiresAtMs / 1000);
  const payloadSegment = base64UrlEncodeBytes(
    textEncoder.encode(JSON.stringify({ sub: claims.sub, sid: claims.sid, iat: issuedAt, exp: expiresAt })),
  );
  const signingInput = `${JWT_HEADER_SEGMENT}.${payloadSegment}`;
  const signatureSegment = base64UrlEncodeBytes(await hmacSha256(secret, signingInput));
  return `${signingInput}.${signatureSegment}`;
}

export type SessionTokenVerification =
  | { ok: true; sub: string; sid: string; exp: number }
  | { ok: false; reason: 'MALFORMED' | 'INVALID_SIGNATURE' | 'EXPIRED' };

/** Verifies signature, `exp` and claim shape. PocketBase record existence is
 * checked separately against the session registry (D2). */
export async function verifySessionToken(
  secret: string,
  token: string,
  nowMs: number,
): Promise<SessionTokenVerification> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'MALFORMED' };
  const [headerSegment, payloadSegment, signatureSegment] = parts;

  let expectedSignature: Uint8Array;
  let payloadJson: string;
  try {
    // The header is not decoded; verifying the signature over the received
    // bytes pins the token to whatever was signed with HS256 and rejects
    // every `alg`-confusion attempt, since we always re-sign with HMAC.
    expectedSignature = await hmacSha256(secret, `${headerSegment}.${payloadSegment}`);
    payloadJson = new TextDecoder().decode(base64UrlToBytes(payloadSegment));
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }

  let presentedSignature: Uint8Array;
  try {
    presentedSignature = base64UrlToBytes(signatureSegment);
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (!constantTimeEquals(expectedSignature, presentedSignature)) {
    return { ok: false, reason: 'INVALID_SIGNATURE' };
  }

  let claims: { sub?: unknown; sid?: unknown; exp?: unknown };
  try {
    claims = JSON.parse(payloadJson);
  } catch {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (typeof claims.sub !== 'string' || typeof claims.sid !== 'string' || typeof claims.exp !== 'number') {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (!claims.sub || !claims.sid || !Number.isFinite(claims.exp)) {
    return { ok: false, reason: 'MALFORMED' };
  }
  if (claims.exp * 1000 <= nowMs) {
    return { ok: false, reason: 'EXPIRED' };
  }
  return { ok: true, sub: claims.sub, sid: claims.sid, exp: claims.exp };
}

/** PocketBase date-field API inputs require RFC3339 (`YYYY-MM-DDTHH:MM:SS.SSSZ`,
 * separator `T`); the space-separated `2024-01-01 00:00:00.000Z` form is only
 * PocketBase's stored/returned representation on reads, and sending it on
 * writes is rejected by date-field validation. */
export function toPbDate(ms: number): string {
  return new Date(ms).toISOString();
}

/** Parses both PocketBase (`YYYY-MM-DD HH:MM:SS.SSSZ`) and RFC3339 dates into
 * a millisecond timestamp, or `null` when the value is not a valid date. */
export function parsePbDate(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const normalized = value.replace(' ', 'T');
  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? null : timestamp;
}

export function buildSessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function buildSessionClearCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Extracts a named cookie value from a `Cookie` header. */
export function readCookie(header: string | null | undefined, name: string): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return '';
}

/** Bearer tokens (desktop/iOS, D6) are the only transport for the
 * `Authorization` header. */
export function readBearerToken(header: string | null | undefined): string {
  if (!header) return '';
  if (!header.toLowerCase().startsWith('bearer ')) return '';
  return header.slice('bearer '.length).trim();
}

/** Human-readable setup-window length for boot logs ("30 min"). */
export function formatSetupWindow(ttlMs: number): string {
  return `${Math.round(ttlMs / 60000)} min`;
}

/** Live single-owner lookup used by both the plugin guards and the boot
 * sequence: an owner appearing at any moment closes setup (D4). */
export async function ownerRecordExistsIn(pb: PocketBase): Promise<boolean> {
  const page = await pb.collection('owner').getList(1, 1);
  return page.totalItems > 0;
}

/** First public IP behind the TLS ingress, or the shared `$unknown` bucket. */
export function clientIpFrom(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  return '$unknown';
}

/** Login transport selector (D6/D9): the hosted web client authenticates
 * through the httpOnly cookie and never sees a token; desktop/iOS clients
 * authenticate with the returned bearer JWT and never get a cookie. */
export type LoginTransport = 'cookie' | 'bearer';

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, '').toLowerCase();
}

/** Hosted-web cookie CSRF guard (D9): a cookie-authenticated unsafe request
 * must present a nonempty Origin that exactly matches the deployment's own
 * public URL. Any other origin — including a CORS client origin — is
 * cross-site and rejected. Duplicate of the public URL in the allow-list is
 * irrelevant here; empty `publicUrl` makes the check fail closed. */
export function isSameOriginWithPublicUrl(
  origin: string | null | undefined,
  publicUrl: string,
): boolean {
  const normalizedPublicUrl = normalizeOrigin(publicUrl);
  if (!normalizedPublicUrl) return false;
  const requested = origin ? normalizeOrigin(origin) : '';
  return requested !== '' && requested === normalizedPublicUrl;
}

/** Exactly-matched CORS allow-list (D6): only `OBOL_CLIENT_ORIGINS` origins
 * receive `Access-Control-Allow-Origin`, and only for actual cross-origin
 * browser requests. The hosted web client is same-origin and never appears
 * here. Empty/unknown origins never pass. */
export function isClientOriginAllowed(
  origin: string | null | undefined,
  clientOrigins: readonly string[],
): boolean {
  if (!origin) return false;
  const requested = normalizeOrigin(origin);
  if (!requested) return false;
  return clientOrigins.some((candidate) => candidate && normalizeOrigin(candidate) === requested);
}

// ---------------------------------------------------------------------------
// In-process sliding-window rate limiter (D6: single process, D1 makes it real)
// ---------------------------------------------------------------------------

export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
}

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly sweepThreshold = 4096;

  constructor(private readonly options: RateLimiterOptions) {}

  /** Whether `bucket` already reached its failure limit inside the window. */
  exceeded(bucket: string, nowMs: number): boolean {
    const hms = this.currentTimestamps(bucket, nowMs);
    return hms.length >= this.options.limit;
  }

  /** Records one event (a failure, or a counted request) for `bucket`. */
  record(bucket: string, nowMs: number): void {
    this.currentTimestamps(bucket, nowMs).push(nowMs);
    if (this.hits.size > this.sweepThreshold) this.sweep(nowMs);
  }

  /** Drops the bucket entirely (successful login re-arms the identity counter). */
  clear(bucket: string): void {
    this.hits.delete(bucket);
  }

  private currentTimestamps(bucket: string, nowMs: number): number[] {
    const cutoff = nowMs - this.options.windowMs;
    const existing = this.hits.get(bucket);
    if (!existing) {
      const fresh: number[] = [];
      this.hits.set(bucket, fresh);
      return fresh;
    }
    let firstKept = 0;
    while (firstKept < existing.length && existing[firstKept] <= cutoff) firstKept += 1;
    const kept = firstKept === 0 ? existing : existing.slice(firstKept);
    if (kept.length === 0) {
      this.hits.delete(bucket);
      // Reinsert a fresh array so the map stays keyed for the in-flight call.
      const fresh: number[] = [];
      this.hits.set(bucket, fresh);
      return fresh;
    }
    if (kept !== existing) this.hits.set(bucket, kept);
    return kept;
  }

  private sweep(nowMs: number): void {
    const cutoff = nowMs - this.options.windowMs;
    for (const [bucket, timestamps] of this.hits) {
      const last = timestamps[timestamps.length - 1];
      if (last !== undefined && last <= cutoff) this.hits.delete(bucket);
      else if (timestamps[0] <= cutoff) {
        let firstKept = 0;
        while (firstKept < timestamps.length && timestamps[firstKept] <= cutoff) firstKept += 1;
        this.hits.set(bucket, timestamps.slice(firstKept));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Session token registry helpers
// ---------------------------------------------------------------------------

export interface SessionRecordLike {
  id: string;
  userId: string;
  expiresAt: string;
  deviceLabel?: string;
  /** App-owned immutable creation timestamp (PB DateField); PB base
   * collections do not auto-inject `created` (D009). */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Environment resolution (fail closed)
// ---------------------------------------------------------------------------

export interface RemoteAuthOptions {
  /** HS256 signing secret, at least 32 characters (D7). */
  sessionSecret: string;
  /** Public origin, used only as the hosted web client's cookie CSRF
   * same-origin target (D6/D9); it is never a CORS allow-list entry. */
  publicUrl: string;
  /** Exact-match CORS allow-list origins (D6). */
  clientOrigins: string[];
  /** True when the deployment ships SMTP settings for PB password resets (D5). */
  smtpConfigured: boolean;
  /** Human-facing deployment name surfaced in D3 responses. */
  serverName?: string;
  /** Static boot token from `OBOL_SETUP_TOKEN`, or the token minted at setup-mode boot (D4). */
  setupToken?: string;
  setupTokenIssuedAtMs?: number;
  /** Setup window; 0 keeps the acceptance window until an owner exists. */
  setupTokenTtlMs?: number;
}

/** D7/D9 fail-closed hardening: remote auth must never run against a
 * cleartext or malformed public URL. The public URL is the cookie CSRF
 * same-origin target, the source of the `__Host-` cookie's security and the
 * base of reset links; an `http`, path-bearing, query-bearing or hash-bearing
 * origin would silently weaken all three. */
function assertHttpsPublicUrl(publicUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(publicUrl);
  } catch {
    throw new Error(
      'OBOL_PUBLIC_URL must be a valid absolute https:// origin; refusing to start (fail closed).',
    );
  }
  const isBareHttpsOrigin =
    parsed.protocol === 'https:' &&
    parsed.pathname === '/' &&
    parsed.search === '' &&
    parsed.hash === '' &&
    parsed.username === '' &&
    parsed.password === '';
  if (!isBareHttpsOrigin) {
    throw new Error(
      'OBOL_PUBLIC_URL must be a valid absolute https:// origin with no path, query, hash or credentials; refusing to start (fail closed).',
    );
  }
}

/** Reads D009 environment variables. Returns `undefined` when remote auth is
 * disabled (no `OBOL_SESSION_SECRET`), exactly as D10 requires. Throws when
 * the secret is present but too short: the server fails closed (D7). */
export function resolveRemoteAuthOptions(
  env: NodeJS.ProcessEnv = process.env,
): RemoteAuthOptions | undefined {
  const secret = (env.OBOL_SESSION_SECRET ?? '').trim();
  if (!secret) return undefined;
  if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `OBOL_SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters; refusing to start (fail closed).`,
    );
  }
  const publicUrl = (env.OBOL_PUBLIC_URL ?? '').trim().replace(/\/+$/, '');
  assertHttpsPublicUrl(publicUrl);
  const clientOrigins = (env.OBOL_CLIENT_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  const setupToken = (env.OBOL_SETUP_TOKEN ?? '').trim() || undefined;
  return {
    sessionSecret: secret,
    publicUrl,
    clientOrigins,
    smtpConfigured: Boolean((env.PB_SMTP_HOST ?? '').trim()),
    setupToken,
    setupTokenIssuedAtMs: setupToken ? Date.now() : undefined,
    setupTokenTtlMs: setupToken ? SETUP_TOKEN_TTL_MS : undefined,
  };
}

export function deriveServerName(publicUrl: string): string {
  if (!publicUrl) return 'Obol';
  try {
    return new URL(publicUrl).host || 'Obol';
  } catch {
    return 'Obol';
  }
}

/** Uniformly random 32-hex-character setup token (D4). */
export function createSetupToken(): string {
  const bytes = new Uint8Array(SETUP_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let token = '';
  for (const byte of bytes) token += byte.toString(16).padStart(2, '0');
  return token;
}

// ---------------------------------------------------------------------------
// Throwaway credential-checking client boundary
// ---------------------------------------------------------------------------

/** Minimal client surface used to check owner credentials. Implemented by the
 * real PocketBase SDK; faked in tests. */
export interface CredentialsClient {
  /** Mirrors `PocketBase.baseUrl`. */
  baseUrl: string;
  autoCancellation(enabled: boolean): unknown;
  collection(name: string): {
    authWithPassword(identity: string, password: string): Promise<unknown>;
    requestPasswordReset(email: string): Promise<unknown>;
    confirmPasswordReset(token: string, password: string, passwordConfirm: string): Promise<unknown>;
  };
}

export interface RemoteAuthDeps {
  /** Superuser-authenticated PocketBase client for session registry CRUD. */
  pb: PocketBase;
  /** Resolved options; `undefined` disables remote auth (D10 legacy mode). */
  options?: RemoteAuthOptions;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable credential client factory; defaults to a fresh PocketBase SDK
   * client per credentials check so the shared superuser authStore is never
   * mutated by `authWithPassword`. */
  createCredentialsClient?: (baseUrl: string) => CredentialsClient;
}

// The D009 public surface, enforced for every matched `/api/**` route.
const PUBLIC_METHOD_PATHS = new Set([
  'GET /api/setup/status',
  'POST /api/setup/init',
  'POST /api/auth/login',
  'POST /api/auth/request-password-reset',
  'POST /api/auth/confirm-password-reset',
]);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

interface SetupCredentials {
  token: string;
  issuedAtMs: number;
  ttlMs: number;
}

const OBOL_SESSION_CONTEXT = Symbol('obol.session.context');

/** The registry record backing the current request, attached by the auth
 * guard once signature, expiry and session-record lookup all pass (D2). */
export interface AuthenticatedSessionOwner {
  /** Session record id (JWT `sid`). */
  sid: string;
  /** Owner record id (JWT `sub`). */
  sub: string;
  transport: 'bearer' | 'cookie';
}

export function readAuthenticatedSession(request: Request): AuthenticatedSessionOwner | undefined {
  const context = (request as unknown as Record<symbol, unknown>)[OBOL_SESSION_CONTEXT];
  return isSessionOwnerContext(context) ? context : undefined;
}

function isSessionOwnerContext(value: unknown): value is AuthenticatedSessionOwner {
  return (
    value instanceof Object &&
    'sid' in value &&
    'sub' in value &&
    'transport' in value &&
    typeof value.sid === 'string' &&
    typeof value.sub === 'string' &&
    (value.transport === 'bearer' || value.transport === 'cookie')
  );
}

function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

/**
 * Builds the D009 plugin. Without `options` it is inert: no hooks, no routes,
 * byte-for-byte the pre-D009 composition for desktop/legacy runtimes (D10).
 */
export function createRemoteAuthPlugin(deps: RemoteAuthDeps) {
  const options = deps.options;
  if (!options) {
    return new Elysia({ name: 'remote-auth-disabled' });
  }

  // Fail closed before binding anything: the D009 routes must never exist
  // with a signing secret that is not at least 32 characters (D7), nor with a
  // non-https public URL that would silently weaken cookie CSRF, the `__Host-`
  // cookie and reset links (D7/D9).
  if (options.sessionSecret.trim().length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `OBOL_SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters; refusing to start (fail closed).`,
    );
  }
  assertHttpsPublicUrl(options.publicUrl.replace(/\/+$/, '').trim());

  const pb = deps.pb;
  const now = deps.now ?? (() => Date.now());
  const createCredentialsClient =
    deps.createCredentialsClient ??
    ((baseUrl: string): CredentialsClient => {
      const client = new PocketBase(baseUrl);
      client.autoCancellation(false);
      return client as unknown as CredentialsClient;
    });

  const serverName = options.serverName ?? deriveServerName(options.publicUrl);

  const loginIpLimiter = new SlidingWindowRateLimiter({
    limit: LOGIN_IP_FAILURE_LIMIT,
    windowMs: LOGIN_RATE_LIMIT_WINDOW_MS,
  });
  const loginIdentityLimiter = new SlidingWindowRateLimiter({
    limit: LOGIN_IDENTITY_FAILURE_LIMIT,
    windowMs: LOGIN_RATE_LIMIT_WINDOW_MS,
  });
  const resetIpLimiter = new SlidingWindowRateLimiter({
    limit: LOGIN_IP_FAILURE_LIMIT,
    windowMs: LOGIN_RATE_LIMIT_WINDOW_MS,
  });
  const resetIdentityLimiter = new SlidingWindowRateLimiter({
    limit: LOGIN_IDENTITY_FAILURE_LIMIT,
    windowMs: LOGIN_RATE_LIMIT_WINDOW_MS,
  });

  // `undefined` = no token produced yet (set up at boot via options, or
  // lazily minted once the first setup call actually needs one).
  let setupCredentials: SetupCredentials | undefined;
  if (options.setupToken) {
    setupCredentials = {
      token: options.setupToken,
      issuedAtMs: options.setupTokenIssuedAtMs ?? now(),
      ttlMs: options.setupTokenTtlMs ?? SETUP_TOKEN_TTL_MS,
    };
  }

  /** Single-flight guard for setup/init (D1): the handler bodies run strictly
   * one after another, so a concurrent second request re-checks owner
   * existence inside the critical section after the first one has created the
   * owner — two valid setups can never create two owner records. The chain is
   * advanced with a settled placeholder regardless of individual rejection,
   * so every return/throw releases the mutex; failures reach only that
   * request's own awaiter. */
  let setupChain: Promise<void> = Promise.resolve();
  function runInSetupCriticalSection<T>(operation: () => Promise<T>): Promise<T> {
    const result = setupChain.then(operation);
    // The next waiter starts only after this operation settled (fulfilled or
    // rejected); the rejection itself is stopped here, reaching only this
    // request's own awaiter through `result`.
    setupChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Owner presence is read live so setup can never reopen after an owner
   * exists, even through PocketBase's own admin surface mid-boot (D4). */
  function ownerRecordExists(): Promise<boolean> {
    return ownerRecordExistsIn(pb);
  }

  function setupWindowExpired(credentials: SetupCredentials): boolean {
    return credentials.ttlMs > 0 && now() - credentials.issuedAtMs > credentials.ttlMs;
  }

  function clearSetupCredentials(): void {
    setupCredentials = undefined;
  }

  function mintedSetupCredentials(): SetupCredentials {
    const token = createSetupToken();
    const credentials: SetupCredentials = { token, issuedAtMs: now(), ttlMs: SETUP_TOKEN_TTL_MS };
    setupCredentials = credentials;
    console.log('🔐 Obol first-run setup mode: one-time setup token generated.');
    console.log(`🔐 Setup token (valid ${Math.round(SETUP_TOKEN_TTL_MS / 60000)} minutes): ${token}`);
    console.log('🔐 Use it with POST /api/setup/init; it is deleted once setup completes.');
    return credentials;
  }

  async function isSetupRequired(): Promise<boolean> {
    return !(await ownerRecordExists());
  }

  const remoteAuthPlugin = new Elysia({ name: 'remote-auth' })

  // CORS (D6): reflect exactly `OBOL_CLIENT_ORIGINS` — the hosted web client
  // is same-origin and never needs CORS — answer preflights, never wildcard.
  // Plain `onRequest`: hooks from `.use()`ed plugins intercept every route of
  // the composed app; `{ as: 'global' }` must NOT be used here because Elysia
  // 1.4 crashes composing global onRequest hooks (observed at runtime, while
  // plain plugin hooks compose correctly and apply globally).
  .onRequest(({ request, set }) => {
    const origin = request.headers.get('origin');
    if (!origin) return;
    if (!isClientOriginAllowed(origin, options.clientOrigins)) {
      set.headers.vary = 'Origin';
      return;
    }
    set.headers['access-control-allow-origin'] = origin;
    set.headers['access-control-allow-credentials'] = 'true';
    set.headers.vary = 'Origin';
    if (request.method.toUpperCase() === 'OPTIONS') {
      // Raw Response return: headers must be explicit because Elysia uses the
      // Response's own headers verbatim.
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': origin,
          'access-control-allow-credentials': 'true',
          'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'access-control-allow-headers': 'Authorization, Content-Type',
          'access-control-max-age': '600',
          vary: 'Origin',
        },
      });
    }
  })

  // The global auth guard (D3): every matched `/api/**` route requires a
  // session unless it is on the D3 public list, including GETs and job POSTs.
  //
  // It lives in `onRequest`, not `onBeforeHandle`: Elysia parses the body and
  // applies the route's schema validation before `onBeforeHandle` runs, so an
  // unauthenticated request with a malformed body would otherwise answer with
  // a validation `400` (leaking that the endpoint exists and how its payload
  // is shaped) instead of the uniform auth response. `onRequest` sees the raw
  // request before any parsing, so authorization is always decided first.
  // Plain registration: plugin `.use()`ed hooks apply to every composed route
  // in Elysia 1.4, while `{ as: 'global' }` crashes composition there.
  .onRequest(async ({ request }) => {
    const url = new URL(request.url);
    const pathname = normalizePathname(url.pathname);
    const method = request.method.toUpperCase();
    if (!pathname.startsWith('/api/')) return;
    if (method === 'OPTIONS') return;
    if (PUBLIC_METHOD_PATHS.has(`${method} ${pathname}`)) return;

    const bearerToken = readBearerToken(request.headers.get('authorization'));
    const cookieToken = readCookie(request.headers.get('cookie'), SESSION_COOKIE_NAME);
    const token = bearerToken || cookieToken;
    const transport: AuthenticatedSessionOwner['transport'] = bearerToken ? 'bearer' : 'cookie';

    if (!token) {
      let setupRequired = false;
      try {
        setupRequired = await isSetupRequired();
      } catch {
        // PocketBase unreachable: fail closed with a generic unauthenticated
        // body; no deployment state information is disclosed either way.
      }
      return setupRequired ? rawErrorResponse('SETUP_REQUIRED', 401) : rawErrorResponse('UNAUTHENTICATED', 401);
    }

    // CSRF guard for the cookie transport on unsafe methods (D9). Bearer
    // header authentication carries no CSRF risk, so the check is skipped.
    // A cookie-authenticated unsafe request must prove same-origin with a
    // nonempty Origin exactly matching the deployment's public URL; any
    // other (or absent) Origin is rejected.
    if (transport === 'cookie' && !SAFE_METHODS.has(method)) {
      if (!isSameOriginWithPublicUrl(request.headers.get('origin'), options.publicUrl)) {
        return rawErrorResponse('FORBIDDEN', 403);
      }
    }

    const verified = await verifySessionToken(options.sessionSecret, token, now());
    if (!verified.ok) {
      return verified.reason === 'MALFORMED'
        ? rawErrorResponse('UNAUTHENTICATED', 401)
        : rawErrorResponse('SESSION_EXPIRED', 401);
    }

    // Per-request session registry lookup: deleting the record revokes the
    // session on the next call (D2).
    let sessionRecord: SessionRecordLike;
    try {
      sessionRecord = (await pb.collection(SESSION_COLLECTION).getOne(verified.sid)) as unknown as SessionRecordLike;
    } catch {
      return rawErrorResponse('SESSION_EXPIRED', 401);
    }

    const expiresAtMs = parsePbDate(sessionRecord.expiresAt);
    if (expiresAtMs === null || expiresAtMs <= now()) {
      // Best-effort cleanup: expired rows die on the next request that finds
      // them, as documented for the rotation/registry contract (D2/D9).
      try {
        await pb.collection(SESSION_COLLECTION).delete(verified.sid);
      } catch {
        // The record was already gone; the rejection below is unaffected.
      }
      return rawErrorResponse('SESSION_EXPIRED', 401);
    }
    if (typeof sessionRecord.userId !== 'string' || sessionRecord.userId !== verified.sub) {
      return rawErrorResponse('SESSION_EXPIRED', 401);
    }

    (request as unknown as Record<symbol, unknown>)[OBOL_SESSION_CONTEXT] = {
      sid: verified.sid,
      sub: verified.sub,
      transport,
    } satisfies AuthenticatedSessionOwner;
  })

  // -- Setup -----------------------------------------------------------------

  .get(
    '/api/setup/status',
    async () => {
      let setupRequired: boolean;
      try {
        setupRequired = await ownerRecordExists();
      } catch {
        return errorResponse('INTERNAL', 500);
      }
      return {
        setupRequired: !setupRequired,
        serverName,
        smtpConfigured: options.smtpConfigured,
      };
    },
    {
      response: {
        200: SetupStatusResponseDTO,
        500: AuthErrorDTO,
      },
    },
  )

  .post(
    '/api/setup/init',
    ({ body }) => runInSetupCriticalSection(async () => {
      let ownerExists: boolean;
      try {
        ownerExists = await ownerRecordExists();
      } catch {
        return errorResponse('INTERNAL', 500);
      }
      if (ownerExists) {
        // The setup window is closed permanently once an owner exists (D4);
        // leftover credentials are cleared so nothing reopens it later.
        clearSetupCredentials();
        return errorResponse('FORBIDDEN', 403);
      }

      const credentials = setupCredentials ?? mintedSetupCredentials();
      const presented = (body.setupToken ?? '').trim();
      const tokenMatches =
        !setupWindowExpired(credentials) &&
        constantTimeEquals(textEncoder.encode(presented), textEncoder.encode(credentials.token));
      if (!tokenMatches) {
        return errorResponse('INVALID_SETUP_TOKEN', 403);
      }

      const violation = validateOwnerIdentity(body.email, body.password);
      if (violation) {
        return errorResponse({ code: 'VALIDATION_ERROR', message: violation }, 400);
      }

      try {
        await pb.collection('owner').create({
          email: body.email.trim().toLowerCase(),
          password: body.password,
          passwordConfirm: body.password,
        });
      } catch (pbError) {
        // Never echo PocketBase response details; the deployment stays in
        // setup mode and can retry after the operator resolves the cause.
        console.error('Owner setup failed (PocketBase status:', pocketBaseStatusOf(pbError), ')');
        return errorResponse('INTERNAL', 500);
      }

      // Setup succeeded: the token is invalidated and the window closed (D4).
      clearSetupCredentials();
      return { serverName };
    }),
    {
      body: SetupInitDTO,
      response: {
        200: SetupInitResponseDTO,
        400: AuthErrorDTO,
        403: AuthErrorDTO,
        500: AuthErrorDTO,
      },
    },
  )

  // -- Login -----------------------------------------------------------------

  .post(
    '/api/auth/login',
    async ({ body, request, set }) => {
      const ip = clientIpFrom(request);
      const identity = body.email.trim().toLowerCase();
      const ipBucket = `login:ip:${ip}`;
      const identityBucket = `login:identity:${identity}`;
      if (loginIpLimiter.exceeded(ipBucket, now()) || loginIdentityLimiter.exceeded(identityBucket, now())) {
        return errorResponse('RATE_LIMITED', 429);
      }

      // Fresh throwaway client per credentials check: `authWithPassword`
      // saves its token into the client's authStore, and the shared
      // superuser client must stay authenticated for session CRUD (D2/D7).
      const credentialsClient = createCredentialsClient(pb.baseUrl);
      let ownerRecord: { id: string };
      try {
        const authResponse = (await credentialsClient
          .collection('owner')
          .authWithPassword(identity, body.password)) as { record?: { id?: string } };
        const ownerId = authResponse.record?.id;
        if (typeof ownerId !== 'string' || ownerId.length === 0) {
          throw new Error('PocketBase did not return an owner record id.');
        }
        ownerRecord = { id: ownerId };
      } catch {
        loginIpLimiter.record(ipBucket, now());
        loginIdentityLimiter.record(identityBucket, now());
        return errorResponse('INVALID_CREDENTIALS', 401);
      }

      loginIdentityLimiter.clear(identityBucket);

      const nowMs = now();
      let sessionRecord: SessionRecordLike;
      try {
        sessionRecord = (await pb.collection(SESSION_COLLECTION).create({
          userId: ownerRecord.id,
          deviceLabel: (body.deviceLabel ?? '').trim().slice(0, MAX_DEVICE_LABEL_LENGTH) || 'Unnamed device',
          // App-owned immutable creation timestamp: PB base collections do not
          // auto-inject `created`, so the 30-day hard cap is derived from this
          // persisted field instead (D009/D2).
          createdAt: toPbDate(nowMs),
          expiresAt: toPbDate(nowMs + SESSION_TOKEN_TTL_MS),
        })) as unknown as SessionRecordLike;
      } catch (pbError) {
        console.error('Session creation failed (PocketBase status:', pocketBaseStatusOf(pbError), ')');
        return errorResponse('INTERNAL', 500);
      }

      // The stored `expiresAt` is the current session/token expiry: the
      // 7-day token window hedged by the immutable 30-day cap derived from
      // the app-owned persisted `createdAt` (D009/D2).
      const createdMs = parsePbDate(sessionRecord.createdAt);
      if (createdMs === null || createdMs > nowMs) {
        console.error('Session creation failed (PocketBase returned no createdAt timestamp).');
        return errorResponse('INTERNAL', 500);
      }
      const expiresAtMs = Math.min(
        nowMs + SESSION_TOKEN_TTL_MS,
        createdMs + SESSION_ABSOLUTE_TTL_MS,
      );
      const token = await signSessionToken(options.sessionSecret, { sub: ownerRecord.id, sid: sessionRecord.id }, nowMs, expiresAtMs);
      if (body.transport === 'bearer') {
        // Desktop/iOS login: the JWT is the only transport, no cookie (D9).
        return { token, expiresAt: new Date(expiresAtMs).toISOString(), serverName };
      }
      // Hosted web login (default): only the httpOnly cookie; the response
      // body never carries an XSS-readable token (D9).
      set.headers['set-cookie'] = buildSessionCookie(token, SESSION_TOKEN_TTL_SECONDS);
      return { expiresAt: new Date(expiresAtMs).toISOString(), serverName };
    },
    {
      body: LoginRequestDTO,
      response: {
        200: LoginResponseDTO,
        401: AuthErrorDTO,
        429: AuthErrorDTO,
        500: AuthErrorDTO,
      },
    },
  )

  // -- Session lifecycle (session-gated) --------------------------------------

  .post(
    '/api/auth/session/renew',
    async ({ request, set }) => {
      const session = readAuthenticatedSession(request);
      if (!session) return errorResponse('UNAUTHENTICATED', 401);

      let record: SessionRecordLike;
      try {
        record = (await pb.collection(SESSION_COLLECTION).getOne(session.sid)) as unknown as SessionRecordLike;
      } catch {
        return errorResponse('SESSION_EXPIRED', 401);
      }
      const currentExpiresAtMs = parsePbDate(record.expiresAt);
      const nowMs = now();
      if (currentExpiresAtMs === null || currentExpiresAtMs <= nowMs) {
        return errorResponse('SESSION_EXPIRED', 401);
      }

      // The hard cap is immutable: the app-owned persisted `createdAt` plus
      // 30 days; PB base collections do not auto-inject `created` (D009/D2).
      // A missing or unparsable timestamp fails closed (D009).
      const createdMs = parsePbDate(record.createdAt);
      if (createdMs === null) {
        return errorResponse('SESSION_EXPIRED', 401);
      }
      const hardCapMs = createdMs + SESSION_ABSOLUTE_TTL_MS;
      if (hardCapMs <= nowMs) {
        return errorResponse('SESSION_EXPIRED', 401);
      }

      // A fresh 7-day window, capped by the immutable absolute expiry (D2).
      const extendedAtMs = Math.min(nowMs + SESSION_TOKEN_TTL_MS, hardCapMs);
      try {
        await pb.collection(SESSION_COLLECTION).update(session.sid, { expiresAt: toPbDate(extendedAtMs) });
      } catch (pbError) {
        console.error('Session renewal failed (PocketBase status:', pocketBaseStatusOf(pbError), ')');
        return errorResponse('INTERNAL', 500);
      }

      const token = await signSessionToken(options.sessionSecret, { sub: session.sub, sid: session.sid }, nowMs, extendedAtMs);
      if (session.transport === 'cookie') {
        // Hosted web: the renewed token lives only in the rotated cookie; the
        // response body carries no token (D9).
        set.headers['set-cookie'] = buildSessionCookie(token, SESSION_TOKEN_TTL_SECONDS);
        return { expiresAt: new Date(extendedAtMs).toISOString() };
      }
      return { token, expiresAt: new Date(extendedAtMs).toISOString() };
    },
    {
      response: {
        200: SessionRenewResponseDTO,
        401: AuthErrorDTO,
        500: AuthErrorDTO,
      },
    },
  )

  .get(
    '/api/auth/session',
    async ({ request }) => {
      const session = readAuthenticatedSession(request);
      if (!session) return errorResponse('UNAUTHENTICATED', 401);

      let records: SessionRecordLike[];
      try {
        records = await listOwnerSessions(session.sub, 100);
      } catch (pbError) {
        console.error('Session listing failed (PocketBase status:', pocketBaseStatusOf(pbError), ')');
        return errorResponse('INTERNAL', 500);
      }

      return {
        sessions: records.map((record) => ({
          id: record.id,
          // D009 API field `created` is mapped from storage `createdAt`.
          created: record.createdAt ?? '',
          deviceLabel: record.deviceLabel ?? 'Unnamed device',
        })),
      };
    },
    {
      response: {
        200: SessionListResponseDTO,
        401: AuthErrorDTO,
        500: AuthErrorDTO,
      },
    },
  )

  .delete(
    '/api/auth/session',
    async ({ request, set }) => {
      const session = readAuthenticatedSession(request);
      if (!session) return errorResponse('UNAUTHENTICATED', 401);

      try {
        await pb.collection(SESSION_COLLECTION).delete(session.sid);
      } catch {
        return errorResponse('SESSION_EXPIRED', 401);
      }

      if (session.transport === 'cookie') {
        // Only a cookie-authenticated logout drops the (still set) cookie;
        // bearer logouts never emit any Set-Cookie, not even an empty one.
        set.headers['set-cookie'] = buildSessionClearCookie();
      }
      return { success: true };
    },
    {
      response: {
        200: SessionRevokedResponseDTO,
        401: AuthErrorDTO,
      },
    },
  )

  .delete(
    '/api/auth/session/:id',
    async ({ request, params, set }) => {
      const callingSession = readAuthenticatedSession(request);
      if (!callingSession) return errorResponse('UNAUTHENTICATED', 401);

      let target: SessionRecordLike;
      try {
        target = (await pb.collection(SESSION_COLLECTION).getOne(params.id)) as unknown as SessionRecordLike;
      } catch {
        return errorResponse({ code: 'NOT_FOUND', message: 'Session not found.' }, 404);
      }
      // Sessions of the single owner are all revocable; anything else is
      // treated as missing so foreign ids cannot be probed (D1).
      if (target.userId !== callingSession.sub) {
        return errorResponse({ code: 'NOT_FOUND', message: 'Session not found.' }, 404);
      }

      try {
        await pb.collection(SESSION_COLLECTION).delete(params.id);
      } catch {
        return errorResponse('INTERNAL', 500);
      }
      if (callingSession.transport === 'cookie' && params.id === callingSession.sid) {
        set.headers['set-cookie'] = buildSessionClearCookie();
      }
      return { success: true };
    },
    {
      response: {
        200: SessionRevokedResponseDTO,
        401: AuthErrorDTO,
        404: AuthErrorDTO,
        500: AuthErrorDTO,
      },
    },
  )

  // -- Password lifecycle (D5) -----------------------------------------------

  .post(
    '/api/auth/request-password-reset',
    async ({ body, request }) => {
      const ip = clientIpFrom(request);
      const identity = body.email.trim().toLowerCase();
      const ipBucket = `reset:ip:${ip}`;
      const identityBucket = `reset:identity:${identity}`;
      if (resetIpLimiter.exceeded(ipBucket, now()) || resetIdentityLimiter.exceeded(identityBucket, now())) {
        return errorResponse('RATE_LIMITED', 429);
      }
      resetIpLimiter.record(ipBucket, now());
      resetIdentityLimiter.record(identityBucket, now());

      // Enumeration protection: every input receives the identical success
      // body; PocketBase is only contacted when SMTP is configured and the
      // result (including unknown-email errors) never reaches the client.
      if (options.smtpConfigured) {
        const credentialsClient = createCredentialsClient(pb.baseUrl);
        try {
          await credentialsClient.collection('owner').requestPasswordReset(identity);
        } catch {
          // Unknown email, disabled SMTP or PocketBase downtime: same body.
          return PASSWORD_RESET_RESPONSE_BODY;
        }
      }
      return PASSWORD_RESET_RESPONSE_BODY;
    },
    {
      body: PasswordResetRequestDTO,
      response: {
        200: PasswordResetResponseDTO,
        429: AuthErrorDTO,
      },
    },
  )

  .post(
    '/api/auth/confirm-password-reset',
    async ({ body }) => {
      const violation = validatePassword(body.password);
      if (violation || body.token.trim().length === 0) {
        return errorResponse({ code: 'VALIDATION_ERROR', message: 'A reset token and a valid password are required.' }, 400);
      }

      // Same throwaway-client boundary as login: although `confirmPasswordReset`
      // does not store its result, verifying through a disposable client keeps
      // the shared superuser authStore untouched no matter what the SDK does.
      const credentialsClient = createCredentialsClient(pb.baseUrl);
      try {
        await credentialsClient.collection('owner').confirmPasswordReset(
          body.token.trim(),
          body.password,
          body.password,
        );
      } catch {
        return errorResponse('INVALID_RESET_TOKEN', 400);
      }

      // Password reset revokes every device (D2): the deployment's sessions
      // registry is emptied (D1 keeps it owner-only). No PocketBase credential
      // is ever issued or returned.
      try {
        await deleteAllSessions(pb);
      } catch (pbError) {
        console.error('Session revocation after password reset failed (PocketBase status:', pocketBaseStatusOf(pbError), ')');
        return errorResponse('INTERNAL', 500);
      }
      return { success: true };
    },
    {
      body: PasswordResetConfirmDTO,
      response: {
        200: SessionRevokedResponseDTO,
        400: AuthErrorDTO,
        500: AuthErrorDTO,
      },
    },
  );

  function validatePassword(value: string): string | undefined {
    if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH || value.length > MAX_PASSWORD_LENGTH) {
      return `The password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters long.`;
    }
    return undefined;
  }

  function validateOwnerIdentity(email: string, password: string): string | undefined {
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 254) {
      return 'A valid email address is required.';
    }
    return validatePassword(password);
  }

  /** All current session records of the deployment. D1 guarantees exactly one
   * owner, so deleting every record is the same as deleting the owner's. */
  async function listOwnerSessions(ownerId: string, perPage: number): Promise<SessionRecordLike[]> {
    let items: SessionRecordLike[] = [];
    for (let page = 1; page < 200; page += 1) {
      const result = await pb.collection(SESSION_COLLECTION).getList(page, perPage, {
        sort: '-createdAt',
      });
      const records = (result.items ?? []) as unknown as SessionRecordLike[];
      items = items.concat(records);
      if (records.length < perPage) break;
    }
    return items.filter((record) => record.userId === ownerId);
  }

  return remoteAuthPlugin;
}

const PASSWORD_RESET_RESPONSE_BODY = {
  message: 'If the address belongs to the owner account, a password reset link has been sent.',
} as const;

/** PocketBase errors are logged by status only: response bodies, credentials
 * and tokens never surface in logs (D7). */
export function pocketBaseStatusOf(pbError: unknown): string {
  if (pbError instanceof Object && 'status' in pbError && typeof pbError.status === 'number') {
    return String(pbError.status);
  }
  return 'unknown';
}

/** Deletes every session record of the deployment. D1: exactly one owner, so
 * the deployment-wide list is the owner's session list. Deletes repeatedly
 * from offset one so a record deletion never shifts the next page out of
 * reach. */
const DELETE_ALL_SESSIONS_BATCH = 500;

async function deleteAllSessions(pb: PocketBase): Promise<number> {
  let deleted = 0;
  for (;;) {
    const result = await pb.collection(SESSION_COLLECTION).getList(1, DELETE_ALL_SESSIONS_BATCH);
    const records = result.items as unknown as SessionRecordLike[];
    if (records.length === 0) break;
    for (const record of records) {
      await pb.collection(SESSION_COLLECTION).delete(record.id);
      deleted += 1;
    }
  }
  return deleted;
}

