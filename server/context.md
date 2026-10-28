# server/ — ElysiaJS BFF (Bun)

All business logic (`canon.md §2`). Clean Architecture (D003): `domain/` → `application/` → `infrastructure/`.

| Path | Role |
|---|---|
| `src/domain/` | Entities, repository interfaces, errors, date math (`utils/dateUtils.ts`) |
| `src/application/use-cases/` | One class per operation; constructor-injected repositories only |
| `src/infrastructure/controllers/` | Elysia route groups, factories receiving the awilix container |
| `src/infrastructure/repositories/` | `Pocketbase*Repository` — the only code that knows PocketBase |
| `src/infrastructure/validators/` | TypeBox DTO schemas |
| `src/infrastructure/use-case-routes/` | Typed controller-to-use-case dispatch (D006); does not contain business rules |
| `src/infrastructure/scheduler/` | Cron plugin (daily 01:00 `America/Fortaleza`), resolves use cases directly |
| `src/infrastructure/di/container.ts` | `createContainer(pb)`: repositories singleton, use cases scoped |
| `src/index.ts` | `createServer(pb)` factory and `App` type; `startHostedServer()` listens only when this file is the Bun entrypoint |

Rules: no Elysia/PocketBase imports inside `domain/` or `application/`; controllers declare HTTP and invoke use cases via `use-case-routes/`; cron calls the same use-case classes directly. Structured ledger filters are parsed at the HTTP boundary and safely built in the transaction repository; the frontend never sends PocketBase filter syntax.
