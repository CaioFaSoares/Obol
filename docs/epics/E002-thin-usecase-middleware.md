# E002 - Thin use-case dispatch layer

**Status**: proposed · **Created**: 2026-10-28
**Related**: `docs/arquitetura.md`, `docs/canon.md §2`, D003 (Clean Architecture)

## Goal

Add a small, consistent boundary between Elysia controllers and the existing application use-case classes. Borrow Tickety's explicit route-to-use-case mapping and edge discipline without importing its proxy architecture into Obol.

This is **not** a rewrite of the application layer. Existing `execute()` classes, Awilix constructor injection, repository interfaces, TypeBox validators, and domain error semantics remain the system of record.

## Research findings

### Tickety

`_Copland/Tickety/middleware/src/controllers/bff.controller.ts` matches a declarative `BFF_ROUTES` table; `src/usecases/types.ts` defines the use-case input/environment/result types; `src/contracts/parse.ts` validates at the edge; one `ErrorFilter` maps failures. A request is matched, validated, dispatched to a use-case handler, and serialized. The legacy gateway and Clojure upstream exist because Tickety is a proxy BFF.

### Obol today

`server/src/infrastructure/controllers/TransactionController.ts` repeats this pattern per endpoint: declare Elysia route + TypeBox schema, resolve a concrete class from Awilix, call `.execute()`, set status/return. `CategoryController.ts` is the smaller version. Business rules are already isolated in `application/use-cases/`; `errorPlugin.ts` already maps domain errors to HTTP. `package.json` has no meaningful test script (`test` exits with an error), so there is no existing controller/use-case integration harness to extend.

## Decision direction

Adopt **declarative route descriptors plus one Elysia adapter**, retaining class-based use cases and Awilix:

```ts
useCaseRoute({
  method: 'POST',
  path: '/',
  body: TransactionDTO,
  useCase: 'createTransactionUseCase',
  status: 201,
  input: ({ body }) => body,
})
```

The adapter should do only four jobs:

1. register the Elysia method/path and TypeBox request schemas;
2. resolve the registered use-case token from the scoped Awilix container;
3. map the validated HTTP inputs to the use-case's `execute(...)` arguments;
4. return its result and apply an optional HTTP status.

Domain errors continue to bubble to `errorPlugin`; Elysia/TypeBox validation continues to produce the existing 400 behavior. The adapter must not wrap errors or implement domain policy.

Proposed home: `server/src/infrastructure/use-case-routes/` (or `infrastructure/http/` if naming proves clearer). Keep route descriptors close to their controller; do not create a second domain/application layer or a new top-level `middleware/` workspace. Tickety's `middleware/` is a separate BFF/proxy application, not a drop-in Elysia package.

## Borrow / do not borrow

| Borrow from Tickety | Do not port to Obol |
|---|---|
| Explicit route table: endpoint → contract → use-case handler | NestJS/Express, `UpstreamClient`, gateway passthrough, or Clojure proxy semantics |
| Validate and strip input at the boundary before use-case execution | Zod in parallel with existing TypeBox validators |
| One response/error boundary; use cases do not touch request/response objects | `UseCaseEnv` tuple replacing Awilix constructor injection without a concrete need |
| Behavioral tests that assert client response and dependency interaction | Auth presence gates, rate limits, request-id/security middleware, SSE/streaming, partial-upstream composition (not current Obol requirements) |

## Scope

### Included

- A typed descriptor for method/path, optional query/body/params schemas, Awilix use-case registration key, input mapping, and optional success status.
- A generic `useCaseRoute` adapter used by one representative route group first.
- Thin migration of all existing controller endpoints to the descriptor pattern only after the pilot proves type safety and behavior parity.
- One centralized rule for route-level status handling; domain errors remain in `errorPlugin`.
- A test harness that boots the real Elysia controller with a test Awilix container and substitutes only repository dependencies/use-case registrations; assert status, response shape, validation rejection before execution, and domain error mapping.

### Explicitly excluded

