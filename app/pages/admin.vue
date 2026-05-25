<script setup lang="ts">
import { ref } from 'vue'

const toast = useToast()
const isRunning = ref(false)

const triggerCron = async () => {
  isRunning.value = true
  try {
    const { $api } = useNuxtApp()
    // A rota correspondente no Elysia para o gatilho manual
    const res = await $api.api.jobs.recurrence.post()
    
    if (res.error) throw res.error

    toast.add({
      title: 'Cron Executado',
      description: 'As recorrências foram processadas com sucesso!',
      color: 'green'
    })
  } catch (err: any) {
    console.error(err)
    toast.add({
      title: 'Erro no Cron',
      description: err.message || 'Falha ao executar o gatilho manual.',
      color: 'red'
    })
  } finally {
    isRunning.value = false
  }
}
</script>

<template>
  <div class="p-6 max-w-7xl mx-auto space-y-6">
    <div class="flex items-center justify-between">
      <h1 class="text-3xl font-bold tracking-tight text-white">
        Administração
      </h1>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
      <UCard :ui="{ background: 'bg-zinc-900', ring: 'ring-1 ring-zinc-800' }">
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon name="i-heroicons-cpu-chip" class="w-5 h-5 text-emerald-400" />
            <h3 class="font-semibold text-lg text-white">Rotinas de Background (Cron)</h3>
          </div>
        </template>
        
        <p class="text-sm text-zinc-400 mb-6">
          Utilize esta seção para forçar a execução manual de rotinas que normalmente ocorrem em background, útil para testes e depuração.
        </p>

        <div class="space-y-4">
          <div class="flex items-center justify-between p-4 bg-zinc-950/50 rounded-lg border border-zinc-800/50">
            <div>
              <p class="font-medium text-white text-sm">Motor de Recorrências</p>
              <p class="text-xs text-zinc-500 mt-1">Lança transações de bolsas, assinaturas e parcelamentos previstos para o mês atual.</p>
            </div>
            <UButton 
              color="primary" 
              variant="soft" 
              icon="i-heroicons-play" 
              :loading="isRunning"
              @click="triggerCron"
            >
              Executar Agora
            </UButton>
          </div>
        </div>
      </UCard>
    </div>
  </div>
</template>
