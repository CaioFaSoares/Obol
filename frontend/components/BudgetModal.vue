<script setup lang="ts">
import { ref } from 'vue'

const isOpen = ref(false)
const isSubmitting = ref(false)
const name = ref('')
const type = ref<'fixed_budget' | 'variable'>('fixed_budget')
const monthlyBudget = ref<number>()

const emit = defineEmits<{ created: [] }>()

function open() {
  isOpen.value = true
}

function close() {
  isOpen.value = false
  name.value = ''
  type.value = 'fixed_budget'
  monthlyBudget.value = undefined
}

defineExpose({ open })

async function submit() {
  if (!name.value) return
  isSubmitting.value = true
  try {
    const payload: any = {
      name: name.value,
      type: type.value,
    }
    if (type.value === 'fixed_budget' && monthlyBudget.value) {
      payload.monthly_budget = monthlyBudget.value
    }

    // @ts-expect-error dynamic route
    const res = await api.api.categories.post(payload)
    if (res.error) throw res.error
    
    emit('created')
    close()
  } catch (err) {
    console.error('Falha ao criar categoria', err)
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
            Novo Orçamento / Categoria
          </h3>
          <UButton color="gray" variant="ghost" icon="i-heroicons-x-mark" class="-my-1" @click="close" />
        </div>
      </template>

      <form @submit.prevent="submit" class="space-y-4">
        <UFormGroup label="Nome da Categoria">
          <UInput v-model="name" placeholder="Ex: Mercado, Lazer..." />
        </UFormGroup>

        <UFormGroup label="Tipo">
          <div class="flex gap-4 mt-1">
            <URadio v-model="type" value="fixed_budget" label="Orçamento Fixo Mensal" />
            <URadio v-model="type" value="variable" label="Apenas Categoria (Variável)" />
          </div>
        </UFormGroup>

        <UFormGroup v-if="type === 'fixed_budget'" label="Teto de Gastos (R$)">
          <UInput v-model="monthlyBudget" type="text" placeholder="Ex: 1000.00" />
        </UFormGroup>

        <div class="flex justify-end gap-3 pt-2">
          <UButton label="Cancelar" variant="ghost" color="gray" @click="close" />
          <UButton type="submit" label="Criar Categoria" color="primary" :loading="isSubmitting" />
        </div>
      </form>
    </UCard>
  </UModal>
</template>
