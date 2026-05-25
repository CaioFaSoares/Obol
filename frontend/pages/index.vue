<script setup lang="ts">
import { computed } from 'vue'
import { useTransactionEdit } from '../composables/useTransactionEdit'
import { useFinanceStore } from '../stores/finance'

const { open } = useTransactionEdit()
const forecastDays = ref(30)

const forecastQuery = computed(() => {
  return getForecastRange(forecastDays.value)
})

const financeStore = useFinanceStore()
const toast = useToast()

const { data: forecastData, pending: pendingForecast, error } = await useAsyncData('forecast', async () => {
  const res = await api.api.forecast.get({ query: forecastQuery.value })
  if (res.error) throw res.error
  return res.data
}, { watch: [forecastQuery] })

const { data: transactionsData, pending: pendingTransactions } = await useAsyncData(async () => {
  const { startDate, endDate } = forecastQuery.value
  const res = await api.api.transactions.get({
    query: {
      filter: `card_id = "" && (status = 'pending' || (status = 'realized' && realized_date >= '${startDate} 00:00:00.000Z' && realized_date <= '${endDate} 23:59:59.999Z'))`,
      sort: 'expected_date'
    }
  })
  if (res.error) {
    console.error('Failed to fetch transactions:', res.error)
    throw res.error
  }
  return (res.data as any[]) ?? []
}, { watch: [forecastQuery] })

const timelineData = computed(() => {
  if (!Array.isArray(forecastData.value)) return []
  return forecastData.value
})

const currentBalance = computed(() => {
  return financeStore.accounts
    .filter(a => a.type !== 'investment')
    .reduce((sum, a) => sum + (a.initial_balance || 0), 0)
})

const forecastedBalance = computed(() => {
  if (!timelineData.value.length) return 0
  return timelineData.value[timelineData.value.length - 1].balance
})

const transactions = computed((): any[] => {
  return transactionsData.value || []
})

const activeTab = ref(0)
const tabItems = [
  { label: 'Realizados', key: 'realized', icon: 'i-heroicons-check-badge' },
  { label: 'Pendentes', key: 'pending', icon: 'i-heroicons-clock' }
]

const filteredTransactions = computed(() => {
  const status = activeTab.value === 0 ? 'realized' : 'pending'
  return transactions.value.filter((t: any) => t.status === status)
})

const realizeTransaction = async (id: string, updateBalance: boolean) => {
  try {
    const res = await api.api.transactions({ id }).realize.patch({ update_balance: updateBalance })
    if (res.error) throw res.error

    toast.add({ 
      title: 'Sucesso!', 
      description: updateBalance ? 'Baixa realizada com sucesso.' : 'Baixa silenciosa efetuada.', 
      color: 'emerald' 
    })
    window.location.reload()
  } catch (err) {
    console.error(err)
    toast.add({ title: 'Erro', description: 'Não foi possível dar baixa.', color: 'red' })
  }
}
</script>

