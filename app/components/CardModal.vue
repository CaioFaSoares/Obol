<script setup lang="ts">
import { ref } from 'vue'
import { useFinanceStore } from '../stores/finance'

const isOpen = ref(false)
const isSubmitting = ref(false)
const editingId = ref<string | null>(null)
const name = ref('')
const limit = ref<number>()
const closingDay = ref<number>(1)
const dueDay = ref<number>(1)

const emit = defineEmits<{ created: [] }>()
const financeStore = useFinanceStore()

function open(card?: any) {
  if (card) {
    editingId.value = card.id
    name.value = card.name
    limit.value = card.limit
    closingDay.value = card.closing_day
    dueDay.value = card.due_day
  } else {
    editingId.value = null
    name.value = ''
    limit.value = undefined
    closingDay.value = 1
    dueDay.value = 1
  }
  isOpen.value = true
}

function close() {
  isOpen.value = false
  editingId.value = null
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
    const payload = {
      name: name.value,
      limit: limit.value,
      closing_day: Number(closingDay.value),
      due_day: Number(dueDay.value),
    }
    
    let res
    if (editingId.value) {
      res = await api.api.cards({ id: editingId.value }).patch(payload)
    } else {
      res = await api.api.cards.post(payload)
    }
    
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
          <h3 class="min-w-0 text-base font-semibold leading-6 text-white">
            {{ editingId ? 'Editar Cartão' : 'Novo Cartão de Crédito' }}
          </h3>
          <UButton color="gray" variant="ghost" icon="i-heroicons-x-mark" class="shrink-0 -my-1" @click="close" />
        </div>
      </template>

      <form @submit.prevent="submit" class="space-y-4 [&_input]:text-base [&_select]:text-base sm:[&_input]:text-sm sm:[&_select]:text-sm">
        <UFormGroup label="Nome do Cartão">
          <UInput v-model="name" placeholder="Ex: Cartão XP, Ultravioleta..." />
        </UFormGroup>

        <UFormGroup label="Limite Total (R$)">
          <UInput v-model="limit" type="text" inputmode="decimal" placeholder="Ex: 5000.00" />
        </UFormGroup>

        <div class="grid grid-cols-2 gap-4">
          <UFormGroup label="Dia de Fechamento">
            <USelect v-model="closingDay" :options="dayOptions" />
          </UFormGroup>

          <UFormGroup label="Dia de Vencimento">
            <USelect v-model="dueDay" :options="dayOptions" />
          </UFormGroup>
        </div>

        <div class="sticky bottom-0 bg-zinc-900 -mx-4 px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:bg-transparent sm:mx-0 sm:px-0 sm:pb-0 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3">
          <UButton label="Cancelar" variant="ghost" color="gray" class="w-full sm:w-auto" @click="close" />
          <UButton type="submit" :label="editingId ? 'Salvar Alterações' : 'Criar Cartão'" color="primary" :loading="isSubmitting" class="w-full sm:w-auto" />
        </div>
      </form>
    </UCard>
  </UModal>
</template>
