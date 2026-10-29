<script setup lang="ts">
import { computed, ref } from 'vue'
import { formatCurrency } from '../utils/formatters'

const props = defineProps<{
  data?: any[]
  selectedDate?: string
}>()

const emit = defineEmits<{
  (e: 'select', payload: { date: string, balance: number }): void
}>()

// Local (safe, non-UTC) YYYY-MM-DD for today, matching getForecastRange
const todayStr = (() => {
  const now = new Date()
  const offset = now.getTimezoneOffset()
  const localDate = new Date(now.getTime() - (offset * 60 * 1000))
  return localDate.toISOString().split('T')[0]
})()

const pad = (n: number) => String(n).padStart(2, '0')

const today = (() => {
  const [y, m, d] = todayStr.split('-').map(Number)
  return { y, m, d }
})()

// Displayed month (1-based month), defaults to the current month
const viewYear = ref(today.y)
const viewMonth = ref(today.m)

const balanceByDate = computed(() => {
  const map = new Map<string, number>()
  for (const point of props.data || []) {
    if (!point?.date) continue
    const key = point.date instanceof Date
      ? point.date.toISOString().slice(0, 10)
      : String(point.date).slice(0, 10)
    const balance = Number(point.balance) || 0
    if (!map.has(key)) map.set(key, balance)
  }
  return map
})

const hasData = computed(() => (props.data || []).length > 0)

