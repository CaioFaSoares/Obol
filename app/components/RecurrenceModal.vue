<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRecurrenceModal } from '~/composables/useRecurrenceModal'
import { useFinanceStore } from '../stores/finance'

const { isOpen, close, recurrenceToEdit } = useRecurrenceModal()
const financeStore = useFinanceStore()

const isSubmitting = ref(false)
const name = ref('')
const amount = ref<number>()
const payday = ref<number>(1)
const type = ref<'income' | 'expense'>('expense')
const source = ref<'account' | 'card'>('account')
const accountId = ref('')
const cardId = ref('')
const categoryId = ref('')
const endDate = ref('')

watch(type, (newType) => {
  if (newType === 'income' && source.value === 'card') {
    source.value = 'account'
  }
})

watch(recurrenceToEdit, (val) => {
  if (val) {
    name.value = val.name
    amount.value = val.amount
    payday.value = val.payday
    type.value = val.type
    if (val.card_id) {
      source.value = 'card'
      cardId.value = val.card_id
    } else {
      source.value = 'account'
      accountId.value = val.account_id || ''
    }
    categoryId.value = val.category_id || ''
    endDate.value = val.end_date ? val.end_date.split('T')[0] : ''
  } else {
    name.value = ''
    amount.value = undefined
    payday.value = 1
    type.value = 'expense'
    source.value = 'account'
    accountId.value = ''
    cardId.value = ''
    categoryId.value = ''
    endDate.value = ''
  }
}, { immediate: true })

const emit = defineEmits<{ created: [] }>()

async function submit() {
  if (!name.value || !amount.value || !payday.value) return
  isSubmitting.value = true
  try {
    const payload: any = {
      name: name.value,
      amount: parseCurrencyInput(amount.value),
      payday: Number(payday.value),
      type: type.value,
    }
    if (source.value === 'account' && accountId.value) payload.account_id = accountId.value
    if (source.value === 'card' && cardId.value) payload.card_id = cardId.value
    if (categoryId.value) payload.category_id = categoryId.value
    if (endDate.value) payload.end_date = endDate.value

    if (recurrenceToEdit.value) {
      const res = await api.api.recurrences({ id: recurrenceToEdit.value.id }).put(payload)
      if (res.error) throw res.error
    } else {
      const res = await api.api.recurrences.post(payload)
      if (res.error) throw res.error
    }
    emit('created')
    close()
  } catch (err) {
    console.error('Falha ao salvar recorrência', err)
  } finally {
    isSubmitting.value = false
  }
}

const paydayOptions = Array.from({ length: 31 }, (_, i) => ({ label: `Dia ${i + 1}`, value: i + 1 }))

const accountOptions = computed(() => {
  return financeStore.accounts.map(a => ({ label: a.name, value: a.id }))
})

const cardOptions = computed(() => {
  return financeStore.cards.map(c => ({ label: c.name, value: c.id }))
})

const categoryOptions = computed(() => {
  return financeStore.categories.map(c => ({ label: c.name, value: c.id }))
})
</script>

<template>
  <UModal v-model="isOpen">
    <UCard :ui="{ ring: '', divide: 'divide-y divide-gray-100 dark:divide-gray-800' }">
      <template #header>
        <div class="flex items-center justify-between">
          <h3 class="text-base font-semibold leading-6 text-white">
            {{ recurrenceToEdit ? 'Editar Recorrência' : 'Nova Recorrência' }}
          </h3>
          <UButton color="gray" variant="ghost" icon="i-heroicons-x-mark" class="-my-1" @click="close" />
        </div>
      </template>

      <form @submit.prevent="submit" class="space-y-4">
        <UFormGroup label="Nome">
          <UInput v-model="name" placeholder="Ex: Netflix, Bolsa CNPq..." />
        </UFormGroup>

        <UFormGroup label="Valor (R$)">
          <UInput v-model="amount" type="text" placeholder="0.00" />
        </UFormGroup>

        <div class="grid grid-cols-2 gap-4">
          <UFormGroup label="Tipo">
            <div class="flex gap-4 mt-1">
              <URadio v-model="type" value="expense" label="Despesa" />
              <URadio v-model="type" value="income" label="Receita" />
            </div>
          </UFormGroup>

          <UFormGroup label="Dia de cobrança">
            <USelect v-model="payday" :options="paydayOptions" />
          </UFormGroup>
        </div>

        <UFormGroup label="Origem/Destino">
          <div class="flex gap-4 mt-1">
            <URadio v-model="source" value="account" label="Conta" />
            <URadio v-if="type === 'expense'" v-model="source" value="card" label="Cartão" />
          </div>
        </UFormGroup>

        <UFormGroup v-if="source === 'account'" label="Conta">
          <USelect v-model="accountId" :options="accountOptions" placeholder="Selecione a conta" />
        </UFormGroup>
        <UFormGroup v-else label="Cartão">
          <USelect v-model="cardId" :options="cardOptions" placeholder="Selecione o cartão" />
        </UFormGroup>

        <UFormGroup label="Orçamento / Categoria (opcional)">
          <USelect v-model="categoryId" :options="categoryOptions" placeholder="Sem orçamento vinculado" />
        </UFormGroup>

        <UFormGroup label="Data Final (opcional)">
          <UInput v-model="endDate" type="date" />
        </UFormGroup>

        <div class="flex justify-end gap-3 pt-2">
          <UButton label="Cancelar" variant="ghost" color="gray" @click="close" />
          <UButton
            type="submit"
            :label="recurrenceToEdit ? 'Salvar Alterações' : (type === 'income' ? 'Criar Receita Fixa' : 'Criar Despesa Fixa')"
            :color="type === 'income' ? 'green' : 'red'"
            :loading="isSubmitting"
          />
        </div>
      </form>
    </UCard>
  </UModal>
</template>
