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
          <h3 class="text-base font-semibold leading-6 text-white">
            Novo Projeto / Freela
          </h3>
          <UButton color="gray" variant="ghost" icon="i-heroicons-x-mark" class="-my-1" @click="close" />
        </div>
      </template>

      <form @submit.prevent="submit" class="space-y-4">
        <UFormGroup label="Nome do Projeto">
          <UInput v-model="name" placeholder="Ex: App Obol, Site Cliente X..." />
        </UFormGroup>

        <UFormGroup label="Valor Total Acordado (R$)">
          <UInput v-model="totalValue" type="text" placeholder="Ex: 5000.00" />
        </UFormGroup>

        <div class="flex justify-end gap-3 pt-2">
          <UButton label="Cancelar" variant="ghost" color="gray" @click="close" />
          <UButton type="submit" label="Criar Projeto" color="primary" :loading="isSubmitting" />
        </div>
      </form>
    </UCard>
  </UModal>
</template>
