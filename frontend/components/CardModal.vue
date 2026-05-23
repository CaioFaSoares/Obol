<script setup lang="ts">
import { ref } from 'vue'
import { useFinanceStore } from '../stores/finance'

const isOpen = ref(false)
const isSubmitting = ref(false)
const name = ref('')
const limit = ref<number>()
const closingDay = ref<number>(1)
const dueDay = ref<number>(1)

const emit = defineEmits<{ created: [] }>()
const financeStore = useFinanceStore()

function open() {
  isOpen.value = true
}

function close() {
  isOpen.value = false
  name.value = ''
  limit.value = undefined
  closingDay.value = 1
  dueDay.value = 1
}

defineExpose({ open })

async function submit() {
  if (!name.value || !limit.value || !closingDay.value || !dueDay.value) return
  isSubmitting.value = true
  try {
    const res = await api.api.cards.post({
      name: name.value,
      limit: limit.value,
      closing_day: Number(closingDay.value),
      due_day: Number(dueDay.value),
    })
    if (res.error) throw res.error
    
    await financeStore.loadBaseData(true) // Force reload to update fast entry
    emit('created')
    close()
  } catch (err) {
    console.error('Falha ao criar cartão', err)
  } finally {
    isSubmitting.value = false
  }
}

const dayOptions = Array.from({ length: 31 }, (_, i) => ({ label: `Dia ${i + 1}`, value: i + 1 }))
</script>

<template>
  <UModal v-model="isOpen">
    <UCard :ui="{ ring: '', divide: 'divide-y divide-gray-100 dark:divide-gray-800' }">
      <template #header>
        <div class="flex items-center justify-between">
          <h3 class="text-base font-semibold leading-6 text-white">
            Novo Cartão de Crédito
          </h3>
          <UButton color="gray" variant="ghost" icon="i-heroicons-x-mark" class="-my-1" @click="close" />
        </div>
      </template>

      <form @submit.prevent="submit" class="space-y-4">
        <UFormGroup label="Nome do Cartão">
          <UInput v-model="name" placeholder="Ex: Cartão XP, Ultravioleta..." />
        </UFormGroup>

        <UFormGroup label="Limite Total (R$)">
          <UInput v-model="limit" type="number" step="0.01" placeholder="Ex: 5000.00" />
        </UFormGroup>

        <div class="grid grid-cols-2 gap-4">
          <UFormGroup label="Dia de Fechamento">
            <USelect v-model="closingDay" :options="dayOptions" />
          </UFormGroup>

          <UFormGroup label="Dia de Vencimento">
            <USelect v-model="dueDay" :options="dayOptions" />
          </UFormGroup>
        </div>

        <div class="flex justify-end gap-3 pt-2">
          <UButton label="Cancelar" variant="ghost" color="gray" @click="close" />
          <UButton type="submit" label="Criar Cartão" color="primary" :loading="isSubmitting" />
        </div>
      </form>
    </UCard>
  </UModal>
</template>
