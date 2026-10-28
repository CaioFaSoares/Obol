# Architecture

> Facts verified against the code as of 2026-10-28. The numbered source of truth is [`canon.md`](canon.md); decisions live in [`decisions/`](decisions/log.md).

## The Triad

```
┌───────────────────────────────────────────────────────────────┐
│ app/  Nuxt 3 + Nuxt UI + Pinia + ECharts                      │
│       Talks ONLY to the BFF via Eden Treaty (typed, strict)   │
└──────────────────────────┬────────────────────────────────────┘
                           │ HTTP (TypeBox DTOs)
┌──────────────────────────▼────────────────────────────────────┐
│ server/  ElysiaJS on Bun  — all business logic                │
│   Clean Architecture: domain → application → infrastructure   │
│   + scheduler (cron, isolated from HTTP)                      │
└──────────────────────────┬────────────────────────────────────┘
                           │ PocketBase SDK (localhost, internal)
┌──────────────────────────▼────────────────────────────────────┐
│ db/  PocketBase v0.23+ (SQLite)                               │
│   Public API rules = null; migrations run on boot             │
└───────────────────────────────────────────────────────────────┘
```

## Server layering (`server/src`)

| Layer | Contents | Rule |
|---|---|---|
| `domain/` | `entities/` (7 entities), `interfaces/` (7 repository interfaces + `Common`), `errors/`, `utils/` (`mathUtils`) | Pure; imports nothing from outer layers |
| `application/use-cases/` | One class per operation (33 registered), constructor-injected via domain interfaces | No Elysia, no PocketBase imports |
| `infrastructure/controllers/` | 8 Elysia route groups (`Transaction`, `Forecast`, `Card`, `Recurrence`, `Category`, `Project`, `Account`, `Job`), each a factory receiving the awilix container | Thin: validate → resolve use case → execute → HTTP |
| `infrastructure/repositories/` | `Pocketbase*Repository` per domain interface | The only code that knows PocketBase |
| `infrastructure/validators/` | TypeBox schemas per domain | DTO shape for controllers |
| `infrastructure/scheduler/` | `schedulerPlugin(container)` — cron engine, isolated from the HTTP thread | Owns recurrence processing |
| `infrastructure/di/container.ts` | awilix container, `InjectionMode.CLASSIC` | Repositories as singletons, use cases as scoped |
| `infrastructure/plugins/` | `pocketbase.ts` (authenticated `pb` client), `errorPlugin.ts` (global error shield) | — |

Entry: `server/src/index.ts` mounts `errorPlugin` → `schedulerPlugin` → 8 controllers → health check, listens on `PORT` (default 8080), and exports `type App` for Eden Treaty.

## Frontend layering (`app/`)

| Path | Role |
|---|---|
| `pages/` | `index.vue` (dashboard + forecast chart), `ledger.vue`, `management.vue`, `cards.vue`, `admin.vue` |
| `components/` | Tabs (`TabFinancial`, `TabBudgets`, `TabProjects`, `TabRecurrences`), modals (`FastEntry`, `TransactionEdit`, `Account/Card/Category/Budget/Project/Recurrence`), `ForecastChart` |
| `stores/finance.ts` | Pinia cache of base data (accounts, cards, categories, projects) |
| `composables/useRefresh.ts` | Global reactive refresh: any mutation triggers store reload + page refetch |
| `utils/api.ts` | Singleton Eden Treaty client bound to the BFF `App` type |

## Persistence (`db/`)

- `db/pb_migrations/` - JavaScript migrations executed by PocketBase on boot (`init_schema` + 11 incremental: transfer destination, purchase date, silent flag, installments, invoices, simulation flag, invoices fix, skipped periods, scheduled flag).
- `db/pb_data/` - live SQLite data (gitignored).

## Runtime topology

- Dev: `docker-compose.yml` - `obol-app` (:13000), `obol-server` (:13080), `obol-database` (:13090) on `obol_net`.
- Deploy: `docker-compose.coolify.yml` - `expose` only, reverse-proxied by Coolify.
- Dev environment: `flake.nix` (nodejs_22, bun, docker-compose).
