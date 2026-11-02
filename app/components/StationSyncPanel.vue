<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useStationSync, STATION_BRIDGE_UNAVAILABLE } from '../composables/useStationSync'
import type {
  DesktopConflictEntry,
  DesktopConflictResolution,
  DesktopDependentPolicy,
  DesktopOutboxEntry,
  DesktopPairingActionId,
  DesktopPairingPreview,
  DesktopStationPhase
} from '../../desktop/electrobun/shared-rpc'

/**
 * Desktop-local station surface. Renders only the bridge-reported state:
 * no polling, no invented "up to date" claim, and no network path of its own.
 * Pairing never leaves local mode; finance keeps flowing through the local RPC.
 */
const station = useStationSync()
const {
  status,
  preview,
  outbox,
  conflicts,
  isSupported,
  busy,
  busyAction,
  busyLabel,
  error,
  queueError,
  notice,
  lastExport
} = station

const expanded = ref(false)
const pairingOpen = ref(false)

const serverAddress = ref('')
const email = ref('')
const password = ref('')

const selectedChoice = ref<DesktopPairingActionId | null>(null)
const confirmation = ref('')
const receipt = ref<string | null>(null)

const disconnectArmed = ref(false)
let disconnectTimer: ReturnType<typeof setTimeout> | undefined

const resolutionDraft = reactive<Record<string, DesktopConflictResolution | ''>>({})
const dependentsDraft = reactive<Record<string, DesktopDependentPolicy | ''>>({})
const ackDraft = reactive<Record<string, DesktopDependentPolicy | ''>>({})

const RESOLUTION_OPTIONS: Array<{ label: string, value: DesktopConflictResolution }> = [
  { label: 'Use the server record', value: 'useServer' },
  { label: 'Retry with the current server revision', value: 'retryWithCurrentServerRevision' },
  { label: 'Discard my local operation', value: 'discard' }
]

const DEPENDENTS_OPTIONS: Array<{ label: string, value: DesktopDependentPolicy }> = [
  { label: 'Keep dependent operations queued', value: 'blockQueued' },
  { label: 'Reject the dependent operations', value: 'rejectDependents' },
  { label: 'Retry without the dependency', value: 'retryWithoutDependency' }
]

interface PhaseMeta {
  label: string
  color: 'gray' | 'amber' | 'blue' | 'emerald' | 'red'
  icon: string
}

const PHASE_META: Record<DesktopStationPhase, PhaseMeta> = {
  standalone: { label: 'Local only', color: 'gray', icon: 'i-heroicons-computer-desktop' },
  offline: { label: 'Offline', color: 'amber', icon: 'i-heroicons-cloud' },
  syncing: { label: 'Syncing', color: 'blue', icon: 'i-heroicons-arrow-path' },
  upToDate: { label: 'Up to date', color: 'emerald', icon: 'i-heroicons-check-circle' },
  authRequired: { label: 'Server sign-in required', color: 'amber', icon: 'i-heroicons-key' },
  conflict: { label: 'Conflicts need review', color: 'red', icon: 'i-heroicons-exclamation-triangle' },
  error: { label: 'Sync error', color: 'red', icon: 'i-heroicons-exclamation-circle' },
  blocked: { label: 'Blocked', color: 'red', icon: 'i-heroicons-no-symbol' }
}

const phaseMeta = computed(() => PHASE_META[status.value?.phase ?? 'standalone'])

const statusSummary = computed(() => {
  const current = status.value
  if (!current) return 'Reading station status…'
  if (!current.isPaired) return 'Local station only. Pair with a server to synchronize this profile.'
  const server = current.serverName || current.serverUrl || 'a server'
  return `Paired with ${server} · last sync ${formatTimestamp(current.lastSyncAt)}`
})

const pendingLabel = computed(() => {
  const count = status.value?.pendingCount ?? 0
  return count === 1 ? '1 pending operation' : `${count} pending operations`
})

