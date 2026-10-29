import { treaty } from '@elysiajs/eden'
import type { Treaty } from '@elysiajs/eden'
import type { App } from '../../server/src/index'
import type { createRemoteAuthPlugin } from '../../server/src/infrastructure/plugins/remoteAuth'
import type {
  ApiFetchRequest,
  ApiFetchResponse,
  DesktopUpdaterState,
  LocalAccountSummary,
  LocalAuthSetupRequest,
  LocalAuthStatus,
  LocalAuthUnlockRequest
} from '../../desktop/electrobun/shared-rpc'

export type DesktopUpdaterUnsubscribe = () => void

export interface ObolViewBridge {
  apiFetch(request: ApiFetchRequest): Promise<ApiFetchResponse>
  auth: {
    status(): Promise<LocalAuthStatus>
    setup(request: LocalAuthSetupRequest): Promise<LocalAccountSummary>
    unlock(request: LocalAuthUnlockRequest): Promise<LocalAccountSummary>
  }
  updater: {
    status(): Promise<DesktopUpdaterState>
    check(): Promise<DesktopUpdaterState>
    install(): Promise<void>
    subscribe(callback: (state: DesktopUpdaterState) => void): DesktopUpdaterUnsubscribe
  }
}

declare global {
  interface Window {
    obol?: ObolViewBridge
  }
}

/**
 * Remote transport selected before the local Electrobun `window.obol` RPC path.
 * D009: remote desktop and iOS authenticate with `Authorization: Bearer <jwt>`;
 * the hosted web never carries a token in JS and relies on the
 * `__Host-obol_session` httpOnly cookie sent with `credentials: 'include'`.
 */
export interface RemoteBearerTransport {
  kind: 'bearer'
  /** Absolute origin of the central server, e.g. `https://obol.example.com`. */
  serverUrl: string
  /** Returns the current BFF minted session token from the right storage. */
  getToken: () => string | null
}

export interface RemoteCookieTransport {
  kind: 'cookie'
}

export type RemoteTransport = RemoteBearerTransport | RemoteCookieTransport

export type RemoteAuthFailureCode = 'UNAUTHENTICATED' | 'SESSION_EXPIRED'

// ---- D009 route contract ---------------------------------------------------
// The composed `App` returns a union (D009 remote branch vs D10 inert branch),
// and its `.use(remoteAuthPlugin)` keeps only the route info its members share,
// so `/api/setup/*` and `/api/auth/*` are missing from `Treaty.Create<App>`
// navigation. The D009 routes are therefore taken from the auth plugin's own
// chained instance — its per-status response maps come straight from the server
// DTOs — and the app-side intersection preserves the financial routes from
// `App`. The plugin's route type is not exported by the server (hence the
// `ReturnType` derivation here); once the server folds the plugin routes into
// `App['~Routes']` natively, `AuthedRoutes` and `ObolApp` collapse to plain
// `App`.

type RemoteAuthPluginRoutes = ReturnType<typeof createRemoteAuthPlugin>['~Routes']
type FullPluginRoutes<M> = M extends unknown ? ('api' extends keyof M ? M : never) : never
type AuthedRoutes = FullPluginRoutes<RemoteAuthPluginRoutes>
type ObolApp = App & { '~Routes': App['~Routes'] & AuthedRoutes }

export type ObolApi = Treaty.Create<ObolApp>

let activeTransport: RemoteTransport | null = null
let authFailureHandler: ((code: RemoteAuthFailureCode) => void) | null = null

export function setRemoteTransport(transport: RemoteTransport | null): void {
  activeTransport = transport
}

/** Absolute origin of the selected remote server, or `null` when not in bearer mode. */
export function remoteServerUrl(): string | null {
  return activeTransport?.kind === 'bearer' ? activeTransport.serverUrl : null
}

/**
 * Invoked by the fetcher when the remote server rejects the session, so the
 * auth gate can return to login instead of sending more unauthenticated calls.
 */
