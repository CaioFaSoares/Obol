<script setup lang="ts">
const { open } = useFastEntry()
</script>

<template>
  <div class="min-h-screen relative bg-zinc-950">
    <!-- Top Navigation Bar -->
    <nav class="sticky top-0 z-40 bg-zinc-900/80 backdrop-blur border-b border-zinc-800">
      <div class="max-w-7xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
        <div class="flex items-center gap-1">
          <span class="text-white font-bold text-lg mr-4">Obol</span>
          <NuxtLink
            to="/"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
            active-class="bg-zinc-700 text-white"
            inactive-class="text-zinc-400 hover:text-white hover:bg-zinc-800"
          >
            <UIcon name="i-heroicons-home" class="w-4 h-4" />
            Dashboard
          </NuxtLink>

          <NuxtLink
            to="/management"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
            active-class="bg-zinc-700 text-white"
            inactive-class="text-zinc-400 hover:text-white hover:bg-zinc-800"
          >
            <UIcon name="i-heroicons-cog-6-tooth" class="w-4 h-4" />
            Gestão
          </NuxtLink>

          <NuxtLink
            to="/cards"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
            active-class="bg-zinc-700 text-white"
            inactive-class="text-zinc-400 hover:text-white hover:bg-zinc-800"
          >
            <UIcon name="i-heroicons-credit-card" class="w-4 h-4" />
            Cartões
          </NuxtLink>
        </div>
      </div>
    </nav>

    <!-- Main page content -->
    <slot />

    <!-- Global Fast Entry Modal -->
    <FastEntryModal />

    <!-- Floating Action Button -->
    <UButton
      icon="i-heroicons-plus"
      size="xl"
      color="primary"
      variant="solid"
      :ui="{ rounded: 'rounded-full' }"
      class="fixed bottom-6 right-6 shadow-lg hover:scale-105 transition-transform w-14 h-14 flex items-center justify-center z-50"
      @click="open"
    />
  </div>
</template>