const conflictLabel = computed(() => {
  const count = status.value?.conflictCount ?? 0
  return count === 1 ? '1 conflict' : `${count} conflicts`
})

const selectedAction = computed(
  () => preview.value?.actions.find(action => action.id === selectedChoice.value) ?? null
)

const destructiveChoice = computed(() => selectedAction.value?.isDestructive === true)

const confirmBlocked = computed(() => {
  if (busy.value || selectedChoice.value === null) return true
  if (!destructiveChoice.value) return false
  return receipt.value === null || confirmation.value.trim() !== 'REPLACE'
})

const credentialsIncomplete = computed(
  () => serverAddress.value.trim().length === 0 ||
    email.value.trim().length === 0 ||
    password.value.length === 0
)

const liveMessage = computed(() => {
  if (busy.value && busyLabel.value) return busyLabel.value
  const current = status.value
  if (!current) return 'Reading station status.'
  return `${phaseMeta.value.label}. ${pendingLabel.value}, ${conflictLabel.value}.`
})

function formatTimestamp(value: string | null): string {
  if (!value) return 'never'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(parsed)
}

function formatJson(value: unknown): string {
  if (value === null || value === undefined) return '—'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function shortStationId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value
}

function resetPairingDraft(): void {
  password.value = ''
  confirmation.value = ''
  receipt.value = null
  selectedChoice.value = null
}

function openPairing(): void {
  expanded.value = true
  pairingOpen.value = true
  serverAddress.value = status.value?.serverUrl ?? ''
}

function closePairing(): void {
  pairingOpen.value = false
  resetPairingDraft()
}

async function submitPreview(): Promise<void> {
  if (busy.value || credentialsIncomplete.value) return
  try {
    await station.previewConnection({
      serverAddress: serverAddress.value.trim(),
      email: email.value.trim(),
      password: password.value
    })
    // Success clears the password; a failure keeps it so the user can retry.
    password.value = ''
  } catch {
    // The failure keeps the typed password so the user can correct and retry.
  }
}

async function cancelPreview(): Promise<void> {
  try {
    await station.cancelConnectionPreview()
  } catch {
    // The preview stays visible so the backend error remains actionable.
    return
  }
  closePairing()
}

async function confirmPairing(): Promise<void> {
  if (confirmBlocked.value || selectedChoice.value === null) return
  try {
    await station.confirmConnection({
      choice: selectedChoice.value,
      confirmation: confirmation.value.trim(),
      exportReceipt: destructiveChoice.value ? receipt.value : null
    })
    closePairing()
  } catch {
    // Keep the preview, the chosen action and the typed confirmation intact.
  }
}

async function exportSnapshot(): Promise<void> {
  if (busy.value) return
  try {
    const result = await station.exportSnapshot()
    receipt.value = result.receipt
  } catch {
    // A failed save leaves no usable receipt for a destructive confirmation.
    receipt.value = null
  }
}

async function synchronize(): Promise<void> {
  try {
    await station.synchronize()
  } catch {
    // Shared error alert shows the backend reason.
  }
}

async function refreshStation(): Promise<void> {
  await station.refresh()
}

function requestDisconnect(): void {
  if (busy.value) return
  if (!disconnectArmed.value) {
    disconnectArmed.value = true
    if (disconnectTimer) clearTimeout(disconnectTimer)
    disconnectTimer = setTimeout(() => {
      disconnectArmed.value = false
    }, 6000)
    return
  }
  disconnectArmed.value = false
  if (disconnectTimer) clearTimeout(disconnectTimer)
  void (async () => {
    try {
      await station.disconnect()
    } catch {
      // Shared error alert shows the backend reason.
    }
  })()
}

async function signOut(): Promise<void> {
  if (busy.value) return
  try {
    await station.signOut()
  } catch {
    // Shared error alert shows the backend reason.
  }
}

