<script setup lang="ts">
import { onMounted } from 'vue'

const financeStore = useFinanceStore()

await useAsyncData('global-finance-data', async () => {
  await financeStore.loadBaseData()
  return true
})

onMounted(() => {
  if (financeStore.accounts.length === 0) {
    financeStore.loadBaseData(true)
  }
})
</script>

<template>
  <NuxtLayout>
    <NuxtRouteAnnouncer />
    <NuxtPage />
  </NuxtLayout>
</template>
