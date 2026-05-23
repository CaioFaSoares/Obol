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
  },
  runtimeConfig: {
    public: {
      apiBase: process.env.NUXT_PUBLIC_API_BASE || 'http://localhost:8080'
    }
  },
  routeRules: {
    '/api/**': { proxy: 'http://bff:8080/api/**' }
  }
})
