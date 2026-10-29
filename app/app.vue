<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { ObolViewBridge } from './utils/api'
import type {
  LocalAccountSummary,
  LocalAuthSetupRequest,
  LocalAuthUnlockRequest
} from '../desktop/electrobun/shared-rpc'
import { hostedServerRequiresAuth, useRemoteSession } from './composables/useRemoteSession'

type LocalAuthMode = 'checking' | 'setup' | 'unlock' | 'unlocked' | 'hosted' | 'error'

const financeStore = useFinanceStore()
const remote = useRemoteSession()

function isDesktopClient(): boolean {
  return typeof window !== 'undefined' &&
    (window.location.protocol === 'views:' || window.obol?.auth !== undefined)
}

const desktopRuntime = import.meta.client && isDesktopClient()
const authMode = ref<LocalAuthMode>(
  desktopRuntime ? (authBridge() ? 'checking' : 'error') : 'hosted'
)
const localAccount = ref<LocalAccountSummary | null>(null)
const authBusy = ref(false)
const authMessage = ref(
  desktopRuntime && !authBridge() ? 'The desktop authentication bridge is unavailable.' : ''
)
function authBridge(): ObolViewBridge['auth'] | undefined {
  return typeof window === 'undefined' ? undefined : window.obol?.auth
}

// Desktop: set once the local login screen's "Connect to a central server"
// action is used, or when a previous remote session was configured.
const remoteModeRequested = ref(false)

const localGateVisible = computed(() =>
  desktopRuntime && !remoteModeRequested.value &&
  (authMode.value === 'checking' || authMode.value === 'setup' || authMode.value === 'unlock' || authMode.value === 'error')
)

// Everything except a verified session and the legacy hosted dashboard is
// gated; the app stays behind RemoteAuthGate until a session is confirmed.
const remoteGateVisible = computed(() => {
  if (!import.meta.client) return false
  switch (remote.remoteStep.value) {
    case 'idle':
    case 'active':
    case 'sessions':
      return false
    default:
      return true
  }
})

const remoteOverlayVisible = computed(() =>
  import.meta.client && remote.remoteStep.value === 'sessions'
)

const remoteBadgeVisible = computed(() =>
  import.meta.client && remote.remoteStep.value === 'active'
)

const localGateMode = computed(() => {
  switch (authMode.value) {
    case 'checking':
    case 'setup':
    case 'unlock':
    case 'error':
      return authMode.value
    default:
      return 'checking'
  }
})

