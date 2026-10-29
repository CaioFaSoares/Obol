import { treaty } from '@elysiajs/eden'
import type { App } from '../../server/src/index'
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

// Hosted UI requests stay same-origin and use the Nuxt proxy. In Electrobun,
// the document-start bridge routes the same typed HTTP contract to Elysia in-process.
const apiUrl = import.meta.server
  ? process.env.NUXT_PUBLIC_API_BASE || 'http://obol-server:13080'
  : window.location.origin

const fetcher: typeof fetch = async (input, init) => {
  const bridge = typeof window === 'undefined' ? undefined : window.obol
  if (!bridge) return globalThis.fetch(input, init)

  const url = new URL(input instanceof Request ? input.url : input.toString())
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  const bodyInit = init?.body ?? (input instanceof Request ? input.body : undefined)
  const body = method === 'GET' || method === 'HEAD' || bodyInit === undefined || bodyInit === null
    ? undefined
    : typeof bodyInit === 'string'
      ? bodyInit
      : await new Response(bodyInit).text()
  const response = await bridge.apiFetch({
    path: `${url.pathname}${url.search}`,
    method,
    headers: Array.from(headers.entries()),
    body
  })

  return new Response(response.body || null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}

export const api = treaty<App>(apiUrl, { fetcher })