export function onRemoteAuthFailure(
  handler: ((code: RemoteAuthFailureCode) => void) | null
): void {
  authFailureHandler = handler
}

function defaultApiBase(): string {
  // Hosted UI requests stay same-origin and use the Nuxt proxy. In Electrobun,
  // the document-start bridge routes the same typed HTTP contract to Elysia in-process.
  return import.meta.server
    ? process.env.NUXT_PUBLIC_API_BASE || 'http://obol-server:13080'
    : window.location.origin
}

// One treaty instance per base URL so remote server changes do not leave a
// shared client pointed at the previous deployment.
const treatyCache = new Map<string, ObolApi>()

/** Typed treaty client for an explicit origin (used by the hosted capability probe). */
export function apiClientFor(baseUrl: string): ObolApi {
  let client = treatyCache.get(baseUrl)
  if (!client) {
    // `parseDate` is disabled so `expiresAt`/`created` ISO strings arrive as
    // strings, matching the D009 contract instead of silent `Date` coercion.
    client = treaty<ObolApp>(baseUrl, { fetcher, parseDate: false })
    treatyCache.set(baseUrl, client)
  }
  return client
}

/**
 * The typed Eden client. The target URL is resolved per property access:
 * the remote bearer transport wins over the local `window.obol` RPC path, and
 * a Capacitor `capacitor://localhost` document origin is never used to reach
 * the central server.
 */
export const api = new Proxy({} as ObolApi, {
  get(_target, prop) {
    const baseUrl =
      activeTransport?.kind === 'bearer'
        ? activeTransport.serverUrl
        : defaultApiBase()
    const client = apiClientFor(baseUrl)
    return Reflect.get(client, prop, client)
  }
})

function fetchBody(request: Request): Promise<string | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return Promise.resolve(undefined)
  }
  const bodyInit = request.body
  if (bodyInit === undefined || bodyInit === null) return Promise.resolve(undefined)
  if (typeof bodyInit === 'string') return Promise.resolve(bodyInit)
  return new Response(bodyInit).text()
}

const fetcher: typeof fetch = async (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init)

  if (activeTransport) return remoteFetch(request)

  const bridge = typeof window === 'undefined' ? undefined : window.obol
  if (!bridge) return globalThis.fetch(request)

  const url = new URL(request.url)
  const method = request.method
  const headers = Array.from(request.headers.entries())
  const body = await fetchBody(request)
  const response = await bridge.apiFetch({
    path: `${url.pathname}${url.search}`,
    method,
    headers,
    body
  })

  return new Response(response.body || null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}

async function remoteFetch(request: Request): Promise<Response> {
  const transport = activeTransport as RemoteTransport
  if (transport.kind === 'cookie') {
    // Same-origin cookie requests (no CORS; the Nuxt proxy forwards the typed
    // contract). The browser reads/writes the httpOnly session cookie; the
    // token is never placed in JS-readable storage.
    return relayRemoteFailure(globalThis.fetch(new Request(request, { credentials: 'include' })))
  }

  // Bearer transport: retarget the request so a Capacitor `capacitor://localhost`
  // document origin cannot leak into requests against the central server.
  const url = new URL(request.url)
  const target = new URL(`${url.pathname}${url.search}`, transport.serverUrl)
  const headers = new Headers(request.headers)
  const token = transport.getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const body = await fetchBody(request)
  return relayRemoteFailure(
    globalThis.fetch(target, {
      method: request.method,
      headers,
      body,
      credentials: 'omit'
    })
  )
}

async function relayRemoteFailure(responsePromise: Promise<Response>): Promise<Response> {
  const response = await responsePromise
  if (response.status === 401 && authFailureHandler) {
    let code: RemoteAuthFailureCode = 'UNAUTHENTICATED'
    try {
      const payload = (await response.clone().json()) as { code?: unknown } | undefined
      if (payload?.code === 'SESSION_EXPIRED') code = 'SESSION_EXPIRED'
    } catch {
      // The response body is optional; status alone already triggers the gate.
    }
    authFailureHandler(code)
  }
  return response
}
