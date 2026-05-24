<template>
  <div class="max-w-4xl mx-auto py-8 px-4 sm:px-6 space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-3xl font-bold text-white">Cartões de Crédito</h1>
    </div>

    <!-- Seletor Mestre de Cartão -->
    <div class="w-full md:w-1/3">
      <USelectMenu
        v-model="selectedCardId"
        :options="financeStore.cards"
        value-attribute="id"
        option-attribute="name"
        placeholder="Selecione um cartão"
        icon="i-heroicons-credit-card"
      />
    </div>

    <!-- Timeline de Meses -->
    <div v-if="invoices.length > 0" class="flex items-center space-x-2 overflow-x-auto py-2 scrollbar-hide">
      <UButton
        v-for="inv in invoices"
        :key="inv.period"
        :label="formatPeriod(inv.period)"
        :color="selectedPeriod === inv.period ? 'primary' : 'gray'"
        :variant="selectedPeriod === inv.period ? 'solid' : 'soft'"
        @click="selectedPeriod = inv.period"
        class="capitalize"
      />
    </div>

    <!-- Corpo da Fatura -->
    <div v-if="currentInvoice" class="bg-zinc-900 border border-zinc-800 rounded-xl p-6 space-y-6">
      <div class="flex items-center justify-between border-b border-zinc-800 pb-4">
        <div>
          <p class="text-sm text-zinc-400">Vencimento: {{ new Date(currentInvoice.dueDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) }}</p>
          <div class="flex items-end gap-3 mt-1">
            <div>
              <p class="text-xs text-zinc-500 uppercase font-semibold">Em Aberto</p>
              <p class="text-3xl font-bold text-white">{{ formatCurrency(currentInvoice.totalAmount) }}</p>
            </div>
            <div class="mb-1 hidden sm:block h-8 border-l border-zinc-700"></div>
            <div class="mb-1 hidden sm:block">
              <p class="text-xs text-zinc-500 uppercase font-semibold">Gasto Bruto no Mês</p>
              <p class="text-lg font-medium text-zinc-300">{{ formatCurrency(currentInvoice.totalSpent) }}</p>
            </div>
          </div>
        </div>
        <div class="flex flex-col items-end gap-2">
          <UBadge :color="getStatusProps(currentInvoice.status).color" variant="subtle">
            {{ getStatusProps(currentInvoice.status).label }}
          </UBadge>

          <UButton 
            v-if="currentInvoice.status === 'CLOSED' || currentInvoice.status === 'OPEN'" 
            :label="currentInvoice.status === 'OPEN' ? 'Antecipar Pagamento' : 'Pagar Fatura'" 
            :color="currentInvoice.status === 'OPEN' ? 'blue' : 'primary'" 
            icon="i-heroicons-banknotes"
            :loading="isPaying"
            @click="payInvoice"
          />
        </div>
      </div>

      <!-- Lista de Compras -->
      <div class="space-y-3">
        <h3 class="text-sm font-medium text-zinc-400 uppercase tracking-wider">Compras do Mês</h3>
        
        <div v-if="currentInvoice.transactions.length === 0" class="text-zinc-500 py-4 text-center">
          Nenhuma transação nesta fatura.
        </div>

        <div v-for="txn in currentInvoice.transactions" :key="txn.id" class="flex items-center justify-between p-3 rounded-lg bg-zinc-800/50 hover:bg-zinc-800 transition-colors">
          <div>
            <p class="text-white font-medium">{{ txn.title }}</p>
            <p class="text-xs text-zinc-500">Comprado em: {{ new Date(txn.expected_date).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) }}</p>
          </div>
          <div class="flex items-center gap-4">
            <p class="text-white font-semibold">
              <span v-if="txn.amount < 0" class="text-emerald-400 mr-1">+</span>
              {{ formatCurrency(Math.abs(txn.amount)) }}
            </p>
            <UDropdown :items="getTransactionItems(txn)" :popper="{ placement: 'bottom-end' }">
              <UButton color="gray" variant="ghost" icon="i-heroicons-ellipsis-vertical" class="opacity-50 hover:opacity-100 transition-opacity" />
            </UDropdown>
          </div>
        </div>
      </div>
    </div>
    
    <div v-else-if="selectedCardId && !isLoadingInvoices" class="flex flex-col items-center py-16 text-zinc-500 gap-2">
      <UIcon name="i-heroicons-document-text" class="w-10 h-10" />
      <p>Nenhuma fatura encontrada para este cartão.</p>
    </div>

    <div v-if="isLoadingInvoices" class="flex justify-center py-12">
      <UIcon name="i-heroicons-arrow-path" class="w-8 h-8 animate-spin text-primary" />
    </div>

    <!-- Seleção de Conta para Pagamento -->
    <UModal v-model="isPaymentModalOpen">
      <div class="p-6 space-y-4">
        <h3 class="text-lg font-medium text-white">Pagar Fatura</h3>
        <p class="text-sm text-zinc-400">Selecione de qual conta o valor de {{ formatCurrency(currentInvoice?.totalAmount || 0) }} será debitado.</p>
        
        <UFormGroup label="Valor a Pagar">
          <UInput v-model="amountToPay" type="number" step="0.01" placeholder="Ex: 150.00" />
        </UFormGroup>

        <UFormGroup label="Conta Corrente">
          <USelectMenu
            v-model="paymentAccountId"
            :options="financeStore.accounts"
            value-attribute="id"
            option-attribute="name"
            placeholder="Selecione a conta"
            icon="i-heroicons-building-library"
          />
        </UFormGroup>

        <div class="flex justify-end gap-3 mt-6">
          <UButton label="Cancelar" color="gray" variant="ghost" @click="isPaymentModalOpen = false" />
          <UButton label="Confirmar Pagamento" color="primary" :disabled="!paymentAccountId" :loading="isPaying" @click="confirmPayment" />
        </div>
      </div>
    </UModal>

    <!-- Modal de Edição de Transação -->
    <UModal v-model="isEditModalOpen">
      <div class="p-6 space-y-4">
        <h3 class="text-lg font-medium text-white">Editar Transação</h3>
        
        <div v-if="editingTxn" class="space-y-4">
          <UFormGroup label="Título">
            <UInput v-model="editingTxn.title" placeholder="Ex: Uber" />
          </UFormGroup>
          <UFormGroup label="Valor">
            <UInput v-model="editingTxn.amount" type="number" step="0.01" placeholder="Valor (positivo ou negativo)" />
          </UFormGroup>
          <UFormGroup label="Data da Compra">
            <UInput v-model="editingTxn.expected_date" type="date" />
          </UFormGroup>
        </div>

        <div class="flex justify-end gap-3 mt-6">
          <UButton label="Cancelar" color="gray" variant="ghost" @click="isEditModalOpen = false" />
          <UButton label="Salvar Alterações" color="primary" @click="saveEdit" />
        </div>
      </div>
    </UModal>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed, onMounted } from 'vue'
