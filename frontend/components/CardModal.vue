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
          <h3 class="text-base font-semibold leading-6 text-white">
            {{ editingId ? 'Editar Cartão' : 'Novo Cartão de Crédito' }}
          </h3>
          <UButton color="gray" variant="ghost" icon="i-heroicons-x-mark" class="-my-1" @click="close" />
        </div>
      </template>

      <form @submit.prevent="submit" class="space-y-4">
        <UFormGroup label="Nome do Cartão">
          <UInput v-model="name" placeholder="Ex: Cartão XP, Ultravioleta..." />
        </UFormGroup>

        <UFormGroup label="Limite Total (R$)">
          <UInput v-model="limit" type="text" placeholder="Ex: 5000.00" />
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
          <UButton type="submit" :label="editingId ? 'Salvar Alterações' : 'Criar Cartão'" color="primary" :loading="isSubmitting" />
        </div>
      </form>
    </UCard>
  </UModal>
</template>
