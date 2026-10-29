<script setup lang="ts">
import { ref } from 'vue'

const isOpen = ref(false)
const isSubmitting = ref(false)
const name = ref('')
const totalValue = ref<number>()

const emit = defineEmits<{ created: [] }>()

function open() {
  isOpen.value = true
}

function close() {
  isOpen.value = false
  name.value = ''
  totalValue.value = undefined
}

defineExpose({ open })

async function submit() {
  if (!name.value || !totalValue.value) return
  isSubmitting.value = true
  try {
    const res = await api.api.projects.post({
      name: name.value,
      total_value: totalValue.value,
    })
    if (res.error) throw res.error
    
    emit('created')
    close()
  } catch (err) {
    console.error('Falha ao criar projeto', err)
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
            Novo Projeto / Freela
          </h3>
          <UButton color="gray" variant="ghost" icon="i-heroicons-x-mark" class="shrink-0 -my-1" @click="close" />
        </div>
      </template>

      <form @submit.prevent="submit" class="space-y-4 [&_input]:text-base [&_select]:text-base sm:[&_input]:text-sm sm:[&_select]:text-sm">
        <UFormGroup label="Nome do Projeto">
          <UInput v-model="name" placeholder="Ex: App Obol, Site Cliente X..." />
        </UFormGroup>

        <UFormGroup label="Valor Total Acordado (R$)">
          <UInput v-model="totalValue" type="text" inputmode="decimal" placeholder="Ex: 5000.00" />
        </UFormGroup>

        <div class="sticky bottom-0 bg-zinc-900 -mx-4 px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:bg-transparent sm:mx-0 sm:px-0 sm:pb-0 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3">
          <UButton label="Cancelar" variant="ghost" color="gray" class="w-full sm:w-auto" @click="close" />
          <UButton type="submit" label="Criar Projeto" color="primary" :loading="isSubmitting" class="w-full sm:w-auto" />
        </div>
      </form>
    </UCard>
  </UModal>
</template>
