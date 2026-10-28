# D003 - Clean Architecture on the BFF

**Status**: accepted (2026-06-03, commit `ce430f3`)

## Context
The BFF had grown routes with inline business logic (route files owning PocketBase queries). This made the forecast/transaction rules untestable and coupled HTTP shape to persistence.

## Decision
Layer the server (`server/src`) as:

- `domain/` - entities (`Transaction`, `Invoice`, `Recurrence`, `Card`, `Account`, `Category`, `Project`), repository interfaces, shared errors, `utils/` (math/date helpers).
- `application/use-cases/` - one class per operation (33 registered use cases), constructor-injected repositories only.
- `infrastructure/` - `controllers/` (Elysia route groups receiving the DI container), `repositories/` (PocketBase implementations of the domain interfaces), `validators/` (TypeBox schemas), `scheduler/` (cron plugin), `plugins/`, `di/container.ts` (awilix, `InjectionMode.CLASSIC`).

Rules:
- Use cases never import Elysia or PocketBase directly; they depend on domain interfaces.
- Controllers stay thin: validate, resolve a use case from the container, execute, map to HTTP.
- Repositories are registered as singletons, use cases as scoped.

## Consequences
- Business rules are testable without HTTP or PocketBase.
- Swapping PocketBase for another persistence (e.g. local SQLite for the desktop build) means implementing the domain interfaces, not rewriting use cases. This is the lever for the Electrobun epic (E001).
