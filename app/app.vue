<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { ObolViewBridge } from './utils/api'
import type {
  LocalAccountSummary,
  LocalAuthSetupRequest,
  LocalAuthUnlockRequest
} from '../desktop/electrobun/shared-rpc'

type LocalAuthMode = 'checking' | 'setup' | 'unlock' | 'unlocked' | 'hosted' | 'error'

const financeStore = useFinanceStore()
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

onMounted(async () => {
  if (isDesktopClient()) {
    if (!authBridge()) {
      authMode.value = 'error'
      authMessage.value = 'The desktop authentication bridge is unavailable.'
      return
    }
    await readAuthState()
  } else if (financeStore.accounts.length === 0) {
    await financeStore.loadBaseData(true)
  }
})
</script>

<template>
  <UNotifications />
  <LocalAuthGate
    v-if="desktopRuntime && (authMode === 'checking' || authMode === 'setup' || authMode === 'unlock' || authMode === 'error')"
    :mode="localGateMode"
    :account="localAccount"
    :busy="authBusy"
    :message="authMessage"
    @setup="setupLocalAccount"
    @unlock="unlockLocalAccount"
    @retry="readAuthState"
  />
  <NuxtLayout v-else>
    <NuxtRouteAnnouncer />
    <NuxtPage />
  </NuxtLayout>
</template>
