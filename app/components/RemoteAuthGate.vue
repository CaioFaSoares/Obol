<script setup lang="ts">
import { ref, watch } from 'vue'
import type {
  RemoteAuthRequest,
  RemoteResetSubmission,
  RemoteSessionListItem,
  RemoteSetupSubmission,
  RemoteStep
} from '../composables/useRemoteSession'

const props = defineProps<{
  step: RemoteStep
  busy: boolean
  message: string
  /** Full endpoint URL of the currently selected server, when one is configured. */
  serverUrl: string | null
  serverName: string | null
  sessions: RemoteSessionListItem[]
  cooldown: number
  /** Password reset token extracted from an email link, when present. */
  resetToken: string
  smtpConfigured: boolean | null
  /** Desktop only: the Mac's local profile unlock can always take over again. */
  allowLocalSwitch?: boolean
  /** Bearer clients can point at another deployment; the hosted web cannot. */
  allowServerChange?: boolean
  /** Renders only the passive remote-session badge while the app is unlocked. */
  statusBadge?: boolean
  /** Renders the session manager over an already-visible dashboard. */
  overlay?: boolean
}>()

const emit = defineEmits<{
  'choose-server': [url: string]
  setup: [submission: RemoteSetupSubmission]
  login: [request: RemoteAuthRequest]
  'show-reset-request': []
  'reset-request-submit': [email: string]
  'reset-confirm': [submission: RemoteResetSubmission]
  logout: []
  revoke: [id: string]
  'back-to-active': []
  'change-server': []
  'switch-local': []
  retry: []
  manage: []
}>()

const serverUrlInput = ref('')
const setupToken = ref('')
const email = ref('')
const password = ref('')
const confirmation = ref('')
const validationMessage = ref('')

watch(
  () => props.resetToken,
  value => {
    if (value) setupToken.value = value
  },
  { immediate: true }
)

function isConfirmationStep(): boolean {
  return props.step === 'setup' || props.step === 'reset-confirm'
}

function submitServerUrl(): void {
  validationMessage.value = ''
  emit('choose-server', serverUrlInput.value)
}

function submitSetup(): void {
  validationMessage.value = ''
  const normalizedEmail = email.value.trim().toLowerCase()
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    validationMessage.value = 'Enter a valid email address.'
    return
  }
  if (setupToken.value.trim().length === 0) {
    validationMessage.value = 'Enter the one-time setup token from the server logs.'
    return
  }
  if (password.value.length < 10) {
    validationMessage.value = 'Password must be at least 10 characters.'
    return
  }
  if (password.value !== confirmation.value) {
    validationMessage.value = 'Passwords do not match.'
    return
  }
  emit('setup', {
    setupToken: setupToken.value.trim(),
    email: normalizedEmail,
    password: password.value
  })
}

function submitLogin(): void {
  validationMessage.value = ''
  const normalizedEmail = email.value.trim().toLowerCase()
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    validationMessage.value = 'Enter a valid email address.'
    return
  }
  if (password.value.length === 0) {
    validationMessage.value = 'Enter your password.'
    return
  }
  emit('login', { email: normalizedEmail, password: password.value })
}

function submitResetRequest(): void {
  validationMessage.value = ''
  const normalizedEmail = email.value.trim().toLowerCase()
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    validationMessage.value = 'Enter a valid email address.'
    return
  }
  emit('reset-request-submit', normalizedEmail)
}

function submitResetConfirm(): void {
  validationMessage.value = ''
  if (setupToken.value.trim().length === 0) {
    validationMessage.value = 'Paste the reset token from the email link.'
    return
  }
  if (password.value.length < 10) {
    validationMessage.value = 'Password must be at least 10 characters.'
    return
  }
  if (password.value !== confirmation.value) {
    validationMessage.value = 'Passwords do not match.'
    return
  }
  emit('reset-confirm', { token: setupToken.value.trim(), password: password.value })
}

function typeName(): string {
  return props.serverName ?? props.serverUrl ?? 'remote server'
}

function refreshOnSubmit(): void {
  if (props.step === 'server-url') submitServerUrl()
  else if (props.step === 'setup') submitSetup()
  else if (props.step === 'login') submitLogin()
  else if (props.step === 'reset-request') submitResetRequest()
  else if (props.step === 'reset-confirm') submitResetConfirm()
}
</script>

