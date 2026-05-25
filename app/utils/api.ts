import { treaty } from '@elysiajs/eden'
import type { App } from '../../server/src/index' 

// Server: bate direto no Server via rede interna Docker
// Client: usa a mesma origem (localhost:3000) — o Nuxt faz proxy /api/** → server:8080
const apiUrl = import.meta.server
  ? 'http://server:8080'
  : window.location.origin

// @ts-expect-error type mismatch entre as versões locais do elysia no monorepo
export const api = treaty<App>(apiUrl)
