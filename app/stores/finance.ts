import { defineStore } from 'pinia'

export const useFinanceStore = defineStore('finance', () => {
  const accounts = ref<any[]>([])
  const cards = ref<any[]>([])
  const categories = ref<any[]>([])
  const projects = ref<any[]>([])
  const isLoading = ref(false)
  const isLoaded = ref(false)
  const loadError = ref<string | null>(null)

  // Ownership token for in-flight work. `resetBaseData` bumps it, so results
  // and cleanup from a previous endpoint can never touch the new session.
  let generation = 0
  let current: Promise<void> | null = null
  let queued: Promise<void> | null = null

  /**
   * Drop every cached value and invalidate in-flight work. The next ordinary
   * load always fetches all four datasets; responses already on the wire are
   * discarded instead of repopulating the cache with another server's data.
   */
  function resetBaseData(): void {
    generation += 1
    current = null
    queued = null
    accounts.value = []
    cards.value = []
    categories.value = []
    projects.value = []
    isLoading.value = false
    isLoaded.value = false
    loadError.value = null
  }

  function executeRun(runGeneration: number): Promise<void> {
    return (async () => {
      isLoading.value = true
      loadError.value = null

      try {
        const [resAccounts, resCards, resCategories, resProjects] = await Promise.all([
          api.api.accounts.get(),
          api.api.cards.get(),
          api.api.categories.get(),
          api.api.projects.get()
        ])

        // A reset or a newer generation owns the cache now: these payloads
        // belong to a server this session no longer talks to.
        if (runGeneration !== generation) return

        // All-or-nothing: a subset would mix datasets from different
        // responses, so a partial failure keeps the last complete snapshot.
        const complete = [resAccounts, resCards, resCategories, resProjects]
          .every(res => !res.error && res.data != null)

        if (!complete) {
          isLoaded.value = false
          loadError.value = 'Some financial data could not be loaded. Retry to complete the cache.'
          return
        }

        accounts.value = resAccounts.data ?? []
        cards.value = resCards.data ?? []
        categories.value = resCategories.data ?? []
        projects.value = resProjects.data ?? []
        isLoaded.value = true
        loadError.value = null
      } catch (error) {
        if (runGeneration !== generation) return
        console.error('❌ Falha ao carregar cache inicial', error)
        isLoaded.value = false
        loadError.value = 'Could not load financial data. Check your connection and try again.'
      }
    })()
  }

  function startRun(): Promise<void> {
    const run = executeRun(generation)
    current = run
    void run.then(() => {
      // Only the run that still owns the cache clears the loading state, so a
      // stale finally can never mask a newer load.
      if (current !== run) return
      isLoading.value = false
      current = null
    })
    return run
  }

  function loadBaseData(force = false): Promise<void> {
    if (current) {
      // A non-forced caller reuses the running load. A forced refresh must run
      // after any in-flight load so it observes the mutation that requested
      // it; simultaneous forced callers share that single follow-up run.
      if (!force) return current
      if (queued) return queued

      const prior = current
      const queuedGeneration = generation
      const followUp = (async () => {
        await prior
        // A reset superseded this refresh; its owner starts from a clean cache.
        if (queuedGeneration !== generation) return
        queued = null
        await startRun()
      })()
      queued = followUp
      return followUp
    }

    if (!force && isLoaded.value) return Promise.resolve()
    return startRun()
  }

  return {
    accounts,
    cards,
    categories,
    projects,
    isLoading,
    isLoaded,
    loadError,
    loadBaseData,
    resetBaseData
  }
})
