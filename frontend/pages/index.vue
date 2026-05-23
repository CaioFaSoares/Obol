<script setup lang="ts">
import { computed } from 'vue'

const { startDate, endDate } = getForecastRange()

const { data: forecastData, pending, error } = await useAsyncData('forecast', async () => {
  const res = await api.api.forecast.get({ query: { startDate, endDate } })
  if (res.error) throw res.error
  return res.data
})

const timelineData = computed(() => {
  if (!Array.isArray(forecastData.value)) return []
  return forecastData.value
})

const currentBalance = computed(() => {
  if (!timelineData.value.length) return 0
  return timelineData.value[0].balance
})

const forecastedBalance = computed(() => {
  if (!timelineData.value.length) return 0
  return timelineData.value[timelineData.value.length - 1].balance
})

// O backend de projeção atual retorna apenas a timeline, então a lista de pendentes fica vazia por enquanto
const pendingTransactions = computed((): any[] => {
  return []
})
</script>

<template>
  <div class="p-6 max-w-7xl mx-auto space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-3xl font-bold tracking-tight text-white">
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
