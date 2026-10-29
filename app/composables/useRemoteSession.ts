import { computed, ref } from 'vue'
import { Capacitor } from '@capacitor/core'
import { SecureStorage } from '@aparajita/capacitor-secure-storage'

import { api, apiClientFor, onRemoteAuthFailure, setRemoteTransport, remoteServerUrl } from '../utils/api'

/**
 * D009 remote identity client state. One deployed server has exactly one
 * owner; sessions are verified on startup (`GET /api/auth/session`), renewed
 * before expiry when the expiry is known, and cleared on
 * `SESSION_EXPIRED`/revocation before any unauthenticated financial call.
 *
 * Credential storage per client (D9):
 * - iOS: Keychain via `@aparajita/capacitor-secure-storage`, always after the
 *   nonblank `obol.remote.` prefix is set, never falling back to localStorage.
 * - Desktop remote mode: WebView `localStorage`, stored separately from the
 *   local profile (D008 no-sync rule).
 * - Hosted web: no JS token storage at all; the `__Host-obol_session` httpOnly
 *   cookie travels with `credentials: 'include'` requests.
 * Only the endpoint URL lives in localStorage; it is not a secret.
 *
 * Transport field contract (backend slice): login requests carry an explicit
 * `transport: 'cookie' | 'bearer'`. Bearer clients persist the token returned
 * in the body and ignore any Set-Cookie; the hosted web reads no body token
 * and relies on the cookie the server refreshes via Set-Cookie. All D009
 * calls ride the typed Eden treaty transport (`utils/api.ts`); the auth
 * errors are typed `{ code, message }` bodies surfaced through
 * `RemoteApiError`.
 */

export type RemoteStep =
  | 'idle'
  | 'server-url'
  | 'checking'
  | 'setup'
  | 'login'
  | 'reset-request'
  | 'reset-confirm'
  | 'sessions'
  | 'active'
  | 'error'

export interface RemoteSessionListItem {
  id: string
  createdAt: string | null
  deviceLabel: string | null
}

export interface RemoteAuthRequest {
  email: string
  password: string
}

export interface RemoteSetupSubmission {
  setupToken: string
  email: string
  password: string
}

export interface RemoteResetSubmission {
  token: string
  password: string
}

// ---- Boundary helpers ------------------------------------------------------
// D009 auth servers always answer errors with `{ code, message }`; the typed
// contract comes from the treaty client, and only the runtime values below
// still need their guards because they guard the actual response body.

function stringField(payload: unknown, name: string): string | null {
  if (payload === null || typeof payload !== 'object' || !(name in payload)) return null
  const value = (payload as Record<string, unknown>)[name]
  return typeof value === 'string' ? value : null
}

/** Treaty failures are runtime `{ status, value }` pairs; `value` is the
 * parsed D009 error body. Every failure keeps its HTTP status. */
function remoteApiError(error: { value?: unknown }, status: number): RemoteApiError {
  const code = stringField(error.value, 'code') ?? `HTTP_${status}`
  const message = stringField(error.value, 'message') ?? `Request failed (${status}).`
  return new RemoteApiError(message, code, status)
}

const SERVER_URL_KEY = 'obol.remote.serverUrl'
const ACTIVE_FLAG_KEY = 'obol.remote.active'
const SERVER_NAME_KEY = 'obol.remote.serverName'
const SERVER_URL_STORAGE_PREFIX = 'obol.remote.'
const TOKEN_KEY = 'sessionToken'
const EXPIRES_KEY = 'sessionExpiresAt'
const SECURE_PREFIX = 'obol.remote.'
const RENEW_MARGIN_MS = 24 * 60 * 60 * 1000

type HostedCapability = 'auth' | 'legacy' | 'unknown'

/**
 * Hosted capability probe against the typed `GET /api/setup/status` contract.
 * Only a 404 proves the deployment predates the D009 plugin; auth failures,
 * network outages and server errors are NOT a license to fall back to the
 * legacy dashboard, so they surface as auth/unknown gating.
 */
