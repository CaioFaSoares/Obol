const apiBase = process.env.NUXT_PUBLIC_API_BASE || 'http://obol-server:13080'
const desktopStaticBuild = process.env.OBOL_DESKTOP_STATIC === 'true'
const desktopLocalDev = process.env.OBOL_DESKTOP_LOCAL === 'true'
const desktopSpa = desktopStaticBuild || desktopLocalDev

export default defineNuxtConfig({
  // Local Electrobun also disables SSR so the login gate runs before desktop API access.
  ssr: !desktopSpa,
  app: {
    baseURL: desktopStaticBuild ? './' : '/'
  },
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
      apiBase
    }
  },
  icon: {
    clientBundle: {
      icons: [
        'heroicons:arrow-down-tray',
        'heroicons:arrow-path-20-solid',
        'heroicons:chevron-down',
        'heroicons:chevron-down-20-solid',
        'heroicons:chevron-double-left-20-solid',
        'heroicons:chevron-double-right-20-solid',
        'heroicons:chevron-left-20-solid',
        'heroicons:chevron-right-20-solid',
        'heroicons:circle-stack-20-solid'
      ],
      scan: true
    }
  },
  routeRules: {
    '/api/_nuxt_icon/**': {},
    '/api/**': { proxy: `${apiBase}/api/**` }
  }
})