async function applyConflict(entry: DesktopConflictEntry): Promise<void> {
  const resolution = resolutionDraft[entry.opId]
  const dependents = dependentsDraft[entry.opId]
  if (busy.value || !resolution || !dependents) return
  try {
    await station.resolveConflict({ opId: entry.opId, resolution, dependents })
    delete resolutionDraft[entry.opId]
    delete dependentsDraft[entry.opId]
  } catch {
    // The conflict row keeps the chosen policy so the user can retry.
  }
}

async function acknowledgeRejected(entry: DesktopOutboxEntry): Promise<void> {
  const dependents = ackDraft[entry.opId]
  if (busy.value || !dependents) return
  try {
    await station.acknowledgeRejected({ opId: entry.opId, dependents })
    delete ackDraft[entry.opId]
  } catch {
    // Keep the selected dependent policy for retry.
  }
}

function isRejected(entry: DesktopOutboxEntry): boolean {
  return entry.status === 'rejected'
}

watch(preview, (next: DesktopPairingPreview | null) => {
  if (!next) return
  selectedChoice.value = null
  confirmation.value = ''
  receipt.value = null
})

watch(conflicts, rows => {
  for (const row of rows) {
    if (!(row.opId in resolutionDraft)) resolutionDraft[row.opId] = ''
    if (!(row.opId in dependentsDraft)) dependentsDraft[row.opId] = ''
  }
}, { immediate: true })

watch(outbox, rows => {
  for (const row of rows) {
    if (isRejected(row) && !(row.opId in ackDraft)) ackDraft[row.opId] = ''
  }
}, { immediate: true })

onMounted(() => {
  void station.start()
})

onBeforeUnmount(() => {
  if (disconnectTimer) clearTimeout(disconnectTimer)
  station.stop()
})
</script>