async function probeHostedCapability(): Promise<HostedCapability> {
  try {
    // Node fetch (SSR prerender) needs an absolute URL; the browser probes
    // same-origin so the request always lands on the deployment's real proxy.
    const base = import.meta.server
      ? (process.env.NUXT_PUBLIC_API_BASE || 'http://obol-server:13080').replace(/\/$/, '')
      : window.location.origin
    const result = await apiClientFor(base).api.setup.status.get()
    if (result.error) return result.status === 404 ? 'legacy' : 'unknown'
    return 'auth'
  } catch {
    return 'unknown'
  }
}

/** Server-side prefetch decision: skip the unauthenticated financial load
 * only when the deployment is auth-enabled. */
export async function hostedServerRequiresAuth(): Promise<boolean> {
  const capability = await probeHostedCapability()
  return capability !== 'legacy'
}

class RemoteApiError extends Error {
  code: string
  status: number

  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = 'RemoteApiError'
    this.code = code
    this.status = status
  }
}

// Session state is process-global so the gate, app shell and status badge share it.
const remoteStep = ref<RemoteStep>('idle')
const remoteBusy = ref(false)
const remoteMessage = ref('')
const remoteErrorCode = ref<string | null>(null)
const remoteServerUrlRef = ref<string | null>(null)
const remoteServerName = ref<string | null>(null)
const remoteSessions = ref<RemoteSessionListItem[]>([])
const remoteExpiresAt = ref<number | null>(null)
const remoteCooldown = ref(0)
const smtpConfigured = ref<boolean | null>(null)
const cooldownTimer: { current: ReturnType<typeof setInterval> | null } = { current: null }
const renewTimer: { current: ReturnType<typeof setTimeout> | null } = { current: null }
let pendingResetToken = ''
let bearerToken: string | null = null
let failureHandlerBound = false
let secureStorageReady: Promise<void> | null = null