<template>
  <!-- Passive badge shown while a remote session is active. -->
  <div
    v-if="statusBadge"
    class="fixed bottom-3 right-3 z-50 flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/90 px-3 py-1.5 text-xs text-zinc-300 shadow-lg backdrop-blur"
  >
    <UIcon name="i-heroicons-server-stack" class="h-3.5 w-3.5 text-emerald-400" />
    <span class="font-medium text-zinc-100">{{ typeName() }}</span>
    <button
      class="text-zinc-400 transition hover:text-emerald-400"
      title="Session details and sign out"
      @click="emit('manage')"
    >
      <UIcon name="i-heroicons-user-circle" class="h-4 w-4" />
    </button>
  </div>

  <main
    v-else
    class="flex items-center justify-center px-4 py-10"
    :class="overlay ? 'fixed inset-0 z-50 bg-zinc-950/80 backdrop-blur-sm' : 'min-h-screen bg-zinc-950'"
  >
    <UCard
      class="w-full max-w-md"
      :ui="{ background: 'bg-zinc-900', ring: 'ring-1 ring-zinc-800', body: { padding: 'p-6 sm:p-8' } }"
    >
      <div class="space-y-6">
        <header class="space-y-2 text-center">
          <p class="text-emerald-400 text-sm font-semibold tracking-wide">OBOL</p>
          <h1 class="text-2xl font-semibold text-white">
            {{ step === 'checking'
              ? 'Connecting to the server'
              : step === 'server-url'
                ? 'Connect to your Obol server'
                : step === 'setup'
                  ? 'Set up the server owner'
                  : step === 'login'
                    ? `Sign in to ${typeName()}`
                    : step === 'reset-request' || step === 'reset-confirm'
                      ? 'Reset your password'
                      : step === 'sessions'
                        ? 'Active sessions'
                        : 'Obol could not connect' }}
          </h1>
          <p class="text-sm text-zinc-400">
            {{ step === 'checking'
              ? 'Verifying this server and your session…'
              : step === 'server-url'
                ? 'Enter the address of your self-hosted Obol server.'
                : step === 'setup'
                  ? 'Use the one-time setup token from the server logs (`docker compose logs obol-server`).'
                  : step === 'reset-request'
                    ? 'You will receive a reset link at that address, if it belongs to an account.'
                    : step === 'reset-confirm'
                      ? 'Choose the new password for the server owner.'
                      : step === 'sessions'
                        ? 'Sign out any device with a session on this server.'
                        : 'Sign in with the server owner account.' }}
          </p>
        </header>

        <p
          v-if="serverUrl && step !== 'server-url' && step !== 'sessions' && step !== 'error' && step !== 'checking'"
          class="text-center text-xs text-zinc-500"
        >
          {{ serverName ? serverName : 'Server' }} · {{ serverUrl }}
        </p>

        <p
          v-if="serverName && (step === 'checking' || step === 'sessions')"
          class="text-center text-xs text-zinc-500"
        >
          {{ serverName }} · {{ serverUrl }}
        </p>

        <div v-if="step === 'checking'" class="flex justify-center py-4" aria-label="Loading">
          <UIcon name="i-heroicons-arrow-path" class="h-6 w-6 animate-spin text-emerald-400" />
        </div>

        <div v-else-if="step === 'error'" class="space-y-4">
          <p class="rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-200" role="alert">
            {{ message || 'The server is unreachable right now.' }}
          </p>
          <UButton block color="primary" :loading="busy" @click="emit('retry')">Try again</UButton>
          <div class="flex flex-col items-center gap-1">
            <UButton v-if="allowServerChange" variant="link" color="gray" size="sm" @click="emit('change-server')">
              Use a different server
            </UButton>
            <UButton
              v-if="allowLocalSwitch"
              variant="link"
              color="gray"
              size="sm"
              @click="emit('switch-local')"
            >
              Use this Mac's local profile instead
            </UButton>
          </div>
        </div>

        <div v-else-if="step === 'sessions'" class="space-y-4">
          <div
            v-if="message"
            class="rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-200"
            role="alert"
          >
            {{ message }}
          </div>

          <ul v-if="sessions.length > 0" class="space-y-2">
            <li
              v-for="session in sessions"
              :key="session.id"
              class="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2"
            >
              <div class="min-w-0">
                <p class="truncate text-sm text-zinc-100">
                  {{ session.deviceLabel || 'Session' }}
                </p>
                <p class="text-xs text-zinc-500">
                  {{ session.createdAt ? `Created ${session.createdAt}` : session.id }}
                </p>
              </div>
              <UButton
                size="xs"
                color="red"
                variant="soft"
                :disabled="busy"
                :loading="busy"
                @click="emit('revoke', session.id)"
              >
                Revoke
              </UButton>
            </li>
          </ul>
          <p v-else class="text-center text-sm text-zinc-500">
            No active sessions were returned by the server.
          </p>

          <UButton block color="red" variant="soft" :loading="busy" @click="emit('logout')">
            Sign out of this device
          </UButton>
          <div class="flex flex-col items-center gap-1">
            <UButton variant="link" color="gray" size="sm" @click="emit('back-to-active')">Done</UButton>
            <UButton v-if="allowServerChange" variant="link" color="gray" size="sm" @click="emit('change-server')">
              Use a different server
            </UButton>
            <UButton v-if="allowLocalSwitch" variant="link" color="gray" size="sm" @click="emit('switch-local')">
              Use this Mac's local profile instead
            </UButton>
          </div>
        </div>

        <form v-else class="space-y-4" @submit.prevent="refreshOnSubmit">
          <UFormGroup v-if="step === 'server-url'" label="Server address">
            <UInput
              v-model="serverUrlInput"
              name="server-url"
              type="url"
              inputmode="url"
              autocomplete="url"
              placeholder="https://obol.example.com"
              class="w-full"
              required
              autofocus
            />
            <p class="mt-1 text-xs text-zinc-500">
              HTTPS is required. In development builds, a localhost HTTP server is accepted.
            </p>
          </UFormGroup>

          <UFormGroup
            v-if="step === 'setup'"
            label="Setup token"
          >
            <UInput
              v-model="setupToken"
              maxlength="64"
              placeholder="32-character token from the server logs"
              class="w-full"
              required
              autofocus
            />
          </UFormGroup>

          <UFormGroup
            v-else-if="step === 'reset-confirm'"
            label="Reset token"
          >
            <UInput
              v-model="setupToken"
              maxlength="512"
              placeholder="From the password reset email link"
              class="w-full"
              required
              autofocus
            />
          </UFormGroup>

          <UFormGroup v-if="step === 'login' || step === 'setup' || step === 'reset-request'" label="Email">
            <UInput
              v-model="email"
              type="email"
              autocomplete="username"
              maxlength="254"
              required
              :autofocus="step === 'login' || step === 'reset-request'"
            />
          </UFormGroup>

          <UFormGroup
            v-if="step === 'setup' || step === 'reset-confirm' || step === 'login'"
            label="Password"
          >
            <UInput
              v-model="password"
              type="password"
              :autocomplete="isConfirmationStep() ? 'new-password' : 'current-password'"
              :minlength="isConfirmationStep() ? 10 : undefined"
              maxlength="256"
              required
            />
            <p v-if="isConfirmationStep()" class="mt-1 text-xs text-zinc-500">At least 10 characters.</p>
          </UFormGroup>

          <UFormGroup v-if="isConfirmationStep()" label="Confirm password">
            <UInput
              v-model="confirmation"
              type="password"
              autocomplete="new-password"
              :minlength="isConfirmationStep() ? 10 : undefined"
              maxlength="256"
              required
            />
          </UFormGroup>

          <p v-if="validationMessage" class="text-sm text-red-300" role="alert">
            {{ validationMessage }}
          </p>
          <p v-if="message" class="text-sm text-red-300" role="alert">
            {{ message }}
          </p>

          <UButton
            block
            type="submit"
            color="primary"
            :loading="busy"
            :disabled="cooldown > 0"
          >
            {{ step === 'server-url'
              ? 'Connect'
              : step === 'setup'
                ? 'Create owner account'
                : step === 'reset-request'
                  ? 'Send reset link'
                  : step === 'reset-confirm'
                    ? 'Set new password'
                    : cooldown > 0
                      ? `Wait ${cooldown}s`
                      : 'Sign in' }}
          </UButton>

          <div class="flex flex-col items-center gap-1">
            <UButton
              v-if="step === 'login' && smtpConfigured !== false"
              variant="link"
              color="gray"
              size="sm"
              @click="emit('show-reset-request')"
            >
              Forgot password?
            </UButton>
            <p v-else-if="step === 'login' && smtpConfigured === false" class="text-xs text-zinc-500">
              Email is not configured on this server; ask the deployment operator to reset the password.
            </p>

            <UButton
              v-if="step !== 'server-url' && allowServerChange"
              variant="link"
              color="gray"
              size="sm"
              @click="emit('change-server')"
            >
              Use a different server
            </UButton>
            <UButton
              v-if="allowLocalSwitch && step !== 'sessions'"
              variant="link"
              color="gray"
              size="sm"
              @click="emit('switch-local')"
            >
              Use this Mac's local profile instead
            </UButton>
          </div>
        </form>

        <p v-if="step !== 'sessions' && !statusBadge" class="text-xs leading-relaxed text-zinc-500">
          This login authenticates the one owner of this Obol deployment. Your other accounts and devices
          become additional sessions of the same data; signing out here never touches any local ledger files.
        </p>
      </div>
    </UCard>
  </main>
</template>