- Rewriting use-case classes as standalone functions.
- Moving use cases into `infrastructure/` or creating another `middleware/` package.
- Changing transaction, invoice, recurrence, forecast, or PocketBase behavior.
- Replacing TypeBox, Awilix, or `errorPlugin`.
- Authentication, rate limiting, request tracing, retries, telemetry, partial failures, or an additional error hierarchy.
- Frontend or API response-contract changes.

## Migration plan

### Step 0 — Baseline

- Record current route behavior for the pilot controller: method/path, TypeBox schema, default status, response shape, and errors.
- Add the smallest server test setup using Bun's test runner; prove it can boot an Elysia app with an isolated Awilix container without PocketBase/network access.
- Do not migrate controllers before this baseline passes.

### Step 1 — Adapter and pilot

- Add descriptor types and `useCaseRoute` under `server/src/infrastructure/`.
- Pilot `CategoryController` (three straightforward endpoints) or `ForecastController` (one query-only endpoint); choose the smallest surface after inspecting its contract.
- Compare requests/responses and validation/error behavior against the baseline. Remove the pilot's direct `container.resolve()` only if parity is proven.

### Step 2 — Expand by controller

Migrate one controller at a time, in small isolated commits: `Category` → `Account` → `Project` → `Recurrence` → `Card` → `Transaction` → `Forecast` → `Job`. Keep route prefixes, TypeBox schemas, default page/sort values, status codes, and response shapes unchanged. The more complex Transaction/Card routes come last.

### Step 3 — Consolidate and document

- Remove duplicated resolve/execute/status boilerplate from controllers; preserve controllers as route-group declarations.
- Update `docs/arquitetura.md` with the adapter boundary and `AGENTS.md`/`server/context.md` with its constraints.
- Add an accepted ADR only after the pilot and migration establish the actual design; do not record a proposal as a settled architectural decision.

## Invariants

- Controllers declare HTTP; use cases own business rules; repositories own PocketBase access.
- The adapter knows Awilix + Elysia + TypeBox, but no domain semantics.
- Use-case classes receive dependencies through constructors and remain directly callable outside HTTP (cron jobs must continue resolving `ProcessMonthlyRecurrencesUseCase` and `ReconcileInvoicesUseCase` directly).
- Every existing endpoint keeps its route, validation, status, response and error contract.
- Invalid input never executes a use case. Domain errors still reach `errorPlugin` unchanged.
- No behavior changes in this epic; future business changes are separate work.

## Acceptance criteria

- A pilot controller is fully covered by deterministic tests without a running PocketBase.
- Tests prove: valid request dispatches once to the expected use case with parsed input; invalid input returns 400 and does not execute the use case; domain `NotFoundError`/`ValidationError` map through the existing `errorPlugin`; creation endpoints retain 201; result bodies are unchanged.
- All current controllers use the adapter, with no direct `container.resolve()` in their route handlers (except explicitly documented non-use-case infrastructure routes).
- Cron/scheduler still resolves and executes the same use-case classes; no HTTP adapter dependency enters application or domain layers.
- `bun run src/index.ts` reaches the same PocketBase boot/auth boundary; existing compose/dev runtime remains unchanged.
- TypeScript check succeeds using the repository-pinned toolchain; no new compiler or validation framework is added.

## Risks and stop conditions

- **Over-abstraction**: if descriptors require type casts that erase Elysia's Eden Treaty inference, stop and keep the current explicit controller pattern. The goal is less duplication without losing the typed API contract.
- **Awilix scoping**: resolve use cases from the same scoped container lifecycle as today; do not accidentally share request-scoped instances or build a global singleton dispatcher.
- **TypeBox/Elysia generic friction**: first prove request and response inference on one pilot. If the adapter cannot preserve it, narrow the adapter to a helper around `container.resolve()` rather than force a route DSL.
- **Business-logic leakage**: reject any descriptor callback that implements invoice/balance/recurrence rules; it may only map validated transport input to the existing use-case arguments.
