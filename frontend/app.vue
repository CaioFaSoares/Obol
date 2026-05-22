<script setup lang="ts">
const financeStore = useFinanceStore()

await callOnce(async () => {
  await financeStore.loadBaseData()
})
</script>

<template>
  <NuxtLayout>
    <NuxtRouteAnnouncer />
    <NuxtPage />
  </NuxtLayout>
</template>
