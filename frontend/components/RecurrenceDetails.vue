<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { useFinanceStore } from '../stores/finance'

const props = defineProps<{
  modelValue: boolean
  recurrence: any | null
}>()

const emit = defineEmits(['update:modelValue', 'refresh'])

const isOpen = computed({
  get: () => props.modelValue,
  set: (val) => emit('update:modelValue', val)
})
const toast = useToast()
const financeStore = useFinanceStore()
const isLoading = ref(false)
const transactions = ref<any[]>([])

async function fetchTransactions() {
  if (!props.recurrence?.id) return
  isLoading.value = true
  try {
    const res = await api.api.recurrences({ id: String(props.recurrence.id) }).transactions.get()
    if (!res.error) {
      transactions.value = res.data as any[]
    }
  } catch (e) {
    console.error(e)
  } finally {
    isLoading.value = false
  }
}

watch(() => props.modelValue, (newVal) => {
  if (newVal && props.recurrence) {
    fetchTransactions()
  }
})

async function toggleStatus() {
  if (!props.recurrence) return
  const newStatus = props.recurrence.status === 'active' ? 'paused' : 'active'
  try {
    await api.api.recurrences({ id: String(props.recurrence.id) })['toggle-status'].patch({ status: newStatus })
    toast.add({ title: 'Status Atualizado', color: 'emerald' })
    emit('refresh')
    isOpen.value = false
  } catch (e) {
    toast.add({ title: 'Erro ao alterar status', color: 'red' })
  }
}

async function launchManual() {
  if (!props.recurrence) return
  try {
    await api.api.recurrences({ id: String(props.recurrence.id) }).launch.post()
    toast.add({ title: 'Lançamento Efetuado', description: 'Pendência gerada no Dashboard', color: 'emerald' })
    fetchTransactions()
  } catch (e) {
    toast.add({ title: 'Erro ao lançar', color: 'red' })
  }
}

async function deactivate() {
  if (!props.recurrence) return
  if (!confirm('Deseja desativar este contrato de recorrência?')) return
  try {
    await api.api.recurrences({ id: String(props.recurrence.id) }).delete()
    toast.add({ title: 'Contrato Encerrado', color: 'emerald' })
    emit('refresh')
    isOpen.value = false
  } catch (e) {
    toast.add({ title: 'Erro ao desativar', color: 'red' })
  }
}

async function realizeTransaction(txnId: string, updateBalance: boolean) {
  try {
    const res = await api.api.transactions({ id: txnId }).realize.patch({ update_balance: updateBalance })
    if (res.error) throw res.error

    toast.add({ 
      title: 'Sucesso!', 
      description: updateBalance ? 'Baixa realizada com sucesso.' : 'Baixa silenciosa efetuada.', 
      color: 'emerald' 
    })
    fetchTransactions()
    financeStore.loadBaseData(true)
  } catch (err) {
    console.error(err)
    toast.add({ title: 'Erro', description: 'Não foi possível dar baixa.', color: 'red' })
  }
}

function getBadgeColor(status: string) {
  if (status === 'active') return 'green'
  if (status === 'paused') return 'yellow'
  return 'red'
}

function getBadgeLabel(status: string) {
  if (status === 'active') return 'Ativa'
  if (status === 'paused') return 'Pausada'
  return 'Encerrada'
}
</script>

<template>
  <USlideover v-model="isOpen">
    <div class="flex-1 flex flex-col bg-zinc-900 p-6 overflow-y-auto">
      <div class="flex justify-between items-center mb-6">
        <h2 class="text-xl font-bold text-white">Detalhes da Recorrência</h2>
        <UButton icon="i-heroicons-x-mark" color="gray" variant="ghost" @click="isOpen = false" />
      </div>

      <div v-if="recurrence" class="space-y-6">
        <!-- Cabeçalho -->
        <UCard :ui="{ background: 'bg-zinc-800/50', ring: 'ring-1 ring-zinc-800' }">
          <div class="flex justify-between items-start mb-4">
            <div>
              <h3 class="text-lg font-medium text-white">{{ recurrence.name }}</h3>
              <p class="text-sm text-zinc-400">Dia de cobrança: {{ recurrence.payday }}</p>
            </div>
            <UBadge :color="getBadgeColor(recurrence.status)" variant="subtle">
              {{ getBadgeLabel(recurrence.status) }}
            </UBadge>
          </div>
          <div class="text-3xl font-mono" :class="recurrence.type === 'income' ? 'text-emerald-400' : 'text-red-400'">
            {{ formatCurrency(recurrence.amount) }}
          </div>
        </UCard>

        <!-- Ações -->
        <div class="grid grid-cols-2 gap-3" v-if="recurrence.status !== 'ended'">
          <UButton 
            v-if="recurrence.status === 'active'"
            icon="i-heroicons-pause" 
            color="yellow" 
            variant="soft" 
            label="Pausar" 
            block
            @click="toggleStatus"
          />
          <UButton 
            v-if="recurrence.status === 'paused'"
            icon="i-heroicons-play" 
            color="green" 
            variant="soft" 
            label="Reativar" 
            block
            @click="toggleStatus"
          />
          <UButton 
            icon="i-heroicons-bolt" 
            color="primary" 
            label="Lançar Agora" 
            block
            @click="launchManual"
          />
        </div>
        
        <UButton 
          v-if="recurrence.status !== 'ended'"
          icon="i-heroicons-trash" 
          color="red" 
          variant="ghost" 
          label="Encerrar Contrato" 
          block
          @click="deactivate"
        />

        <!-- Histórico -->
        <div>
          <h4 class="text-sm font-semibold text-zinc-300 mb-3 border-b border-zinc-800 pb-2">Histórico de Transações</h4>
          <div v-if="isLoading" class="space-y-2">
            <USkeleton class="h-10 w-full bg-zinc-800" v-for="i in 3" :key="i" />
          </div>
          <div v-else-if="transactions.length === 0" class="text-center py-4 text-zinc-500 text-sm">
            Nenhuma transação gerada ainda.
          </div>
          <ul v-else class="space-y-2">
            <li v-for="txn in transactions" :key="txn.id" class="flex justify-between items-center p-3 rounded bg-zinc-800/30 group">
              <div>
                <p class="text-sm text-white font-medium">{{ txn.title }}</p>
                <p class="text-xs text-zinc-500">{{ formatDate(txn.expected_date) }}</p>
              </div>
              <div class="flex items-center gap-2">
                <UBadge :color="txn.status === 'realized' ? 'green' : 'yellow'" variant="subtle" size="xs">
                  {{ txn.status === 'realized' ? 'Pago' : 'Pendente' }}
                </UBadge>
                
                <UDropdown 
                  v-if="txn.status === 'pending'"
                  :items="[[
                    { label: 'Dar baixa e somar no saldo', icon: 'i-heroicons-plus-circle', click: () => realizeTransaction(txn.id, true) },
                    { label: 'Já está no saldo (Baixa Silenciosa)', icon: 'i-heroicons-eye-slash', click: () => realizeTransaction(txn.id, false) }
                  ]]" 
                  :popper="{ placement: 'bottom-end' }"
                >
                  <UButton 
                    icon="i-heroicons-check-circle" 
                    color="emerald" 
                    variant="ghost" 
                    size="xs"
                    class="opacity-0 group-hover:opacity-100 transition-opacity"
                    title="Opções de Baixa"
                  />
                </UDropdown>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </USlideover>
</template>
