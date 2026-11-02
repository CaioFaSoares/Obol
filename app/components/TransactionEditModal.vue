<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { TransactionUpdatePatch } from '../../server/src/domain/entities/Transaction'

const { isOpen, close, editingTransaction } = useTransactionEdit()
const { triggerRefresh } = useRefresh()
const financeStore = useFinanceStore()
const toast = useToast()

const amount = ref<number>()
const title = ref('')
const type = ref<'income' | 'expense' | 'transfer'>('expense')
const status = ref<'pending' | 'realized'>('pending')
const expectedDate = ref('')
const realizedDate = ref('')

const source = ref<'account' | 'card'>('account')
const sourceId = ref('')
const destinationAccountId = ref('')
const categoryId = ref('')

const isSubmitting = ref(false)
const isDeleting = ref(false)

// Preenche os campos quando o modal abre com uma transação
watch(editingTransaction, (txn) => {
  if (txn) {
    amount.value = txn.amount
    title.value = txn.title
    type.value = txn.type
    status.value = txn.status
    expectedDate.value = txn.expected_date ? txn.expected_date.split('T')[0] : ''
    realizedDate.value = txn.realized_date ? txn.realized_date.split('T')[0] : ''
    
    if (txn.card_id) {
      source.value = 'card'
      sourceId.value = txn.card_id
    } else {
      source.value = 'account'
      sourceId.value = txn.account_id || ''
    }
    
    if (txn.type === 'transfer') {
      destinationAccountId.value = txn.destination_account_id || ''
    }
    
    categoryId.value = txn.category_id || ''
  }
})

const accountOptions = computed(() => financeStore.accounts.map(a => ({ label: a.name, value: a.id })))
const cardOptions = computed(() => financeStore.cards.map(c => ({ label: c.name, value: c.id })))
const categoryOptions = computed(() => financeStore.categories.map(c => ({ label: c.name, value: c.id })))

// Eden treaty wraps non-success responses as { status, value }; the body shape
// varies per route (plain string, validation object, or `{ error, details }`),
// so the human-readable detail is read only after checking the actual shape.
function readEdenErrorDetail(error: { value?: unknown }): string | undefined {
  const value = error.value
  if (typeof value === 'string') return value || undefined
  if (!value || typeof value !== 'object') return undefined
  if ('message' in value && typeof value.message === 'string') return value.message || undefined
  if ('details' in value && typeof value.details === 'string') return value.details || undefined
  if ('error' in value && typeof value.error === 'string') return value.error || undefined
  return undefined
}

/**
 * Builds the PATCH body from the form.
 *
 * An omitted field keeps the stored value and `null` clears it, so switching
 * or removing an origin sends an explicit clear instead of an empty-string
 * sentinel. Card rows send the effective purchase date: the server derives it
 * from `expected_date` when it is missing, and the date input shows the stored
 * due date, so an untouched input must not re-route the invoice.
 */
function buildUpdatePatch(input: {
  title: string
  amount: number
  type: 'income' | 'expense' | 'transfer'
  status: 'pending' | 'realized'
  expectedDate: string
  realizedDate: string
  source: 'account' | 'card'
  sourceId: string
  destinationAccountId: string
  categoryId: string
  purchaseDate: string | undefined
  hadCard: boolean
}): TransactionUpdatePatch {
  const base: TransactionUpdatePatch = {
    title: input.title,
    amount: input.amount,
    type: input.type,
    status: input.status,
    expected_date: input.expectedDate ? new Date(input.expectedDate).toISOString() : new Date().toISOString(),
    ...(input.status === 'realized' && input.realizedDate
      ? { realized_date: new Date(input.realizedDate).toISOString() }
      : {})
  }

  if (input.type === 'transfer') {
    return {
      ...base,
      account_id: input.sourceId || null,
      destination_account_id: input.destinationAccountId || null,
      card_id: null,
      category_id: null
    }
  }

  if (input.source === 'card') {
    return {
      ...base,
      card_id: input.sourceId || null,
      account_id: null,
      category_id: input.categoryId || null,
      destination_account_id: null,
      ...(input.purchaseDate !== undefined ? { purchase_date: input.purchaseDate } : {})
    }
  }

  return {
    ...base,
    account_id: input.sourceId || null,
    card_id: null,
    category_id: input.categoryId || null,
    destination_account_id: null,
    ...(input.hadCard ? { purchase_date: null } : {})
  }
}

const submit = async () => {
  if (!editingTransaction.value) return
  isSubmitting.value = true
  try {
    const original = editingTransaction.value
    const storedExpectedDay = typeof original.expected_date === 'string' ? original.expected_date.split('T')[0] : ''
    const dateChanged = !storedExpectedDay || expectedDate.value !== storedExpectedDay
    const purchaseDate = dateChanged
      ? (expectedDate.value ? new Date(expectedDate.value).toISOString() : undefined)
      : (typeof original.purchase_date === 'string' && original.purchase_date
        ? new Date(original.purchase_date).toISOString()
        : undefined)
    const patch = buildUpdatePatch({
      title: title.value,
      amount: parseCurrencyInput(amount.value ?? 0),
      type: type.value,
      status: status.value,
      expectedDate: expectedDate.value,
      realizedDate: realizedDate.value,
      source: source.value,
      sourceId: sourceId.value,
      destinationAccountId: destinationAccountId.value,
      categoryId: categoryId.value,
      purchaseDate,
      hadCard: Boolean(original.card_id)
    })

    const res = await api.api.transactions({ id: original.id }).patch(patch)
    if (res.error) {
      console.error('API Error:', res.error)
      throw new Error(readEdenErrorDetail(res.error) || 'Erro ao atualizar a transação')
    }

    toast.add({ title: 'Alterações salvas!', color: 'emerald' })
    triggerRefresh()
    close()
  } catch (err: any) {
    console.error('Falha ao atualizar transação', err)
    toast.add({ title: 'Erro ao salvar', description: err.message, color: 'red' })
  } finally {
    isSubmitting.value = false
  }
}

