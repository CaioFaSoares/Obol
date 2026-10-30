<script setup lang="ts">
import { ref } from 'vue'

const toast = useToast()
const isRunning = ref(false)

const isResetOpen = ref(false)
const isResetting = ref(false)
const confirmText = ref('')

const canConfirm = computed(() => confirmText.value.trim().toUpperCase() === 'LIMPAR')

const openReset = () => {
  confirmText.value = ''
  isResetOpen.value = true
}

const resetError = ref('')

const submitReset = async () => {
  if (!canConfirm.value || isResetting.value) return
  isResetting.value = true
  resetError.value = ''
  try {
    const res = await api.api.admin.reset.post({ confirm: 'LIMPAR' })
    if (res.error) {
      const value: any = (res.error as any).value
      const status = (res.error as any).status
      throw new Error(
        value?.details || value?.error || value?.message || `Falha ao limpar a base de dados (${status}).`
      )
    }
    const total = (res.data as any)?.total ?? 0
    isResetOpen.value = false
    confirmText.value = ''
    useRefresh().triggerRefresh()
    await useFinanceStore().loadBaseData(true)
    toast.add({
      title: 'Base de dados limpa',
      description: `${total} registro(s) removido(s) permanentemente.`,
      color: 'green'
    })
  } catch (err: any) {
    console.error(err)
    const message = err.message || 'Falha ao limpar a base de dados.'
    resetError.value = message
    toast.add({
      title: 'Erro ao limpar base de dados',
      description: message,
      color: 'red'
    })
  } finally {
    isResetting.value = false
  }
}

const triggerCron = async () => {
  isRunning.value = true
  try {
    // A rota correspondente no Elysia para o gatilho manual
    const res = await api.api.jobs.recurrence.post()
    
    if (res.error) throw res.error

    const data = res.data as any;
    let desc = `Lançadas: ${data.processed} | Ignoradas: ${data.skipped}`;
    if (data.generatedNames && data.generatedNames.length > 0) {
      desc += `\n\nGeradas:\n- ${data.generatedNames.join('\n- ')}`;
    }

    toast.add({
      title: 'Cron Executado',
      description: desc,
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
  <div class="p-4 sm:p-6 max-w-7xl mx-auto space-y-6">
    <div class="flex items-center justify-between gap-3">
      <h1 class="text-2xl sm:text-3xl font-bold tracking-tight text-white">
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
          <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 p-4 bg-zinc-950/50 rounded-lg border border-zinc-800/50">
            <div class="min-w-0">
              <p class="font-medium text-white text-sm">Motor de Recorrências</p>
              <p class="text-xs text-zinc-500 mt-1 break-words">Lança transações de bolsas, assinaturas e parcelamentos previstos para o mês atual.</p>
            </div>
            <UButton
              class="self-stretch sm:self-auto"
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

      <UCard :ui="{ background: 'bg-zinc-900', ring: 'ring-1 ring-zinc-800' }">
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon name="i-heroicons-trash" class="w-5 h-5 text-red-400" />
            <h3 class="font-semibold text-lg text-white">Limpar Base de Dados</h3>
          </div>
        </template>

        <p class="text-sm text-zinc-400 mb-4">
          Esta ação <span class="text-red-400 font-medium">não pode ser desfeita</span>. Todos os registros financeiros serão excluídos permanentemente: transações, faturas, recorrências, cartões, contas, categorias e projetos.
        </p>
        <p class="text-sm text-zinc-500 mb-6">
          A sua conta de proprietário e as sessões ativas são preservadas.
        </p>

        <UButton
          class="w-full sm:w-auto"
          color="red"
          variant="soft"
          icon="i-heroicons-exclamation-triangle"
          @click="openReset"
        >
          Limpar Base de Dados
        </UButton>
      </UCard>
    </div>

    <UModal v-model="isResetOpen">
      <UCard :ui="{ background: 'bg-zinc-900', ring: 'ring-1 ring-zinc-800' }">
        <template #header>
          <div class="flex items-center gap-2">
            <UIcon name="i-heroicons-exclamation-triangle" class="w-5 h-5 text-red-400" />
            <h3 class="font-semibold text-lg text-white">Confirmar Exclusão</h3>
          </div>
        </template>

        <UAlert
          v-if="resetError"
          icon="i-heroicons-exclamation-triangle"
          color="red"
          variant="soft"
          title="Erro ao limpar a base de dados"
          :description="resetError"
          class="mb-4"
        />

        <p class="text-sm text-zinc-400 mb-4">
          Todos os registros financeiros (transações, faturas, recorrências, cartões, contas, categorias e projetos) serão excluídos permanentemente. Sua conta e suas sessões ativas serão preservadas.
        </p>
        <p class="text-sm text-zinc-500 mb-2">
          Digite <span class="text-white font-semibold">LIMPAR</span> para confirmar:
        </p>
        <UFormGroup label="Confirmação">
          <UInput
            v-model="confirmText"
            placeholder="LIMPAR"
            autocomplete="off"
            class="w-full"
          />
        </UFormGroup>

        <template #footer>
          <div class="flex flex-col sm:flex-row justify-end gap-3">
            <UButton
              class="w-full sm:w-auto"
              color="gray"
              variant="ghost"
              :disabled="isResetting"
              @click="isResetOpen = false"
            >
              Cancelar
            </UButton>
            <UButton
              class="w-full sm:w-auto"
              color="red"
              icon="i-heroicons-trash"
              :disabled="!canConfirm"
              :loading="isResetting"
              @click="submitReset"
            >
              Limpar Agora
            </UButton>
          </div>
        </template>
      </UCard>
    </UModal>
  </div>
</template>
