<script setup lang="ts">
const { open } = useFastEntry()
</script>

<template>
  <div class="min-h-screen relative">
    <!-- Main page content will be injected here -->
    <slot />

    <!-- Global Fast Entry Modal instance -->
    <FastEntryModal />

    <!-- Floating Action Button (FAB) -->
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
