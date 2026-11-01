<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRecurrenceModal } from '~/composables/useRecurrenceModal'
import { useFinanceStore } from '../stores/finance'

const { isOpen, close, recurrenceToEdit } = useRecurrenceModal()
const financeStore = useFinanceStore()

type RecurrenceFrequency = 'monthly' | 'weekly'

const isSubmitting = ref(false)
const name = ref('')
const amount = ref<number>()
const payday = ref<number>(1)
const frequency = ref<RecurrenceFrequency>('monthly')
const weekday = ref<number>(1)
const type = ref<'income' | 'expense'>('expense')
const source = ref<'account' | 'card'>('account')
const accountId = ref('')
const cardId = ref('')
const categoryId = ref('')
const endDate = ref('')
const isInstallment = ref(false)
const totalInstallments = ref<number>()

/** ISO weekday 1..7 (Monday = 1); anything else falls back to Monday. */
function isIsoWeekday(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 7
}

watch(type, (newType) => {
  if (newType === 'income' && source.value === 'card') {
    source.value = 'account'
  }
})

watch(recurrenceToEdit, (val) => {
  if (val) {
    name.value = val.name
    amount.value = val.amount
    payday.value = val.payday
    frequency.value = val.frequency === 'weekly' ? 'weekly' : 'monthly'
    weekday.value = isIsoWeekday(val.weekday) ? val.weekday : 1
    type.value = val.type
    if (val.card_id) {
      source.value = 'card'
      cardId.value = val.card_id
    } else {
      source.value = 'account'
      accountId.value = val.account_id || ''
    }
    categoryId.value = val.category_id || ''
    endDate.value = val.end_date ? val.end_date.split('T')[0] : ''
    if (val.total_installments && val.total_installments > 0) {
      isInstallment.value = true
      totalInstallments.value = val.total_installments
    } else {
      isInstallment.value = false
      totalInstallments.value = undefined
    }
  } else {
    name.value = ''
    amount.value = undefined
    payday.value = 1
    frequency.value = 'monthly'
    weekday.value = 1
    type.value = 'expense'
    source.value = 'account'
    accountId.value = ''
    cardId.value = ''
    categoryId.value = ''
    endDate.value = ''
    isInstallment.value = false
    totalInstallments.value = undefined
  }
}, { immediate: true })

const emit = defineEmits<{ created: [] }>()

/**
 * Update body built from the editable form fields.
 *
 * An omitted field keeps the stored value and `null` clears it. The wire
 * contract allows a readonly `skipped_periods` list, but this modal never edits
 * skipped periods, so it is omitted here (preserved server-side) instead of
 * being echoed back as a mutable default.
 */
interface RecurrenceFormPatch {
  name: string
  amount: number
  payday: number
  frequency: RecurrenceFrequency
  weekday: number | null
  type: 'income' | 'expense'
  account_id: string | null
  card_id: string | null
  category_id: string | null
  end_date: string | null
  total_installments?: number | null
}

/**
 * Switching origin clears the other relation explicitly, and an emptied end
 * date or a disabled installment plan clears those fields instead of
 * preserving stale values. Create requests omit unset fields and never send
 * null.
 *
 * A monthly cadence clears `weekday` with `null` so a row switched back from
 * weekly does not keep a stored ISO weekday.
 */
function buildUpdatePatch(input: {
  name: string
  amount: number
  payday: number
  frequency: RecurrenceFrequency
  weekday: number
  type: 'income' | 'expense'
  source: 'account' | 'card'
  accountId: string
  cardId: string
  categoryId: string
  endDate: string
  isInstallment: boolean
  totalInstallments: number | undefined
}): RecurrenceFormPatch {
  const base: RecurrenceFormPatch = {
    name: input.name,
    amount: input.amount,
    payday: input.payday,
    frequency: input.frequency,
    weekday: input.frequency === 'weekly' ? input.weekday : null,
    type: input.type,
    account_id: input.source === 'account' ? input.accountId || null : null,
    card_id: input.source === 'card' ? input.cardId || null : null,
    category_id: input.categoryId || null,
    end_date: input.endDate || null
  }
  if (!input.isInstallment) {
    return { ...base, total_installments: null }
  }
  if (input.totalInstallments !== undefined) {
    return { ...base, total_installments: input.totalInstallments }
  }
  return base
}

