<script setup lang="ts">
import { ref } from 'vue'

const { data: budgets, refresh } = await useAsyncData('budgets', async () => {
  // @ts-expect-error nested route typing
  const res = await api.api.categories.budgets.get()
  if (res.error) throw res.error
  return (res.data as any[]) ?? []
})

function progressPercent(spent: number, budget: number) {
  if (!budget) return 0
  return Math.min(100, Math.round((spent / budget) * 100))
}

function barColor(percent: number) {
  if (percent >= 90) return 'red'
  if (percent >= 70) return 'yellow'
  return 'green'
}

const budgetModal = ref()
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <p class="text-sm text-zinc-400">Monitoramento dos seus "potes" de orçamento mensal.</p>
      <UButton icon="i-heroicons-plus" size="sm" color="primary" label="Novo Orçamento" @click="budgetModal?.open()" />
    </div>

    <div v-if="!budgets?.length" class="flex flex-col items-center py-16 text-zinc-500 gap-2">
      <UIcon name="i-heroicons-chart-bar" class="w-10 h-10" />
      <p>Nenhuma categoria de orçamento fixo cadastrada.</p>
    </div>

    <ul v-else class="space-y-4">
      <li
        v-for="cat in budgets"
        :key="cat.id"
        class="bg-zinc-800/50 rounded-xl p-4 space-y-2"
      >
        <div class="flex items-center justify-between">
          <span class="text-white font-medium">{{ cat.name }}</span>
          <span class="text-sm text-zinc-400">
            <span :class="progressPercent(cat.spent, cat.monthly_budget) >= 90 ? 'text-red-400' : 'text-white'">
              {{ formatCurrency(cat.spent) }}
            </span>
            <span class="text-zinc-600"> / </span>
            {{ formatCurrency(cat.monthly_budget) }}
          </span>
        </div>

        <div class="w-full bg-zinc-700 rounded-full h-2">
          <div
            class="h-2 rounded-full transition-all duration-500"
            :style="{ width: `${progressPercent(cat.spent, cat.monthly_budget)}%` }"
            :class="{
              'bg-emerald-500': barColor(progressPercent(cat.spent, cat.monthly_budget)) === 'green',
              'bg-yellow-400': barColor(progressPercent(cat.spent, cat.monthly_budget)) === 'yellow',
              'bg-red-500':    barColor(progressPercent(cat.spent, cat.monthly_budget)) === 'red',
            }"
          />
        </div>

        <p class="text-xs text-right" :class="{
          'text-emerald-400': progressPercent(cat.spent, cat.monthly_budget) < 70,
          'text-yellow-400':  progressPercent(cat.spent, cat.monthly_budget) >= 70 && progressPercent(cat.spent, cat.monthly_budget) < 90,
          'text-red-400':     progressPercent(cat.spent, cat.monthly_budget) >= 90,
        }">
          {{ progressPercent(cat.spent, cat.monthly_budget) }}% utilizado
        </p>
      </li>
    </ul>

    <!-- Modal -->
    <BudgetModal ref="budgetModal" @created="refresh" />
  </div>
</template>
