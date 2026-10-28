# app/ — Nuxt 3 frontend

The UI layer of the Triad (`canon.md §2`). Talks only to the BFF via the typed Eden client; never imports the PocketBase SDK or touches `db/` directly.

| Path | Role |
|---|---|
| `pages/` | `index` (dashboard/forecast), `ledger`, `cards`, `management`, `admin` |
| `components/` | Tabs + modals, one per domain surface; `ForecastChart.vue` wraps ECharts |
| `stores/finance.ts` | Pinia cache of base data (`loadBaseData(force)`) |
| `composables/useRefresh.ts` | Global refresh counter (`triggerRefresh()`); every mutation calls it |
| `composables/useFastEntry.ts`, `useTransactionEdit.ts`, `useRecurrenceModal.ts` | Modal orchestration |
| `utils/api.ts` | Typed Eden client bound to `server/src/index` `App`; hosted web uses Nuxt same-origin proxy, Electrobun uses `window.obol` RPC fetcher |
| `nuxt.config.ts` | Hosted SSR by default; `OBOL_DESKTOP_STATIC=true` generates the relative-asset desktop SPA |
| `utils/formatters.ts` | `formatCurrency`, `formatDate` |

Rules: business rules live server-side; pages call BFF endpoints and refresh via `useRefresh`. Never add PocketBase SDK access to the frontend. UI strings may be pt-BR (user-facing), code identifiers follow `CONTEXT.md`.