async function submit() {
  if (!name.value || !amount.value || !payday.value) return
  if (frequency.value === 'weekly' && !isIsoWeekday(weekday.value)) return
  isSubmitting.value = true
  try {
    const amountValue = parseCurrencyInput(amount.value ?? 0)
    const totalInstallmentsValue =
      isInstallment.value && totalInstallments.value && totalInstallments.value > 0
        ? Number(totalInstallments.value)
        : undefined

    if (recurrenceToEdit.value) {
      const patch = buildUpdatePatch({
        name: name.value,
        amount: amountValue,
        payday: Number(payday.value),
        frequency: frequency.value,
        weekday: weekday.value,
        type: type.value,
        source: source.value,
        accountId: accountId.value,
        cardId: cardId.value,
        categoryId: categoryId.value,
        endDate: endDate.value,
        isInstallment: isInstallment.value,
        totalInstallments: totalInstallmentsValue
      })
      const res = await api.api.recurrences({ id: recurrenceToEdit.value.id }).put(patch)
      if (res.error) throw res.error
    } else {
      const createBody = {
        name: name.value,
        amount: amountValue,
        payday: Number(payday.value),
        frequency: frequency.value,
        ...(frequency.value === 'weekly' ? { weekday: Number(weekday.value) } : {}),
        type: type.value,
        ...(source.value === 'account' && accountId.value ? { account_id: accountId.value } : {}),
        ...(source.value === 'card' && cardId.value ? { card_id: cardId.value } : {}),
        ...(categoryId.value ? { category_id: categoryId.value } : {}),
        ...(endDate.value ? { end_date: endDate.value } : {}),
        ...(totalInstallmentsValue !== undefined ? { total_installments: totalInstallmentsValue } : {})
      }
      const res = await api.api.recurrences.post(createBody)
      if (res.error) throw res.error
    }
    emit('created')
    close()
  } catch (err) {
    console.error('Falha ao salvar recorrência', err)
  } finally {
    isSubmitting.value = false
  }
}

const paydayOptions = Array.from({ length: 31 }, (_, i) => ({ label: `Dia ${i + 1}`, value: i + 1 }))

const frequencyOptions: Array<{ label: string; value: RecurrenceFrequency }> = [
  { label: 'Mensal', value: 'monthly' },
  { label: 'Semanal', value: 'weekly' }
]

/** ISO weekdays, Monday = 1 through Sunday = 7. */
const weekdayOptions: Array<{ label: string; value: number }> = [
  { label: 'Segunda', value: 1 },
  { label: 'Terça', value: 2 },
  { label: 'Quarta', value: 3 },
  { label: 'Quinta', value: 4 },
  { label: 'Sexta', value: 5 },
  { label: 'Sábado', value: 6 },
  { label: 'Domingo', value: 7 }
]

const accountOptions = computed(() => {
  return financeStore.accounts.map(a => ({ label: a.name, value: a.id }))
})

const cardOptions = computed(() => {
  return financeStore.cards.map(c => ({ label: c.name, value: c.id }))
})

const categoryOptions = computed(() => {
  return financeStore.categories.map(c => ({ label: c.name, value: c.id }))
})
</script>

