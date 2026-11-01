<script setup lang="ts">
import { ref } from 'vue'

const { data: budgets, pending, error, refresh } = await useAsyncData('budgets', async () => {
  const res = await api.api.categories.budgets.get()
  if (res.error) throw res.error
  return (res.data as any[]) ?? []
})

function progressPercent(spent: number, budget: number) {
  if (!budget) return 0
  const percent = Math.round((spent / budget) * 100)
  return Math.max(0, Math.min(100, percent))
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
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p class="text-sm text-zinc-400 min-w-0">Monitoramento dos seus "potes" de orçamento mensal.</p>
      <div class="flex items-center gap-2 w-full sm:w-auto">
        <UIcon
          v-if="pending && budgets?.length"
          name="i-heroicons-arrow-path"
          class="w-4 h-4 animate-spin text-primary shrink-0"
          aria-hidden="true"
        />
        <span v-if="pending && budgets?.length" class="sr-only" role="status">Refreshing budgets</span>
        <UButton icon="i-heroicons-plus" size="sm" color="primary" label="Novo Orçamento" class="w-full sm:w-auto justify-center" @click="budgetModal?.open()" />
      </div>
    </div>

    <div v-if="pending && !budgets" class="space-y-3" aria-busy="true">
      <USkeleton class="h-20 w-full rounded-xl bg-zinc-800" />
      <USkeleton class="h-20 w-full rounded-xl bg-zinc-800" />
      <USkeleton class="h-20 w-full rounded-xl bg-zinc-800" />
    </div>

    <template v-else>
      <UAlert
        v-if="error"
        icon="i-heroicons-exclamation-triangle"
        color="red"
        variant="soft"
        title="Could not load budgets"
        description="The budget list could not be fetched. Check your connection and try again."
      >
        <template #actions>
          <UButton
            label="Retry"
            icon="i-heroicons-arrow-path"
            color="red"
            size="sm"
            :loading="pending"
            @click="refresh()"
          />
        </template>
      </UAlert>

      <div v-if="!budgets?.length && !error" class="flex flex-col items-center py-16 text-zinc-500 gap-2">
        <UIcon name="i-heroicons-chart-bar" class="w-10 h-10" />
        <p>Nenhuma categoria de gastos cadastrada.</p>
      </div>

      <ul v-else-if="budgets?.length" class="space-y-4">
      <li
        v-for="cat in budgets"
        :key="cat.id"
        class="bg-zinc-800/50 rounded-xl p-4 space-y-2"
      >
        <div class="flex items-center justify-between gap-3">
          <span class="text-white font-medium min-w-0 break-words">{{ cat.name }}</span>
          <span class="text-sm text-zinc-400 shrink-0 text-right">
            <template v-if="cat.monthly_budget">
              <span :class="progressPercent(cat.spent, cat.monthly_budget) >= 90 ? 'text-red-400' : 'text-white'">
                {{ formatCurrency(cat.spent) }}
              </span>
              <span class="text-zinc-600"> / </span>
              {{ formatCurrency(cat.monthly_budget) }}
            </template>
            <template v-else>
              <span class="text-white">{{ formatCurrency(cat.spent) }}</span>
            </template>
          </span>
        </div>

        <template v-if="cat.monthly_budget">
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
        </template>
        <template v-else>
          <p class="text-xs text-right text-zinc-500">Sem limite definido</p>
        </template>
      </li>
    </ul>
    </template>

    <!-- Modal -->
    <BudgetModal ref="budgetModal" @created="refresh" />
  </div>
</template>
