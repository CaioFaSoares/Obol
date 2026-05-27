<script setup lang="ts">
import { ref, computed, watch } from 'vue'

const { isOpen, close } = useFastEntry()
const { triggerRefresh } = useRefresh()
const financeStore = useFinanceStore()

const amount = ref<number>()
const description = ref('')
const type = ref<'expense' | 'income' | 'transfer'>('expense')
const source = ref('account') // 'account' or 'card'
const sourceId = ref('')
const destinationAccountId = ref('')
const categoryId = ref('')
const isSimulated = ref(false)
const isScheduled = ref(false)
const scheduledDate = ref('')

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

// Mutuamente exclusivos: agendado desliga simulado e vice-versa
watch(isScheduled, (val) => {
  if (val) {
    isSimulated.value = false
    source.value = 'account'
  }
})
watch(isSimulated, (val) => {
  if (val) isScheduled.value = false
})

const submit = async () => {
  if (!amount.value || !description.value) {
    return useToast().add({ title: 'Preencha valor e descrição', color: 'red' })
  }

  if (isScheduled.value && !scheduledDate.value) {
    return useToast().add({ title: 'Informe a data de vencimento para a conta agendada.', color: 'red' })
  }
  
  if (!isSimulated.value && !isScheduled.value && type.value !== 'transfer' && !sourceId.value) {
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
      status: isSimulated.value || isScheduled.value ? 'pending' : status,
      expected_date: isScheduled.value ? new Date(scheduledDate.value + 'T12:00:00').toISOString() : now,
      is_simulated: isSimulated.value,
      is_scheduled: isScheduled.value
    }

    if (isScheduled.value) {
      // Contas agendadas sempre vão para a conta bancária (sem cartão)
      if (sourceId.value) {
        payload.account_id = sourceId.value
      }
    } else if (type.value === 'transfer') {
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
    }

    if (type.value !== 'transfer' && categoryId.value) {
      payload.category_id = categoryId.value
    }

    const res = await api.api.transactions.post(payload)
    if (res.error) throw res.error

    const toastTitle = isSimulated.value 
      ? 'Simulação Criada!' 
      : isScheduled.value 
        ? 'Conta Agendada!' 
        : 'Lançamento Salvo!'
    const toastColor = isSimulated.value ? 'purple' : isScheduled.value ? 'amber' : 'emerald'

    useToast().add({ title: toastTitle, color: toastColor })

    triggerRefresh()
    close()
    amount.value = undefined
    description.value = ''
    type.value = 'expense'
    source.value = 'account'
    sourceId.value = ''
    destinationAccountId.value = ''
    categoryId.value = ''
    isSimulated.value = false
    isScheduled.value = false
    scheduledDate.value = ''
  } catch (err) {
    console.error('Failed to submit transaction', err)
    useToast().add({ title: 'Erro ao salvar', color: 'red' })
  } finally {
    isSubmitting.value = false
  }
}
</script>

<template>
  <UModal v-model="isOpen" prevent-close>
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
            <URadio v-model="type" value="transfer" label="Transferência" :disabled="isScheduled" />
          </div>
        </UFormGroup>

        <UFormGroup v-if="type !== 'transfer' && !isSimulated && !isScheduled" label="Forma de Pagamento">
          <div class="flex gap-4">
            <URadio v-model="source" value="account" label="Conta" />
            <URadio v-model="source" value="card" label="Cartão" />
          </div>
        </UFormGroup>

        <UFormGroup v-if="(type === 'transfer' || (!isSimulated && !isScheduled && source === 'account')) || isScheduled" :label="type === 'transfer' ? 'Conta de Origem' : isScheduled ? 'Conta para Pagamento (opcional)' : 'Selecione a Conta'">
          <USelect v-model="sourceId" :options="accountOptions" placeholder="Selecione a conta de origem" />
        </UFormGroup>
        
        <UFormGroup v-if="type === 'transfer'" label="Conta de Destino">
          <USelect v-model="destinationAccountId" :options="accountOptions" placeholder="Selecione a conta de destino" />
        </UFormGroup>

        <UFormGroup v-if="type !== 'transfer' && !isSimulated && !isScheduled && source === 'card'" label="Selecione o Cartão">
          <USelect v-model="sourceId" :options="cardOptions" placeholder="Selecione o cartão" />
        </UFormGroup>

        <UFormGroup v-if="type !== 'transfer'" label="Orçamento / Categoria (opcional)">
          <USelect v-model="categoryId" :options="categoryOptions" placeholder="Sem orçamento vinculado" />
        </UFormGroup>

        <!-- Toggle de Simulação -->
        <div v-if="type !== 'transfer' && !isScheduled" class="bg-purple-900/10 border border-purple-500/20 rounded-lg p-4 flex items-start gap-3 mt-4">
          <UToggle v-model="isSimulated" color="purple" class="mt-0.5" />
          <div>
            <h4 class="text-sm font-medium text-purple-200">Lançamento Simulado</h4>
            <p class="text-xs text-purple-300/70 mt-1">
              Não debita do seu saldo real. Ideal para testar o futuro no gráfico.
            </p>
          </div>
        </div>

        <!-- Toggle de Conta Agendada -->
        <div v-if="type !== 'transfer' && !isSimulated" class="bg-amber-900/10 border border-amber-500/20 rounded-lg p-4 flex items-start gap-3 mt-4">
          <UToggle v-model="isScheduled" color="amber" class="mt-0.5" />
          <div class="flex-1">
            <h4 class="text-sm font-medium text-amber-200">Conta Fixa / Boleto Agendado</h4>
            <p class="text-xs text-amber-300/70 mt-1">
              Aparece como obrigação fixa no caixa. Exige confirmação manual para dar baixa.
            </p>
            <UFormGroup v-if="isScheduled" label="Data de Vencimento" class="mt-3">
              <UInput v-model="scheduledDate" type="date" />
            </UFormGroup>
          </div>
        </div>

        <div class="flex justify-end gap-3 mt-6">
          <UButton label="Cancelar" variant="ghost" color="gray" @click="close" />
          <UButton 
            type="submit" 
            :label="isScheduled ? 'Agendar' : 'Lançar'" 
            :color="isSimulated ? 'purple' : isScheduled ? 'amber' : 'primary'" 
            :loading="isSubmitting" 
          />
        </div>
      </form>
    </UCard>
  </UModal>
</template>
