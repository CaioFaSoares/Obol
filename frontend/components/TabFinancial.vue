<script setup lang="ts">
import { ref, computed } from 'vue'
import { useFinanceStore } from '../stores/finance'

const financeStore = useFinanceStore()

const accounts = computed(() => financeStore.accounts)
const cards = computed(() => financeStore.cards)

const accountModal = ref()
const cardModal = ref()

async function refreshAccounts() {
  await financeStore.loadBaseData(true)
}

async function refreshCards() {
  await financeStore.loadBaseData(true)
}
</script>

<template>
  <div class="space-y-8">
    <p class="text-sm text-zinc-400 -mb-4">Gestão do seu patrimônio e linhas de crédito.</p>

    <!-- Seção Contas -->
    <section class="space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-semibold text-white flex items-center gap-2">
          <UIcon name="i-heroicons-building-library" /> Contas Bancárias
        </h2>
        <UButton icon="i-heroicons-plus" size="sm" color="primary" label="Nova Conta" @click="accountModal?.open()" />
      </div>

      <div v-if="!accounts?.length" class="bg-zinc-800/30 rounded-xl p-8 text-center text-zinc-500">
        Nenhuma conta cadastrada.
      </div>

      <ul v-else class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <li
          v-for="acc in accounts"
          :key="acc.id"
          class="bg-zinc-800/50 rounded-xl p-4 border border-zinc-700/50"
        >
          <div class="flex items-start justify-between">
            <div>
              <p class="text-white font-medium">{{ acc.name }}</p>
              <p class="text-xs text-zinc-400 capitalize">{{ acc.type === 'checking' ? 'Conta Corrente' : acc.type === 'savings' ? 'Poupança' : 'Investimento' }}</p>
            </div>
            <span class="font-mono" :class="acc.initial_balance >= 0 ? 'text-emerald-400' : 'text-red-400'">
              {{ formatCurrency(acc.initial_balance) }}
            </span>
          </div>
        </li>
      </ul>
    </section>

    <!-- Seção Cartões -->
    <section class="space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-semibold text-white flex items-center gap-2">
          <UIcon name="i-heroicons-credit-card" /> Cartões de Crédito
        </h2>
        <UButton icon="i-heroicons-plus" size="sm" color="primary" label="Novo Cartão" @click="cardModal?.open()" />
      </div>

      <div v-if="!cards?.length" class="bg-zinc-800/30 rounded-xl p-8 text-center text-zinc-500">
        Nenhum cartão cadastrado.
      </div>

      <ul v-else class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <li
          v-for="card in cards"
          :key="card.id"
          class="bg-zinc-800/50 rounded-xl p-4 border border-zinc-700/50 space-y-2"
        >
          <div class="flex items-center justify-between">
            <p class="text-white font-medium">{{ card.name }}</p>
            <span class="font-mono text-zinc-300">
              Limite: {{ formatCurrency(card.limit) }}
            </span>
          </div>
          <div class="flex items-center justify-between text-xs text-zinc-500">
            <span>Fecha dia {{ card.closing_day }}</span>
            <span>Vence dia {{ card.due_day }}</span>
          </div>
        </li>
      </ul>
    </section>

    <!-- Modais -->
    <AccountModal ref="accountModal" @created="refreshAccounts" />
    <CardModal ref="cardModal" @created="refreshCards" />
  </div>
</template>
