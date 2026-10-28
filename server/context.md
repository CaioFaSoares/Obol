# server/ — ElysiaJS BFF (Bun)

All business logic (`canon.md §2`). Clean Architecture (D003): `domain/` → `application/` → `infrastructure/`.

| Path | Role |
|---|---|
| `src/domain/` | Entities, repository interfaces, errors, date math (`utils/dateUtils.ts`) |
| `src/application/use-cases/` | One class per operation; constructor-injected repositories only |
| `src/infrastructure/controllers/` | Elysia route groups, factories receiving the awilix container |
| `src/infrastructure/repositories/` | `Pocketbase*Repository` — the only code that knows PocketBase |
| `src/infrastructure/validators/` | TypeBox DTO schemas |
| `src/infrastructure/scheduler/` | Cron plugin (daily 01:00 `America/Fortaleza`) |
| `src/infrastructure/di/container.ts` | awilix registration: repositories singleton, use cases scoped |
| `src/index.ts` | Entry; mounts plugins, scheduler, 8 controllers; exports `type App` |

Rules: no Elysia/PocketBase imports inside `domain/` or `application/`; controllers stay thin; filtering logic for lists lives in repositories (accepting options), not in the frontend when it is server-authoritative.
