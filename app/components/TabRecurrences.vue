<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRecurrenceModal } from '~/composables/useRecurrenceModal'
import { useFinanceStore } from '../stores/finance'

const { open } = useRecurrenceModal()
const financeStore = useFinanceStore()

const { data: recurrences, refresh } = await useAsyncData('recurrences', async () => {
  const res = await api.api.recurrences.get()
  if (res.error) throw res.error
  return (res.data as any[]) ?? []
})

const incomes = computed(() => recurrences.value?.filter(r => r.type === 'income') || [])
const expenses = computed(() => recurrences.value?.filter(r => r.type === 'expense') || [])

const isDetailsOpen = ref(false)
const selectedRecurrence = ref<any | null>(null)

function openDetails(rec: any) {
  selectedRecurrence.value = rec
  isDetailsOpen.value = true
}


function badgeColor(type: string) {
  return type === 'income' ? 'green' : 'red'
}
function badgeLabel(type: string) {
  return type === 'income' ? 'Receita' : 'Despesa'
}

function getSourceName(rec: any) {
  if (rec.type === 'income') {
    const acc = financeStore.accounts.find(a => a.id === rec.account_id)
    return acc ? `Cai na Conta: ${acc.name}` : 'Sem conta vinculada'
  } else {
    if (rec.card_id) {
      const card = financeStore.cards.find(c => c.id === rec.card_id)
      return card ? `Debita do Cartão: ${card.name}` : 'Sem cartão vinculado'
    } else {
      const acc = financeStore.accounts.find(a => a.id === rec.account_id)
      return acc ? `Debita da Conta: ${acc.name}` : 'Sem conta vinculada'
    }
  }
}
</script>

<template>
  <div class="space-y-4">
    <!-- Header -->
    <div class="flex items-center justify-between">
      <p class="text-sm text-zinc-400">Contratos que o motor de Cron processa automaticamente toda madrugada.</p>
      <UButton icon="i-heroicons-plus" size="sm" color="primary" label="Nova Recorrência" @click="open()" />
    </div>

    <!-- Lista vazia -->
    <div v-if="!recurrences?.length" class="flex flex-col items-center py-16 text-zinc-500 gap-2">
      <UIcon name="i-heroicons-arrows-right-left" class="w-10 h-10" />
      <p>Nenhuma recorrência cadastrada ainda.</p>
      <UButton size="sm" color="primary" variant="ghost" label="Criar primeira recorrência" @click="open()" />
    </div>

    <!-- Lista Receitas -->
    <div v-if="incomes.length > 0">
      <h3 class="text-sm font-semibold text-emerald-400 mb-2 border-b border-zinc-800 pb-1">Receitas Fixas</h3>
      <ul class="divide-y divide-zinc-800/50">
        <li
          v-for="rec in incomes"
          :key="rec.id"
          class="flex items-center justify-between py-3"
        >
          <div class="flex items-center gap-3">
            <UBadge color="green" variant="subtle" label="Receita" />
            <div class="cursor-pointer hover:underline" @click="openDetails(rec)">
              <p class="text-white font-medium flex items-center gap-2">
                {{ rec.name }}
                <UBadge v-if="rec.total_installments > 0" color="blue" variant="subtle" size="xs">{{ rec.total_installments }}x</UBadge>
              </p>
              <p class="text-xs text-zinc-500">
                Entra todo dia {{ rec.payday }} • {{ getSourceName(rec) }}
                <span v-if="rec.status === 'ended'" class="ml-1 text-red-400">(encerrada)</span>
                <span v-else-if="rec.status === 'paused'" class="ml-1 text-yellow-400">(pausada)</span>
              </p>
            </div>
          </div>
          <div class="flex items-center gap-4">
            <span class="font-mono font-semibold text-emerald-400">
              {{ formatCurrency(rec.amount) }}
            </span>
          </div>
        </li>
      </ul>
    </div>

    <!-- Lista Despesas -->
    <div v-if="expenses.length > 0">
      <h3 class="text-sm font-semibold text-red-400 mb-2 border-b border-zinc-800 pb-1 mt-4">Despesas Fixas</h3>
      <ul class="divide-y divide-zinc-800/50">
        <li
          v-for="rec in expenses"
          :key="rec.id"
          class="flex items-center justify-between py-3"
        >
          <div class="flex items-center gap-3">
            <UBadge color="red" variant="subtle" label="Despesa" />
            <div class="cursor-pointer hover:underline" @click="openDetails(rec)">
              <p class="text-white font-medium flex items-center gap-2">
                {{ rec.name }}
                <UBadge v-if="rec.total_installments > 0" color="blue" variant="subtle" size="xs">{{ rec.total_installments }}x</UBadge>
              </p>
              <p class="text-xs text-zinc-500">
                Cobra todo dia {{ rec.payday }} • {{ getSourceName(rec) }}
                <span v-if="rec.status === 'ended'" class="ml-1 text-red-400">(encerrada)</span>
                <span v-else-if="rec.status === 'paused'" class="ml-1 text-yellow-400">(pausada)</span>
              </p>
            </div>
          </div>
          <div class="flex items-center gap-4">
            <span class="font-mono font-semibold text-red-400">
              {{ formatCurrency(rec.amount) }}
            </span>
          </div>
        </li>
      </ul>
    </div>

    <!-- Modal e Slideover -->
    <RecurrenceModal @created="refresh" />
    <RecurrenceDetails v-model="isDetailsOpen" :recurrence="selectedRecurrence" @refresh="refresh" />
  </div>
</template>
