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
          <h3 class="min-w-0 text-base font-semibold leading-6 text-white">
            Novo Orçamento / Categoria
          </h3>
          <UButton color="gray" variant="ghost" icon="i-heroicons-x-mark" class="shrink-0 -my-1" @click="close" />
        </div>
      </template>

      <form @submit.prevent="submit" class="space-y-4 [&_input]:text-base [&_select]:text-base sm:[&_input]:text-sm sm:[&_select]:text-sm">
        <UFormGroup label="Nome da Categoria">
          <UInput v-model="name" placeholder="Ex: Mercado, Lazer..." />
        </UFormGroup>

        <UFormGroup label="Tipo">
          <div class="flex flex-col gap-3 mt-1 sm:flex-row sm:gap-4">
            <URadio v-model="type" value="fixed_budget" label="Orçamento Fixo Mensal" />
            <URadio v-model="type" value="variable" label="Apenas Categoria (Variável)" />
          </div>
        </UFormGroup>

        <UFormGroup v-if="type === 'fixed_budget'" label="Teto de Gastos (R$)">
          <UInput v-model="monthlyBudget" type="text" inputmode="decimal" placeholder="Ex: 1000.00" />
        </UFormGroup>

        <div class="sticky bottom-0 bg-zinc-900 -mx-4 px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:bg-transparent sm:mx-0 sm:px-0 sm:pb-0 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3">
          <UButton label="Cancelar" variant="ghost" color="gray" class="w-full sm:w-auto" @click="close" />
          <UButton type="submit" label="Criar Categoria" color="primary" :loading="isSubmitting" class="w-full sm:w-auto" />
        </div>
      </form>
    </UCard>
  </UModal>
</template>
