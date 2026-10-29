<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import { useTransactionEdit } from '../composables/useTransactionEdit'
import { useRefresh } from '../composables/useRefresh'
import { useFastEntry } from '../composables/useFastEntry'
import { useFinanceStore } from '../stores/finance'
import { formatCurrency, formatDate, getForecastRange } from '../utils/formatters'
import { api } from '../utils/api'

const { open } = useTransactionEdit()
const { globalRefreshTrigger, triggerRefresh } = useRefresh()
const { open: openFastEntry } = useFastEntry()
const forecastDays = ref(30)
const includeSimulations = ref(false)

watch(globalRefreshTrigger, () => {
  refreshNuxtData() // Refresh the useAsyncData (e.g. forecast)
  loadRecentTransactions(true) // Refresh the custom history
  financeStore.loadBaseData(true) // Refresh global accounts and cards
})

const forecastQuery = computed(() => {
  return getForecastRange(forecastDays.value)
})

const financeStore = useFinanceStore()
const toast = useToast()

const { data: forecastData, pending: pendingForecast, error } = await useAsyncData('forecast', async () => {
  const res = await api.api.forecast.get({
    query: {
      ...forecastQuery.value,
      includeSimulations: includeSimulations.value ? 'true' : undefined
    }
  })
  if (res.error) throw res.error
  return res.data
}, { watch: [forecastQuery, includeSimulations] })

const { data: transactionsData, pending: pendingTransactions, error: transactionsError, refresh: refreshTransactions } = await useAsyncData(async () => {
  const { startDate, endDate } = forecastQuery.value
  const [pendingResult, realizedResult] = await Promise.all([
    api.api.transactions.get({
      query: {
        status: 'pending',
        simulation: 'real',
        sort: 'expected_date',
        perPage: '500'
      }
    }),
    api.api.transactions.get({
      query: {
        status: 'realized',
        simulation: 'real',
        dateFrom: startDate,
        dateTo: endDate,
        dateField: 'realized_date',
        sort: 'expected_date',
        perPage: '500'
      }
    })
  ])
  if (pendingResult.error) throw pendingResult.error
  if (realizedResult.error) throw realizedResult.error
  return [...pendingResult.data.items, ...realizedResult.data.items]
}, { watch: [forecastQuery] })

const timelineData = computed(() => {
  if (forecastData.value && typeof forecastData.value === 'object' && 'timeline' in forecastData.value) {
    return (forecastData.value as any).timeline || []
  }
  return []
})

