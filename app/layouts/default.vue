<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { DesktopUpdaterState } from '../../desktop/electrobun/shared-rpc'

const { open } = useFastEntry()

const updaterState = ref<DesktopUpdaterState | null>(null)
const updaterBridge = computed(() => (typeof window === 'undefined' ? undefined : window.obol?.updater))
let unsubscribeUpdater: (() => void) | undefined

onMounted(() => {
  const updater = window.obol?.updater
  // Hosted web has no Electrobun view bridge: never show the banner.
  if (!updater) return

  // Subscribe to push messages first so no state update is missed,
  // then fetch the current snapshot.
  unsubscribeUpdater = updater.subscribe(state => {
    updaterState.value = state
  })
  updater.status()
    .then(state => {
      updaterState.value = state
    })
    .catch(() => {
      // The bridge will surface errors via state updates if the check fails.
    })
})

onBeforeUnmount(() => {
  unsubscribeUpdater?.()
  unsubscribeUpdater = undefined
})

function retryUpdaterCheck (): void {
  updaterBridge.value?.check()
    .catch(() => {
      // Errors arrive as state updates ('error' status) via the subscription.
    })
}

function installUpdater (): void {
  updaterBridge.value?.install()
    .catch(() => {
      // Installation failures also surface as state updates via the subscription.
    })
}
</script>

<template>
  <div class="min-h-screen relative bg-zinc-950">
    <!-- Top Navigation Bar -->
    <nav
      aria-label="Main navigation"
      class="sticky top-0 z-40 bg-zinc-900/80 backdrop-blur border-b border-zinc-800 max-sm:pt-[env(safe-area-inset-top,0px)]"
    >
      <div class="max-w-7xl mx-auto px-4 sm:px-6 py-2 sm:py-0 sm:h-14 max-sm:flex max-sm:flex-col sm:flex sm:items-center sm:justify-between">
        <span class="text-white font-bold text-lg mr-4">Obol</span>
        <div class="flex items-center gap-1 flex-nowrap py-2 -my-2 max-sm:overflow-x-auto max-sm:-mx-4 max-sm:px-4 max-sm:pb-3 max-sm:-mb-2 max-sm:overscroll-x-contain no-scrollbar">
          <NuxtLink
            to="/"
            class="flex shrink-0 items-center gap-1.5 px-2 max-sm:py-2 py-1.5 rounded-lg text-sm sm:px-3 font-medium transition-colors"
            active-class="bg-zinc-700 text-white"
            inactive-class="text-zinc-400 hover:text-white hover:bg-zinc-800"
          >
            <UIcon name="i-heroicons-home" class="w-4 h-4" />
            Dashboard
          </NuxtLink>

          <NuxtLink
            to="/management"
            class="flex shrink-0 items-center gap-1.5 px-2 max-sm:py-2 py-1.5 rounded-lg text-sm sm:px-3 font-medium transition-colors"
            active-class="bg-zinc-700 text-white"
            inactive-class="text-zinc-400 hover:text-white hover:bg-zinc-800"
          >
            <UIcon name="i-heroicons-cog-6-tooth" class="w-4 h-4" />
            Gestão
          </NuxtLink>

          <NuxtLink
            to="/cards"
            class="flex shrink-0 items-center gap-1.5 px-2 max-sm:py-2 py-1.5 rounded-lg text-sm sm:px-3 font-medium transition-colors"
            active-class="bg-zinc-700 text-white"
            inactive-class="text-zinc-400 hover:text-white hover:bg-zinc-800"
          >
            <UIcon name="i-heroicons-credit-card" class="w-4 h-4" />
            Cartões
          </NuxtLink>

          <NuxtLink
            to="/ledger"
            class="flex shrink-0 items-center gap-1.5 px-2 max-sm:py-2 py-1.5 rounded-lg text-sm sm:px-3 font-medium transition-colors"
            active-class="bg-zinc-700 text-white"
            inactive-class="text-zinc-400 hover:text-white hover:bg-zinc-800"
          >
            <UIcon name="i-heroicons-document-text" class="w-4 h-4" />
            Auditoria
          </NuxtLink>

          <NuxtLink
            to="/admin"
            class="flex shrink-0 items-center gap-1.5 px-2 max-sm:py-2 py-1.5 rounded-lg text-sm sm:px-3 font-medium transition-colors"
            active-class="bg-zinc-700 text-white"
            inactive-class="text-zinc-400 hover:text-white hover:bg-zinc-800"
          >
            <UIcon name="i-heroicons-wrench-screwdriver" class="w-4 h-4" />
            Admin
          </NuxtLink>
        </div>
      </div>
    </nav>

    <!-- Desktop updater banner; only rendered when the Electrobun bridge exists -->
    <DesktopUpdaterBanner
      v-if="updaterState"
      :state="updaterState"
      @check="retryUpdaterCheck"
      @install="installUpdater"
    />

    <!-- Main page content -->
    <slot />

    <!-- Global Fast Entry Modal -->
    <FastEntryModal />
    
    <!-- Global Transaction Edit Modal -->
    <TransactionEditModal />

    <!-- Bottom spacer: keeps floating action button clear of the last content rows on mobile -->
    <div aria-hidden="true" class="sm:hidden h-[calc(6rem+env(safe-area-inset-bottom,0px))]" />

    <!-- Floating Action Button -->
    <UButton
      icon="i-heroicons-plus"
      size="xl"
      color="primary"
      variant="solid"
      :ui="{ rounded: 'rounded-full' }"
      aria-label="Quick entry"
      class="fixed bottom-[calc(1.5rem+env(safe-area-inset-bottom,0px))] right-[calc(1.5rem+env(safe-area-inset-right,0px))] max-sm:bottom-[calc(1rem+env(safe-area-inset-bottom,0px))] max-sm:right-[calc(1rem+env(safe-area-inset-right,0px))] shadow-lg hover:scale-105 transition-transform w-14 h-14 max-sm:w-12 max-sm:h-12 flex items-center justify-center z-50"
      @click="open"
    />
  </div>
</template>

<style>
/* Hidden scrollbar for the mobile navigation row; scrolling stays touch/drag-driven. */
.no-scrollbar {
  scrollbar-width: none;
}
.no-scrollbar::-webkit-scrollbar {
  display: none;
}
</style>

