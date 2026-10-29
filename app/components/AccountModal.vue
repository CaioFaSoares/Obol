<script setup lang="ts">
import { ref } from 'vue'
import { useFinanceStore } from '../stores/finance'

const isOpen = ref(false)
const isSubmitting = ref(false)
const name = ref('')
const type = ref<'checking' | 'savings' | 'investment'>('checking')
const initialBalance = ref<number>()

const emit = defineEmits<{ created: [] }>()
const financeStore = useFinanceStore()

function open() {
  isOpen.value = true
}

function close() {
  isOpen.value = false
  name.value = ''
  type.value = 'checking'
  initialBalance.value = undefined
}

defineExpose({ open })

async function submit() {
  if (!name.value || initialBalance.value === undefined) return
  isSubmitting.value = true
  try {
    const res = await api.api.accounts.post({
      name: name.value,
      type: type.value,
      initial_balance: initialBalance.value,
    })
    if (res.error) throw res.error
    
    await financeStore.loadBaseData(true) // Force reload to update fast entry
    emit('created')
    close()
  } catch (err) {
    console.error('Falha ao criar conta', err)
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
          <h3 class="min-w-0 text-base font-semibold leading-6 text-white">
            Nova Conta
          </h3>
          <UButton color="gray" variant="ghost" icon="i-heroicons-x-mark" class="shrink-0 -my-1" @click="close" />
        </div>
      </template>

      <form @submit.prevent="submit" class="space-y-4 [&_input]:text-base [&_select]:text-base sm:[&_input]:text-sm sm:[&_select]:text-sm">
        <UFormGroup label="Nome da Conta">
          <UInput v-model="name" placeholder="Ex: Nubank, Itaú..." />
        </UFormGroup>

        <UFormGroup label="Tipo">
          <USelect v-model="type" :options="[{ label: 'Conta Corrente', value: 'checking' }, { label: 'Poupança', value: 'savings' }, { label: 'Investimento', value: 'investment' }]" />
        </UFormGroup>

        <UFormGroup label="Saldo Inicial (R$)">
          <UInput v-model="initialBalance" type="text" inputmode="decimal" placeholder="Ex: 1500.00" />
        </UFormGroup>

        <div class="sticky bottom-0 bg-zinc-900 -mx-4 px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:bg-transparent sm:mx-0 sm:px-0 sm:pb-0 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3">
          <UButton label="Cancelar" variant="ghost" color="gray" class="w-full sm:w-auto" @click="close" />
          <UButton type="submit" label="Criar Conta" color="primary" :loading="isSubmitting" class="w-full sm:w-auto" />
        </div>
      </form>
    </UCard>
  </UModal>
</template>
