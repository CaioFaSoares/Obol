<script setup lang="ts">
import { computed } from 'vue'
import type { DesktopUpdaterState } from '../../desktop/electrobun/shared-rpc'

const props = defineProps<{
  state: DesktopUpdaterState | null
}>()

const emit = defineEmits<{
  check: []
  install: []
}>()

// The bridge forwards the Electrobun core status vocabulary (open-ended),
// so we decide outcomes from the state flags
// `{updateAvailable, updateReady, error, progress}` instead of raw statuses.
// Between the install request being accepted and the app restarting,
// the update is being applied transactionally and must not be retriggered.
const APPLYING_STATUSES = new Set(['applying', 'complete', 'launching-new-version', 'extracting', 'replacing-app'])
const GENERIC_ERROR_MESSAGE = 'Não foi possível atualizar o Obol.'

const busy = computed(() => {
  const state = props.state
  if (!state) return false
  if (state.status === 'checking') return !state.error
  return Boolean(state.updateAvailable && !state.updateReady && !state.error)
})

const visible = computed(() => {
  const state = props.state
  if (!state) return false
  if (state.error) return true
  if (state.updateReady) return true
  if (state.updateAvailable) return true
  return Boolean(state.status && APPLYING_STATUSES.has(state.status))
})

const progress = computed(() => {
  const value = props.state?.progress
  if (typeof value !== 'number' || Number.isNaN(value)) return null
  return Math.min(100, Math.max(0, value))
})

const applying = computed(() => {
  const status = props.state?.status
  return typeof status === 'string' && APPLYING_STATUSES.has(status)
})

const message = computed(() => {
  const state = props.state
  if (!state) return ''
  if (state.error) {
    return state.error || state.message || GENERIC_ERROR_MESSAGE
  }
  if (state.updateReady) {
    return 'Atualização pronta para instalação.'
  }
  if (state.status === 'checking') {
    return 'Verificando atualizações…'
  }
  if (applying.value) {
    return 'Reiniciando o Obol para concluir a atualização…'
  }
  if (state.updateAvailable || state.status === 'downloading' || state.status === 'update-available') {
    return 'Baixando atualização…'
  }
  return state.message || 'Verificando atualizações…'
})

const toneClasses = computed(() => {
  const state = props.state
  if (state?.error) {
    return 'border-red-900 bg-red-950/40 text-red-200'
  }
  if (state?.updateReady) {
    return 'border-emerald-800 bg-emerald-950/40 text-emerald-100'
  }
  return 'border-zinc-800 bg-zinc-900/80 text-zinc-300'
})

const icon = computed(() => {
  const state = props.state
  if (state?.error) return 'i-heroicons-exclamation-triangle'
  if (state?.updateReady) return 'i-heroicons-arrow-down-tray'
  return 'i-heroicons-arrow-path'
})

function install (): void {
  emit('install')
}

function retry (): void {
  emit('check')
}
</script>

<template>
  <div v-if="visible" class="max-w-7xl mx-auto px-4 sm:px-6 pt-3">
    <div
      class="flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm"
      :class="toneClasses"
      aria-label="Atualização do Obol"
      role="status"
      :aria-live="state?.error ? 'assertive' : 'polite'"
    >
      <UIcon
        :name="icon"
        class="h-5 w-5 shrink-0"
        :class="busy ? 'animate-spin' : ''"
        aria-hidden="true"
      />

      <div class="flex-1 min-w-0">
        <p class="font-medium">
          {{ message }}
          <span
            v-if="state?.availableVersion"
            class="font-normal"
            :class="state.error ? 'text-red-300' : state.updateReady ? 'text-emerald-300' : 'text-zinc-400'"
          >— versão {{ state.availableVersion }}</span>
        </p>
      </div>

      <div
        v-if="progress !== null && busy"
        class="w-full sm:w-48"
        role="progressbar"
        :aria-valuenow="Math.round(progress)"
        aria-valuemin="0"
        aria-valuemax="100"
        aria-label="Progresso do download da atualização"
      >
        <div class="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
          <div
            class="h-full rounded-full bg-emerald-400 transition-all"
            :style="{ width: `${progress}%` }"
          />
        </div>
      </div>

      <UButton
        v-if="state?.updateReady"
        color="primary"
        size="sm"
        icon="i-heroicons-arrow-path"
        :disabled="applying"
        aria-label="Reiniciar o Obol agora para instalar a atualização"
        @click="install"
      >
        Reiniciar para atualizar
      </UButton>

      <UButton
        v-else-if="state?.error"
        color="primary"
        size="sm"
        variant="outline"
        aria-label="Tentar atualizar o Obol novamente"
        @click="retry"
      >
        Tentar novamente
      </UButton>
    </div>
  </div>
</template>