import { useFinanceStore } from '~/stores/finance'
import { api } from '~/utils/api'
import { formatCurrency, getStatusProps } from '~/utils/formatters'

const financeStore = useFinanceStore()
const toast = useToast()

const selectedCardId = ref<string>('')
const invoices = ref<any[]>([])
const selectedPeriod = ref<string>('')
const isLoadingInvoices = ref(false)

const isPaymentModalOpen = ref(false)
const paymentAccountId = ref<string>('')
const amountToPay = ref<number>(0)
const isPaying = ref(false)

// Carrega os cartões ao montar
onMounted(async () => {
  await financeStore.loadBaseData()
  if (financeStore.cards.length > 0) {
    selectedCardId.value = financeStore.cards[0].id
  }
})

// Reatividade pura: Bate na API sempre que o cartão mudar
watch(selectedCardId, async (newId) => {
  if (!newId) return
  
  isLoadingInvoices.value = true
  invoices.value = []
  selectedPeriod.value = ''

  try {
    const res = await api.api.cards({ id: newId }).invoices.get()
    
    if (res.data && Array.isArray(res.data)) {
      invoices.value = res.data
      
      // Lógica super inteligente para selecionar o mês atual automaticamente
      // Tenta achar a primeira aberta ou fechada
      const current = res.data.find(inv => inv.status === 'OPEN' || inv.status === 'CLOSED')
      if (current) {
        selectedPeriod.value = current.period
      } else if (res.data.length > 0) {
        selectedPeriod.value = res.data[0].period // Fallback para a mais recente
      }
    }
  } catch (error) {
    console.error('Falha ao carregar faturas', error)
    toast.add({ title: 'Erro', description: 'Não foi possível carregar as faturas deste cartão.', color: 'red' })
  } finally {
    isLoadingInvoices.value = false
  }
})

