<script setup lang="ts">
import { ref, watch, computed, onMounted, onUnmounted } from 'vue'
import { formatCurrency, formatDate } from '../utils/formatters'
import { api } from '../utils/api'
import { useFinanceStore } from '../stores/finance'
import { useTransactionEdit } from '../composables/useTransactionEdit'
import type { Transaction } from '../../server/src/domain/entities/Transaction'
import type { TransactionListItem, TransactionQueryFilters, TransactionSummary } from '../../server/src/domain/interfaces/TransactionQuery'

type LedgerSortField = 'expected_date' | 'realized_date' | 'amount' | 'created'


const { open: openEditModal } = useTransactionEdit()
const { globalRefreshTrigger } = useRefresh()
const financeStore = useFinanceStore()
const toast = useToast()

// 1. Filtro states (structured params — no PocketBase filter syntax built client-side)
const searchQuery = ref('')
const selectedStatus = ref<TransactionQueryFilters['status']>('all')
const selectedType = ref<TransactionQueryFilters['type']>('all')
const simulationFilter = ref<TransactionQueryFilters['simulation']>('real')
const scheduledFilter = ref<TransactionQueryFilters['scheduled']>('all')
const dateFrom = ref('')
const dateTo = ref('')
const accountIdFilter = ref('')
const cardIdFilter = ref('')
const categoryIdFilter = ref('')
const sortField = ref<LedgerSortField>('expected_date')
const sortDirection = ref<'asc' | 'desc'>('desc')

// 2. Data states
const transactions = ref<TransactionListItem[]>([])
const page = ref(1)
const perPage = ref(20)
const totalItems = ref(0)
const totalPages = ref(0)
const isLoading = ref(false)
const fetchError = ref('')
const summary = ref<TransactionSummary>({ incomeTotal: 0, expenseTotal: 0, netTotal: 0, count: 0 })

// Options
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
  { label: 'Apenas Reais', value: 'real' },
  { label: 'Apenas Simulações', value: 'simulated' },
  { label: 'Misturado', value: 'all' }
]

const scheduledOptions = [
  { label: 'Todos', value: 'all' },
  { label: 'Apenas Agendados', value: 'scheduled' },
  { label: 'Sem Agendados', value: 'unscheduled' }
]

const sortFieldOptions = [
  { label: 'Data Prevista', value: 'expected_date' },
  { label: 'Data Realizada', value: 'realized_date' },
  { label: 'Valor', value: 'amount' },
  { label: 'Data de Criação', value: 'created' }
]

const sortDirectionOptions = [
  { label: 'Descendente', value: 'desc' },
  { label: 'Ascendente', value: 'asc' }
]

// Entity selects (financeStore is loaded globally; base data refreshed on mount below)
const accountOptions = computed(() => financeStore.accounts.map(a => ({ label: a.name, value: a.id })))
const cardOptions = computed(() => financeStore.cards.map(c => ({ label: c.name, value: c.id })))
const categoryOptions = computed(() => financeStore.categories.map(c => ({ label: c.name, value: c.id })))

const anyEntityOption = { label: 'Todas', value: '' }
const accountFilterOptions = computed(() => [anyEntityOption, ...accountOptions.value])
const cardFilterOptions = computed(() => [anyEntityOption, ...cardOptions.value])
const categoryFilterOptions = computed(() => [anyEntityOption, ...categoryOptions.value])

// Structured filters are shared by the list and summary requests; sorting and
// pagination belong only to the list request.
const dateFieldComputed = computed<TransactionQueryFilters['dateField']>(() =>
  selectedStatus.value === 'realized' ? 'realized_date' : 'expected_date'
)