<template>
  <div class="p-6 max-w-7xl mx-auto space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-3xl font-bold tracking-tight text-white">
        Dashboard de Projeção
      </h1>
    </div>

    <div v-if="pendingForecast" class="space-y-6">
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
          <p class="text-4xl font-mono text-white font-semibold">
            {{ formatCurrency(currentBalance) }}
          </p>
        </UCard>
        
        <UCard :ui="{ background: 'bg-zinc-900', ring: 'ring-1 ring-zinc-800' }">
          <div class="flex items-center justify-between mb-1">
            <p class="text-sm text-zinc-400 font-medium">Projeção (+{{ forecastDays }} Dias)</p>
            <UDropdown :items="[
              [{ label: '15 Dias', click: () => forecastDays = 15 }],
              [{ label: '30 Dias', click: () => forecastDays = 30 }],
              [{ label: '60 Dias', click: () => forecastDays = 60 }],
              [{ label: '90 Dias', click: () => forecastDays = 90 }]
            ]" :popper="{ placement: 'bottom-end' }">
              <UButton color="gray" variant="ghost" icon="i-heroicons-calendar-days" size="xs" />
            </UDropdown>
          </div>
          <p class="text-4xl font-mono font-semibold" :class="forecastedBalance >= 0 ? 'text-emerald-400' : 'text-red-400'">
            {{ formatCurrency(forecastedBalance) }}
          </p>
        </UCard>
      </div>

      <UCard :ui="{ background: 'bg-zinc-900', ring: 'ring-1 ring-zinc-800' }">
        <template #header>
          <h3 class="font-semibold text-lg text-white">Trajetória do Saldo</h3>
        </template>
        <!-- The component itself provides the height wrapper -->
        <ForecastChart :data="timelineData" :current-balance="currentBalance" />
      </UCard>

      <UCard v-if="pendingTransactions" :ui="{ background: 'bg-zinc-900', ring: 'ring-1 ring-zinc-800' }">
        <template #header>
          <h3 class="font-semibold text-lg text-white">Histórico de Lançamentos</h3>
        </template>
        <div class="space-y-4 py-2">
          <USkeleton class="h-10 w-full rounded-md bg-zinc-800" />
          <USkeleton class="h-10 w-full rounded-md bg-zinc-800" />
          <USkeleton class="h-10 w-full rounded-md bg-zinc-800" />
        </div>
      </UCard>

      <UCard v-else-if="transactions.length > 0" :ui="{ background: 'bg-zinc-900', ring: 'ring-1 ring-zinc-800' }">
        <template #header>
          <h3 class="font-semibold text-lg text-white">Histórico de Lançamentos</h3>
        </template>
        
        <UTabs v-model="activeTab" :items="tabItems" class="w-full mb-4" />

        <div v-if="filteredTransactions.length === 0" class="p-8 text-center text-zinc-500">
          Nenhum lançamento encontrado nesta aba.
        </div>

        <ul v-else class="divide-y divide-zinc-800">
          <li v-for="t in filteredTransactions" :key="t.id" class="py-3 flex justify-between items-center group">
            <div>
              <p class="text-white font-medium flex items-center gap-2">
                {{ t.title }}
                <UBadge v-if="t.status === 'pending'" color="yellow" variant="subtle" size="xs">Pendente</UBadge>
                <UBadge v-if="t.is_silent" color="gray" variant="subtle" size="xs">Baixa Silenciosa</UBadge>
              </p>
              <p class="text-xs text-zinc-400">
                Previsto: {{ formatDate(t.expected_date) }} 
                <span v-if="t.realized_date">• Realizado: {{ formatDate(t.realized_date) }}</span>
              </p>
            </div>
            <div class="flex items-center gap-4">
              <span 
                class="font-mono" 
                :class="{
                  'text-zinc-400': t.type === 'transfer',
                  'text-red-400': t.type === 'expense',
                  'text-emerald-400': t.type === 'income'
                }"
              >
                {{ t.type === 'expense' ? '-' : (t.type === 'income' ? '+' : '') }}{{ formatCurrency(t.amount) }}
              </span>
              <div class="flex gap-1">
                <UDropdown 
                  v-if="t.status === 'pending'"
                  :items="[[
                    { 
                      label: 'Dar baixa e somar no saldo', 
                      icon: 'i-heroicons-plus-circle', 
                      click: () => realizeTransaction(t.id, true) 
                    },
                    { 
                      label: 'Já está no saldo (Baixa Silenciosa)', 
                      icon: 'i-heroicons-eye-slash', 
                      click: () => realizeTransaction(t.id, false) 
                    }
                  ]]" 
                  :popper="{ placement: 'bottom-end' }"
                >
                  <UButton 
                    icon="i-heroicons-check-circle" 
                    color="emerald" 
                    variant="ghost" 
                    size="sm"
                    class="opacity-50 hover:opacity-100 transition-opacity"
                    title="Opções de Baixa"
                  />
                </UDropdown>
                <UButton
                  icon="i-heroicons-pencil-square"
                  size="xs"
                  color="gray"
                  variant="ghost"
                  class="opacity-0 group-hover:opacity-100 transition-opacity"
                  @click="open(t)"
                />
              </div>
            </div>
          </li>
        </ul>
      </UCard>
    </div>

    <TransactionEditModal />
  </div>
</template>
