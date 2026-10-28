# E002 - Thin use-case dispatch layer

**Status**: implemented · **Completed**: 2026-10-28
**Related**: `docs/arquitetura.md`, `docs/canon.md §2`, D003 (Clean Architecture), D006 (typed dispatch)

## Goal

Add a small, consistent boundary between Elysia controllers and the existing application use-case classes. Borrow Tickety's explicit route-to-use-case mapping and edge discipline without importing its proxy architecture into Obol.

This is **not** a rewrite of the application layer. Existing `execute()` classes, Awilix constructor injection, repository interfaces, TypeBox validators, and domain error semantics remain the system of record.

## Research findings

### Tickety

`_Copland/Tickety/middleware/src/controllers/bff.controller.ts` matches a declarative `BFF_ROUTES` table; `src/usecases/types.ts` defines the use-case input/environment/result types; `src/contracts/parse.ts` validates at the edge; one `ErrorFilter` maps failures. A request is matched, validated, dispatched to a use-case handler, and serialized. The legacy gateway and Clojure upstream exist because Tickety is a proxy BFF.

### Obol baseline (before E002)

Controllers repeated direct `container.resolve()` + `.execute()`. `errorPlugin.ts` declared domain mappings but its local hook did not propagate when mounted; runtime tests returned 500 for domain errors. `server/package.json` had no meaningful test script, so the dispatch boundary had no behavior tests.

## Implemented architecture

E002 uses a typed invocation helper rather than a route-descriptor DSL. This keeps Elysia route declarations, TypeBox validation, and Eden Treaty inference on the existing handlers.

`server/src/infrastructure/use-case-routes/` contains:

- `registry.ts`: maps every Awilix registration token to its concrete use-case class.
- `dispatch.ts`: `executeUseCase(container, token, ...args)` type-checks the token/arguments and calls `execute` with the resolved class as its receiver. `resolveUseCase` handles composed Job routes.
- `index.ts`: exports the typed boundary.

Controllers still own method/path, TypeBox schema, HTTP status, and request-to-use-case argument mapping. All use-case business logic remains in `application/use-cases/`; `errorPlugin` is global and maps domain errors centrally. Cron jobs resolve and execute use cases directly from Awilix, not through HTTP dispatch.

## Borrow / do not borrow

| Borrow from Tickety | Do not port to Obol |
|---|---|
| One explicit dispatch boundary for endpoint → use-case | NestJS/Express, `UpstreamClient`, gateway passthrough, or Clojure proxy semantics |
| Validate at the edge before use-case execution | Zod in parallel with existing TypeBox validators |
| Central error mapping and behavioral boundary tests | `UseCaseEnv` replacing Awilix constructor injection without a concrete need |
| Use-case methods never receive request/response objects | Auth presence gates, rate limits, request tracing, SSE/streaming, or partial-upstream composition |

## Implemented scope

- All existing HTTP controller handlers call `executeUseCase` or the typed resolver. `container.resolve()` remains directly in the scheduler, which is intentionally outside HTTP.
- E002 did not change route paths, request contracts, defaults, statuses, or response shapes. E001 later replaced transaction-list raw filters with structured query parameters; see that epic for the current contract.
- `server/test/http-dispatch.test.ts` verifies valid dispatch, defaults and parsed request values, invalid-body rejection before execution, domain error mapping, creation status/result, composed input mapping, and preservation of the method receiver.
- No new domain behavior or HTTP response contract was introduced.

## Migration record

1. Added a deterministic Bun test harness using the real Elysia controllers and isolated Awilix containers; no PocketBase process is needed.
2. Pilot-tested typed dispatch on Account/Category/Transaction/Card handlers, then migrated all controller groups.
3. Confirmed scheduled use cases remain directly resolved from Awilix and added the class-receiver regression test after an actual desktop smoke exposed the importance of `this` binding.
4. Updated architecture and agent guidance to point to `use-case-routes/`.

## Invariants

- Controllers declare HTTP; use cases own business rules; repositories own PocketBase access.
- The dispatch boundary knows Awilix and use-case types but no domain rules.
- Use-case classes remain constructor-injected and directly callable outside HTTP. The scheduler still resolves its use cases directly.
- E002 preserved endpoint paths, defaults, statuses, and response bodies. The current transaction-list filter contract is the later E001 structured-query change.

## Verification

- `cd server && bun test`: 11 passed (including the later E001 raw-filter boundary regression).
- `cd server && bun x --package typescript@5.5.4 tsc --noEmit`: passed.
- `server/test/http-dispatch.test.ts` covers parsed input/defaults, validation-before-execution, domain errors, 201/result parity, composed arguments, instance `this` binding, and rejection of raw transaction filter parameters.
- All controller handlers use `executeUseCase` or `resolveUseCase`; the scheduler remains direct Awilix dispatch.

## Deliberately not included

- No route descriptor DSL, proxy/gateway, middleware package, auth/rate limit layer, tracing, retries, or partial-upstream failure model.
- No domain behavior or frontend API contract change was introduced by E002; E001 later introduced the structured transaction query contract.

The decision is recorded in [D006](../decisions/D006-thin-usecase-dispatch.md).