<template>
  <UModal v-model="isOpen">
    <UCard :ui="{ ring: '', divide: 'divide-y divide-gray-100 dark:divide-gray-800' }">
      <template #header>
        <div class="flex items-center justify-between">
          <h3 class="min-w-0 text-base font-semibold leading-6 text-white">
            {{ recurrenceToEdit ? 'Editar Recorrência' : 'Nova Recorrência' }}
          </h3>
          <UButton color="gray" variant="ghost" icon="i-heroicons-x-mark" class="shrink-0 -my-1" @click="close" />
        </div>
      </template>

      <form @submit.prevent="submit" class="space-y-4 [&_input]:text-base [&_select]:text-base sm:[&_input]:text-sm sm:[&_select]:text-sm">
        <UFormGroup label="Nome">
          <UInput v-model="name" placeholder="Ex: Netflix, Bolsa CNPq..." />
        </UFormGroup>

        <UFormGroup label="Valor (R$)">
          <UInput v-model="amount" type="text" inputmode="decimal" placeholder="0.00" />
        </UFormGroup>

        <div class="grid gap-4 sm:grid-cols-2">
          <UFormGroup label="Tipo">
            <div class="flex flex-wrap gap-4 mt-1">
              <URadio v-model="type" value="expense" label="Despesa" />
              <URadio v-model="type" value="income" label="Receita" />
            </div>
          </UFormGroup>

          <UFormGroup label="Periodicidade">
            <USelect v-model="frequency" :options="frequencyOptions" />
          </UFormGroup>
        </div>

        <UFormGroup v-if="frequency === 'monthly'" label="Dia de cobrança">
          <USelect v-model="payday" :options="paydayOptions" />
        </UFormGroup>

        <UFormGroup v-else label="Dia da semana">
          <USelect v-model="weekday" :options="weekdayOptions" />
          <p v-if="recurrenceToEdit && recurrenceToEdit.frequency !== 'weekly'" class="text-xs text-zinc-500 mt-1">
            Salvar como Semanal pode gerar ocorrências semanais já neste mês.
          </p>
        </UFormGroup>

        <UFormGroup label="Origem/Destino">
          <div class="flex flex-wrap gap-4 mt-1">
            <URadio v-model="source" value="account" label="Conta" />
            <URadio v-if="type === 'expense'" v-model="source" value="card" label="Cartão" />
          </div>
        </UFormGroup>

        <UFormGroup v-if="source === 'account'" label="Conta">
          <USelect v-model="accountId" :options="accountOptions" placeholder="Selecione a conta" />
        </UFormGroup>
        <UFormGroup v-else label="Cartão">
          <USelect v-model="cardId" :options="cardOptions" placeholder="Selecione o cartão" />
        </UFormGroup>

        <UFormGroup label="Orçamento / Categoria (opcional)">
          <USelect v-model="categoryId" :options="categoryOptions" placeholder="Sem orçamento vinculado" />
        </UFormGroup>

        <UFormGroup label="Data Final (opcional)">
          <UInput v-model="endDate" type="date" />
        </UFormGroup>

        <div class="border-t border-zinc-800 pt-4 space-y-3">
          <UFormGroup label="Este contrato é um parcelamento?">
            <UToggle v-model="isInstallment" />
            <p class="text-xs text-zinc-500 mt-1">
              Ative para compras parceladas (ex: Computador em 10x). Deixe desativado para assinaturas sem fim (ex: Netflix).
            </p>
          </UFormGroup>

          <UFormGroup v-if="isInstallment" label="Número de Parcelas">
            <UInput v-model="totalInstallments" type="number" min="2" max="120" placeholder="Ex: 10" />
          </UFormGroup>
        </div>

        <div class="sticky bottom-0 bg-zinc-900 -mx-4 px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:bg-transparent sm:mx-0 sm:px-0 sm:pb-0 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3">
          <UButton label="Cancelar" variant="ghost" color="gray" class="w-full sm:w-auto" @click="close" />
          <UButton
            type="submit"
            :label="recurrenceToEdit ? 'Salvar Alterações' : (type === 'income' ? 'Criar Receita Fixa' : 'Criar Despesa Fixa')"
            :color="type === 'income' ? 'green' : 'red'"
            :loading="isSubmitting"
            class="w-full sm:w-auto"
          />
        </div>
      </form>
    </UCard>
  </UModal>
</template>
