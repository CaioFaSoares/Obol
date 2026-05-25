import { defineStore } from 'pinia'

export const useFinanceStore = defineStore('finance', () => {
  const accounts = ref<any[]>([])
  const cards = ref<any[]>([])
  const categories = ref<any[]>([])
  const projects = ref<any[]>([])
  const isLoading = ref(false)

  async function loadBaseData(force = false) {
    if (!force && accounts.value.length > 0) return

    isLoading.value = true
    try {
      const [resAccounts, resCards, resCategories, resProjects] = await Promise.all([
        api.api.accounts.get(),
        api.api.cards.get(),
        api.api.categories.get(),
        api.api.projects.get()
      ])

      if (resAccounts.data) accounts.value = resAccounts.data as any[]
      if (resCards.data) cards.value = resCards.data as any[]
      if (resCategories.data) categories.value = resCategories.data as any[]
      if (resProjects.data) projects.value = resProjects.data as any[]

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
    projects,
    isLoading,
    loadBaseData
  }
})