const pendingInvoices = computed(() => {
  if (forecastData.value && typeof forecastData.value === 'object' && 'upcomingInvoices' in forecastData.value) {
    return (forecastData.value as any).upcomingInvoices || []
  }
  return []
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

const isDayDetailModalOpen = ref(false)
const selectedDayData = ref<any>(null)
const selectedCalendarDate = ref<string>('')

// Normalize any date format to the 'YYYY-MM-DD' key
const dateToKey = (dateVal: any): string => {
  if (!dateVal) return ''
  if (dateVal instanceof Date) return dateVal.toISOString().substring(0, 10)
  return String(dateVal).substring(0, 10)
}

const todayKey = computed(() => getForecastRange(0).endDate)

const selectedDayIsFuture = computed(() => {
  const key = dateToKey(selectedDayData.value?.date)
  return !!key && key > todayKey.value
})

const selectedDayLabel = computed(() => {
  const key = dateToKey(selectedDayData.value?.date)
  return key ? formatDate(key + 'T12:00:00Z') : ''
})

const onForecastPointClick = (payload: { index: number, data: any }) => {
  selectedDayData.value = payload.data
  selectedCalendarDate.value = dateToKey(payload.data?.date)
  isDayDetailModalOpen.value = true
}

const onCalendarSelect = (payload: { date: string, balance: number }) => {
  selectedCalendarDate.value = payload.date
  selectedDayData.value = { date: payload.date, balance: payload.balance }
  isDayDetailModalOpen.value = true
}

const dayDetailTransactions = computed(() => {
  if (!selectedDayData.value || !selectedDayData.value.date) return []

  // Safely extract target date string (YYYY-MM-DD)
  let targetDateStr = '';
  if (selectedDayData.value.date instanceof Date) {
    targetDateStr = selectedDayData.value.date.toISOString().substring(0, 10)
  } else {
    targetDateStr = String(selectedDayData.value.date).substring(0, 10)
  }

  const getSafeDateStr = (dateVal: any) => {
    if (!dateVal) return '';
    return dateVal instanceof Date ? dateVal.toISOString() : String(dateVal);
  }

  const baseList = transactions.value
    .filter(t => {
      const dateToCheck = t.status === 'realized' && t.realized_date ? t.realized_date : t.expected_date
      const safeDateStr = getSafeDateStr(dateToCheck);
      return safeDateStr.substring(0, 10) <= targetDateStr && !t.card_id
    })

  const validInvoices = invoicesAsTxns.value.filter((inv: any) => {
    const safeDateStr = getSafeDateStr(inv.expected_date);
    return safeDateStr.substring(0, 10) <= targetDateStr;
  })

  return [...baseList, ...validInvoices]
    .sort((a, b) => {
      const dateA = getSafeDateStr(a.status === 'realized' && a.realized_date ? a.realized_date : a.expected_date);
      const dateB = getSafeDateStr(b.status === 'realized' && b.realized_date ? b.realized_date : b.expected_date);
      return dateB.localeCompare(dateA) // Descending
    })
    .slice(0, 15)
})

const activeTab = ref(0)
const tabItems = computed(() => {
  const tabs = [
    { label: 'Realizados', key: 'realized', icon: 'i-heroicons-check-badge' },
    { label: 'Pendentes', key: 'pending', icon: 'i-heroicons-clock' }
  ]
  if (includeSimulations.value) {
    tabs.push({ label: 'Simulados', key: 'simulated', icon: 'i-heroicons-sparkles' })
  }
  return tabs
})

watch(includeSimulations, (newVal) => {
  if (!newVal && activeTab.value === 2) {
    activeTab.value = 1
  }
})

const invoicesAsTxns = computed(() => {
  return pendingInvoices.value
    .map((inv: any) => ({
      id: `invoice-${inv.card_id}-${inv.dateStr}`,
      title: `💳 Fatura ${inv.card_name}`,
      expected_date: inv.dateStr,
      amount: inv.amount,
      type: 'expense',
      status: 'pending',
      isInvoice: true,
      card_id: inv.card_id,
      originalStatus: inv.status
    }))
})

const recentPage = ref(1)
const recentTransactions = ref<any[]>([])
const hasMoreRecent = ref(false)
const isLoadingRecent = ref(false)
const recentLoadError = ref<any>(null)

const retryRecentTransactions = () => {
  recentLoadError.value = null
  refreshTransactions()
  loadRecentTransactions(true)
}

const loadRecentTransactions = async (reset = false) => {
  if (isLoadingRecent.value) return
  isLoadingRecent.value = true

  if (reset) {
    recentLoadError.value = null
    recentPage.value = 1
    recentTransactions.value = []
  }

  const currentTab = tabItems.value[activeTab.value]?.key || 'realized'
  const status = currentTab === 'simulated' ? 'all' : currentTab
  const simulation = currentTab === 'simulated' ? 'simulated' : 'real'
  const sort = currentTab === 'realized' ? '-realized_date' : 'expected_date'

  try {
    const res = await api.api.transactions.get({
      query: {
        status,
        simulation,
        sort,
        page: String(recentPage.value),
        perPage: '15'
      }
    })

    if (res.error) {
      recentLoadError.value = res.error
    } else {
      const data: any = res.data
      const items = (Array.isArray(data) ? data : (data?.items ?? [])).filter((t: any) => !t.card_id)

      if (reset) {
        recentTransactions.value = items
      } else {
        recentTransactions.value.push(...items)
      }

      if (!Array.isArray(data) && data.page < data.totalPages) {
        hasMoreRecent.value = true
      } else {
        hasMoreRecent.value = false
      }
    }
  } catch (err) {
    recentLoadError.value = err
    console.error('Failed to load recent transactions:', err)
  } finally {
    isLoadingRecent.value = false
  }
}

// Reload the list when the tab changes
watch(activeTab, () => {
  loadRecentTransactions(true)
})

const filteredTransactions = computed(() => {
  const currentTab = tabItems.value[activeTab.value]?.key || 'realized'
  const baseList = recentTransactions.value

  if (currentTab === 'pending' || currentTab === 'simulated') {
    const list = currentTab === 'pending' ? [...baseList, ...invoicesAsTxns.value] : baseList
    return list.sort((a, b) => {
      const dateA = a.status === 'realized' && a.realized_date ? a.realized_date : a.expected_date
      const dateB = b.status === 'realized' && b.realized_date ? b.realized_date : b.expected_date
      // Ascending (oldest/soonest first) for pending and simulated
      return new Date(dateA).getTime() - new Date(dateB).getTime()
    })
  }

  // Descending (newest first) for realized
  return baseList.sort((a, b) => {
    const dateA = a.realized_date || a.expected_date
    const dateB = b.realized_date || b.expected_date
    return new Date(dateB).getTime() - new Date(dateA).getTime()
  })
})

// Load initial data on the client
onMounted(() => {
  loadRecentTransactions(true)
})

const realizeTransaction = async (id: string, updateBalance: boolean) => {
  try {
    const res = await api.api.transactions({ id }).realize.patch({ update_balance: updateBalance })
    if (res.error) throw res.error

    toast.add({
      title: 'Sucesso!',
      description: updateBalance ? 'Transação baixada e saldo atualizado.' : 'Transação baixada silenciosamente.',
      color: 'emerald'
    })

    triggerRefresh()
  } catch (err) {
    console.error(err)
    toast.add({ title: 'Erro', description: 'Não foi possível dar baixa.', color: 'red' })
  }
}

const quickLinks = [
  { label: 'Lançamentos', to: '/ledger', icon: 'i-heroicons-list-bullet' },
  { label: 'Cartões', to: '/cards', icon: 'i-heroicons-credit-card' },
  { label: 'Gestão', to: '/management', icon: 'i-heroicons-adjustments-horizontal' }
]

const cardUi = { background: 'bg-zinc-900', ring: 'ring-1 ring-zinc-800' }
</script>

<template>
  <div class="p-4 sm:p-6 max-w-7xl mx-auto space-y-5 sm:space-y-6">
    <!-- Daily header -->
    <header class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div class="space-y-2">
        <h1 class="text-2xl sm:text-3xl font-bold tracking-tight text-white">
          Painel do Dia
        </h1>
        <nav class="flex flex-wrap items-center gap-2">
          <UButton
            v-for="link in quickLinks"
            :key="link.to"
            :to="link.to"
            :icon="link.icon"
            color="gray"
            variant="ghost"
            size="xs"
          >
            {{ link.label }}
          </UButton>
        </nav>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <UButton
          icon="i-heroicons-plus-circle"
          color="primary"
          size="sm"
          label="Novo lançamento"
          @click="openFastEntry()"
        />
        <div class="flex items-center gap-2 bg-zinc-900 ring-1 ring-zinc-800 rounded-lg px-3 py-1.5">
          <span class="text-sm text-zinc-400">Simulação</span>
          <UToggle v-model="includeSimulations" color="purple" />
        </div>
      </div>
    </header>

    <div v-if="pendingForecast" class="space-y-6">
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <USkeleton class="h-28 w-full rounded-xl bg-zinc-800" />
        <USkeleton class="h-28 w-full rounded-xl bg-zinc-800" />
      </div>
      <USkeleton class="h-72 w-full rounded-xl bg-zinc-800" />
      <USkeleton class="h-64 w-full rounded-xl bg-zinc-800" />
    </div>

    <div v-else-if="error">
      <UAlert
        icon="i-heroicons-exclamation-triangle"
        color="red"
        variant="subtle"
        title="Erro ao carregar projeção"
        :description="String(error?.message || error)"
      />
    </div>

    <div v-else class="space-y-5 sm:space-y-6">
      <!-- Present vs projected balance -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <UCard :ui="cardUi">
          <p class="text-sm text-zinc-400 font-medium mb-1 flex items-center gap-2">
            Saldo disponível
            <UBadge color="zinc" variant="subtle" size="xs">Hoje</UBadge>
          </p>
          <p class="text-3xl sm:text-4xl font-mono text-white font-semibold">
            {{ formatCurrency(currentBalance) }}
          </p>
          <p class="text-xs text-zinc-500 mt-1">Conta somada ao caixa real, sem projeções.</p>
        </UCard>

        <UCard :ui="cardUi">
          <div class="flex items-center justify-between mb-1">
            <p class="text-sm text-zinc-400 font-medium flex items-center gap-2">
              Projeção
              <UBadge color="purple" variant="subtle" size="xs">Futuro</UBadge>
            </p>
            <UDropdown :items="[
              [{ label: '15 Dias', click: () => forecastDays = 15 }],
              [{ label: '30 Dias', click: () => forecastDays = 30 }],
              [{ label: '60 Dias', click: () => forecastDays = 60 }],
              [{ label: '90 Dias', click: () => forecastDays = 90 }]
            ]" :popper="{ placement: 'bottom-end' }">
              <UButton color="gray" variant="ghost" size="xs" :label="`+${forecastDays} dias`" trailing-icon="i-heroicons-calendar-days" />
            </UDropdown>
          </div>
          <p class="text-3xl sm:text-4xl font-mono font-semibold" :class="forecastedBalance >= 0 ? 'text-emerald-400' : 'text-red-400'">
            {{ formatCurrency(forecastedBalance) }}
          </p>
          <p class="text-xs text-zinc-500 mt-1">Projetado para daqui a {{ forecastDays }} dias.</p>
        </UCard>
      </div>

      <UCard :ui="cardUi">
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="font-semibold text-lg text-white">Calendário do Saldo</h3>
            <span class="hidden sm:inline text-xs text-zinc-500">Toque em um dia para ver a composição</span>
          </div>
        </template>
        <ForecastCalendar
          :data="timelineData"
          :selected-date="selectedCalendarDate"
          @select="onCalendarSelect"
        />
      </UCard>

      <UCard :ui="cardUi">
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="font-semibold text-lg text-white">Trajetória do Saldo</h3>
            <span class="hidden sm:inline text-xs text-zinc-500">Toque em um ponto para detalhar</span>
          </div>
        </template>
        <!-- The component itself provides the height wrapper -->
        <ForecastChart :data="timelineData" :current-balance="currentBalance" @point-click="onForecastPointClick" />
      </UCard>

      <!-- Entry history -->
      <UCard v-if="pendingTransactions && isLoadingRecent && recentPage === 1" :ui="cardUi">
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="font-semibold text-lg text-white">Lançamentos</h3>
          </div>
        </template>
        <div class="space-y-4 py-2">
          <USkeleton class="h-10 w-full rounded-md bg-zinc-800" />
          <USkeleton class="h-10 w-full rounded-md bg-zinc-800" />
          <USkeleton class="h-10 w-full rounded-md bg-zinc-800" />
        </div>
      </UCard>

      <UCard v-else :ui="cardUi">
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="font-semibold text-lg text-white">Lançamentos</h3>
            <UButton
              to="/ledger"
              icon="i-heroicons-arrow-right"
              color="gray"
              variant="ghost"
              size="xs"
              label="Ver tudo"
            />
          </div>
        </template>

        <UTabs v-model="activeTab" :items="tabItems" class="w-full mb-4" />

        <UAlert
          v-if="transactionsError || recentLoadError"
          icon="i-heroicons-exclamation-triangle"
          title="Erro ao carregar lançamentos"
          description="Não foi possível carregar os lançamentos. Verifique sua conexão e tente novamente."
          color="red"
          variant="soft"
          class="mb-4"
        >
          <template #actions>
            <UButton
              label="Tentar novamente"
              icon="i-heroicons-arrow-path"
              color="red"
              size="sm"
              :loading="isLoadingRecent"
              @click="retryRecentTransactions"
            />
          </template>
        </UAlert>

        <template v-else>
          <div v-if="filteredTransactions.length === 0" class="p-8 text-center text-zinc-500">
            Nenhum lançamento encontrado nesta aba.
          </div>

        <ul v-else class="divide-y divide-zinc-800">
          <li v-for="t in filteredTransactions" :key="t.id" class="py-3 flex justify-between items-center gap-3 group">
            <div class="min-w-0">
              <p class="text-white font-medium flex items-center gap-2 flex-wrap">
                <UIcon v-if="t.is_scheduled" name="i-heroicons-calendar-days" class="w-4 h-4 text-amber-400 flex-shrink-0" />
                <span class="truncate">{{ t.title }}</span>
                <UBadge v-if="t.is_scheduled" color="amber" variant="subtle" size="xs">Agendado</UBadge>
                <UBadge v-else-if="t.status === 'pending'" color="yellow" variant="subtle" size="xs">Pendente</UBadge>
                <UBadge v-if="t.is_silent" color="gray" variant="subtle" size="xs">Baixa Silenciosa</UBadge>
              </p>
              <p class="text-xs text-zinc-400">
                {{ t.is_scheduled ? 'Vencimento:' : 'Previsto:' }} {{ formatDate(t.expected_date) }}
                <span v-if="t.realized_date">• Realizado: {{ formatDate(t.realized_date) }}</span>
              </p>
            </div>
            <div class="flex items-center gap-2 sm:gap-4 shrink-0">
              <div class="flex gap-1">
                <template v-if="!t.isInvoice">
                  <UButton
                    icon="i-heroicons-pencil-square"
                    size="xs"
                    color="gray"
                    variant="ghost"
                    class="sm:opacity-0 sm:group-hover:opacity-100 transition-opacity"
                    @click="open(t)"
                  />
                  <UDropdown
                    v-if="t.status === 'pending' && !t.is_scheduled"
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
                </template>
                <template v-else>
                  <UButton
                    :to="`/cards?card_id=${t.card_id}`"
                    icon="i-heroicons-credit-card"
                    color="purple"
                    variant="soft"
                    size="sm"
                    title="Pagar Fatura no Módulo de Cartões"
                  />
                </template>
              </div>
              <span
                class="font-mono text-right min-w-[100px]"
                :class="{
                  'text-zinc-400': t.type === 'transfer',
                  'text-red-400': t.type === 'expense',
                  'text-emerald-400': t.type === 'income'
                }"
              >
                {{ t.type === 'expense' ? '-' : (t.type === 'income' ? '+' : '') }}{{ formatCurrency(t.amount) }}
              </span>
            </div>
          </li>
        </ul>

        <div v-if="hasMoreRecent" class="mt-6 text-center">
          <UButton
            @click="() => { recentPage++; loadRecentTransactions() }"
            :loading="isLoadingRecent"
            color="primary"
            icon="i-heroicons-arrow-path"
          >
            Carregar mais
          </UButton>
        </div>
        </template>
      </UCard>
    </div>

    <UModal v-model="isDayDetailModalOpen">
      <UCard :ui="{ ring: '', divide: 'divide-y divide-zinc-800', background: 'bg-zinc-900' }">
        <template #header>
          <div class="flex items-center justify-between">
            <div>
              <h3 class="text-base font-semibold text-white flex items-center gap-2">
                Composição do Saldo
                <UBadge v-if="selectedDayIsFuture" color="purple" variant="subtle" size="xs">Projetado</UBadge>
                <UBadge v-else color="zinc" variant="subtle" size="xs">Confirmado</UBadge>
              </h3>
              <p class="text-xs text-zinc-400 mt-1">
                Até {{ selectedDayLabel }} —
                Saldo: <span class="font-mono" :class="selectedDayData && selectedDayData.balance < 0 ? 'text-red-400' : 'text-emerald-400'">{{ formatCurrency(selectedDayData?.balance || 0) }}</span>
              </p>
            </div>
            <UButton color="gray" variant="ghost" icon="i-heroicons-x-mark-20-solid" class="-my-1" @click="isDayDetailModalOpen = false" />
          </div>
        </template>

        <div class="space-y-4">
          <p class="text-xs text-zinc-500 mb-2">As 15 transações mais recentes (ou agendadas) que impactam este dia:</p>
          <ul v-if="dayDetailTransactions.length > 0" class="divide-y divide-zinc-800">
            <li v-for="t in dayDetailTransactions" :key="t.id" class="py-2 flex justify-between items-center">
              <div>
                <p class="text-white text-sm font-medium flex items-center gap-2">
                  {{ t.title }}
                  <UBadge v-if="t.status === 'pending'" color="yellow" variant="subtle" size="xs">Pendente</UBadge>
                </p>
                <p class="text-xs text-zinc-400">
                  {{ formatDate(t.status === 'realized' && t.realized_date ? t.realized_date : t.expected_date) }}
                </p>
              </div>
              <span
                class="font-mono text-sm"
                :class="{
                  'text-zinc-400': t.type === 'transfer',
                  'text-red-400': t.type === 'expense',
                  'text-emerald-400': t.type === 'income'
                }"
              >
                {{ t.type === 'expense' ? '-' : (t.type === 'income' ? '+' : '') }}{{ formatCurrency(t.amount) }}
              </span>
            </li>
          </ul>
          <div v-else class="text-center py-4 text-zinc-500 text-sm">
            Nenhuma transação encontrada.
          </div>
        </div>
      </UCard>
    </UModal>
  </div>
</template>
