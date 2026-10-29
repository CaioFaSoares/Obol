<script setup lang="ts">
const tabs = [
  { key: 'financial',   label: 'Contas & Cartões', icon: 'i-heroicons-credit-card' },
  { key: 'recurrences', label: 'Recorrências', icon: 'i-heroicons-arrows-right-left' },
  { key: 'budgets',     label: 'Orçamentos',   icon: 'i-heroicons-chart-bar' },
  { key: 'projects',    label: 'Projetos',      icon: 'i-heroicons-briefcase' },
]
</script>

<template>
  <div class="p-4 sm:p-6 max-w-4xl mx-auto space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-2xl sm:text-3xl font-bold tracking-tight text-white">Gestão</h1>
    </div>

    <!-- Adaptive tabs: on small screens the grid collapses to an auto-width
         strip that scrolls horizontally inside its own bounds; on sm+ the
         default full-width equal columns are kept (desktop unchanged). -->
    <UTabs
      :items="tabs"
      :ui="{
        list: {
          base: 'relative max-sm:max-w-full max-sm:overflow-x-auto',
          width: 'w-full max-sm:w-max',
          background: 'bg-zinc-900',
          tab: { icon: 'w-4 h-4 flex-shrink-0 me-1.5 sm:me-2' },
          marker: { background: 'bg-zinc-700' },
        },
      }"
    >
      <template #item="{ item }">
        <UCard :ui="{ background: 'bg-zinc-900', ring: 'ring-1 ring-zinc-800', body: { padding: 'px-4 py-5 sm:p-6' } }">
          <TabFinancial   v-if="item.key === 'financial'" />
          <TabRecurrences v-else-if="item.key === 'recurrences'" />
          <TabBudgets     v-else-if="item.key === 'budgets'" />
          <TabProjects    v-else-if="item.key === 'projects'" />
        </UCard>
      </template>
    </UTabs>
  </div>
</template>
