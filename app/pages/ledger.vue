<script setup lang="ts">
import { ref, watch, computed, onMounted } from 'vue'
import { formatCurrency, formatDate } from '../utils/formatters'
import { api } from '../utils/api'
import { useFinanceStore } from '../stores/finance'
import { useTransactionEdit } from '../composables/useTransactionEdit'

const { open: openEditModal } = useTransactionEdit()
const { globalRefreshTrigger } = useRefresh()
const financeStore = useFinanceStore()
const toast = useToast()

watch(globalRefreshTrigger, () => {
  fetchLedgerData()
  financeStore.loadBaseData(true)
})

// 1. Estados Reativos dos Filtros
const searchQuery = ref('')
const selectedStatus = ref('all') // 'all', 'realized', 'pending'
const selectedType = ref('all')   // 'all', 'income', 'expense', 'transfer'
const simulationFilter = ref('exclude_simulated') // 'exclude_simulated', 'only_simulated', 'all'
const scheduledFilter = ref('all') // 'all', 'only_scheduled', 'exclude_scheduled'

// 2. Estados de Paginação e Dados
const transactions = ref<any[]>([])
const page = ref(1)
const perPage = ref(20)
const totalItems = ref(0)
const totalPages = ref(0)
const isLoading = ref(false)

// Opções para os Selects
const statusOptions = [
  { label: 'Todos os Status', value: 'all' },
  { label: 'Realizados', value: 'realized' },
  { label: 'Pendentes', value: 'pending' }
]

const typeOptions = [
  { label: 'Todos os Tipos', value: 'all' },
  { label: 'Receitas', value: 'income' },
  { label: 'Despesas', value: 'expense' },
  { label: 'Transferências', value: 'transfer' }
]

const simulationOptions = [
  { label: 'Apenas Reais', value: 'exclude_simulated' },
  { label: 'Apenas Simulações', value: 'only_simulated' },
  { label: 'Misturado', value: 'all' }
]

const scheduledOptions = [
  { label: 'Todos', value: 'all' },
  { label: 'Apenas Agendados', value: 'only_scheduled' },
  { label: 'Sem Agendados', value: 'exclude_scheduled' }
]

// 3. Construtor de Filtros Estritos (Sintaxe PocketBase)
const filterString = computed(() => {
  const conditions = []

  if (searchQuery.value) {
    conditions.push(`title ~ '${searchQuery.value}'`)
  }
  if (selectedStatus.value !== 'all') {
    conditions.push(`status = '${selectedStatus.value}'`)
  }
  if (selectedType.value !== 'all') {
    conditions.push(`type = '${selectedType.value}'`)
  }

  // Regra de Isolamento de Simulação
  if (simulationFilter.value === 'exclude_simulated') {
    conditions.push(`is_simulated = false`)
  } else if (simulationFilter.value === 'only_simulated') {
    conditions.push(`is_simulated = true`)
  }

  // Regra de Isolamento de Agendados
  if (scheduledFilter.value === 'only_scheduled') {
    conditions.push(`is_scheduled = true`)
  } else if (scheduledFilter.value === 'exclude_scheduled') {
    conditions.push(`is_scheduled = false`)
  }

  return conditions.join(' && ')
})

// 4. Função de Busca no BFF
async function fetchLedgerData() {
  isLoading.value = true
  try {
    const res = await api.api.transactions.get({
      query: {
        page: String(page.value),
        perPage: String(perPage.value),
        sort: '-expected_date',
        filter: filterString.value || undefined
      }
    })

    if (!res.error) {
      const data: any = res.data
      transactions.value = data.items || []
      totalItems.value = data.totalItems || 0
      totalPages.value = data.totalPages || 0
    }
  } catch (err) {
    console.error('Falha na busca do Ledger:', err)
  } finally {
    isLoading.value = false
  }
}

let searchTimeout: any = null
const onSearchInput = () => {
  if (searchTimeout) clearTimeout(searchTimeout)
  searchTimeout = setTimeout(() => {
    page.value = 1
    fetchLedgerData()
  }, 300)
}

watch([selectedStatus, selectedType, simulationFilter, scheduledFilter], () => {
  page.value = 1
  fetchLedgerData()
})

watch(page, () => {
  fetchLedgerData()
})

onMounted(() => {
  fetchLedgerData()
})

// Mapeamento de Colunas do Grid
const columns = [
  { key: 'expected_date', label: 'Data' },
  { key: 'title', label: 'Título' },
  { key: 'account_or_card', label: 'Conta/Cartão' },
  { key: 'status', label: 'Status' },
  { key: 'amount', label: 'Valor' },
  { key: 'actions' }
]

// ----------------------------------------------------
// Lógica de Efetivação (Tornar Real)
// ----------------------------------------------------
const isConversionModalOpen = ref(false)
const selectedTxnToEfectuate = ref<any>(null)
const conversionSource = ref('account')
const targetAccountId = ref('')
const targetCardId = ref('')
const destinationId = ref('')
const isConverting = ref(false)