function buildFilters(): TransactionQueryFilters {
  const filters: TransactionQueryFilters = {};
  const search = searchQuery.value.trim();
  if (search) filters.search = search;
  if (selectedStatus.value && selectedStatus.value !== 'all') filters.status = selectedStatus.value;
  if (selectedType.value && selectedType.value !== 'all') filters.type = selectedType.value;
  if (simulationFilter.value && simulationFilter.value !== 'all') filters.simulation = simulationFilter.value;
  if (scheduledFilter.value && scheduledFilter.value !== 'all') filters.scheduled = scheduledFilter.value;
  if (accountIdFilter.value) filters.accountId = accountIdFilter.value;
  if (cardIdFilter.value) filters.cardId = cardIdFilter.value;
  if (categoryIdFilter.value) filters.categoryId = categoryIdFilter.value;
  if (dateFrom.value) filters.dateFrom = dateFrom.value;
  if (dateTo.value) filters.dateTo = dateTo.value;
  if (dateFrom.value || dateTo.value) filters.dateField = dateFieldComputed.value;
  return filters;
}

function buildSort(): string {
  return `${sortDirection.value === 'desc' ? '-' : ''}${sortField.value}`;
}

// 4. Fetch list + summary using one filter snapshot.
let latestRequestId = 0;
function clearLedgerData() {
  transactions.value = [];
  totalItems.value = 0;
  totalPages.value = 0;
  summary.value = { incomeTotal: 0, expenseTotal: 0, netTotal: 0, count: 0 };
}

async function fetchLedgerData() {
  const requestId = ++latestRequestId;
  const filters = buildFilters();
  isLoading.value = true;
  fetchError.value = '';

  try {
    const query = {
      ...filters,
      page: String(page.value),
      perPage: String(perPage.value),
      sort: buildSort(),
      expandInvoice: 'true' as const
    };
    const [resList, resSummary] = await Promise.all([
      api.api.transactions.get({ query }),
      api.api.transactions.summary.get({ query: filters })
    ]);
    if (requestId !== latestRequestId) return;

    const errors: string[] = [];
    if (resList.error) errors.push('Falha ao carregar os lançamentos');
    if (resSummary.error) errors.push('Falha ao carregar os totais');
    if (errors.length > 0) {
      fetchError.value = errors.join(' · ');
      clearLedgerData();
      toast.add({ title: fetchError.value, color: 'red' });
      return;
    }

    if (!resList.data || !resSummary.data) {
      throw new Error('Resposta incompleta do servidor');
    }
    transactions.value = resList.data.items;
    totalItems.value = resList.data.totalItems;
    totalPages.value = resList.data.totalPages;
    summary.value = resSummary.data;
  } catch {
    if (requestId !== latestRequestId) return;
    fetchError.value = 'Erro de rede ao buscar o ledger';
    clearLedgerData();
    toast.add({ title: fetchError.value, color: 'red' });
  } finally {
    if (requestId === latestRequestId) isLoading.value = false;
  }
}

// Debounced plain-text search; no PocketBase syntax is constructed in the UI.
let searchTimeout: ReturnType<typeof setTimeout> | undefined;
const onSearchInput = () => {
  if (searchTimeout) clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    if (page.value !== 1) page.value = 1;
    else void fetchLedgerData();
  }, 300);
};

// Filter/sort changes return to the first page; changing page itself fetches once.
watch([
  selectedStatus,
  selectedType,
  simulationFilter,
  scheduledFilter,
  accountIdFilter,
  cardIdFilter,
  categoryIdFilter,
  dateFrom,
  dateTo,
  sortField,
  sortDirection
], () => {
  if (page.value !== 1) page.value = 1;
  else void fetchLedgerData();
});

watch(page, () => void fetchLedgerData());
watch(globalRefreshTrigger, () => {
  void fetchLedgerData();
  void financeStore.loadBaseData(true);
});

onMounted(() => {
  void financeStore.loadBaseData();
  void fetchLedgerData();
});

