import { treaty } from '@elysiajs/eden'
import type { App } from '../../bff/src/index' 

// Server: bate direto no BFF via rede interna Docker
// Client: usa a mesma origem (localhost:3000) — o Nuxt faz proxy /api/** → bff:8080
const apiUrl = import.meta.server
  ? 'http://bff:8080'
  : window.location.origin

// @ts-expect-error type mismatch entre as versões locais do elysia no monorepo
export const api = treaty<App>(apiUrl)