const mapActionsMenu = (row: any) => {
  const baseActions = [
    { 
      label: 'Editar registro', 
      icon: 'i-heroicons-pencil-square', 
      click: () => {
        openEditModal(row)
      }
    },
    { 
      label: 'Excluir registro', 
      icon: 'i-heroicons-trash', 
      click: async () => {
        if (confirm('Tem certeza que deseja excluir esta transação?')) {
          await api.api.transactions({ id: row.id }).delete()
          fetchLedgerData()
          financeStore.loadBaseData()
        }
      }
    }
  ]

  if (row.is_simulated) {
    baseActions.unshift({
      label: 'Efetivar (Tornar Real)',
      icon: 'i-heroicons-bolt',
      click: () => openConversionModal(row)
    })
  }

  return [baseActions]
}

function openConversionModal(txn: any) {
  selectedTxnToEfectuate.value = txn
  conversionSource.value = 'account'
  targetAccountId.value = ''
  targetCardId.value = ''
  destinationId.value = ''
  isConversionModalOpen.value = true
}

async function confirmRealityConversion() {
  if (conversionSource.value === 'account' && !targetAccountId.value && selectedTxnToEfectuate.value.type !== 'transfer') {
    toast.add({ title: 'Selecione uma conta.', color: 'red' })
    return
  }
  if (conversionSource.value === 'card' && !targetCardId.value) {
    toast.add({ title: 'Selecione um cartão.', color: 'red' })
    return
  }
  if (selectedTxnToEfectuate.value.type === 'transfer' && (!targetAccountId.value || !destinationId.value)) {
    toast.add({ title: 'Selecione conta de origem e destino.', color: 'red' })
    return
  }

  isConverting.value = true
  try {
    const id = selectedTxnToEfectuate.value.id
    
    const payload: any = {
      is_simulated: false,
      status: 'pending' // Default, mas mudamos se for conta
    }

    if (selectedTxnToEfectuate.value.type === 'transfer') {
      payload.account_id = targetAccountId.value
      payload.destination_account_id = destinationId.value
      payload.status = 'realized'
      payload.realized_date = new Date().toISOString()
    } else {
      if (conversionSource.value === 'account') {
        payload.account_id = targetAccountId.value
        payload.card_id = null
        if (selectedTxnToEfectuate.value.type === 'expense') {
          payload.status = 'realized'
          payload.realized_date = new Date().toISOString()
        }
      } else {
        payload.card_id = targetCardId.value
        payload.account_id = null
      }
    }

    const res = await api.api.transactions({ id }).patch(payload)
    if (res.error) throw res.error

    toast.add({ title: 'Transação materializada no caixa!', color: 'emerald' })
    isConversionModalOpen.value = false
    
    fetchLedgerData()
    financeStore.loadBaseData() 

  } catch (err) {
    console.error('Erro na mutação de realidade:', err)
    toast.add({ title: 'Erro ao materializar transação', color: 'red' })
  } finally {
    isConverting.value = false
  }
}

// Helpers
const getEntityName = (row: any) => {
  if (row.type === 'transfer') {
    const src = financeStore.accounts.find(a => a.id === row.account_id)?.name || '?'
    const dst = financeStore.accounts.find(a => a.id === row.destination_account_id)?.name || '?'
    return `${src} → ${dst}`
  }
  if (row.card_id) {
    return financeStore.cards.find(c => c.id === row.card_id)?.name || 'Cartão'
  }
  if (row.account_id) {
    return financeStore.accounts.find(a => a.id === row.account_id)?.name || 'Conta'
  }
  return '—'
}

const accountOptions = computed(() => financeStore.accounts.map(a => ({ label: a.name, value: a.id })))
const cardOptions = computed(() => financeStore.cards.map(c => ({ label: c.name, value: c.id })))
</script>