const deleteTransaction = async () => {
  if (!editingTransaction.value) return
  if (!confirm('Deseja realmente excluir esta transação? Seu saldo original será restaurado se necessário.')) return
  
  isDeleting.value = true
  try {
    const transactionId = editingTransaction.value.id as string
    const res = await api.api.transactions({ id: transactionId }).delete()
    if (res.error) throw res.error

    triggerRefresh()
    close()
  } catch (err) {
    console.error('Falha ao deletar transação', err)
  } finally {
    isDeleting.value = false
  }
}
</script>

<template>
  <UModal
    v-model="isOpen"
    prevent-close
    :ui="{
      inner: 'fixed inset-0 overflow-y-auto overscroll-contain',
      // Cap the panel to the viewport so the card body scrolls internally instead of the page.
      base: 'relative text-left flex flex-col max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100vh-4rem)]'
    }"
  >
    <UCard @click.stop class="flex flex-col min-h-0" :ui="{
      ring: '',
      divide: 'divide-y divide-gray-100 dark:divide-gray-800',
      body: { base: 'min-h-0 flex-1 overflow-y-auto overscroll-contain' }
    }">
      <template #header>
        <div class="flex items-center justify-between">
          <h3 class="text-base font-semibold text-white">
            Editar Lançamento
          </h3>
          <UButton color="gray" variant="ghost" icon="i-heroicons-x-mark" class="-my-1" @click="close" />
        </div>
      </template>

      <form @submit.prevent="submit" class="space-y-4">
        <UFormGroup label="Valor">
          <UInput
            v-model="amount"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            placeholder="0.00"
            icon="i-heroicons-currency-dollar"
            input-class="text-base sm:text-sm"
          >
            <template #leading><span class="text-gray-400 sm:text-sm">R$</span></template>
          </UInput>
        </UFormGroup>

        <UFormGroup label="Descrição">
          <UInput v-model="title" autocomplete="off" input-class="text-base sm:text-sm" />
        </UFormGroup>

        <div class="grid grid-cols-2 gap-4">
          <UFormGroup label="Tipo">
            <USelect v-model="type" :options="[{label:'Despesa', value:'expense'}, {label:'Receita', value:'income'}, {label:'Transferência', value:'transfer'}]" />
          </UFormGroup>
          <UFormGroup label="Status">
            <USelect v-model="status" :options="[{label:'Pendente', value:'pending'}, {label:'Realizado', value:'realized'}]" />
          </UFormGroup>
        </div>

        <UFormGroup v-if="type !== 'transfer'" label="Forma de Pagamento">
          <div class="flex flex-wrap gap-4">
            <URadio v-model="source" value="account" label="Conta" />
            <URadio v-if="type === 'expense'" v-model="source" value="card" label="Cartão" />
          </div>
        </UFormGroup>

        <UFormGroup v-if="source === 'account' || type === 'transfer'" :label="type === 'transfer' ? 'Conta de Origem' : 'Selecione a Conta'">
          <USelect v-model="sourceId" :options="accountOptions" />
        </UFormGroup>
        
        <UFormGroup v-if="type === 'transfer'" label="Conta de Destino">
          <USelect v-model="destinationAccountId" :options="accountOptions" />
        </UFormGroup>

        <UFormGroup v-if="type !== 'transfer' && source === 'card'" label="Selecione o Cartão">
          <USelect v-model="sourceId" :options="cardOptions" />
        </UFormGroup>

        <UFormGroup v-if="type !== 'transfer'" label="Orçamento / Categoria (opcional)">
          <USelect v-model="categoryId" :options="categoryOptions" placeholder="Sem orçamento vinculado" />
        </UFormGroup>

        <UFormGroup label="Data Esperada">
          <UInput v-model="expectedDate" type="date" input-class="text-base sm:text-sm" />
        </UFormGroup>

        <UFormGroup v-if="status === 'realized'" label="Data de Realização">
          <UInput v-model="realizedDate" type="date" input-class="text-base sm:text-sm" />
        </UFormGroup>

        <div class="flex flex-wrap items-center justify-between gap-3 mt-6">
          <UButton
            icon="i-heroicons-trash"
            label="Excluir"
            color="red"
            variant="ghost"
            :loading="isDeleting"
            @click="deleteTransaction"
          />
          <div class="flex flex-wrap justify-end gap-3 ml-auto">
            <UButton label="Cancelar" variant="ghost" color="gray" @click="close" />
            <UButton type="submit" label="Salvar Alterações" color="primary" :loading="isSubmitting" />
          </div>
        </div>
      </form>
    </UCard>
  </UModal>
</template>