if (import.meta.server) {
  await useAsyncData('global-finance-data', async () => {
    // Auth-enabled deployments must not expose unauthenticated financial calls
    // in the prerender: the remote gate fetches data only after verification.
    if (await hostedServerRequiresAuth()) return false
    await financeStore.loadBaseData()
    return true
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Could not open this local profile.'
}

async function readAuthState(): Promise<void> {
  const bridge = authBridge()
  if (!bridge) {
    authMode.value = 'hosted'
    return
  }
  authBusy.value = true
  authMessage.value = ''
  try {
    const status = await bridge.status()
    localAccount.value = status.account
    authMode.value = status.setupRequired ? 'setup' : 'unlock'
  } catch (error) {
    authMessage.value = errorMessage(error)
    authMode.value = 'error'
  } finally {
    authBusy.value = false
  }
}

async function finishLocalUnlock(account: LocalAccountSummary): Promise<void> {
  localAccount.value = account
  authMessage.value = ''
  authMode.value = 'unlocked'
  try {
    await financeStore.loadBaseData(true)
  } catch (error) {
    console.error('Local profile unlocked, but base data could not be loaded:', error)
  }
}

async function setupLocalAccount(request: LocalAuthSetupRequest): Promise<void> {
  const bridge = authBridge()
  if (!bridge || authBusy.value) return
  authBusy.value = true
  authMessage.value = ''
  try {
    const account = await bridge.setup(request)
    await finishLocalUnlock(account)
  } catch (error) {
    authMessage.value = errorMessage(error)
    try {
      const status = await bridge.status()
      localAccount.value = status.account
      authMode.value = status.setupRequired ? 'setup' : 'unlock'
    } catch {
      authMode.value = 'error'
    }
  } finally {
    authBusy.value = false
  }
}

async function unlockLocalAccount(request: LocalAuthUnlockRequest): Promise<void> {
  const bridge = authBridge()
  if (!bridge || authBusy.value) return
  authBusy.value = true
  authMessage.value = ''
  try {
    const account = await bridge.unlock(request)
    await finishLocalUnlock(account)
  } catch (error) {
    authMessage.value = errorMessage(error)
  } finally {
    authBusy.value = false
  }
}

// Explicit local -> remote path from the local login screen. The local profile
// is never touched by remote mode (D008 no-sync rule).
function connectRemote(): void {
  remote.enterRemoteConfiguration()
  remoteModeRequested.value = true
}

// Explicit remote -> local path. The local profile requires unlocking again.
function switchToLocal(): void {
  remote.useLocalInstead()
  remoteModeRequested.value = false
  void readAuthState()
}

// After login the session is verified and the remote transport is registered;
// pull base data exactly like the local unlock path does.
watch(remote.remoteStep, async (step, previous) => {
  if (step !== 'active' || previous === 'active' || previous === 'sessions') return
  await financeStore.loadBaseData(true)
})

onMounted(async () => {
  if (isDesktopClient()) {
    remoteModeRequested.value = remote.remoteRequested()
    if (remoteModeRequested.value) {
      await remote.bootstrapRemote()
    } else {
      await readAuthState()
    }
  } else {
    // Native iOS and hosted web run the same remote identity flow; legacy
    // (auth-disabled) hosted deployments resolve to 'idle' inside the call
    // and load the dashboard as before.
    await remote.bootstrapRemote()
  }

  // The remoteStep watcher pulls base data as soon as a session goes active.
  if (
    remote.remoteStep.value === 'idle' &&
    !isDesktopClient() &&
    financeStore.accounts.length === 0
  ) {
    await financeStore.loadBaseData(true)
  }
})
</script>

<template>
  <UNotifications />
  <RemoteAuthGate
    v-if="remoteGateVisible"
    :step="remote.remoteStep.value"
    :busy="remote.remoteBusy.value"
    :message="remote.remoteMessage.value"
    :server-url="remote.remoteServerUrl.value"
    :server-name="remote.remoteServerName.value"
    :sessions="remote.remoteSessions.value"
    :cooldown="remote.remoteCooldown.value"
    :reset-token="remote.pendingResetToken.value"
    :smtp-configured="remote.smtpConfigured.value"
    :allow-local-switch="desktopRuntime"
    :allow-server-change="remote.endpointConfigurable.value"
    @choose-server="url => remote.chooseServer(url)"
    @setup="submission => remote.submitSetup(submission)"
    @login="request => remote.submitLogin(request)"
    @show-reset-request="remote.showPasswordReset()"
    @reset-request-submit="email => remote.requestPasswordReset(email)"
    @reset-confirm="submission => remote.confirmPasswordReset(submission)"
    @logout="remote.logout()"
    @revoke="id => remote.revokeSession(id)"
    @change-server="remote.changeServerUrl()"
    @switch-local="switchToLocal"
    @retry="remote.retryStartup()"
  />
  <LocalAuthGate
    v-else-if="localGateVisible"
    :mode="localGateMode"
    :account="localAccount"
    :busy="authBusy"
    :message="authMessage"
    @setup="setupLocalAccount"
    @unlock="unlockLocalAccount"
    @retry="readAuthState"
    @connect="connectRemote"
  />
  <template v-else>
    <NuxtLayout>
      <NuxtRouteAnnouncer />
      <NuxtPage />
    </NuxtLayout>
    <RemoteAuthGate
      v-if="remoteBadgeVisible"
      status-badge
      :step="remote.remoteStep.value"
      :busy="remote.remoteBusy.value"
      :message="remote.remoteMessage.value"
      :server-url="remote.remoteServerUrl.value"
      :server-name="remote.remoteServerName.value"
      :sessions="remote.remoteSessions.value"
      :cooldown="remote.remoteCooldown.value"
      :reset-token="remote.pendingResetToken.value"
      :smtp-configured="remote.smtpConfigured.value"
      :allow-server-change="remote.endpointConfigurable.value"
      @manage="remote.openSessionManager()"
    />
    <RemoteAuthGate
      v-if="remoteOverlayVisible"
      overlay
      step="sessions"
      :busy="remote.remoteBusy.value"
      :message="remote.remoteMessage.value"
      :server-url="remote.remoteServerUrl.value"
      :server-name="remote.remoteServerName.value"
      :sessions="remote.remoteSessions.value"
      :cooldown="remote.remoteCooldown.value"
      :reset-token="remote.pendingResetToken.value"
      :smtp-configured="remote.smtpConfigured.value"
      :allow-server-change="remote.endpointConfigurable.value"
      :allow-local-switch="desktopRuntime"
      @logout="remote.logout()"
      @revoke="id => remote.revokeSession(id)"
      @back-to-active="remote.backToActive()"
      @change-server="remote.changeServerUrl()"
      @switch-local="switchToLocal"
    />
  </template>
</template>
