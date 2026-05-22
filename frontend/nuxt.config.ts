export default defineNuxtConfig({
  compatibilityDate: '2024-04-03',
  devtools: { enabled: true },
  modules: [
    '@pinia/nuxt',
    '@nuxt/ui'
  ],
  colorMode: {
    preference: 'dark'
  },
  pinia: {
    storesDirs: ['./stores/**'],
  },
  build: {
    transpile: ['vue-echarts', 'resize-detector']
  }
})
