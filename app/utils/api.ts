import { treaty } from '@elysiajs/eden'
import type { App } from '../../server/src/index' 

// Server: bate direto no Server via rede interna Docker
// Client: usa a mesma origem (localhost:3000) — o Nuxt faz proxy /api/** → server:8080
const apiUrl = import.meta.server
  ? process.env.NUXT_PUBLIC_API_BASE || 'http://obol-server:13080'
  : window.location.origin

export const api = treaty<App>(apiUrl)