// 5. Table columns
const columns = [
  { key: 'expected_date', label: 'Data' },
  { key: 'title', label: 'Título' },
  { key: 'account_or_card', label: 'Conta/Cartão' },
  { key: 'status', label: 'Status' },
  { key: 'amount', label: 'Valor' },
  { key: 'actions' }
]

// 6. Narrow-viewport state: on very small phones the pagination window shrinks
const isNarrowViewport = ref(false)
let narrowViewportQuery: MediaQueryList | undefined
function onViewportChange(event: MediaQueryListEvent) {
  isNarrowViewport.value = event.matches
}

onMounted(() => {
  narrowViewportQuery = window.matchMedia('(max-width: 380px)');
  isNarrowViewport.value = narrowViewportQuery.matches;
  narrowViewportQuery.addEventListener('change', onViewportChange);
})

onUnmounted(() => {
  narrowViewportQuery?.removeEventListener('change', onViewportChange)
})

// ----------------------------------------------------
// Mobile card presentation (mirrors the table cells; desktop table untouched)
// ----------------------------------------------------
const getDisplayDate = (row: TransactionListItem) =>
  selectedStatus.value === 'realized' ? (row.realized_date || row.expected_date) : row.expected_date

/** Only the color literals supported by UBadge (Nuxt UI theme + default badge config keys). */
type TransactionBadgeColor =
  | 'white' | 'black' | 'gray'
  | 'red' | 'orange' | 'amber' | 'yellow' | 'lime' | 'green' | 'emerald'
  | 'teal' | 'cyan' | 'sky' | 'blue' | 'indigo' | 'violet' | 'purple'
  | 'fuchsia' | 'pink' | 'rose' | 'primary'

interface TransactionStatusBadge {
  label: string
  color: TransactionBadgeColor
}

const getStatusBadge = (row: TransactionListItem): TransactionStatusBadge => {
  if (row.status === 'realized') return { label: 'Realizado', color: 'emerald' }
  if (row.is_scheduled) return { label: 'Agendado', color: 'amber' }
  return { label: 'Pendente', color: 'yellow' }
}

const getTitleBadges = (row: TransactionListItem): TransactionStatusBadge[] => {
  const invoiceBadge = getInvoiceBadge(row)
  return ([
    row.is_simulated ? { label: 'Simulado', color: 'purple' } : null,
    row.is_scheduled ? { label: 'Agendado', color: 'amber' } : null,
    row.is_silent ? { label: 'Silencioso', color: 'gray' } : null,
    invoiceBadge ? { label: invoiceBadge, color: 'blue' } : null,
    row.recurrence_id ? { label: 'Recorrente', color: 'cyan' } : null
  ].filter((badge): badge is TransactionStatusBadge => badge !== null))
}

const getAmountClass = (row: TransactionListItem) => ({
  'text-zinc-500': row.type === 'transfer',
  'text-emerald-400': row.type === 'income',
  'text-red-400': row.type === 'expense',
  'italic opacity-80': row.is_simulated
})

const getAmountLabel = (row: TransactionListItem) =>
  row.type === 'transfer'
    ? formatCurrency(row.amount)
    : (row.type === 'expense' ? '-' : '+') + formatCurrency(row.amount)

// ----------------------------------------------------
// Lifecycle badge helpers (silent / invoice / recurrence)
// ----------------------------------------------------
const getInvoiceBadge = (row: TransactionListItem) => {
  if (!row.invoice_id) return null
  return row.invoice_period ? `Fatura ${row.invoice_period}` : 'Faturada'
}

// ----------------------------------------------------
// Delete via in-page UModal (no confirm())
// ----------------------------------------------------
const isDeleteModalOpen = ref(false)
const txnToDelete = ref<TransactionListItem | null>(null)
const isDeleting = ref(false)

function openDeleteModal(txn: TransactionListItem) {
  txnToDelete.value = txn
  isDeleteModalOpen.value = true
}