<template>
  <div class="p-6 max-w-7xl mx-auto space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-3xl font-bold tracking-tight text-white flex items-center gap-2">
        <UIcon name="i-heroicons-document-text" class="w-8 h-8 text-zinc-400" />
        Auditoria (Ledger)
      </h1>
    </div>

    <!-- Filtros -->
    <UCard :ui="{ background: 'bg-zinc-900', ring: 'ring-1 ring-zinc-800' }">
      <div class="grid grid-cols-1 md:grid-cols-5 gap-4">
        <UFormGroup label="Buscar">
          <UInput 
            v-model="searchQuery" 
            placeholder="Buscar lançamentos..." 
            icon="i-heroicons-magnifying-glass"
            @input="onSearchInput"
          />
        </UFormGroup>
        <UFormGroup label="Status">
          <USelect v-model="selectedStatus" :options="statusOptions" />
        </UFormGroup>
        <UFormGroup label="Tipo">
          <USelect v-model="selectedType" :options="typeOptions" />
        </UFormGroup>
        <UFormGroup label="Simulação">
          <USelect v-model="simulationFilter" :options="simulationOptions" />
        </UFormGroup>
        <UFormGroup label="Contas Agendadas">
          <USelect v-model="scheduledFilter" :options="scheduledOptions" />
        </UFormGroup>
      </div>
    </UCard>

    <!-- Grid -->
    <UCard :ui="{ background: 'bg-zinc-900', ring: 'ring-1 ring-zinc-800', body: { padding: '' } }">
      <UTable 
        :rows="transactions" 
        :columns="columns" 
        :loading="isLoading"
      >
        <template #expected_date-data="{ row }">
          <span class="text-sm" :class="{ 'italic text-purple-400': row.is_simulated, 'text-zinc-400': !row.is_simulated }">
            {{ formatDate(row.expected_date) }}
          </span>
        </template>
        
        <template #title-data="{ row }">
          <div class="flex items-center gap-2">
            <UIcon v-if="row.is_scheduled" name="i-heroicons-calendar-days" class="w-4 h-4 text-amber-400 flex-shrink-0" />
            <span :class="{ 'italic text-purple-400': row.is_simulated, 'text-white': !row.is_simulated }">
              {{ row.title }}
            </span>
            <UBadge v-if="row.is_simulated" color="purple" variant="subtle" size="xs">Simulado</UBadge>
            <UBadge v-if="row.is_scheduled" color="amber" variant="subtle" size="xs">Agendado</UBadge>
          </div>
        </template>

        <template #account_or_card-data="{ row }">
          <span class="text-sm text-zinc-400">
            {{ getEntityName(row) }}
          </span>
        </template>

        <template #status-data="{ row }">
          <UBadge v-if="row.status === 'realized'" color="emerald" variant="subtle" size="xs">Realizado</UBadge>
          <UBadge v-else-if="row.is_scheduled" color="amber" variant="subtle" size="xs">Agendado</UBadge>
          <UBadge v-else color="yellow" variant="subtle" size="xs">Pendente</UBadge>
        </template>

        <template #amount-data="{ row }">
          <span 
            class="font-mono text-sm font-medium"
            :class="{
              'text-zinc-500': row.type === 'transfer',
              'text-emerald-400': row.type === 'income',
              'text-red-400': row.type === 'expense',
              'italic opacity-80': row.is_simulated
            }"
          >
            {{ row.type === 'transfer' ? formatCurrency(row.amount) : (row.type === 'expense' ? '-' : '+') + formatCurrency(row.amount) }}
          </span>
        </template>

        <template #actions-data="{ row }">
          <UDropdown :items="mapActionsMenu(row)">
            <UButton color="gray" variant="ghost" icon="i-heroicons-ellipsis-horizontal-20-solid" />
          </UDropdown>
        </template>
      </UTable>

      <div class="flex justify-between items-center p-4 border-t border-zinc-800">
        <div class="text-sm text-zinc-500">
          Total de {{ totalItems }} registros
        </div>
        <UPagination 
          v-model="page" 
          :total="totalItems" 
          :page-count="perPage" 
          :max="7"
        />
      </div>
    </UCard>

    <!-- Modal de Conversão de Cenário -->
    <UModal v-model="isConversionModalOpen">
      <UCard :ui="{ ring: '', divide: 'divide-y divide-zinc-800', background: 'bg-zinc-900' }">
        <template #header>
          <h3 class="text-lg font-semibold text-white flex items-center gap-2">
            <UIcon name="i-heroicons-bolt" class="text-emerald-400" />
            Efetivar Simulação
          </h3>
          <p class="text-sm text-zinc-400 mt-1">
            Escolha a origem real para materializar "{{ selectedTxnToEfectuate?.title }}" no caixa.
          </p>
        </template>
        
        <div class="space-y-4">
          <UFormGroup v-if="selectedTxnToEfectuate?.type !== 'transfer'" label="Forma de Pagamento">
            <div class="flex gap-4">
              <URadio v-model="conversionSource" value="account" label="Conta" />
              <URadio v-model="conversionSource" value="card" label="Cartão" />
            </div>
          </UFormGroup>

          <UFormGroup v-if="selectedTxnToEfectuate?.type === 'transfer' || conversionSource === 'account'" :label="selectedTxnToEfectuate?.type === 'transfer' ? 'Conta de Origem' : 'Selecione a Conta'">
            <USelect v-model="targetAccountId" :options="accountOptions" placeholder="Selecione a conta" />
          </UFormGroup>

          <UFormGroup v-if="selectedTxnToEfectuate?.type === 'transfer'" label="Conta de Destino">
            <USelect v-model="destinationId" :options="accountOptions" placeholder="Selecione a conta destino" />
          </UFormGroup>

          <UFormGroup v-if="selectedTxnToEfectuate?.type !== 'transfer' && conversionSource === 'card'" label="Selecione o Cartão">
            <USelect v-model="targetCardId" :options="cardOptions" placeholder="Selecione o cartão" />
          </UFormGroup>
        </div>

        <template #footer>
          <div class="flex justify-end gap-3">
            <UButton label="Cancelar" variant="ghost" color="gray" @click="isConversionModalOpen = false" />
            <UButton label="Tornar Real" color="emerald" :loading="isConverting" @click="confirmRealityConversion" />
          </div>
        </template>
      </UCard>
    </UModal>
  </div>
</template>
