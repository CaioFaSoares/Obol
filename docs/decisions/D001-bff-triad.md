# D001 - The Triad: Nuxt app + Elysia BFF + PocketBase

**Status**: accepted (2026-05-22, commit `ebd9a2d`)

## Context
Obol needs strict typing from UI to database and a place for business logic that is neither UI nor raw persistence.

## Decision
Three layers, each with one responsibility:

1. **App (Nuxt 3 + Nuxt UI + Pinia)** - UI/UX, client-side form validation, ECharts rendering, global state cache. Never talks to PocketBase directly.
2. **BFF (ElysiaJS on Bun)** - all business logic: forecast engine, transaction interception, cron time engine, strict TypeBox DTO validation. Exports `type App` consumed by the frontend via Eden Treaty, so backend field changes fail TypeScript at development time.
3. **Data (PocketBase v0.23+)** - SQLite persistence, silent superuser auth, DDL migrations on boot. Public API rules are all `null`; only the BFF container reaches it over a private Docker network (`obol_net`).

## Consequences
- End-to-end type safety without duplicated schema definitions.
- The BFF is a mandatory hop for every read/write; there is no direct DB escape hatch.
- Local runs need all three processes; a serverless local variant is proposed by epic E001 (Electrobun).
