<script setup lang="ts">
import { ref, computed } from 'vue'
import { useFinanceStore } from '../stores/finance'

const financeStore = useFinanceStore()
const projects = computed(() => financeStore.projects)

const activeProjects = computed(() => projects.value.filter(p => p.status === 'active'))
const completedProjects = computed(() => projects.value.filter(p => p.status === 'completed'))

const projectModal = ref()

const paymentModal = ref<{ open: boolean; projectId: string; projectName: string }>({
  open: false,
  projectId: '',
  projectName: '',
})
const paymentAmount = ref<number>()
const paymentDesc = ref('')
const isSubmitting = ref(false)
const isFinishing = ref<string | null>(null)

async function finishProject(id: string) {
  isFinishing.value = id
  try {
    const res = await api.api.projects({ id }).complete.patch()
    if (res.error) throw res.error
    await financeStore.loadBaseData(true)
  } catch (err) {
    console.error('Erro ao finalizar projeto', err)
  } finally {
    isFinishing.value = null
  }
}

function openPayment(project: any) {
  paymentModal.value = { open: true, projectId: project.id, projectName: project.name }
  paymentAmount.value = undefined
  paymentDesc.value = ''
}

function closePayment() {
  paymentModal.value.open = false
}

async function submitPayment() {
  if (!paymentAmount.value) return
  isSubmitting.value = true
  try {
    const res = await api.api.projects({ id: paymentModal.value.projectId }).payment.post({
      amount: paymentAmount.value,
      description: paymentDesc.value || undefined,
    })
    if (res.error) throw res.error
    await financeStore.loadBaseData(true)
    closePayment()
  } catch (err) {
    console.error('Erro ao registrar pagamento', err)
  } finally {
    isSubmitting.value = false
  }
}

function receivedPercent(received: number, total: number) {
  if (!total) return 0
  return Math.min(100, Math.round((received / total) * 100))
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <p class="text-sm text-zinc-400">Acompanhamento dos seus recebíveis por projeto/cliente.</p>
      <UButton icon="i-heroicons-plus" size="sm" color="primary" label="Novo Projeto" @click="projectModal?.open()" />
    </div>

    <div v-if="!activeProjects?.length" class="flex flex-col items-center py-16 text-zinc-500 gap-2">
      <UIcon name="i-heroicons-briefcase" class="w-10 h-10" />
      <p>Nenhum projeto ativo no momento.</p>
    </div>

    <ul v-else class="space-y-4">
      <li
        v-for="project in activeProjects"
        :key="project.id"
        class="bg-zinc-800/50 rounded-xl p-4 space-y-3"
      >
        <div class="flex items-center justify-between">
          <div>
            <p class="text-white font-semibold">{{ project.name }}</p>
            <UBadge color="blue" variant="subtle" label="Em andamento" size="xs" class="mt-1" />
          </div>
          <div class="flex items-center gap-2">
            <UButton
              v-if="project.received >= project.total_value"
              icon="i-heroicons-check-circle"
              size="sm"
              color="green"
              variant="solid"
              label="Finalizar"
              :loading="isFinishing === project.id"
              @click="finishProject(project.id)"
            />
            <UButton
              icon="i-heroicons-arrow-down-tray"
              size="sm"
              color="emerald"
              variant="soft"
              label="Dar Baixa"
              @click="openPayment(project)"
            />
          </div>
        </div>

        <!-- Barra de progresso -->
        <div class="space-y-1">
          <div class="w-full bg-zinc-700 rounded-full h-2">
            <div
              class="h-2 rounded-full bg-emerald-500 transition-all duration-500"
              :style="{ width: `${receivedPercent(project.received, project.total_value)}%` }"
            />
          </div>
          <div class="flex justify-between text-xs text-zinc-400">
            <span>Recebido: <span class="text-emerald-400 font-mono">{{ formatCurrency(project.received) }}</span></span>
            <span>Total: <span class="text-white font-mono">{{ formatCurrency(project.total_value) }}</span></span>
          </div>
        </div>
      </li>
    </ul>

    <!-- Seção Histórico -->
    <div v-if="completedProjects.length > 0" class="mt-12">
      <h3 class="text-sm font-semibold text-zinc-400 mb-4 border-b border-zinc-800 pb-2">Histórico de Projetos Concluídos</h3>
      <ul class="space-y-4">
        <li
          v-for="project in completedProjects"
          :key="project.id"
          class="bg-zinc-900 rounded-xl p-4 space-y-3 opacity-80"
        >
          <div class="flex items-center justify-between">
            <div>
              <p class="text-white font-medium">{{ project.name }}</p>
              <UBadge color="gray" variant="subtle" label="Concluído" size="xs" class="mt-1" />
            </div>
            <div class="text-right">
              <p class="text-xs text-zinc-500">Valor Arrecadado</p>
              <p class="text-lg font-mono text-emerald-400">{{ formatCurrency(project.received) }}</p>
            </div>
          </div>

          <div v-if="project.accounts_breakdown?.length" class="bg-zinc-800/50 rounded-lg p-3 text-sm">
            <p class="text-xs text-zinc-500 mb-2">Destino dos fundos:</p>
            <ul class="space-y-1">
              <li v-for="br in project.accounts_breakdown" :key="br.account_name" class="flex justify-between">
                <span class="text-zinc-300">{{ br.account_name }}</span>
                <span class="font-mono text-emerald-400/80">{{ formatCurrency(br.amount) }}</span>
              </li>
            </ul>
          </div>
        </li>
      </ul>
    </div>

    <!-- Modal de Pagamento -->
    <UModal v-model="paymentModal.open">
      <UCard :ui="{ ring: '', divide: 'divide-y divide-gray-100 dark:divide-gray-800' }">
        <template #header>
          <div class="flex items-center justify-between">
            <h3 class="text-base font-semibold text-white">
              Dar Baixa — {{ paymentModal.projectName }}
            </h3>
            <UButton color="gray" variant="ghost" icon="i-heroicons-x-mark" class="-my-1" @click="closePayment" />
          </div>
        </template>

        <form @submit.prevent="submitPayment" class="space-y-4">
          <UFormGroup label="Valor recebido (R$)">
            <UInput v-model="paymentAmount" type="text" placeholder="0.00" autofocus />
          </UFormGroup>
          <UFormGroup label="Descrição (opcional)">
            <UInput v-model="paymentDesc" placeholder="Ex: 1ª parcela, entrega final..." />
          </UFormGroup>
          <div class="flex justify-end gap-3 pt-2">
            <UButton label="Cancelar" variant="ghost" color="gray" @click="closePayment" />
            <UButton type="submit" label="Confirmar Recebimento" color="emerald" :loading="isSubmitting" />
          </div>
        </form>
      </UCard>
    </UModal>

    <!-- Modal Novo Projeto -->
    <ProjectModal ref="projectModal" @created="financeStore.loadBaseData(true)" />
  </div>
</template>
