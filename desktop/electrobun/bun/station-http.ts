// Remote Obol sync transport for the desktop station (D016 D4/D7).
//
// This module owns the HTTP boundary only: origin validation, fresh bearer
// sessions, and typed calls to the documented `/api/sync/*` routes. It never
// touches PocketBase, never reads local finance and never stores a secret.
// Redirects are refused, cookies are never sent, TLS uses Bun's system trust
// store, and every call has a finite AbortSignal deadline.

import type {
  SyncHandshakeRequest,
  SyncHandshakeResponse,
  SyncImportRequest,
  SyncImportResponse,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
  SyncSeedRequest,
  SyncSeedResponse,
} from '../../../server/src/domain/sync/SyncProtocol';
import type { SyncCursor } from '../../../server/src/domain/sync/SyncChange';

/** Failure reported by the remote server or the transport itself. */
export class StationHttpError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'StationHttpError';
    this.status = status;
    this.code = code;
  }
}

/** Login response of `POST /api/auth/login` with `transport: 'bearer'`. */
export interface StationLoginResult {
  readonly token: string;
  readonly expiresAt: string;
  readonly serverName: string;
}

/** Rotated session from `POST /api/auth/session/renew`. */
export interface StationRenewResult {
  readonly token: string;
  readonly expiresAt: string;
}

const LOOPBACK_HOSTS: Readonly<Record<string, true>> = {
  '127.0.0.1': true,
  localhost: true,
  '[::1]': true
};

/**
 * Validates and normalizes one server address. HTTPS is required except for a
 * literal loopback HTTP origin (local self-hosting). Credentials, query
 * strings, fragments and non-root paths are refused so one binding cannot be
 * retargeted silently.
 */
export function normalizeServerAddress(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error('Enter the Obol server address.');
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error('Enter a valid server address, for example https://obol.example.com.');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('The server address must not contain a username or password.');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error('The server address must not contain a query string or fragment.');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error('The server address must point at the server root.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('The Obol server address must use HTTPS.');
  }
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS[parsed.hostname] !== true) {
    throw new Error('Plain HTTP is only allowed for a loopback server address.');
  }
  return parsed.origin;
}

interface RequestOptions {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly token?: string;
  readonly body?: unknown;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

/** Splits a JSON error body without trusting its shape. */
function errorCodeOf(payload: unknown): string | null {
  const box = recordOrNull(payload);
  const code = box === null ? undefined : box['code'];
  return typeof code === 'string' ? code : null;
}

function errorMessageOf(payload: unknown, fallback: string): string {
  const box = recordOrNull(payload);
  const message = box === null ? undefined : box['message'];
  return typeof message === 'string' && message.length > 0 ? message : fallback;
}

/** One authenticated (or session-establishing) remote client. */
export class StationRemoteClient {
  constructor(
    readonly baseUrl: string,
    private token: string | null,
    private readonly signal?: AbortSignal,
  ) {}

  /** Uses one rotated bearer token for subsequent calls. */
  setToken(token: string): void {
    this.token = token;
  }

  /** Fresh bearer login for one pairing preview; no cookie is issued. */
  async login(email: string, password: string, deviceLabel: string): Promise<StationLoginResult> {
    const payload = await this.request<unknown>('/api/auth/login', {
      method: 'POST',
      body: { email, password, deviceLabel, transport: 'bearer' },
      deadlineMs: 20_000,
    });
    const box = recordOf(payload, 'The login response');
    const token = box['token'];
    const expiresAt = box['expiresAt'];
    const serverName = box['serverName'];
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('The server did not return a session token for this device.');
    }
    return {
      token,
      expiresAt: typeof expiresAt === 'string' ? expiresAt : '',
      serverName: typeof serverName === 'string' ? serverName : 'Obol',
    };
  }

