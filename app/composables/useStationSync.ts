import { computed, ref, shallowRef } from 'vue'
import { useFinanceStore } from '../stores/finance'
import { useRefresh } from './useRefresh'
import { remoteServerUrl } from '../utils/api'
import type { DesktopStationBridge } from '../utils/api'
import type {
  DesktopAcknowledgeRejectedRequest,
  DesktopConflictEntry,
  DesktopConfirmConnectionRequest,
  DesktopConnectionPreviewRequest,
  DesktopExportResult,
  DesktopOutboxEntry,
  DesktopPairingPreview,
  DesktopResolveConflictRequest,
  DesktopSignOutResult,
  DesktopStationStatus
} from '../../desktop/electrobun/shared-rpc'

/**
 * Desktop station sync consumes `window.obol.sync`, which only exists in an
 * unlocked desktop-local build. It never retargets the finance transport: the
 * local PocketBase RPC path stays the data path while pairing, syncing and
 * after disconnect. Remote-only desktop and hosted web mount nothing here.
 */

export const STATION_BRIDGE_UNAVAILABLE =
  'This desktop build does not expose the local station sync bridge. Install a desktop build that includes local sync to pair and synchronize.'

export type StationAction =
  | 'synchronize'
  | 'previewConnection'
  | 'confirmConnection'
  | 'cancelConnectionPreview'
  | 'disconnect'
  | 'signOut'
  | 'resolveConflict'
  | 'acknowledgeRejected'
  | 'exportSnapshot'

const ACTION_LABELS: Record<StationAction, string> = {
  synchronize: 'Synchronizing with the server…',
  previewConnection: 'Checking the server…',
  confirmConnection: 'Applying the selected pairing action…',
  cancelConnectionPreview: 'Canceling the connection preview…',
  disconnect: 'Disconnecting the station…',
  signOut: 'Removing credentials…',
  resolveConflict: 'Resolving the conflict…',
  acknowledgeRejected: 'Acknowledging the rejected operation…',
  exportSnapshot: 'Waiting for the snapshot export…'
}

// Session state is module-global: one subscription and one queue view shared by
// every station surface. Bridge payloads are replaced wholesale, never mutated
// in place, so `shallowRef` keeps Vue from deeply unwrapping their recursive
// JSON fields (which otherwise explodes type instantiation).
const status = shallowRef<DesktopStationStatus | null>(null)
const preview = shallowRef<DesktopPairingPreview | null>(null)
const outbox = shallowRef<DesktopOutboxEntry[]>([])
const conflicts = shallowRef<DesktopConflictEntry[]>([])
const lastExport = shallowRef<DesktopExportResult | null>(null)

// Seed synchronously so a supported desktop build never flashes the upgrade
// message before `start()` runs.
const isSupported = ref(bridge() !== undefined)
const isStarted = ref(false)
const busy = ref(false)
const busyAction = ref<StationAction | null>(null)
const error = ref<string | null>(null)
const queueError = ref<string | null>(null)
const notice = ref<string | null>(null)

let unsubscribe: (() => void) | null = null
let observedDataRevision: number | null = null
let financeRefreshInFlight = false

function bridge(): DesktopStationBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.obol?.sync
}

function errorMessage(value: unknown): string {
  if (value instanceof Error && value.message) return value.message
  if (typeof value === 'string' && value.length > 0) return value
  return 'The station request failed.'
}

async function refreshLocalFinance(): Promise<void> {
  // Finance refreshes are local-only; hosted and remote caches never see them.
  if (bridge() === undefined || remoteServerUrl() !== null || financeRefreshInFlight) return
  financeRefreshInFlight = true
  try {
    const financeStore = useFinanceStore()
    const { triggerRefresh } = useRefresh()
    // Force a fresh snapshot after the station reports a real working-data
    // change, then let pages refetch their current query/selection.
    await financeStore.loadBaseData(true)
    triggerRefresh()
  } finally {
    financeRefreshInFlight = false
  }
}

function adopt(next: DesktopStationStatus): void {
  status.value = next
  if (observedDataRevision === null) {
    observedDataRevision = next.dataRevision
    return
  }
  if (next.dataRevision === observedDataRevision) return
  observedDataRevision = next.dataRevision
  void refreshLocalFinance()
}

async function refreshQueues(activeBridge: DesktopStationBridge): Promise<void> {
  const [outboxResult, conflictsResult] = await Promise.allSettled([
    activeBridge.outbox(),
    activeBridge.conflicts()
  ] as const)
  if (outboxResult.status === 'fulfilled') outbox.value = outboxResult.value
  if (conflictsResult.status === 'fulfilled') conflicts.value = conflictsResult.value
  if (outboxResult.status === 'rejected') {
    queueError.value = errorMessage(outboxResult.reason)
  } else if (conflictsResult.status === 'rejected') {
    queueError.value = errorMessage(conflictsResult.reason)
  } else {
    queueError.value = null
  }
}

async function refreshStatusQuietly(activeBridge: DesktopStationBridge): Promise<void> {
  try {
    adopt(await activeBridge.status())
  } catch (failure) {
    // The completed action already changed backend state; a failed follow-up
    // read is a status error, not a queue-read error.
    error.value = errorMessage(failure)
  }
}

/**
 * Start the single bridge subscription and seed status + queue views. Safe to
 * call from every station surface; later calls reuse the running lifecycle.
 */
