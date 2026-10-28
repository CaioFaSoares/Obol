# D006 - Typed use-case dispatch from Elysia controllers

**Status**: accepted · **Date**: 2026-10-28 · **Implemented**: E002

## Context

Obol's HTTP controllers repeated the same Awilix resolve + `.execute()` sequence. Tickety uses a declarative route/use-case table, but its middleware is a separate NestJS/Clojure proxy, not an Elysia package. A route DSL must not erase the endpoint types that Eden Treaty derives from Elysia.

## Decision

- Keep the existing class-based application use cases, constructor injection, repository ports, Elysia route declarations, and TypeBox schemas.
- Use `server/src/infrastructure/use-case-routes/executeUseCase` as the thin HTTP dispatch boundary. Its `UseCaseRegistry` maps each Awilix registration token to the concrete class signature; the helper invokes the method with its resolved instance as `this`.
- Controllers continue to declare paths, schemas, HTTP status codes, and transport-to-use-case argument mapping. `JobController` uses the typed resolver only where one endpoint composes multiple use cases.
- Domain errors bubble through the global `errorPlugin`; E002 made the hook global and mapped the domain error classes explicitly after the route tests exposed that the prior local hook returned 500s. The adapter neither translates errors nor adds domain policy. Scheduled jobs resolve use cases directly from Awilix and bypass the HTTP helper.
- No generic descriptor DSL: retaining explicit Elysia handlers keeps Eden's route/request/response inference intact while removing repetitive container lookups.

## Alternatives considered

- Tickety-style declarative route descriptors: rejected for now. The existing route surface already carries valuable Elysia type inference; descriptors would add a second route representation without a proven reduction in complexity.
- Replacing Awilix classes with `(env, input) -> result` functions: rejected; no concrete requirement justifies changing DI or application contracts.
- Adding a top-level `middleware/` package: rejected; Tickety's `middleware/` is its own BFF process and would create a misleading extra application boundary in Obol.

## Consequences

- Controllers have one typed path for invoking a use case; a misspelled token or mismatched execute arguments fail TypeScript.
- All HTTP endpoints retain their paths, schemas, status codes, and results. Behavioral tests live in `server/test/` and do not require PocketBase.
- The dispatch helper lives only in infrastructure. Application/domain code has no Elysia or Awilix dependency.
