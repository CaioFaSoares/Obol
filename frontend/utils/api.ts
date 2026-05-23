import { treaty } from '@elysiajs/eden'
import type { App } from '../../bff/src/index' 

const apiUrl = import.meta.server ? 'http://bff:8080' : ''

// @ts-expect-error type mismatch entre as versões locais do elysia no monorepo
export const api = treaty<App>(apiUrl)
