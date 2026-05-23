import { defineStore } from 'pinia'

export const useFinanceStore = defineStore('finance', () => {
  const accounts = ref<any[]>([])
  const cards = ref<any[]>([])
  const categories = ref<any[]>([])
  const isLoading = ref(false)

  async function loadBaseData() {
    if (accounts.value.length > 0) return

    isLoading.value = true
    try {
      // Como os endpoints /accounts, /cards e /categories ainda não existem no BFF,
      // pulamos a chamada deles por enquanto para não quebrar a tipagem do Eden.
      /*
      const [resAccounts, resCards, resCategories] = await Promise.all([
        api.api.accounts.get(),
        api.api.cards.get(),
        api.api.categories.get()
      ])

      if (resAccounts.data) accounts.value = resAccounts.data as any[]
      if (resCards.data) cards.value = resCards.data as any[]
      if (resCategories.data) categories.value = resCategories.data as any[]
      */
      
      accounts.value = []
      cards.value = []
      categories.value = []

    } catch (error) {
      console.error('❌ Falha ao carregar cache inicial', error)
    } finally {
      isLoading.value = false
    }
  }

  return {
    accounts,
    cards,
    categories,
    isLoading,
    loadBaseData
  }
})
