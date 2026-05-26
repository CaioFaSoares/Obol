<script setup lang="ts">
import { ref, computed } from 'vue'
import { useFastEntry } from '../composables/useFastEntry'
import { useFinanceStore } from '../stores/finance'

const { isOpen, close } = useFastEntry()
const financeStore = useFinanceStore()

const amount = ref<number>()
const description = ref('')
const type = ref<'expense' | 'income' | 'transfer'>('expense')
const source = ref('account') // 'account' or 'card'
const sourceId = ref('')
const destinationAccountId = ref('')
const categoryId = ref('')
const isSimulated = ref(false)

const isSubmitting = ref(false)

const accountOptions = computed(() => {
  return financeStore.accounts.map(a => ({ label: a.name, value: a.id }))
})

const cardOptions = computed(() => {
  return financeStore.cards.map(c => ({ label: c.name, value: c.id }))
})

const categoryOptions = computed(() => {
  return financeStore.categories.map(c => ({ label: c.name, value: c.id }))
})

const submit = async () => {
  if (!amount.value || !description.value) {
    return useToast().add({ title: 'Preencha valor e descrição', color: 'red' })
  }
  
  if (!isSimulated.value && type.value !== 'transfer' && !sourceId.value) {
    return useToast().add({ title: 'Selecione a conta ou cartão para o lançamento real.', color: 'red' })
  }

  if (type.value === 'transfer' && (!sourceId.value || !destinationAccountId.value)) {
    return useToast().add({ title: 'Selecione a conta de origem e destino', color: 'red' })
  }

  isSubmitting.value = true
  try {
    const status = (type.value !== 'transfer' && source.value === 'card') ? 'pending' : 'realized'
    
    const now = new Date().toISOString()
    const payload: any = {
      title: description.value || (type.value === 'transfer' ? 'Transferência' : 'Lançamento Rápido'),
      amount: parseCurrencyInput(amount.value),
      type: type.value,
      status: isSimulated.value ? 'pending' : status,
      expected_date: now,
      is_simulated: isSimulated.value
    }

    if (type.value === 'transfer') {
      payload.account_id = sourceId.value
      payload.destination_account_id = destinationAccountId.value
      payload.realized_date = now
    } else {
      if (!isSimulated.value) {
        if (source.value === 'account' && sourceId.value) {
          payload.account_id = sourceId.value
          payload.realized_date = now
        } else if (source.value === 'card' && sourceId.value) {
          payload.card_id = sourceId.value
        }
      }

      if (categoryId.value) {
        payload.category_id = categoryId.value
      }
    }

    const res = await api.api.transactions.post(payload)
    if (res.error) throw res.error

    useToast().add({ 
      title: isSimulated.value ? 'Simulação Criada!' : 'Lançamento Salvo!', 
      color: isSimulated.value ? 'purple' : 'emerald' 
    })

    // TODO: A dashboard component would need to react to this,
    // reloading the data. Since the Nuxt layout doesn't natively watch for it,
    // an event could be emitted, but for now we just reload the page.
    window.location.reload()

    close()
    amount.value = undefined
    description.value = ''
    type.value = 'expense'
    source.value = 'account'
    sourceId.value = ''
    destinationAccountId.value = ''
    categoryId.value = ''
    isSimulated.value = false
  } catch (err) {
    console.error('Failed to submit transaction', err)
    useToast().add({ title: 'Erro ao salvar', color: 'red' })
  } finally {
    isSubmitting.value = false
  }
}
</script>

<template>
  <UModal v-model="isOpen">
    <UCard :ui="{ ring: '', divide: 'divide-y divide-gray-100 dark:divide-gray-800' }">
      <template #header>
        <div class="flex items-center justify-between">
          <h3 class="text-base font-semibold leading-6 text-gray-900 dark:text-white">
            Fast Entry
          </h3>
          <UButton color="gray" variant="ghost" icon="i-heroicons-x-mark-20-solid" class="-my-1" @click="close" />
        </div>
      </template>

      <form @submit.prevent="submit" class="space-y-4">
        <UFormGroup label="Valor">
          <UInput v-model="amount" type="text" placeholder="0.00" icon="i-heroicons-currency-dollar">
            <template #leading>
              <span class="text-gray-500 dark:text-gray-400 sm:text-sm">R$</span>
            </template>
          </UInput>
        </UFormGroup>
        
        <UFormGroup label="Descrição">
          <UInput v-model="description" placeholder="Ex: Mercado, Uber..." />
        </UFormGroup>

        <UFormGroup label="Tipo de Lançamento">
          <div class="flex gap-4 mb-2">
            <URadio v-model="type" value="expense" label="Despesa" />
            <URadio v-model="type" value="income" label="Receita" />
            <URadio v-model="type" value="transfer" label="Transferência" />
          </div>
        </UFormGroup>

        <UFormGroup v-if="type !== 'transfer' && !isSimulated" label="Forma de Pagamento">
          <div class="flex gap-4">
            <URadio v-model="source" value="account" label="Conta" />
            <URadio v-model="source" value="card" label="Cartão" />
          </div>
        </UFormGroup>

        <UFormGroup v-if="type === 'transfer' || (!isSimulated && source === 'account')" :label="type === 'transfer' ? 'Conta de Origem' : 'Selecione a Conta'">
          <USelect v-model="sourceId" :options="accountOptions" placeholder="Selecione a conta de origem" />
        </UFormGroup>
        
        <UFormGroup v-if="type === 'transfer'" label="Conta de Destino">
          <USelect v-model="destinationAccountId" :options="accountOptions" placeholder="Selecione a conta de destino" />
        </UFormGroup>

        <UFormGroup v-if="type !== 'transfer' && !isSimulated && source === 'card'" label="Selecione o Cartão">
          <USelect v-model="sourceId" :options="cardOptions" placeholder="Selecione o cartão" />
        </UFormGroup>

        <UFormGroup v-if="type !== 'transfer'" label="Orçamento / Categoria (opcional)">
          <USelect v-model="categoryId" :options="categoryOptions" placeholder="Sem orçamento vinculado" />
        </UFormGroup>

        <div v-if="type !== 'transfer'" class="bg-purple-900/10 border border-purple-500/20 rounded-lg p-4 flex items-start gap-3 mt-4">
          <UToggle v-model="isSimulated" color="purple" class="mt-0.5" />
          <div>
            <h4 class="text-sm font-medium text-purple-200">Lançamento Simulado</h4>
            <p class="text-xs text-purple-300/70 mt-1">
              Não debita do seu saldo real. Ideal para testar o futuro no gráfico.
            </p>
          </div>
        </div>

        <div class="flex justify-end gap-3 mt-6">
          <UButton label="Cancelar" variant="ghost" color="gray" @click="close" />
          <UButton type="submit" label="Lançar" :color="isSimulated ? 'purple' : 'primary'" :loading="isSubmitting" />
        </div>
      </form>
    </UCard>
  </UModal>
</template>