export function useRemoteSession() {
  function nativeClient(): boolean {
    return typeof window !== 'undefined' && Capacitor.isNativePlatform() === true
  }

  // Desktop remote mode only ever runs inside the Electrobun webview bridge.
  function desktopClient(): boolean {
    return typeof window !== 'undefined' && window.obol?.auth !== undefined
  }

  function hostedWeb(): boolean {
    return !nativeClient() && !desktopClient()
  }

  // ---------- credential storage ----------

  async function secureReady(): Promise<void> {
    if (!secureStorageReady) {
      // The plugin rejects a blank prefix (v8.0.1); set the nonblank D009
      // prefix once before any get/set/remove so every session item is
      // namespaced inside the Keychain.
      secureStorageReady = SecureStorage.setKeyPrefix(SECURE_PREFIX)
    }
    await secureStorageReady
  }

  async function readToken(): Promise<string | null> {
    if (bearerToken || hostedWeb()) return bearerToken
    if (nativeClient()) {
      try {
        await secureReady()
        const stored = await SecureStorage.getItem(TOKEN_KEY)
        bearerToken = typeof stored === 'string' && stored.length > 0 ? stored : null
        if (bearerToken) {
          // Retain the stored token expiry so start-up verification can
          // schedule the renewal without a fresh round trip.
          const storedExpiryValue = await SecureStorage.getItem(EXPIRES_KEY)
          remoteExpiresAt.value = parseExpiry(storedExpiryValue) ?? remoteExpiresAt.value
        }
      } catch (error) {
        console.error('Could not read the remote session from the Keychain:', error)
      }
    } else if (desktopClient()) {
      const stored = window.localStorage.getItem(`${SERVER_URL_STORAGE_PREFIX}${TOKEN_KEY}`)
      bearerToken = typeof stored === 'string' && stored.length > 0 ? stored : null
    }
    return bearerToken
  }

  function saveToken(token: string, expiresAt: string | null): void {
    bearerToken = token
    remoteExpiresAt.value = expiresAt === null ? null : parseExpiry(expiresAt)
    if (nativeClient()) {
      void (async () => {
        // Keychain after first unlock; the prefix is set before every mutation.
        await secureReady()
        await SecureStorage.setItem(TOKEN_KEY, token)
        if (expiresAt) await SecureStorage.setItem(EXPIRES_KEY, expiresAt)
      })().catch(error => {
        console.error('Could not persist the remote session to the iOS Keychain:', error)
        remoteMessage.value = 'The session could not be saved to the iOS Keychain.'
      })
    } else if (desktopClient()) {
      window.localStorage.setItem(`${SERVER_URL_STORAGE_PREFIX}${TOKEN_KEY}`, token)
      if (expiresAt) {
        window.localStorage.setItem(`${SERVER_URL_STORAGE_PREFIX}${EXPIRES_KEY}`, expiresAt)
      }
    }
    // Hosted web: the token stays server-side in the httpOnly cookie; the body
    // token is never read into JS state.
  }

  async function clearStoredToken(): Promise<void> {
    bearerToken = null
    remoteExpiresAt.value = null
    if (nativeClient()) {
      try {
        await secureReady()
        await SecureStorage.removeItem(TOKEN_KEY)
        await SecureStorage.removeItem(EXPIRES_KEY)
      } catch (error) {
        console.error('Could not clear the remote session from the Keychain:', error)
      }
    }
    if (desktopClient()) {
      window.localStorage.removeItem(`${SERVER_URL_STORAGE_PREFIX}${TOKEN_KEY}`)
      window.localStorage.removeItem(`${SERVER_URL_STORAGE_PREFIX}${EXPIRES_KEY}`)
    }
  }

  function parseExpiry(value: unknown): number | null {
    if (typeof value !== 'string' || value.length === 0) return null
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? null : parsed
  }

  function storedExpiry(): number | null {
    if (nativeClient() || hostedWeb()) return null
    return parseExpiry(window.localStorage.getItem(`${SERVER_URL_STORAGE_PREFIX}${EXPIRES_KEY}`))
  }

  // ---------- server URL ----------

  function storedServerUrl(): string | null {
    return window.localStorage.getItem(SERVER_URL_KEY)
  }

  function saveServerUrl(url: string): void {
    remoteServerUrlRef.value = url
    window.localStorage.setItem(SERVER_URL_KEY, url)
  }

  function storedServerName(): string | null {
    return window.localStorage.getItem(SERVER_NAME_KEY)
  }

  function saveServerName(value: string | null): void {
    const trimmed = value?.trim() ?? ''
    remoteServerName.value = trimmed.length > 0 ? trimmed : null
    if (remoteServerName.value) {
      window.localStorage.setItem(SERVER_NAME_KEY, remoteServerName.value)
    } else {
      window.localStorage.removeItem(SERVER_NAME_KEY)
    }
  }

  function normalizeServerUrl(input: string): string {
    const trimmed = input.trim().replace(/\/+$/, '')
    if (/^https?:\/\//i.test(trimmed)) return trimmed
    return `https://${trimmed}`
  }

  /** Returns a user-facing problem description, or `null` when the URL is acceptable. */
  function invalidServerUrlMessage(value: string): string | null {
    if (value.trim().length === 0) return 'Enter the server address.'
    let parsed: URL
    try {
      parsed = new URL(normalizeServerUrl(value))
    } catch {
      return 'That is not a valid URL.'
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return 'The server address must use HTTPS.'
    }
    if (parsed.protocol === 'http:') {
      const isLocalhost = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)
      if (isLocalhost && import.meta.dev) return null
      if (isLocalhost) {
        return 'Insecure HTTP endpoints are only available in development builds.'
      }
      return 'Insecure HTTP is only allowed for a localhost development server.'
    }
    return null
  }

  // ---------- D009 endpoint wrappers (typed treaty calls) ----------
  // Cookie (hosted web): same-origin, credentials include, browser-managed
  // httpOnly session; the token never enters JS state. Bearer: absolute
  // server URL, token in the Authorization header, cookies withheld (D9).
  // Every call flows through the same `fetcher` as the financial routes.

  async function setupStatus(): Promise<{ setupRequired: boolean; serverName: string; smtpConfigured: boolean }> {
    const result = await api.api.setup.status.get()
    if (result.error) throw remoteApiError(result.error, result.status)
    return result.data
  }

  async function setupInit(submission: RemoteSetupSubmission): Promise<string | null> {
    const result = await api.api.setup.init.post({
      setupToken: submission.setupToken.trim(),
      email: submission.email.trim().toLowerCase(),
      password: submission.password
    })
    if (result.error) throw remoteApiError(result.error, result.status)
    return result.data.serverName
  }

  async function login(submission: RemoteAuthRequest): Promise<void> {
    const cookieMode = hostedWeb()
    const result = await api.api.auth.login.post({
      email: submission.email.trim().toLowerCase(),
      password: submission.password,
      deviceLabel: deviceLabel(),
      transport: cookieMode ? 'cookie' : 'bearer'
    })
    if (result.error) throw remoteApiError(result.error, result.status)
    const body = result.data
    saveServerName(body.serverName)
    if (cookieMode) {
      // The server refreshed the httpOnly session cookie via Set-Cookie; the
      // body token is deliberately never read into JS state. The response
      // carries the new expiry so renewals can be scheduled client-side.
      remoteExpiresAt.value = parseExpiry(body.expiresAt)
      recordActiveSession()
    } else {
      const token = body.token
      if (!token) throw new RemoteApiError('The server did not issue a session.', 'NO_TOKEN', result.status)
      saveToken(token, body.expiresAt)
      remoteSessions.value = []
      await verifyExistingSession()
    }
  }

  async function renewSession(): Promise<void> {
    // Renewal rides the current transport: bearer header or cookie, both typed.
    try {
      const result = await api.api.auth.session.renew.post()
      if (result.error) return
      const body = result.data
      remoteExpiresAt.value = parseExpiry(body.expiresAt)
      if (!hostedWeb()) {
        // Renewal returns a body token only for bearer transports; bearer
        // clients persist it and never rely on Set-Cookie. For the cookie
        // transport the server rotates the httpOnly cookie via Set-Cookie
        // and the body token stays unread.
        const token = body.token
        if (token) saveToken(token, body.expiresAt)
      }
      scheduleRenewal()
    } catch {
      // The old token stays valid until its own exp (D009); the next request
      // surfaces SESSION_EXPIRED through the transport hook if renewal failed.
    }
  }

  async function verifyExistingSession(): Promise<void> {
    const result = await api.api.auth.session.get()
    if (result.error) throw remoteApiError(result.error, result.status)
    refreshSessionList(result.data)
    if (remoteExpiresAt.value === null) {
      if (hostedWeb()) {
        // Hosted cookie sessions carry their expiry server-side: the renewal
        // call itself reports it, then everything is scheduled from there.
        await renewSession()
      } else {
        remoteExpiresAt.value = storedExpiry()
      }
    }
    remoteStep.value = 'active'
    remoteMessage.value = ''
    remoteErrorCode.value = null
    scheduleRenewal()
  }

  function refreshSessionList(data: unknown): void {
    if (
      data === null ||
      typeof data !== 'object' ||
      !Array.isArray((data as Record<string, unknown>).sessions)
    ) {
      throw new RemoteApiError('The server returned no session list.', 'INTERNAL', 200)
    }
    const rows = (data as Record<string, unknown>).sessions as unknown[]
    const items: RemoteSessionListItem[] = []
    for (const row of rows) {
      if (row === null || typeof row !== 'object' || !('id' in row)) continue
      const record = row as Record<string, unknown>
      const id = typeof record['id'] === 'string' ? record['id'] : ''
      const createdAt =
        typeof record['createdAt'] === 'string'
          ? record['createdAt']
          : typeof record['created'] === 'string'
            ? record['created']
            : null
      const deviceLabel = typeof record['deviceLabel'] === 'string' ? record['deviceLabel'] : null
      if (id.length > 0) items.push({ id, createdAt, deviceLabel })
    }
    remoteSessions.value = items
  }

  async function revokeOwnSession(): Promise<void> {
    const result = await api.api.auth.session.delete()
    if (result.error) throw remoteApiError(result.error, result.status)
  }

  async function revokeSessionById(id: string): Promise<void> {
    const result = await api.api.auth.session({ id: encodeURIComponent(id) }).delete()
    if (result.error) throw remoteApiError(result.error, result.status)
  }

  async function requestReset(email: string): Promise<void> {
    const result = await api.api.auth['request-password-reset'].post({
      email: email.trim().toLowerCase()
    })
    if (result.error) throw remoteApiError(result.error, result.status)
  }

  async function confirmReset(submission: RemoteResetSubmission): Promise<void> {
    const result = await api.api.auth['confirm-password-reset'].post({
      token: submission.token.trim(),
      password: submission.password
    })
    if (result.error) throw remoteApiError(result.error, result.status)
  }

  // ---------- error copy ----------

  function describeError(error: unknown): string {
    if (error instanceof RemoteApiError) {
      if (
        error.status === 0 ||
        /^(Failed to fetch|Load failed|NetworkError|fetch failed)$/i.test(error.message.trim())
      ) {
        return 'Could not reach the server. Check the address and your connection, then try again.'
      }
      switch (error.code) {
        case 'RATE_LIMITED':
          startCooldown()
          return 'Too many attempts. Wait a moment and try again.'
        case 'INVALID_CREDENTIALS':
          return 'Email or password is incorrect.'
        case 'SETUP_REQUIRED':
          remoteStep.value = 'setup'
          return 'Finish setting up this server before signing in.'
        case 'SESSION_EXPIRED':
          return 'The session expired. Sign in again.'
        case 'UNAUTHENTICATED':
          return 'Sign in to continue.'
        case 'FORBIDDEN':
          return 'The server refused that action.'
        case 'INVALID_SETUP_TOKEN':
        case 'INVALID_RESET_TOKEN':
          return error.message
        default:
          return error.message
      }
    }
    if (error instanceof TypeError) {
      return 'Could not reach the server. Check the address and your connection, then try again.'
    }
    return error instanceof Error ? error.message : 'Unexpected error.'
  }

  // ---------- timer handling (handles narrowed before clearing) ----------

  function stopCooldownTimer(): void {
    const handle = cooldownTimer.current
    if (handle !== null) {
      clearInterval(handle)
      cooldownTimer.current = null
    }
  }

  function stopRenewTimer(): void {
    const handle = renewTimer.current
    if (handle !== null) {
      clearTimeout(handle)
      renewTimer.current = null
    }
  }

  function startCooldown(): void {
    remoteCooldown.value = Math.max(remoteCooldown.value, 30)
    stopCooldownTimer()
    cooldownTimer.current = setInterval(() => {
      remoteCooldown.value = Math.max(0, remoteCooldown.value - 1)
      if (remoteCooldown.value === 0) stopCooldownTimer()
    }, 1000)
  }

  function isSessionRejected(error: RemoteApiError): boolean {
    // Expiry and revocation both invalidate the stored token before the gate.
    return error.code === 'SESSION_EXPIRED' ||
      error.code === 'UNAUTHENTICATED' ||
      error.status === 401
  }

  function scheduleRenewal(): void {
    stopRenewTimer()
    const expiresAt = remoteExpiresAt.value
    if (expiresAt === null) {
      // No known expiry (e.g. legacy servers without a renewal contract):
      // nothing to schedule, so the existing cookie rides until verification.
      return
    }
    const delay = expiresAt - Date.now() - RENEW_MARGIN_MS
    renewTimer.current = setTimeout(() => {
      void renewSession()
    }, Math.max(0, Math.min(delay, RENEW_MARGIN_MS)))
  }

  // ---------- transport registration ----------

  function registerBearerTransport(url: string): void {
    remoteServerUrlRef.value = url
    remoteServerName.value = storedServerName()
    // Bearer transport wins over the local `window.obol` RPC path (D9 desktop).
    setRemoteTransport({ kind: 'bearer', serverUrl: url, getToken: () => bearerToken })
  }

  function registerCookieTransport(): void {
    remoteServerUrlRef.value = null
    setRemoteTransport({ kind: 'cookie' })
  }

  function bindFailureHandler(): void {
    if (failureHandlerBound) return
    failureHandlerBound = true
    onRemoteAuthFailure(code => {
      void (async () => {
        await clearStoredToken()
        remoteSessions.value = []
        remoteStep.value = 'login'
        remoteMessage.value =
          code === 'SESSION_EXPIRED'
            ? 'Your session expired or was revoked. Sign in again.'
            : 'Sign in to continue.'
        remoteErrorCode.value = code
      })()
    })
  }

  // ---------- bootstrap ----------

  function consumeResetTokenFromLocation(): string {
    if (typeof window === 'undefined') return ''
    const url = new URL(window.location.href)
    const hashQuery = url.hash.includes('?')
      ? url.hash.slice(url.hash.indexOf('?') + 1)
      : ''
    const token = url.searchParams.get('resetToken') ??
      new URLSearchParams(hashQuery).get('resetToken') ??
      ''
    if (!token) return ''

    // Reset tokens are credentials. Keep them out of browser history and
    // subsequent same-origin Referer headers after the app consumes the link.
    url.searchParams.delete('resetToken')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`)
    return token
  }

  async function bootstrapRemote(): Promise<void> {
    if (import.meta.server) return
    if (remoteBusy.value) return

    bindFailureHandler()
    pendingResetToken = consumeResetTokenFromLocation()
    remoteBusy.value = true
    remoteMessage.value = ''
    remoteErrorCode.value = null
    remoteStep.value = 'checking'

    try {
      if (hostedWeb()) {
        const capability = await probeHostedCapability()
        if (capability === 'legacy') {
          // Auth-disabled hosted deployment: keep today's dashboard behavior.
          remoteStep.value = 'idle'
          return
        }
        registerCookieTransport()
      } else {
        const url = storedServerUrl()
        if (!url || invalidServerUrlMessage(url) !== null) {
          // Nothing configured (or an HTTP endpoint that is no longer allowed
          // outside development): demand a fresh server URL.
          remoteServerName.value = null
          remoteStep.value = 'server-url'
          return
        }
        registerBearerTransport(url)
      }

      const status = await setupStatus()
      smtpConfigured.value = status.smtpConfigured
      saveServerName(status.serverName)

      if (pendingResetToken) {
        remoteStep.value = 'reset-confirm'
        return
      }
      if (status.setupRequired) {
        remoteStep.value = 'setup'
        return
      }

      if (hostedWeb() === false && (await readToken()) === null) {
        remoteStep.value = 'login'
        return
      }

      // An existing session is verified before any financial route is touched.
      await verifyExistingSession()
    } catch (error) {
      await startupError(error)
    } finally {
      remoteBusy.value = false
    }
  }

  async function startupError(error: unknown): Promise<void> {
    if (error instanceof RemoteApiError && isSessionRejected(error)) {
      // The stored session is expired or revoked: clear it and ask to log in.
      await clearStoredToken()
      remoteSessions.value = []
      remoteStep.value = 'login'
      remoteMessage.value = 'The stored session is no longer valid. Sign in again.'
      remoteErrorCode.value = error.code
      return
    }
    remoteMessage.value = describeError(error)
    remoteErrorCode.value = error instanceof RemoteApiError ? error.code : null
    remoteStep.value = 'error'
  }

  // ---------- auth actions ----------

  function deviceLabel(): string {
    if (nativeClient()) return 'iOS app'
    if (desktopClient()) return 'Desktop remote'
    return 'Hosted web browser'
  }

  async function chooseServer(rawUrl: string): Promise<void> {
    remoteMessage.value = ''
    const message = invalidServerUrlMessage(rawUrl)
    if (message) {
      remoteMessage.value = message
      remoteErrorCode.value = 'INVALID_SERVER_URL'
      return
    }
    // Changing the endpoint drops the old deployment's session only.
    await clearStoredToken()
    window.localStorage.removeItem(SERVER_NAME_KEY)
    remoteServerName.value = null
    saveServerUrl(normalizeServerUrl(rawUrl))
    await bootstrapRemote()
  }

  async function submitSetup(submission: RemoteSetupSubmission): Promise<void> {
    remoteBusy.value = true
    remoteMessage.value = ''
    remoteErrorCode.value = null
    try {
      const serverName = await setupInit(submission)
      saveServerName(serverName)
      remoteStep.value = 'login'
      remoteMessage.value = 'Owner account created. Sign in with the new password.'
    } catch (error) {
      remoteMessage.value = describeError(error)
      remoteErrorCode.value = error instanceof RemoteApiError ? error.code : null
      if (error instanceof RemoteApiError && error.code === 'FORBIDDEN') {
        // Setup permanently closed: an owner already exists, go to login.
        remoteStep.value = 'login'
        remoteMessage.value = 'This server is already set up. Sign in instead.'
      }
    } finally {
      remoteBusy.value = false
    }
  }

  async function submitLogin(submission: RemoteAuthRequest): Promise<void> {
    remoteBusy.value = true
    remoteMessage.value = ''
    remoteErrorCode.value = null
    try {
      await login(submission)
    } catch (error) {
      remoteMessage.value = describeError(error)
      remoteErrorCode.value = error instanceof RemoteApiError ? error.code : null
      if (!(error instanceof RemoteApiError && error.code === 'SETUP_REQUIRED')) {
        remoteStep.value = 'login'
      }
    } finally {
      remoteBusy.value = false
    }
  }

  function recordActiveSession(): void {
    remoteStep.value = 'active'
    remoteMessage.value = ''
    remoteErrorCode.value = null
    scheduleRenewal()
  }

  async function logout(): Promise<void> {
    remoteBusy.value = true
    try {
      await revokeOwnSession()
    } catch {
      // Revocation failures must never trap the user in a signed-in state.
    } finally {
      await clearStoredToken()
      remoteSessions.value = []
      remoteStep.value = hostedWeb() ? 'login' : remoteServerUrlRef.value ? 'login' : 'server-url'
      remoteMessage.value = ''
      clearFinanceCache()
      remoteBusy.value = false
    }
  }

  // Financial records loaded from a remote deployment never linger in memory
  // when the transport switches away or the session ends.
  function clearFinanceCache(): void {
    const store = useFinanceStore()
    store.accounts = []
    store.cards = []
    store.categories = []
    store.projects = []
  }

  async function openSessionManager(): Promise<void> {
    remoteBusy.value = true
    remoteMessage.value = ''
    try {
      const result = await api.api.auth.session.get()
      if (result.error) throw remoteApiError(result.error, result.status)
      refreshSessionList(result.data)
      remoteStep.value = 'sessions'
    } catch (error) {
      remoteMessage.value = describeError(error)
    } finally {
      remoteBusy.value = false
    }
  }

  async function revokeSession(id: string): Promise<void> {
    remoteBusy.value = true
    try {
      await revokeSessionById(id)
      await openSessionManager()
    } catch (error) {
      remoteMessage.value = describeError(error)
      // A revocation of the calling session also surfaces through the
      // transport hook and returns the user to the gate.
    } finally {
      remoteBusy.value = false
    }
  }

  // ---------- password reset (D5) ----------

  async function requestPasswordReset(email: string): Promise<void> {
    remoteBusy.value = true
    remoteMessage.value = ''
    try {
      // Enumeration protection: the endpoint always answers with a success body.
      await requestReset(email)
      remoteStep.value = 'login'
      remoteMessage.value = 'If an owner account exists for that email, a reset link has been sent.'
    } catch (error) {
      remoteMessage.value = describeError(error)
    } finally {
      remoteBusy.value = false
    }
  }

  async function confirmPasswordReset(submission: RemoteResetSubmission): Promise<void> {
    remoteBusy.value = true
    remoteMessage.value = ''
    remoteErrorCode.value = null
    try {
      // Password change resets every session of the owner, including this one.
      await confirmReset(submission)
      pendingResetToken = ''
      await clearStoredToken()
      remoteStep.value = 'login'
      remoteMessage.value = 'Password updated. Sign in with the new password.'
    } catch (error) {
      remoteMessage.value = describeError(error)
      remoteErrorCode.value = error instanceof RemoteApiError ? error.code : null
    } finally {
      remoteBusy.value = false
    }
  }

  // ---------- explicit local/remote mode selection ----------

  function remoteRequested(): boolean {
    return typeof window !== 'undefined' && window.localStorage.getItem(ACTIVE_FLAG_KEY) === '1'
  }

  /** Desktop: the explicit "Connect to a central server" entry on the login screen. */
  function enterRemoteConfiguration(): void {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(ACTIVE_FLAG_KEY, '1')
    remoteServerUrlRef.value = storedServerUrl()
    remoteServerName.value = storedServerName()
    remoteMessage.value = ''
    remoteStep.value = 'server-url'
  }

  /** Desktop: explicit switch back to the local profile; the local profile and
   * D007 unlock state are never cleared. */
  function useLocalInstead(): void {
    if (typeof window === 'undefined') return
    window.localStorage.removeItem(ACTIVE_FLAG_KEY)
    setRemoteTransport(null)
    remoteStep.value = 'idle'
    remoteMessage.value = ''
    remoteServerUrlRef.value = null
    remoteServerName.value = null
    remoteSessions.value = []
    clearFinanceCache()
  }

  /** Deliberate endpoint change: drop only the remote session; local data untouched. */
  function changeServerUrl(): void {
    void clearStoredToken()
    remoteSessions.value = []
    window.localStorage.removeItem(SERVER_NAME_KEY)
    remoteServerName.value = null
    clearFinanceCache()
    remoteStep.value = 'server-url'
  }

  function retryStartup(): void {
    void bootstrapRemote()
  }

  return {
    remoteStep,
    remoteBusy,
    remoteMessage,
    remoteErrorCode,
    remoteCooldown,
    remoteServerName: computed(() => remoteServerName.value),
    remoteServerUrl: computed(() => remoteServerUrlRef.value ?? remoteServerUrl()),
    remoteSessions: computed(() => remoteSessions.value),
    // Only bearer clients (desktop remote, iOS) can point at another origin;
    // the hosted web is pinned to its own origin by the Nuxt proxy.
    endpointConfigurable: computed(() => hostedWeb() === false),
    smtpConfigured: computed(() => smtpConfigured.value),
    pendingResetToken: computed(() => pendingResetToken),
    bootstrapRemote,
    chooseServer,
    submitSetup,
    submitLogin,
    logout,
    openSessionManager,
    revokeSession,
    backToActive: () => {
      remoteStep.value = 'active'
    },
    showPasswordReset: () => {
      remoteStep.value = 'reset-request'
    },
    requestPasswordReset,
    confirmPasswordReset,
    remoteRequested,
    enterRemoteConfiguration,
    useLocalInstead,
    changeServerUrl,
    retryStartup
  }
}