  /** Rotates the current bearer session; a 401 means reauthentication is needed. */
  async renew(): Promise<StationRenewResult> {
    const payload = await this.request<unknown>('/api/auth/session/renew', {
      method: 'POST',
      token: this.requireToken(),
      deadlineMs: 15_000,
    });
    const box = recordOf(payload, 'The session renewal response');
    const token = box['token'];
    if (typeof token !== 'string' || token.length === 0) {
      throw new Error('The server did not return a renewed session token.');
    }
    this.token = token;
    return {
      token,
      expiresAt: typeof box['expiresAt'] === 'string' ? box['expiresAt'] : '',
    };
  }

  /** Revokes the current remote session; local data is never touched. */
  async revoke(): Promise<void> {
    await this.request<unknown>('/api/auth/session', {
      method: 'DELETE',
      token: this.requireToken(),
      deadlineMs: 10_000,
    });
  }

  async handshake(request: SyncHandshakeRequest): Promise<SyncHandshakeResponse> {
    return await this.request<SyncHandshakeResponse>('/api/sync/handshake', {
      method: 'POST',
      token: this.requireToken(),
      body: request,
      deadlineMs: 20_000,
    });
  }

  async pull(cursor: SyncCursor, limit: number): Promise<SyncPullResponse> {
    return await this.request<SyncPullResponse>(
      `/api/sync/pull?cursor=${encodeURIComponent(String(cursor))}&limit=${encodeURIComponent(String(limit))}`,
      { method: 'GET', token: this.requireToken(), deadlineMs: 30_000 },
    );
  }

  async push(request: SyncPushRequest): Promise<SyncPushResponse> {
    return await this.request<SyncPushResponse>('/api/sync/push', {
      method: 'POST',
      token: this.requireToken(),
      body: request,
      deadlineMs: 60_000,
    });
  }

  async seed(request: SyncSeedRequest): Promise<SyncSeedResponse> {
    return await this.request<SyncSeedResponse>('/api/sync/seed', {
      method: 'POST',
      token: this.requireToken(),
      body: request,
      deadlineMs: 120_000,
    });
  }

  async import(request: SyncImportRequest): Promise<SyncImportResponse> {
    return await this.request<SyncImportResponse>('/api/sync/import', {
      method: 'POST',
      token: this.requireToken(),
      body: request,
      deadlineMs: 120_000,
    });
  }

  private requireToken(): string {
    if (this.token === null || this.token.length === 0) {
      throw new StationHttpError('This device has no remote session; sign in again.', 401, 'UNAUTHENTICATED');
    }
    return this.token;
  }

  private async request<T>(path: string, options: RequestOptions): Promise<T> {
    const deadline = AbortSignal.timeout(options.deadlineMs ?? 30_000);
    const signal = combineSignals(deadline, this.signal, options.signal);
    let response: Response;
    try {
      response = await fetch(new URL(path, this.baseUrl), {
        method: options.method,
        headers: {
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` })
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: 'error',
        credentials: 'omit',
        signal
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new StationHttpError('The Obol server did not answer before the deadline.', 0, 'TIMEOUT');
      }
      throw new StationHttpError(
        `Could not reach the Obol server: ${error instanceof Error ? error.message : String(error)}`,
        0,
        'NETWORK'
      );
    }

    const text = await response.text();
    let payload: unknown = null;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new StationHttpError(
          `The Obol server returned a non-JSON response (HTTP ${response.status}).`,
          response.status,
          'INVALID_RESPONSE'
        );
      }
    }
    if (!response.ok) {
      const code = errorCodeOf(payload);
      throw new StationHttpError(
        errorMessageOf(payload, `The Obol server rejected the request (HTTP ${response.status}).`),
        response.status,
        code
      );
    }
    return payload as T;
  }
}

/** Narrow a JSON object read from the network. */
function recordOf(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StationHttpError(`${context} must be a JSON object.`, 0, 'INVALID_RESPONSE');
  }
  return value as Record<string, unknown>;
}

/** Nullable object narrowing for error bodies the server may omit. */
function recordOrNull(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Combines optional abort signals without leaking listeners. */
function combineSignals(
  deadline: AbortSignal,
  outer?: AbortSignal,
  extra?: AbortSignal,
): AbortSignal {
  const signals = [deadline, outer, extra].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  if (signals.length === 1) return signals[0]!;
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
