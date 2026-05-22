import { treaty } from '@elysiajs/eden'
import type { App } from '../../bff/src/index' 

export default defineNuxtPlugin(() => {
  const config = useRuntimeConfig()
  const apiUrl = (config.public.apiBase as string) || 'http://localhost:8080'

  const api = treaty<App>(apiUrl)

  return {
    provide: {
      api
    }
  }
})
