<script setup lang="ts">
import { ref, computed } from 'vue'

const { isOpen, close } = useFastEntry()
const financeStore = useFinanceStore()
const { $api } = useNuxtApp()

const amount = ref<number>()
const description = ref('')
const source = ref('account') // 'account' or 'card'
const sourceId = ref('')

const isSubmitting = ref(false)

const accountOptions = computed(() => {
  return financeStore.accounts.map(a => ({ label: a.name, value: a.id }))
})

const cardOptions = computed(() => {
  return financeStore.cards.map(c => ({ label: c.name, value: c.id }))
})

const submit = async () => {
  isSubmitting.value = true
  try {
    const status = source.value === 'card' ? 'pending' : 'realized'
    
    // Este payload simula a chamada baseada na intenção do spec.
    // O tipo será verificado pelo $api caso a rota exista no BFF.
    console.log('Enviando para o BFF:', {
      amount: amount.value,
      description: description.value,
      sourceId: sourceId.value,
      sourceType: source.value,
      status
    })

    // Exemplo de como seria a chamada real se a rota estivesse totalmente definida:
    // await $api.api.transactions.post({ ... })

    // Simulate network delay
    await new Promise(r => setTimeout(r, 500))

    close()
    amount.value = undefined
    description.value = ''
    sourceId.value = ''
  } catch (err) {
    console.error('Failed to submit transaction', err)
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
          <UInput v-model="amount" type="number" step="0.01" placeholder="0.00" icon="i-heroicons-currency-dollar">
            <template #leading>
              <span class="text-gray-500 dark:text-gray-400 sm:text-sm">R$</span>
            </template>
          </UInput>
        </UFormGroup>
        
        <UFormGroup label="Descrição">
          <UInput v-model="description" placeholder="Ex: Mercado, Uber..." />
        </UFormGroup>

        <UFormGroup label="Forma de Pagamento">
          <div class="flex gap-4">
            <URadio v-model="source" value="account" label="Conta" />
            <URadio v-model="source" value="card" label="Cartão" />
          </div>
        </UFormGroup>

        <UFormGroup v-if="source === 'account'" label="Selecione a Conta">
          <USelect v-model="sourceId" :options="accountOptions" />
        </UFormGroup>
        <UFormGroup v-else label="Selecione o Cartão">
          <USelect v-model="sourceId" :options="cardOptions" />
        </UFormGroup>

        <div class="flex justify-end gap-3 mt-6">
          <UButton label="Cancelar" variant="ghost" color="gray" @click="close" />
          <UButton type="submit" label="Lançar" color="primary" :loading="isSubmitting" />
        </div>
      </form>
    </UCard>
  </UModal>
</template>
