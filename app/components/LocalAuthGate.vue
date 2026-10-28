<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type {
  LocalAccountSummary,
  LocalAuthSetupRequest,
  LocalAuthUnlockRequest
} from '../../desktop/electrobun/shared-rpc'

type AuthMode = 'checking' | 'setup' | 'unlock' | 'error'

const props = defineProps<{
  mode: AuthMode
  account: LocalAccountSummary | null
  busy: boolean
  message: string
}>()

const emit = defineEmits<{
  setup: [request: LocalAuthSetupRequest]
  unlock: [request: LocalAuthUnlockRequest]
  retry: []
}>()

const isSetup = computed(() => props.mode === 'setup')
const name = ref('')
const email = ref(props.account?.email ?? '')
const password = ref('')
const confirmation = ref('')
const validationMessage = ref('')

watch(() => props.account?.email, value => {
  if (value) email.value = value
})

function submit(): void {
  validationMessage.value = ''
  const normalizedEmail = email.value.trim().toLowerCase()
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    validationMessage.value = 'Enter a valid email address.'
    return
  }
  if (password.value.length < 8) {
    validationMessage.value = 'Password must be at least 8 characters.'
    return
  }
  if (isSetup.value) {
    if (!name.value.trim()) {
      validationMessage.value = 'Enter your name.'
      return
    }
    if (password.value !== confirmation.value) {
      validationMessage.value = 'Passwords do not match.'
      return
    }
    emit('setup', { name: name.value.trim(), email: normalizedEmail, password: password.value })
    return
  }
  emit('unlock', { email: normalizedEmail, password: password.value })
}
</script>

<template>
  <main class="min-h-screen flex items-center justify-center bg-zinc-950 px-4 py-10">
    <UCard class="w-full max-w-md" :ui="{ background: 'bg-zinc-900', ring: 'ring-1 ring-zinc-800', body: { padding: 'p-6 sm:p-8' } }">
      <div class="space-y-6">
        <header class="space-y-2 text-center">
          <p class="text-emerald-400 text-sm font-semibold tracking-wide">OBOL</p>
          <h1 class="text-2xl font-semibold text-white">
            {{ mode === 'checking' ? 'Opening Obol' : isSetup ? 'Set up this Obol profile' : mode === 'error' ? 'Obol could not unlock' : 'Unlock Obol' }}
          </h1>
          <p class="text-sm text-zinc-400">
            {{ isSetup
              ? 'Create the local credentials you will use each time you open Obol.'
              : mode === 'checking'
                ? 'Checking this local profile…'
                : 'Sign in with the local account for this Mac.' }}
          </p>
        </header>

        <div v-if="mode === 'checking'" class="flex justify-center py-4" aria-label="Loading">
          <UIcon name="i-heroicons-arrow-path" class="h-6 w-6 animate-spin text-emerald-400" />
        </div>

        <div v-else-if="mode === 'error'" class="space-y-4">
          <p class="rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-200" role="alert">
            {{ message }}
          </p>
          <UButton block color="primary" @click="emit('retry')">Try again</UButton>
        </div>

        <form v-else class="space-y-4" @submit.prevent="submit">
          <UFormGroup v-if="isSetup" label="Name">
            <UInput v-model="name" autocomplete="name" maxlength="80" required autofocus />
          </UFormGroup>

          <UFormGroup label="Email">
            <UInput v-model="email" type="email" autocomplete="username" maxlength="254" required :disabled="!isSetup" />
          </UFormGroup>

          <UFormGroup label="Password">
            <UInput v-model="password" type="password" :autocomplete="isSetup ? 'new-password' : 'current-password'" :autofocus="!isSetup" minlength="8" maxlength="256" required />
          </UFormGroup>

          <UFormGroup v-if="isSetup" label="Confirm password">
            <UInput v-model="confirmation" type="password" autocomplete="new-password" minlength="8" maxlength="256" required />
          </UFormGroup>

          <p v-if="validationMessage" class="text-sm text-red-300" role="alert">
            {{ validationMessage }}
          </p>
          <p v-if="message" class="text-sm text-red-300" role="alert">
            {{ message }}
          </p>

          <UButton block type="submit" color="primary" :loading="busy">
            {{ isSetup ? 'Create local account' : 'Unlock' }}
          </UButton>
        </form>

        <p class="text-xs leading-relaxed text-zinc-500">
          This login gates the Obol app on this Mac. PocketBase data files are not encrypted by this password; use macOS FileVault to protect data at rest.
        </p>
        <p v-if="isSetup" class="text-xs leading-relaxed text-zinc-500">
          Existing 0.1.0 ledger data is preserved. Creating this account repairs PocketBase access without deleting transactions.
        </p>
      </div>
    </UCard>
  </main>
</template>