// Ponte reativa para o Corpo da Fatura
const currentInvoice = computed(() => {
  return invoices.value.find(inv => inv.period === selectedPeriod.value)
})

// Formatação do Label do botão de mês (Ex: 2026-05 -> Maio 2026)
const formatPeriod = (period: string) => {
  const [year, month] = period.split('-')
  const date = new Date(parseInt(year), parseInt(month) - 1, 1)
  return new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(date)
}

// Fluxo de Pagamento
const payInvoice = () => {
  paymentAccountId.value = ''
  amountToPay.value = currentInvoice.value?.totalAmount || 0
  isPaymentModalOpen.value = true
}

const confirmPayment = async () => {
  if (!currentInvoice.value || !paymentAccountId.value) return
  
  isPaying.value = true
  try {
    const res = await api.api.cards({ id: selectedCardId.value })['pay-invoice'].post({
      period: currentInvoice.value.period,
      account_id: paymentAccountId.value,
      amount_paid: Number(amountToPay.value)
    })

    if (res.error) {
      toast.add({ title: 'Erro ao Pagar', description: (res.error.value as any)?.error || 'Falha no pagamento', color: 'red' })
      return
    }

    toast.add({ title: 'Fatura Paga!', description: 'Saldos e lançamentos abatidos com sucesso.', color: 'green' })
    isPaymentModalOpen.value = false
    
    // Atualiza os dados recarregando a store (para atualizar o saldo da conta globalmente)
    await financeStore.loadBaseData(true)
    
    // Dispara o re-fetch das faturas reciclando a reatividade do watch
    const currentId = selectedCardId.value
    selectedCardId.value = '' // Reseta temporariamente
    setTimeout(() => {
      selectedCardId.value = currentId // Re-atribui para acionar o watch
    }, 50)

  } catch (error) {
    console.error('Falha ao pagar', error)
    toast.add({ title: 'Erro', description: 'Ocorreu um erro interno ao processar o pagamento.', color: 'red' })
  } finally {
    isPaying.value = false
  }
}

// Menu Contextual e Exclusão
const isEditModalOpen = ref(false)
const editingTxn = ref<any>(null)

const openEditModal = (txn: any) => {
  editingTxn.value = { ...txn, expected_date: txn.expected_date.split('T')[0] } 
  isEditModalOpen.value = true
}

const saveEdit = async () => {
  try {
    const payload = {
      title: editingTxn.value.title,
      amount: Number(editingTxn.value.amount),
      expected_date: new Date(editingTxn.value.expected_date).toISOString()
    }

    const res = await api.api.transactions({ id: editingTxn.value.id }).patch(payload)
    if (res.error) throw new Error("Erro ao salvar.")

    toast.add({ title: 'Gasto atualizado!', color: 'emerald' })
    isEditModalOpen.value = false
    
    // Recarrega as faturas do cartão (Truque rápido do Watcher)
    const tempId = selectedCardId.value
    selectedCardId.value = ''
    setTimeout(() => selectedCardId.value = tempId, 10)
  } catch (err) {
    toast.add({ title: 'Erro', description: 'Não foi possível salvar as alterações', color: 'red' })
  }
}

const getTransactionItems = (txn: any) => [
  [
    {
      label: 'Editar',
      icon: 'i-heroicons-pencil',
      click: () => openEditModal(txn)
    },
    {
      label: 'Excluir',
      icon: 'i-heroicons-trash',
      color: 'red',
      click: () => deleteTransaction(txn.id)
    }
  ]
]

const deleteTransaction = async (id: string) => {
  if (!confirm('Tem certeza que deseja excluir este gasto da fatura?')) return;
  
  try {
    const res = await api.api.transactions({ id }).delete();
    if (res.error) throw new Error('Falha na API');

    toast.add({ title: 'Excluído com sucesso', color: 'gray' });
    
    // Simula recarregamento rápido do watch para recalcular os subtotais na tela
    const tempId = selectedCardId.value;
    selectedCardId.value = '';
    setTimeout(() => selectedCardId.value = tempId, 10);
  } catch (err) {
    toast.add({ title: 'Erro ao excluir', description: 'Tente novamente.', color: 'red' });
  }
};
</script>

<style scoped>
.scrollbar-hide::-webkit-scrollbar {
  display: none;
}
.scrollbar-hide {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
</style>
