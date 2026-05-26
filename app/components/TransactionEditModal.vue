<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useTransactionEdit } from '../composables/useTransactionEdit'
import { useFinanceStore } from '../stores/finance'
import { parseCurrencyInput } from '../utils/formatters'
import { api } from '../utils/api'

const { isOpen, close, editingTransaction } = useTransactionEdit()
const financeStore = useFinanceStore()

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

const submit = async () => {
  if (!editingTransaction.value) return
  isSubmitting.value = true
  try {
    const payload: any = {
      title: title.value,
      amount: parseCurrencyInput(amount.value),
      type: type.value,
      status: status.value,
      expected_date: expectedDate.value ? new Date(expectedDate.value).toISOString() : new Date().toISOString()
    }
    
    if (status.value === 'realized' && realizedDate.value) {
      payload.realized_date = new Date(realizedDate.value).toISOString()
    }

    if (type.value === 'transfer') {
      payload.account_id = sourceId.value
      payload.destination_account_id = destinationAccountId.value
      payload.card_id = null
      payload.category_id = null
    } else {
      if (source.value === 'account' && sourceId.value) {
        payload.account_id = sourceId.value
        payload.card_id = null
      } else if (source.value === 'card' && sourceId.value) {
        payload.card_id = sourceId.value
        payload.account_id = null
      }

      if (categoryId.value) {
        payload.category_id = categoryId.value
      } else {
        payload.category_id = null
      }
      payload.destination_account_id = null
    }

    const transactionId = editingTransaction.value.id as string
    const res = await api.api.transactions({ id: transactionId }).patch(payload)
    if (res.error) throw res.error

    window.location.reload()
    close()
  } catch (err) {
    console.error('Falha ao atualizar transação', err)
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

    window.location.reload()
    close()
  } catch (err) {
    console.error('Falha ao deletar transação', err)
  } finally {
    isDeleting.value = false
  }
}
</script>

<template>
  <UModal v-model="isOpen" prevent-close>
    <UCard :ui="{ ring: '', divide: 'divide-y divide-gray-100 dark:divide-gray-800' }">
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
          <UInput v-model="amount" type="text" placeholder="0.00" icon="i-heroicons-currency-dollar">
            <template #leading><span class="text-gray-400 sm:text-sm">R$</span></template>
          </UInput>
        </UFormGroup>
        
        <UFormGroup label="Descrição">
          <UInput v-model="title" />
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
          <div class="flex gap-4">
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
          <UInput v-model="expectedDate" type="date" />
        </UFormGroup>
        
        <UFormGroup v-if="status === 'realized'" label="Data de Realização">
          <UInput v-model="realizedDate" type="date" />
        </UFormGroup>

        <div class="flex items-center justify-between mt-6">
          <UButton 
            icon="i-heroicons-trash" 
            label="Excluir" 
            color="red" 
            variant="ghost" 
            :loading="isDeleting"
            @click="deleteTransaction" 
          />
          <div class="flex gap-3">
            <UButton label="Cancelar" variant="ghost" color="gray" @click="close" />
            <UButton type="submit" label="Salvar Alterações" color="primary" :loading="isSubmitting" />
          </div>
        </div>
      </form>
    </UCard>
  </UModal>
</template>
