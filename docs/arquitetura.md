# Architecture

> Current behavior verified against source on 2026-10-28. Product rules are in [`canon.md`](canon.md); accepted decisions are in [`decisions/log.md`](decisions/log.md).

## Two runtime modes

| | Hosted web | Local desktop |
|---|---|---|
| Window/UI | Nuxt 3 SSR web app | Electrobun 2.0.5 system WebView; Nuxt static SPA |
| UI → BFF | Eden Treaty → same-origin Nuxt `/api/**` proxy → Elysia HTTP | `LocalAuthGate` unlocks via Electrobun RPC; after unlock, Eden requests use `window.obol.apiFetch` → Elysia `app.handle(Request)` in the same Bun main process |
| BFF | Elysia on Bun, listens `0.0.0.0:8080` inside Compose | Same Elysia app starts after local profile unlock; loopback `127.0.0.1:13080` activates the scheduler. Desktop development uses Nuxt SPA/HMR; packaged WebView API requests use RPC, not that listener. |
| Data | PocketBase Compose service, SQLite volume `db/pb_data` | PocketBase v0.40.6 child bound to `127.0.0.1:13090`; per-user `pb_data` plus `local_profile.json` with a salted PBKDF2 verifier |
| Run command | `docker compose up -d --build` | `cd app && npm ci`; `cd server && bun install`; `cd desktop && bun install && bun run eb:dev` |

The desktop opens on a local setup/unlock screen before starting PocketBase or Elysia. First setup runs PocketBase `superuser upsert` for the internal local account; upgrading a 0.1.0 profile keeps its records and repairs stale credentials without resetting `pb_data`. The login is an app gate, not encryption at rest. Desktop has no remote service, Docker dependency, direct WebView-to-PocketBase access, or network-facing BFF endpoint. See D005 and D007.

## Server layering (`server/src`)

| Layer | Contents | Rule |
|---|---|---|
| `domain/` | Entities, repository interfaces, errors, date/currency math, structured transaction query/summary types | No framework imports |
| `application/use-cases/` | One class per operation, constructor-injected with repository ports | No Elysia or PocketBase imports |
| `infrastructure/controllers/` | 8 Elysia route groups; explicit HTTP schemas/status/argument mapping | Dispatch through `use-case-routes/`; controllers contain no business rules |
| `infrastructure/use-case-routes/` | `executeUseCase` and typed `resolveUseCase`; maps Awilix tokens to concrete use-case classes | Infrastructure-only invocation boundary (D006) |
| `infrastructure/repositories/` | PocketBase implementations; structured ledger query builder uses PocketBase's `filter()` parameter binding | Only layer that accesses PocketBase |
| `infrastructure/validators/` | TypeBox request schemas | HTTP boundary validation |
| `infrastructure/scheduler/` | Daily cron plugin, injected with the Awilix container | Directly resolves use cases; bypasses HTTP dispatch |
| `infrastructure/di/container.ts` | `createContainer(pb)`, Awilix `InjectionMode.CLASSIC` | Repositories singleton; use cases scoped |

`server/src/index.ts` exports `createServer(pb)` without side effects and exports its `App` type for Eden Treaty. `startHostedServer()` authenticates PocketBase and listens on the configured `PORT` only when `src/index.ts` is the Bun entrypoint. Electrobun builds the same server factory around its local PocketBase client.

## Frontend layering (`app/`)

| Path | Role |
|---|---|
| `pages/` | Dashboard, ledger, cards, management, admin |
| `components/` | Domain tabs, modals, `ForecastChart`, daily `ForecastCalendar`, `DesktopUpdaterBanner` |
| `stores/finance.ts` | Pinia cache of accounts/cards/categories/projects |
| `composables/` | Global refresh and modal state |
| `utils/api.ts` | Eden client typed from `server/src/index.ts`; browser uses same-origin proxy, Electrobun uses RPC fetch bridge |
| `app.vue` | Global `UNotifications` host (Nuxt UI v2) |

The web app sends structured filters (`search`, status/type, simulation/scheduled, entity IDs, date range) to the transaction list and summary endpoints; it never constructs PocketBase filter expressions. The HTTP boundary rejects unknown query keys, and the repository applies the exact same server-side filter set to summary totals. See E001 and `canon.md §9`.

## Persistence (`db/`)

- `db/pb_migrations/` - versioned JavaScript schema migrations; never edit an applied migration.
- `db/pb_data/` - hosted Compose SQLite data (gitignored).
- Desktop PB data is not stored in the repository; the local runtime uses `Utils.paths.appData/copland.obol` (or the isolated `copland.obol.eb-dev` identifier in development).

## Runtime and packaging topology

- Hosted dev: `docker-compose.yml` maps Nuxt :13000, Elysia :13080, PocketBase :13090 on `obol_net`.
- Hosted deploy: `docker-compose.coolify.yml` exposes services for Coolify's reverse proxy.
- Desktop: `desktop/app.json` is the app identity/version source; `desktop/scripts/eb-build.ts` generates the static view and Electrobun bundle; `desktop/scripts/ensure-pocketbase.ts` downloads pinned, SHA-256-verified PocketBase binaries for macOS arm64/x86_64 and Windows x64. The main process integrates Electrobun `Updater` for release-channel checks, background downloads, and safe restarts.
- Release: `.github/workflows/release-branch.yml` creates `release-<version>` after a merged release PR from `dev` or `pr/release-*`; `release.yml` validates all three native builds on the PR, publishes Electrobun updater metadata/full bundles plus platform installers after merge, and generates `Casks/obol.rb` from the macOS-only manifest.
- Nix/direnv: `flake.nix` supplies Node, Bun, Docker Compose, and unzip; `.envrc` activates the flake.