const toDateStr = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`

const parseDateStr = (dateStr: string) => {
  const [y, m, d] = dateStr.split('-').map(Number)
  return { y, m, d }
}

const shiftDateStr = (dateStr: string, days: number) => {
  const { y, m, d } = parseDateStr(dateStr)
  const shifted = new Date(y, m - 1, d + days)
  return toDateStr(shifted.getFullYear(), shifted.getMonth() + 1, shifted.getDate())
}

// 7 cols; rows padded so every month ends on a complete week
interface CalCell {
  date: string
  day: number
  balance?: number
  hasBalance: boolean
  isToday: boolean
}

const calendarCells = computed(() => {
  const cells: (CalCell | null)[] = []
  const monthLength = new Date(viewYear.value, viewMonth.value, 0).getDate()
  const leadingBlanks = new Date(viewYear.value, viewMonth.value - 1, 1).getDay()

  for (let i = 0; i < leadingBlanks; i++) cells.push(null)

  for (let d = 1; d <= monthLength; d++) {
    const dateStr = toDateStr(viewYear.value, viewMonth.value, d)
    const hasBalance = balanceByDate.value.has(dateStr)
    cells.push({
      date: dateStr,
      day: d,
      balance: hasBalance ? balanceByDate.value.get(dateStr) : undefined,
      hasBalance,
      isToday: dateStr === todayStr
    })
  }

  while (cells.length % 7 !== 0) cells.push(null)
  return cells
})

const weekdayLabels = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

// "outubro de 2026" from numeric month, no Date/timezone pitfalls
const monthLabel = computed(() => {
  const monthName = new Intl.DateTimeFormat('pt-BR', { month: 'long' }).format(
    new Date(viewYear.value, viewMonth.value - 1, 1)
  )
  return `${monthName} de ${viewYear.value}`
})

// Full spoken label, e.g. "25 de outubro de 2026 saldo previsto R$ 1.234,56"
const dateSpoken = (dateStr: string) => {
  const { y, m, d } = parseDateStr(dateStr)
  const full = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' }).format(
    new Date(y, m - 1, d)
  )
  return full
}

const compactCurrency = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  notation: 'compact',
  maximumFractionDigits: 1
})

const compactBalance = (value: number) => compactCurrency.format(value)

const navigationMonth = (delta: number) => {
  const shifted = new Date(viewYear.value, viewMonth.value - 1 + delta, 1)
  viewYear.value = shifted.getFullYear()
  viewMonth.value = shifted.getMonth() + 1
}

const goToToday = () => {
  viewYear.value = today.y
  viewMonth.value = today.m
}

const selectDay = (cell: CalCell) => {
  if (!cell.hasBalance) return
  emit('select', { date: cell.date, balance: cell.balance || 0 })
}

const balanceToneClass = (cell: CalCell) => {
  const balance = cell.balance
  if (balance === undefined) return 'text-zinc-600 hover:bg-zinc-800/50'
  if (balance === 0) return 'text-zinc-300 hover:bg-zinc-800'
  if (balance < 0) return 'text-red-400 hover:bg-red-500/10'
  return 'text-emerald-300 hover:bg-emerald-500/10'
}

const isSelected = (cell: CalCell) => !!props.selectedDate && props.selectedDate === cell.date

const onCellKeydown = (event: KeyboardEvent, cell: CalCell) => {
  const moves: Record<string, number> = {
    ArrowLeft: -1,
    ArrowRight: 1,
    ArrowUp: -7,
    ArrowDown: 7
  }
  const delta = moves[event.key]
  if (delta === undefined) return

  event.preventDefault()
  const nextDate = shiftDateStr(cell.date, delta)
  const { y, m } = parseDateStr(nextDate)
  if (y !== viewYear.value || m !== viewMonth.value) return

  document.getElementById(`fc-cell-${nextDate}`)?.focus()
}
</script>

<template>
  <section
    class="w-full bg-zinc-900 ring-1 ring-zinc-800 rounded-xl p-3 sm:p-4"
    aria-label="Calendário de saldo projetado"
  >
    <!-- Header: month navigation -->
    <div class="flex items-center justify-between gap-2">
      <UButton
        color="gray"
        variant="ghost"
        icon="i-heroicons-chevron-left"
        aria-label="Mês anterior"
        @click="navigationMonth(-1)"
      />
      <p class="flex-1 text-center font-semibold uppercase tracking-wide text-zinc-200 text-sm sm:text-base truncate" aria-live="polite">
        {{ monthLabel }}
      </p>
      <UButton
        color="gray"
        variant="ghost"
        icon="i-heroicons-chevron-right"
        aria-label="Próximo mês"
        @click="navigationMonth(1)"
      />
    </div>

    <!-- Go to today -->
    <div class="flex items-center justify-center mt-1">
      <UButton
        color="gray"
        variant="ghost"
        label="Hoje"
        icon="i-heroicons-calendar-days"
        size="xs"
        :aria-label="'Ir para hoje, ' + dateSpoken(todayStr)"
        @click="goToToday"
      />
    </div>

    <p v-if="!hasData" class="mt-2 text-center text-xs text-zinc-500">
      Sem dados de projeção para exibir. Gere o forecast para ver os saldos diários.
    </p>

    <!-- Calendar grid -->
    <div role="grid" class="mt-2">
      <div role="row" class="grid grid-cols-7 gap-1">
        <div
          v-for="label in weekdayLabels"
          :key="label"
          role="columnheader"
          class="text-center text-[10px] sm:text-xs font-medium uppercase tracking-wide text-zinc-500 select-none"
        >
          {{ label }}
        </div>
      </div>
      <div role="row" class="grid grid-cols-7 gap-1 mt-1">
        <template v-for="(cell, index) in calendarCells" :key="cell ? cell.date : `blank-${index}`">
          <div v-if="!cell" class="rounded-lg" aria-hidden="true">
            <!-- Placeholder for another month -->
          </div>
          <div
            v-else-if="!cell.hasBalance"
            role="gridcell"
            class="rounded-lg p-px"
            :aria-label="dateSpoken(cell.date) + ' sem projeção'"
          >
            <button
              :id="`fc-cell-${cell.date}`"
              type="button"
              disabled
              class="w-full h-full min-h-[3rem] sm:min-h-[4.25rem] flex flex-col items-center justify-center gap-0.5 rounded-lg px-0.5 py-1.5 text-sm text-zinc-600 cursor-not-allowed select-none overflow-hidden"
              :title="dateSpoken(cell.date) + ' sem projeção'"
              :aria-disabled="true"
            >
              <span>{{ cell.day }}</span>
            </button>
          </div>
          <div
            v-else
            role="gridcell"
            class="rounded-lg p-px"
          >
            <button
              :id="`fc-cell-${cell.date}`"
              type="button"
              class="w-full h-full min-h-[3rem] sm:min-h-[4.25rem] flex flex-col items-center justify-center gap-0.5 rounded-lg px-0.5 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 overflow-hidden min-w-0"
              :class="[balanceToneClass(cell), isSelected(cell) ? 'bg-primary-500/15 ring-2 ring-primary-500' : '', cell.isToday ? 'ring-1 ring-amber-400' : '']"
              :aria-pressed="isSelected(cell) ? 'true' : undefined"
              :aria-label="dateSpoken(cell.date) + ' saldo previsto ' + formatCurrency(cell.balance || 0)"
              @click="selectDay(cell)"
              @keydown="onCellKeydown($event, cell)"
            >
              <span :class="cell.isToday ? 'font-bold' : ''">{{ cell.day }}</span>
              <span class="text-[9px] sm:text-[11px] font-medium opacity-90 leading-none whitespace-nowrap max-[359px]:hidden" :class="cell.balance !== undefined && cell.balance < 0 ? 'text-red-400' : 'text-emerald-400'">
                {{ compactBalance(cell.balance || 0) }}
              </span>
            </button>
          </div>
        </template>
      </div>
    </div>

    <!-- Legend -->
    <div class="mt-3 flex items-center justify-center gap-4 flex-wrap text-[10px] sm:text-xs text-zinc-500">
      <span class="flex items-center gap-1">
        <span class="w-2 h-2 rounded-full bg-emerald-400" aria-hidden="true" />
        Saldo positivo
      </span>
      <span class="flex items-center gap-1">
        <span class="w-2 h-2 rounded-full bg-red-400" aria-hidden="true" />
        Saldo negativo
      </span>
      <span class="flex items-center gap-1">
        <span class="w-2 h-2 rounded-full bg-zinc-700 ring-1 ring-amber-400" aria-hidden="true" />
        Hoje
      </span>
      <span class="flex items-center gap-1">
        <span class="w-2 h-2 rounded-full bg-zinc-800" aria-hidden="true" />
        Sem projeção
      </span>
    </div>
  </section>
</template>