async function start(): Promise<void> {
  if (isStarted.value) return
  isStarted.value = true
  const activeBridge = bridge()
  isSupported.value = activeBridge !== undefined
  if (!activeBridge) {
    error.value = STATION_BRIDGE_UNAVAILABLE
    return
  }

  error.value = null
  try {
    unsubscribe = activeBridge.subscribe(next => adopt(next))
  } catch (failure) {
    error.value = errorMessage(failure)
  }

  try {
    adopt(await activeBridge.status())
  } catch (failure) {
    error.value = errorMessage(failure)
  }
  await refreshQueues(activeBridge)
}

function stop(): void {
  unsubscribe?.()
  unsubscribe = null
  isStarted.value = false
}

async function withAction<T>(
  action: StationAction,
  operation: (activeBridge: DesktopStationBridge) => Promise<T>
): Promise<T> {
  const activeBridge = bridge()
  if (!activeBridge) throw new Error(STATION_BRIDGE_UNAVAILABLE)
  if (busy.value) throw new Error('Another station action is already running. Wait for it to finish.')
  busy.value = true
  busyAction.value = action
  error.value = null
  notice.value = null
  try {
    return await operation(activeBridge)
  } catch (failure) {
    const message = errorMessage(failure)
    error.value = message
    throw failure instanceof Error ? failure : new Error(message)
  } finally {
    busy.value = false
    busyAction.value = null
  }
}

async function synchronize(): Promise<DesktopStationStatus> {
  return withAction('synchronize', async activeBridge => {
    const next = await activeBridge.synchronize()
    adopt(next)
    await refreshQueues(activeBridge)
    return next
  })
}

async function previewConnection(
  request: DesktopConnectionPreviewRequest
): Promise<DesktopPairingPreview> {
  return withAction('previewConnection', async activeBridge => {
    const next = await activeBridge.previewConnection(request)
    preview.value = next
    return next
  })
}

async function confirmConnection(
  request: DesktopConfirmConnectionRequest
): Promise<DesktopStationStatus> {
  return withAction('confirmConnection', async activeBridge => {
    const next = await activeBridge.confirmConnection(request)
    preview.value = null
    adopt(next)
    await refreshQueues(activeBridge)
    return next
  })
}

async function cancelConnectionPreview(): Promise<void> {
  await withAction('cancelConnectionPreview', async activeBridge => {
    await activeBridge.cancelConnectionPreview()
  })
  preview.value = null
}

async function disconnect(): Promise<DesktopStationStatus> {
  return withAction('disconnect', async activeBridge => {
    const next = await activeBridge.disconnect()
    adopt(next)
    await refreshQueues(activeBridge)
    return next
  })
}

async function signOut(): Promise<DesktopSignOutResult> {
  return withAction('signOut', async activeBridge => {
    const result = await activeBridge.signOut()
    notice.value = result.localCredentialRemoved
      ? result.remoteRevoked
        ? 'Local credentials were removed and the remote session was revoked.'
        : 'Local credentials were removed. The remote session could not be revoked; it expires on its own.'
      : 'Local credentials could not be removed. Local financial data is untouched; try again.'
    await refreshStatusQuietly(activeBridge)
    await refreshQueues(activeBridge)
    return result
  })
}

async function resolveConflict(
  request: DesktopResolveConflictRequest
): Promise<DesktopStationStatus> {
  return withAction('resolveConflict', async activeBridge => {
    const next = await activeBridge.resolveConflict(request)
    adopt(next)
    await refreshQueues(activeBridge)
    return next
  })
}

async function acknowledgeRejected(
  request: DesktopAcknowledgeRejectedRequest
): Promise<DesktopStationStatus> {
  return withAction('acknowledgeRejected', async activeBridge => {
    const next = await activeBridge.acknowledgeRejected(request)
    adopt(next)
    await refreshQueues(activeBridge)
    return next
  })
}

async function exportSnapshot(): Promise<DesktopExportResult> {
  return withAction('exportSnapshot', async activeBridge => {
    const result = await activeBridge.exportSnapshot()
    lastExport.value = result
    notice.value = result.saved
      ? 'Snapshot saved. A current export receipt is available for a destructive pairing action.'
      : 'No snapshot file was saved. A destructive pairing action stays unavailable without a completed export.'
    return result
  })
}

async function refresh(): Promise<void> {
  const activeBridge = bridge()
  isSupported.value = activeBridge !== undefined
  if (!activeBridge) {
    error.value = STATION_BRIDGE_UNAVAILABLE
    return
  }
  error.value = null
  try {
    adopt(await activeBridge.status())
  } catch (failure) {
    error.value = errorMessage(failure)
  }
  await refreshQueues(activeBridge)
}

const busyLabel = computed(() => {
  const action = busyAction.value
  return action === null ? null : ACTION_LABELS[action]
})

export function useStationSync() {
  return {
    status,
    preview,
    outbox,
    conflicts,
    isSupported,
    isStarted,
    busy,
    busyAction,
    busyLabel,
    error,
    queueError,
    notice,
    lastExport,
    start,
    stop,
    refresh,
    synchronize,
    previewConnection,
    confirmConnection,
    cancelConnectionPreview,
    disconnect,
    signOut,
    resolveConflict,
    acknowledgeRejected,
    exportSnapshot
  }
}
