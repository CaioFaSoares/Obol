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
          <h3 class="text-base font-semibold leading-6 text-white">
            Nova Conta
          </h3>
          <UButton color="gray" variant="ghost" icon="i-heroicons-x-mark" class="-my-1" @click="close" />
        </div>
      </template>

      <form @submit.prevent="submit" class="space-y-4">
        <UFormGroup label="Nome da Conta">
          <UInput v-model="name" placeholder="Ex: Nubank, Itaú..." />
        </UFormGroup>

        <UFormGroup label="Tipo">
          <USelect v-model="type" :options="[{ label: 'Conta Corrente', value: 'checking' }, { label: 'Poupança', value: 'savings' }, { label: 'Investimento', value: 'investment' }]" />
        </UFormGroup>

        <UFormGroup label="Saldo Inicial (R$)">
          <UInput v-model="initialBalance" type="number" step="0.01" placeholder="Ex: 1500.00" />
        </UFormGroup>

        <div class="flex justify-end gap-3 pt-2">
          <UButton label="Cancelar" variant="ghost" color="gray" @click="close" />
          <UButton type="submit" label="Criar Conta" color="primary" :loading="isSubmitting" />
        </div>
      </form>
    </UCard>
  </UModal>
</template>
