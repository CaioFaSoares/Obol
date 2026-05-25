<script setup lang="ts">
const tabs = [
  { key: 'financial',   label: 'Contas & Cartões', icon: 'i-heroicons-credit-card' },
  { key: 'recurrences', label: 'Recorrências', icon: 'i-heroicons-arrows-right-left' },
  { key: 'budgets',     label: 'Orçamentos',   icon: 'i-heroicons-chart-bar' },
  { key: 'projects',    label: 'Projetos',      icon: 'i-heroicons-briefcase' },
]
</script>

<template>
  <div class="p-6 max-w-4xl mx-auto space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-3xl font-bold tracking-tight text-white">Gestão</h1>
    </div>

    <UTabs :items="tabs" :ui="{ list: { background: 'bg-zinc-900', marker: { background: 'bg-zinc-700' } } }">
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
