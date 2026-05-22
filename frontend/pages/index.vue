<script setup lang="ts">
import { computed } from 'vue'

const { $api } = useNuxtApp()
const { startDate, endDate } = getForecastRange()

const { data: forecastData, pending, error } = await useAsyncData('forecast', () =>
  $api.api.forecast.get({ query: { start: startDate, end: endDate } })
)

const currentBalance = computed(() => {
  if (!forecastData.value?.data?.timeline?.length) return 0
  return forecastData.value.data.timeline[0].projected_balance
})

const forecastedBalance = computed(() => {
  if (!forecastData.value?.data?.timeline?.length) return 0
  const timeline = forecastData.value.data.timeline
  return timeline[timeline.length - 1].projected_balance
})

const timelineData = computed(() => {
  if (!forecastData.value?.data?.timeline) return []
  return forecastData.value.data.timeline
})

const pendingTransactions = computed(() => {
  if (!forecastData.value?.data?.pendingTransactions) return []
  return forecastData.value.data.pendingTransactions
})
</script>

<template>
  <div class="p-6 max-w-7xl mx-auto space-y-6">
    <div class="flex items-center justify-between">
      <h1 v-pretext class="text-3xl font-bold tracking-tight text-white">
        Dashboard de Projeção
      </h1>
    </div>

    <div v-if="pending" class="space-y-6">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <USkeleton class="h-32 w-full rounded-xl bg-zinc-800" />
        <USkeleton class="h-32 w-full rounded-xl bg-zinc-800" />
      </div>
      <USkeleton class="h-80 w-full rounded-xl bg-zinc-800" />
    </div>

    <div v-else-if="error">
      <UAlert
        icon="i-heroicons-exclamation-triangle"
        color="red"
        variant="subtle"
        title="Erro ao carregar projeção"
        :description="error.message"
      />
    </div>

    <div v-else class="space-y-6">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <UCard :ui="{ background: 'bg-zinc-900', ring: 'ring-1 ring-zinc-800' }">
          <p class="text-sm text-zinc-400 font-medium mb-1">Caixa Atual (Hoje)</p>
          <p v-pretext class="text-4xl font-mono text-white font-semibold">
            {{ formatCurrency(currentBalance) }}
          </p>
        </UCard>
        
        <UCard :ui="{ background: 'bg-zinc-900', ring: 'ring-1 ring-zinc-800' }">
          <p class="text-sm text-zinc-400 font-medium mb-1">Projeção (+30 Dias)</p>
          <p v-pretext class="text-4xl font-mono font-semibold" :class="forecastedBalance >= 0 ? 'text-emerald-400' : 'text-red-400'">
            {{ formatCurrency(forecastedBalance) }}
          </p>
        </UCard>
      </div>

      <UCard :ui="{ background: 'bg-zinc-900', ring: 'ring-1 ring-zinc-800' }">
        <template #header>
          <h3 class="font-semibold text-lg text-white">Trajetória do Saldo</h3>
        </template>
        <!-- The component itself provides the height wrapper -->
        <ForecastChart :data="timelineData" />
      </UCard>

      <UCard v-if="pendingTransactions.length > 0" :ui="{ background: 'bg-zinc-900', ring: 'ring-1 ring-zinc-800' }">
        <template #header>
          <h3 class="font-semibold text-lg text-white">Próximos Lançamentos Pendentes</h3>
        </template>
        
        <ul class="divide-y divide-zinc-800">
          <li v-for="t in pendingTransactions" :key="t.id" class="py-3 flex justify-between items-center">
            <div>
              <p class="text-white font-medium">{{ t.description }}</p>
              <p class="text-xs text-zinc-400">{{ t.date }}</p>
            </div>
            <span class="font-mono" :class="t.amount < 0 ? 'text-red-400' : 'text-emerald-400'">
              {{ formatCurrency(t.amount) }}
            </span>
          </li>
        </ul>
      </UCard>
    </div>
  </div>
</template>