<template>
  <section aria-label="Station sync" class="max-w-7xl mx-auto px-4 sm:px-6 pt-4">
    <UCard :ui="{ body: { padding: 'p-4 sm:p-5' } }">
      <p class="sr-only" aria-live="polite">{{ liveMessage }}</p>

      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="text-base font-semibold text-white flex items-center gap-2">
            <UIcon name="i-heroicons-arrows-right-left" class="w-5 h-5 text-zinc-400" aria-hidden="true" />
            Station sync
          </h2>
          <p class="text-xs text-zinc-400 mt-1 break-words">{{ statusSummary }}</p>
          <p v-if="status" class="text-xs text-zinc-500 mt-1">
            Station
            <span class="font-mono" :title="status.stationId">{{ shortStationId(status.stationId) }}</span>
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <UBadge :color="phaseMeta.color" variant="subtle">
            <UIcon :name="phaseMeta.icon" class="w-3.5 h-3.5 mr-1" aria-hidden="true" />
            {{ phaseMeta.label }}
          </UBadge>
          <UBadge color="gray" variant="subtle">{{ pendingLabel }}</UBadge>
          <UBadge :color="(status?.conflictCount ?? 0) > 0 ? 'red' : 'gray'" variant="subtle">
            {{ conflictLabel }}
          </UBadge>
          <UButton
            :label="expanded ? 'Hide details' : 'Show details'"
            color="gray"
            variant="ghost"
            size="sm"
            class="min-h-[44px]"
            :aria-expanded="expanded"
            aria-controls="station-sync-details"
            @click="expanded = !expanded"
          />
        </div>
      </div>

      <UAlert
        v-if="!isSupported"
        class="mt-4"
        color="red"
        variant="soft"
        icon="i-heroicons-exclamation-triangle"
        title="Station sync unavailable"
        :description="STATION_BRIDGE_UNAVAILABLE"
      />

      <template v-else>
        <UAlert
          v-if="error"
          class="mt-4"
          color="red"
          variant="soft"
          icon="i-heroicons-exclamation-triangle"
          title="Station request failed"
          :description="error"
        >
          <template #actions>
            <UButton
              label="Refresh status"
              color="red"
              variant="soft"
              size="sm"
              :disabled="busy"
              class="min-h-[44px]"
              @click="refreshStation"
            />
          </template>
        </UAlert>

        <div v-if="!status" class="mt-4 flex items-center gap-2 text-sm text-zinc-400" role="status">
          <UIcon name="i-heroicons-arrow-path" class="w-4 h-4 animate-spin" aria-hidden="true" />
          Reading station status…
        </div>

        <template v-else>
          <UAlert
            v-if="status.phase === 'authRequired'"
            class="mt-4"
            color="amber"
            variant="soft"
            icon="i-heroicons-key"
            title="Server sign-in required"
            description="Local finance keeps working. Pending operations stay queued until you reconnect to the server."
          >
            <template #actions>
              <UButton
                label="Reconnect…"
                color="amber"
                variant="soft"
                size="sm"
                class="min-h-[44px]"
                :disabled="busy"
                @click="openPairing"
              />
            </template>
          </UAlert>

          <p v-if="status.detail" class="mt-3 text-sm text-zinc-300 break-words">{{ status.detail }}</p>

          <p v-if="status.phase === 'syncing'" class="mt-2 text-xs text-blue-300" aria-live="polite">
            Synchronization in progress. {{ pendingLabel }} remain queued.
          </p>

          <div v-if="status.isPaired" class="mt-4 flex flex-wrap items-center gap-2">
            <UButton
              label="Sync now"
              icon="i-heroicons-arrow-path"
              color="primary"
              :loading="busyAction === 'synchronize'"
              :disabled="busy || status.phase === 'syncing'"
              class="min-h-[44px]"
              @click="synchronize"
            />
            <UButton
              label="Refresh status"
              icon="i-heroicons-arrow-uturn-right"
              color="gray"
              variant="soft"
              :disabled="busy"
              class="min-h-[44px]"
              @click="refreshStation"
            />
            <UButton
              :label="disconnectArmed ? 'Confirm disconnect' : 'Disconnect'"
              icon="i-heroicons-link-slash"
              :color="disconnectArmed ? 'red' : 'gray'"
              :variant="disconnectArmed ? 'solid' : 'soft'"
              :disabled="busy"
              class="min-h-[44px]"
              @click="requestDisconnect"
            />
            <UButton
              label="Sign out of server"
              icon="i-heroicons-arrow-right-on-rectangle"
              color="gray"
              variant="soft"
              :loading="busyAction === 'signOut'"
              :disabled="busy"
              class="min-h-[44px]"
              @click="signOut"
            />
          </div>

          <p v-if="disconnectArmed" class="mt-2 text-xs text-amber-300" aria-live="polite">
            Disconnecting stops synchronization; local finance stays on this device until you pair again.
          </p>

          <div class="mt-4 flex flex-wrap items-center gap-2">
            <UButton
              :label="status.isPaired ? 'Change server…' : 'Pair with a server…'"
              icon="i-heroicons-server"
              color="gray"
              variant="soft"
              :disabled="busy || preview !== null"
              class="min-h-[44px]"
              @click="openPairing"
            />
          </div>

          <UAlert
            v-if="queueError"
            class="mt-3"
            color="amber"
            variant="soft"
            icon="i-heroicons-exclamation-circle"
            title="Queue details could not be read"
            :description="queueError"
          />

          <UAlert
            v-if="notice"
            class="mt-3"
            color="blue"
            variant="soft"
            icon="i-heroicons-information-circle"
            title="Station notice"
            :description="notice"
          />

          <div id="station-sync-details" v-show="expanded" class="mt-6 space-y-6">
            <section v-if="pairingOpen && !preview" class="space-y-4">
              <h3 class="text-sm font-semibold text-white">Connect to a server</h3>
              <div class="grid gap-4 sm:grid-cols-2">
                <UFormGroup label="Server address" name="station-server-address">
                  <UInput
                    v-model="serverAddress"
                    type="url"
                    autocomplete="url"
                    placeholder="https://obol.example.com"
                    class="min-h-[44px]"
                    :disabled="busy"
                  />
                </UFormGroup>
                <UFormGroup label="Account email" name="station-email">
                  <UInput
                    v-model="email"
                    type="email"
                    autocomplete="username"
                    class="min-h-[44px]"
                    :disabled="busy"
                  />
                </UFormGroup>
                <UFormGroup label="Password" name="station-password">
                  <UInput
                    v-model="password"
                    type="password"
                    autocomplete="current-password"
                    class="min-h-[44px]"
                    :disabled="busy"
                  />
                  <p class="mt-1 text-xs text-zinc-500">
                    Used only for this connection check. It is never stored on the device.
                  </p>
                </UFormGroup>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <UButton
                  label="Check server"
                  color="primary"
                  :loading="busyAction === 'previewConnection'"
                  :disabled="busy || credentialsIncomplete"
                  class="min-h-[44px]"
                  @click="submitPreview"
                />
                <UButton
                  label="Cancel"
                  color="gray"
                  variant="ghost"
                  :disabled="busy"
                  class="min-h-[44px]"
                  @click="closePairing"
                />
              </div>
            </section>

            <section v-if="preview" class="space-y-4 rounded-lg border border-zinc-800 p-4">
              <h3 class="text-sm font-semibold text-white">Review this connection</h3>
              <dl class="grid gap-3 sm:grid-cols-2 text-sm">
                <div>
                  <dt class="text-xs uppercase tracking-wide text-zinc-500">Server</dt>
                  <dd class="text-zinc-200 break-words">{{ preview.serverName }}</dd>
                </div>
                <div>
                  <dt class="text-xs uppercase tracking-wide text-zinc-500">Address</dt>
                  <dd class="text-zinc-200 break-all">{{ preview.serverAddress }}</dd>
                </div>
                <div>
                  <dt class="text-xs uppercase tracking-wide text-zinc-500">Server data</dt>
                  <dd class="text-zinc-200">{{ preview.hasServerData ? 'This server already has financial data' : 'Empty server' }}</dd>
                </div>
                <div>
                  <dt class="text-xs uppercase tracking-wide text-zinc-500">This device</dt>
                  <dd class="text-zinc-200">
                    {{ preview.localEntityCount }} records · {{ preview.localOperationCount }} operations
                  </dd>
                </div>
              </dl>

              <p v-if="preview.isRePairing" class="text-xs text-amber-300">
                This device was paired before. Its frozen queue is kept only for the same server instance.
              </p>

              <ul v-if="preview.warnings.length > 0" class="space-y-1">
                <li v-for="warning in preview.warnings" :key="warning" class="text-sm text-amber-300 flex gap-2">
                  <UIcon name="i-heroicons-exclamation-triangle" class="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                  <span class="break-words">{{ warning }}</span>
                </li>
              </ul>

              <fieldset class="space-y-2">
                <legend class="text-xs uppercase tracking-wide text-zinc-500">Allowed actions</legend>
                <UButton
                  v-for="action in preview.actions"
                  :key="action.id"
                  block
                  :label="action.label"
                  :icon="action.isDestructive ? 'i-heroicons-exclamation-triangle' : 'i-heroicons-check'"
                  :color="selectedChoice === action.id ? (action.isDestructive ? 'red' : 'primary') : 'gray'"
                  :variant="selectedChoice === action.id ? 'solid' : 'soft'"
                  :aria-pressed="selectedChoice === action.id"
                  :disabled="busy"
                  class="min-h-[44px] justify-start text-left"
                  @click="selectedChoice = action.id"
                />
              </fieldset>

              <div v-if="destructiveChoice" class="space-y-3 rounded-lg border border-red-900/60 bg-red-950/20 p-3">
                <p class="text-sm text-red-200">
                  This action replaces local financial data. Export a current snapshot and type REPLACE to confirm.
                </p>
                <UButton
                  label="Export current data"
                  icon="i-heroicons-arrow-down-tray"
                  color="red"
                  variant="soft"
                  :loading="busyAction === 'exportSnapshot'"
                  :disabled="busy"
                  class="min-h-[44px]"
                  @click="exportSnapshot"
                />
                <p class="text-xs" :class="receipt ? 'text-emerald-300' : 'text-zinc-400'" aria-live="polite">
                  {{ receipt ? 'A completed export receipt is ready for this confirmation.' : 'No completed export yet. A started download does not count.' }}
                </p>
                <UFormGroup label="Type REPLACE to confirm" name="station-confirmation">
                  <UInput
                    v-model="confirmation"
                    type="text"
                    autocomplete="off"
                    placeholder="REPLACE"
                    class="min-h-[44px]"
                    :disabled="busy"
                  />
                </UFormGroup>
              </div>

              <div class="flex flex-wrap items-center gap-2">
                <UButton
                  label="Confirm connection"
                  color="primary"
                  :loading="busyAction === 'confirmConnection'"
                  :disabled="confirmBlocked"
                  class="min-h-[44px]"
                  @click="confirmPairing"
                />
                <UButton
                  label="Cancel preview"
                  color="gray"
                  variant="ghost"
                  :disabled="busy"
                  class="min-h-[44px]"
                  @click="cancelPreview"
                />
              </div>
            </section>

            <section class="space-y-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <h3 class="text-sm font-semibold text-white">Snapshot export</h3>
                <span class="text-xs text-zinc-500">
                  {{ lastExport === null ? 'No export attempted in this session.' : lastExport.saved ? 'Last export saved.' : 'Last export was canceled or failed.' }}
                </span>
              </div>
              <UButton
                label="Export snapshot"
                icon="i-heroicons-arrow-down-tray"
                color="gray"
                variant="soft"
                :loading="busyAction === 'exportSnapshot'"
                :disabled="busy"
                class="min-h-[44px]"
                @click="exportSnapshot"
              />
            </section>

            <section class="space-y-3">
              <h3 class="text-sm font-semibold text-white">Pending operations</h3>
              <p v-if="outbox.length === 0" class="text-sm text-zinc-500">No pending operations.</p>
              <ul v-else class="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
                <li v-for="entry in outbox" :key="entry.opId" class="p-3 space-y-2">
                  <div class="flex flex-wrap items-center gap-2">
                    <UBadge color="gray" variant="subtle">{{ entry.type }}</UBadge>
                    <span class="text-sm text-zinc-200 break-all">{{ entry.entityType }} · {{ entry.entityId }}</span>
                    <UBadge :color="isRejected(entry) ? 'red' : 'amber'" variant="subtle">
                      {{ isRejected(entry) ? 'Rejected' : entry.status }}
                    </UBadge>
                    <span class="text-xs text-zinc-500">{{ entry.attempts }} attempt(s)</span>
                  </div>
                  <p class="text-xs text-zinc-500 break-all">
                    <span class="font-mono">{{ entry.opId }}</span> · effective {{ formatTimestamp(entry.effectiveAt) }} · created {{ formatTimestamp(entry.clientCreatedAt) }}
                  </p>
                  <p v-if="entry.lastError" class="text-sm text-red-300 break-words">{{ entry.lastError }}</p>
                  <p v-else class="text-sm text-zinc-400">Waiting for a sync cycle.</p>
                  <p v-if="entry.dependsOn.length > 0" class="text-xs text-zinc-500 break-all">
                    Depends on: {{ entry.dependsOn.join(', ') }}
                  </p>
                  <details class="text-xs text-zinc-400">
                    <summary class="cursor-pointer select-none min-h-[44px] flex items-center">Operation detail</summary>
                    <div class="mt-2 space-y-2">
                      <p class="text-zinc-500">Intent</p>
                      <pre class="whitespace-pre-wrap break-words bg-zinc-900 rounded p-2">{{ formatJson(entry.payload) }}</pre>
                      <p class="text-zinc-500">Base revisions</p>
                      <pre class="whitespace-pre-wrap break-words bg-zinc-900 rounded p-2">{{ formatJson(entry.baseRevisions) }}</pre>
                      <p class="text-zinc-500">Before snapshots</p>
                      <pre class="whitespace-pre-wrap break-words bg-zinc-900 rounded p-2">{{ formatJson(entry.beforeSnapshots) }}</pre>
                    </div>
                  </details>
                  <div v-if="isRejected(entry)" class="flex flex-wrap items-end gap-2">
                    <UFormGroup label="Dependent operations" :name="`station-ack-dependents-${entry.opId}`" class="min-w-[220px]">
                      <USelect
                        v-model="ackDraft[entry.opId]"
                        :options="DEPENDENTS_OPTIONS"
                        placeholder="Choose a policy"
                        class="min-h-[44px]"
                        :disabled="busy"
                      />
                    </UFormGroup>
                    <UButton
                      label="Acknowledge rejection"
                      color="red"
                      variant="soft"
                      :loading="busyAction === 'acknowledgeRejected'"
                      :disabled="busy || !ackDraft[entry.opId]"
                      class="min-h-[44px]"
                      @click="acknowledgeRejected(entry)"
                    />
                  </div>
                </li>
              </ul>
            </section>

            <section class="space-y-3">
              <h3 class="text-sm font-semibold text-white">Conflicts</h3>
              <p v-if="conflicts.length === 0" class="text-sm text-zinc-500">No conflicts.</p>
              <ul v-else class="space-y-3">
                <li
                  v-for="entry in conflicts"
                  :key="entry.opId"
                  class="rounded-lg border border-zinc-800 p-3 space-y-3"
                >
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="text-sm text-zinc-200 break-all">{{ entry.entityType }} · {{ entry.entityId }}</span>
                    <UBadge color="red" variant="subtle">Conflict</UBadge>
                  </div>
                  <p class="text-sm text-zinc-300 break-words">{{ entry.message }}</p>
                  <p class="text-xs text-zinc-500">
                    Your base revision {{ entry.baseRevision === null ? 'none' : entry.baseRevision }} ·
                    server revision {{ entry.currentRevision }}
                  </p>
                  <div class="grid gap-2 sm:grid-cols-2">
                    <div>
                      <p class="text-xs uppercase tracking-wide text-zinc-500">Your intent</p>
                      <pre class="mt-1 whitespace-pre-wrap break-words bg-zinc-900 rounded p-2 text-xs text-zinc-300">{{ formatJson(entry.localIntent) }}</pre>
                    </div>
                    <div>
                      <p class="text-xs uppercase tracking-wide text-zinc-500">Current server record</p>
                      <pre class="mt-1 whitespace-pre-wrap break-words bg-zinc-900 rounded p-2 text-xs text-zinc-300">{{ formatJson(entry.currentRecord) }}</pre>
                    </div>
                  </div>
                  <div class="grid gap-2 sm:grid-cols-2">
                    <UFormGroup label="Resolution" :name="`station-resolution-${entry.opId}`">
                      <USelect
                        v-model="resolutionDraft[entry.opId]"
                        :options="RESOLUTION_OPTIONS"
                        placeholder="Choose a resolution"
                        class="min-h-[44px]"
                        :disabled="busy"
                      />
                    </UFormGroup>
                    <UFormGroup label="Dependent operations" :name="`station-dependents-${entry.opId}`">
                      <USelect
                        v-model="dependentsDraft[entry.opId]"
                        :options="DEPENDENTS_OPTIONS"
                        placeholder="Choose a policy"
                        class="min-h-[44px]"
                        :disabled="busy"
                      />
                    </UFormGroup>
                  </div>
                  <UButton
                    label="Apply resolution"
                    color="primary"
                    :loading="busyAction === 'resolveConflict'"
                    :disabled="busy || !resolutionDraft[entry.opId] || !dependentsDraft[entry.opId]"
                    class="min-h-[44px]"
                    @click="applyConflict(entry)"
                  />
                </li>
              </ul>
            </section>
          </div>
        </template>
      </template>
    </UCard>
  </section>
</template>