async function confirmDelete() {
  if (!txnToDelete.value) return
  isDeleting.value = true
  try {
    const res = await api.api.transactions({ id: txnToDelete.value.id }).delete()
    if (res.error) throw res.error
    toast.add({ title: 'Transação excluída.', color: 'emerald' })
    isDeleteModalOpen.value = false
    txnToDelete.value = null
    fetchLedgerData()
    financeStore.loadBaseData()
  } catch {
    toast.add({ title: 'Erro ao excluir transação', color: 'red' })
  } finally {
    isDeleting.value = false
  }
}

// ----------------------------------------------------
// Actions menu
// ----------------------------------------------------
const mapActionsMenu = (row: TransactionListItem) => {
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
      click: () => openDeleteModal(row)
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

// ----------------------------------------------------
// Reality conversion (simulated → real)
// ----------------------------------------------------
const isConversionModalOpen = ref(false)
const selectedTxnToEfectuate = ref<TransactionListItem | null>(null)
const conversionSource = ref<'account' | 'card'>('account')
const targetAccountId = ref('')
const targetCardId = ref('')
const destinationId = ref('')
const isConverting = ref(false)

function openConversionModal(txn: TransactionListItem) {
  selectedTxnToEfectuate.value = txn
  conversionSource.value = 'account'
  targetAccountId.value = ''
  targetCardId.value = ''
  destinationId.value = ''
  isConversionModalOpen.value = true
}

async function confirmRealityConversion() {
  const transaction = selectedTxnToEfectuate.value;
  if (!transaction) return;

  if (conversionSource.value === 'account' && !targetAccountId.value && transaction.type !== 'transfer') {
    toast.add({ title: 'Selecione uma conta.', color: 'red' });
    return;
  }
  if (conversionSource.value === 'card' && !targetCardId.value) {
    toast.add({ title: 'Selecione um cartão.', color: 'red' });
    return;
  }
  if (transaction.type === 'transfer' && (!targetAccountId.value || !destinationId.value)) {
    toast.add({ title: 'Selecione conta de origem e destino.', color: 'red' });
    return;
  }

  isConverting.value = true;
  try {
    const payload: Partial<Transaction> = {
      is_simulated: false,
      status: 'pending'
    };

    if (transaction.type === 'transfer') {
      payload.account_id = targetAccountId.value;
      payload.destination_account_id = destinationId.value;
      payload.status = 'realized';
      payload.realized_date = new Date().toISOString();
    } else if (conversionSource.value === 'account') {
      payload.account_id = targetAccountId.value;
      payload.card_id = '';
      if (transaction.type === 'expense') {
        payload.status = 'realized';
        payload.realized_date = new Date().toISOString();
      }
    } else {
      payload.card_id = targetCardId.value;
      payload.account_id = '';
    }

    const res = await api.api.transactions({ id: transaction.id }).patch(payload);
    if (res.error) throw res.error;

    toast.add({ title: 'Transação materializada no caixa!', color: 'emerald' });
    isConversionModalOpen.value = false;
    void fetchLedgerData();
    void financeStore.loadBaseData();
  } catch {
    toast.add({ title: 'Erro ao materializar transação', color: 'red' });
  } finally {
    isConverting.value = false;
  }
}

// ----------------------------------------------------
// CSV export of the current filter set (cap 1000 rows)
// ----------------------------------------------------
const EXPORT_CAP = 1000;
const isExporting = ref(false);

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /["\n\r,;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function exportCsv() {
  isExporting.value = true;
  try {
    const filters = buildFilters();
    const sort = buildSort();
    const rows: TransactionListItem[] = [];
    let exportTotalItems = 0;
    let pagesFetched = 0;

    while (rows.length < EXPORT_CAP) {
      const response = await api.api.transactions.get({
        query: {
          ...filters,
          sort,
          expandInvoice: 'true',
          page: String(pagesFetched + 1),
          perPage: String(Math.min(100, EXPORT_CAP - rows.length))
        }
      });
      if (response.error || !response.data) throw new Error('Ledger export request failed');
      if (pagesFetched === 0) exportTotalItems = response.data.totalItems;
      const items = response.data.items;
      if (items.length === 0) break;
      rows.push(...items);
      pagesFetched += 1;
      if (rows.length >= exportTotalItems) break;
    }

    const truncated = rows.length >= EXPORT_CAP && rows.length < exportTotalItems;

    const header = [
      'id', 'title', 'amount', 'type', 'status',
      'expected_date', 'realized_date',
      'account_id', 'card_id', 'destination_account_id', 'category_id',
      'is_simulated', 'is_scheduled', 'is_silent', 'invoice_id', 'invoice_period', 'recurrence_id',
      'created'
    ];
    const lines = [header.join(',')];
    for (const transaction of rows) {
      lines.push([
        csvEscape(transaction.id), csvEscape(transaction.title), csvEscape(transaction.amount),
        csvEscape(transaction.type), csvEscape(transaction.status),
        csvEscape(transaction.expected_date), csvEscape(transaction.realized_date),
        csvEscape(transaction.account_id), csvEscape(transaction.card_id),
        csvEscape(transaction.destination_account_id), csvEscape(transaction.category_id),
        csvEscape(transaction.is_simulated ? 'true' : 'false'),
        csvEscape(transaction.is_scheduled ? 'true' : 'false'),
        csvEscape(transaction.is_silent ? 'true' : 'false'),
        csvEscape(transaction.invoice_id), csvEscape(transaction.invoice_period),
        csvEscape(transaction.recurrence_id), csvEscape(transaction.created)
      ].join(','));
    }

    const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `obol-ledger-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);

    if (truncated) {
      toast.add({ title: `Exportação limitada aos primeiros ${EXPORT_CAP} registros de ${exportTotalItems}.`, color: 'amber' });
    } else {
      toast.add({ title: `CSV exportado com ${rows.length} registros.`, color: 'emerald' });
    }
  } catch {
    toast.add({ title: 'Erro ao exportar CSV', color: 'red' });
  } finally {
    isExporting.value = false;
  }
}



// Helpers
const getEntityName = (row: TransactionListItem) => {
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
</script>

<template>
  <div class="p-4 sm:p-6 max-w-7xl mx-auto space-y-6">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="text-2xl sm:text-3xl font-bold tracking-tight text-white flex items-center gap-2 min-w-0">
        <UIcon name="i-heroicons-document-text" class="w-6 h-6 sm:w-8 sm:h-8 text-zinc-400 flex-shrink-0" />
        Auditoria (Ledger)
      </h1>
      <UButton
        label="Exportar CSV"
        icon="i-heroicons-arrow-down-tray"
        color="gray"
        variant="soft"
        :loading="isExporting"
        @click="exportCsv"
      />
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
        <UFormGroup label="Agendamento">
          <USelect v-model="scheduledFilter" :options="scheduledOptions" />
        </UFormGroup>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-5 gap-4 mt-4">
        <UFormGroup label="Conta">
          <USelect v-model="accountIdFilter" :options="accountFilterOptions" />
        </UFormGroup>
        <UFormGroup label="Cartão">
          <USelect v-model="cardIdFilter" :options="cardFilterOptions" />
        </UFormGroup>
        <UFormGroup label="Categoria">
          <USelect v-model="categoryIdFilter" :options="categoryFilterOptions" />
        </UFormGroup>
        <UFormGroup label="Data Inicial">
          <UInput v-model="dateFrom" type="date" />
        </UFormGroup>
        <UFormGroup label="Data Final">
          <div class="space-y-2">
            <UInput v-model="dateTo" type="date" />
            <p class="text-xs text-zinc-500">
              Campo: {{ selectedStatus === 'realized' ? 'Data Realizada' : 'Data Prevista' }}
            </p>
          </div>
        </UFormGroup>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4">
        <UFormGroup label="Ordenar por">
          <USelect v-model="sortField" :options="sortFieldOptions" />
        </UFormGroup>
        <UFormGroup label="Direção">
          <USelect v-model="sortDirection" :options="sortDirectionOptions" />
        </UFormGroup>
      </div>
    </UCard>

    <!-- Resumo do conjunto filtrado -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <UCard :ui="{ background: 'bg-zinc-900', ring: 'ring-1 ring-zinc-800', body: { padding: 'px-4 py-3' } }">
        <p class="text-xs uppercase tracking-wide text-zinc-500">Entradas</p>
        <p class="text-base sm:text-lg font-semibold text-emerald-400 font-mono">{{ formatCurrency(summary.incomeTotal) }}</p>
      </UCard>
      <UCard :ui="{ background: 'bg-zinc-900', ring: 'ring-1 ring-zinc-800', body: { padding: 'px-4 py-3' } }">
        <p class="text-xs uppercase tracking-wide text-zinc-500">Saídas</p>
        <p class="text-base sm:text-lg font-semibold text-red-400 font-mono">{{ formatCurrency(summary.expenseTotal) }}</p>
      </UCard>
      <UCard :ui="{ background: 'bg-zinc-900', ring: 'ring-1 ring-zinc-800', body: { padding: 'px-4 py-3' } }">
        <p class="text-xs uppercase tracking-wide text-zinc-500">Saldo</p>
        <p class="text-base sm:text-lg font-semibold font-mono" :class="summary.netTotal >= 0 ? 'text-white' : 'text-red-400'">
          {{ formatCurrency(summary.netTotal) }}
        </p>
      </UCard>
      <UCard :ui="{ background: 'bg-zinc-900', ring: 'ring-1 ring-zinc-800', body: { padding: 'px-4 py-3' } }">
        <p class="text-xs uppercase tracking-wide text-zinc-500">Registros (incl. transferências)</p>
        <p class="text-base sm:text-lg font-semibold text-white font-mono">{{ summary.count }}</p>
      </UCard>
    </div>

    <UAlert
      v-if="fetchError"
      icon="i-heroicons-exclamation-triangle"
      color="red"
      variant="subtle"
      :title="fetchError"
    />

    <!-- Grid -->
    <UCard :ui="{ background: 'bg-zinc-900', ring: 'ring-1 ring-zinc-800', body: { padding: '' } }">
      <div class="hidden md:block">
        <UTable
          :rows="transactions"
          :columns="columns"
          :loading="isLoading"
        >
        <template #expected_date-data="{ row }">
          <span class="text-sm" :class="{ 'italic text-purple-400': row.is_simulated, 'text-zinc-400': !row.is_simulated }">
            {{ formatDate(selectedStatus === 'realized' ? (row.realized_date || row.expected_date) : row.expected_date) }}
          </span>
        </template>

        <template #title-data="{ row }">
          <div class="flex items-center gap-2 flex-wrap">
            <UIcon v-if="row.is_scheduled" name="i-heroicons-calendar-days" class="w-4 h-4 text-amber-400 flex-shrink-0" />
            <span :class="{ 'italic text-purple-400': row.is_simulated, 'text-white': !row.is_simulated }">
              {{ row.title }}
            </span>
            <UBadge v-if="row.is_simulated" color="purple" variant="subtle" size="xs">Simulado</UBadge>
            <UBadge v-if="row.is_scheduled" color="amber" variant="subtle" size="xs">Agendado</UBadge>
            <UBadge v-if="row.is_silent" color="gray" variant="subtle" size="xs">Silencioso</UBadge>
            <UBadge v-if="getInvoiceBadge(row)" color="blue" variant="subtle" size="xs">{{ getInvoiceBadge(row) }}</UBadge>
            <UBadge v-if="row.recurrence_id" color="cyan" variant="subtle" size="xs">Recorrente</UBadge>
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
      </div>

      <!-- Mobile list: on narrow screens transactions render as cards -->
      <div class="md:hidden p-3 space-y-2">
        <div v-if="isLoading && transactions.length === 0" class="space-y-2" aria-hidden="true">
          <div v-for="i in 3" :key="i" class="h-20 rounded-xl bg-zinc-800/60 animate-pulse" />
        </div>
        <p v-else-if="transactions.length === 0" class="py-8 text-center text-sm text-zinc-500">
          No entries found.
        </p>
        <template v-else>
          <div
            v-for="row in transactions"
            :key="row.id"
            class="rounded-xl bg-zinc-800/40 ring-1 ring-zinc-800 p-4 space-y-2 active:bg-zinc-800/80"
            @click="openEditModal(row)"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <div class="flex items-start gap-1.5 flex-wrap">
                  <UIcon v-if="row.is_scheduled" name="i-heroicons-calendar-days" class="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                  <p class="font-medium min-w-0 break-words" :class="{ 'italic text-purple-400': row.is_simulated, 'text-white': !row.is_simulated }">
                    {{ row.title }}
                  </p>
                </div>
                <p class="text-xs text-zinc-500 mt-0.5 truncate">{{ getEntityName(row) }}</p>
              </div>
              <span
                class="font-mono text-sm font-medium whitespace-nowrap flex-shrink-0"
                :class="getAmountClass(row)"
              >
                {{ getAmountLabel(row) }}
              </span>
            </div>
            <div class="flex items-end justify-between gap-3">
              <div class="flex items-center gap-1.5 flex-wrap min-w-0">
                <UBadge :color="getStatusBadge(row).color" variant="subtle" size="xs">{{ getStatusBadge(row).label }}</UBadge>
                <span class="text-xs" :class="{ 'italic text-purple-400': row.is_simulated, 'text-zinc-400': !row.is_simulated }">
                  {{ formatDate(getDisplayDate(row)) }}
                </span>
                <UBadge
                  v-for="badge in getTitleBadges(row)"
                  :key="badge.label"
                  :color="badge.color"
                  variant="subtle"
                  size="xs"
                >{{ badge.label }}</UBadge>
              </div>
              <div class="flex-shrink-0" @click.stop>
                <UDropdown :items="mapActionsMenu(row)">
                  <UButton color="gray" variant="ghost" icon="i-heroicons-ellipsis-horizontal-20-solid" />
                </UDropdown>
              </div>
            </div>
          </div>
        </template>
      </div>

      <div class="flex flex-wrap justify-between items-center gap-3 p-4 border-t border-zinc-800">
        <div class="text-sm text-zinc-500">
          Total de {{ totalItems }} registros
        </div>
        <UPagination
          v-model="page"
          :total="totalItems"
          :page-count="perPage"
          :max="isNarrowViewport ? 5 : 7"
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

    <!-- Modal de Exclusão -->
    <UModal v-model="isDeleteModalOpen">
      <UCard :ui="{ ring: '', divide: 'divide-y divide-zinc-800', background: 'bg-zinc-900' }">
        <template #header>
          <h3 class="text-lg font-semibold text-white flex items-center gap-2">
            <UIcon name="i-heroicons-exclamation-triangle" class="text-red-400" />
            Excluir Transação
          </h3>
          <p class="text-sm text-zinc-400 mt-1">
            Tem certeza que deseja excluir "{{ txnToDelete?.title }}"? Esta ação não pode ser desfeita.
          </p>
        </template>

        <template #footer>
          <div class="flex justify-end gap-3">
            <UButton label="Cancelar" variant="ghost" color="gray" @click="isDeleteModalOpen = false" />
            <UButton label="Excluir" color="red" :loading="isDeleting" @click="confirmDelete" />
          </div>
        </template>
      </UCard>
    </UModal>
  </div>
</template>
