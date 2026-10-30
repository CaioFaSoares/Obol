# Architecture

> Current behavior verified against source on 2026-10-29. Product rules are in [`canon.md`](canon.md); accepted decisions are in [`decisions/log.md`](decisions/log.md).

## Runtime modes

| | Hosted web | Local desktop | Central server clients |
|---|---|---|---|
| Window/UI | Nuxt 3 SSR web app | Electrobun 2.0.5 system WebView; Nuxt static SPA | Existing Nuxt/Vue UI in Electrobun remote mode or the Capacitor iOS shell |
| UI → BFF | Eden Treaty → same-origin Nuxt `/api/**` proxy → Elysia HTTP | `LocalAuthGate` unlocks through Electrobun RPC; Eden requests use `window.obol.apiFetch` → in-process Elysia `app.handle(Request)` | Typed Eden client → configured HTTPS server; remote desktop and iOS use Bearer sessions, hosted web uses its same-origin HttpOnly cookie |
| BFF | Elysia on Bun behind the hosted proxy | Same Elysia app around local PocketBase; no remote auth secret, no public listener | Elysia BFF in the production Compose stack; D009 auth protects `/api/**` |
| Data | PocketBase Compose service | PocketBase v0.40.6 child bound to `127.0.0.1:13090`; per-profile `pb_data` plus `local_profile.json` | Central PocketBase volume, private to the BFF; one owner per deployment, shared data for every valid session |

The central server is an optional shared runtime, not a service operated by the Obol project. Remote desktop mode is selected explicitly and never imports, syncs, or overwrites the local profile. iOS packages the same Nuxt/Vue UI with Capacitor 8 and stores bearer credentials in the iOS Keychain. The hosted web uses an HttpOnly cookie; remote desktop/iOS use Bearer tokens and exact CORS origins (`views://mainview` and `capacitor://localhost`). See [D008](decisions/D008-central-server-clients.md), [D009](decisions/D009-remote-identity.md), [D014](decisions/D014-electrobun-cors-origin.md), and the [self-hosting runbook](self-hosting.md).

## Server layering (`server/src`)

| Layer | Contents | Rule |
|---|---|---|
| `domain/` | Entities, repository interfaces, errors, date/currency math, structured transaction query/summary types | No framework imports |
| `application/use-cases/` | One class per operation, constructor-injected with repository ports | No Elysia or PocketBase imports |
| `infrastructure/controllers/` | 9 Elysia route groups; explicit HTTP schemas/status/argument mapping | Dispatch through `use-case-routes/`; controllers contain no business rules |
| `infrastructure/use-case-routes/` | `executeUseCase` and typed `resolveUseCase`; maps Awilix tokens to concrete use-case classes | Infrastructure-only invocation boundary (D006) |
| `infrastructure/repositories/` | PocketBase implementations; structured ledger query builder uses PocketBase's `filter()` parameter binding | Only layer that accesses PocketBase |
| `infrastructure/validators/` | TypeBox request schemas | HTTP boundary validation |
| `infrastructure/scheduler/` | Daily cron plugin, injected with the Awilix container | Directly resolves use cases; bypasses HTTP dispatch |
| `infrastructure/di/container.ts` | `createContainer(pb)`, Awilix `InjectionMode.CLASSIC` | Repositories singleton; use cases scoped |

`server/src/index.ts` exports `createServer(pb, remoteAuthOptions)` without side effects and exports its `App` type for Eden Treaty. Omitting the auth argument resolves `OBOL_SESSION_SECRET` for hosted deployments; passing `null` disables remote auth explicitly. Electrobun passes `null` so a developer shell secret cannot alter its local RPC mode. `startHostedServer()` authenticates PocketBase, configures remote auth, and listens only when `src/index.ts` is the Bun entrypoint.

## Frontend layering (`app/`)

| Path | Role |
|---|---|
| `pages/` | Dashboard, ledger, cards, management, admin |
| `components/` | Domain tabs, modals, `ForecastChart`, daily `ForecastCalendar`, `DesktopUpdaterBanner` |
| `stores/finance.ts` | Pinia cache of accounts/cards/categories/projects |
| `composables/` | Global refresh and modal state |
| `utils/api.ts` | Eden client typed from `server/src/index.ts`; hosted web uses the same-origin proxy, Electrobun uses local RPC or remote Bearer transport, and Capacitor iOS uses remote Bearer transport |
| `app.vue` | Global `UNotifications` host (Nuxt UI v2) |

The web app sends structured filters (`search`, status/type, simulation/scheduled, entity IDs, date range) to the transaction list and summary endpoints; it never constructs PocketBase filter expressions. The HTTP boundary rejects unknown query keys, and the repository applies the exact same server-side filter set to summary totals. See E001 and `canon.md §9`.

## Persistence (`db/`)

- `db/pb_migrations/` - versioned JavaScript schema migrations; never edit an applied migration.
- `db/pb_data/` - hosted Compose SQLite data (gitignored).
- Desktop PB data is not stored in the repository; the local runtime uses `Utils.paths.appData/copland.obol` (or the isolated `copland.obol.eb-dev` identifier in development).

- Hosted development: `docker-compose.yml` maps Nuxt :13000, Elysia :13080, and PocketBase :13090 on `obol_net`.
- Hosted deploy: `docker-compose.coolify.yml` keeps the existing Coolify reverse-proxy topology.
- Central self-hosting: `docker-compose.self-hosted.yml` builds the BFF and Nuxt web client, stores PocketBase data in a named volume, and publishes only loopback BFF/web ports. PocketBase has no host port. TLS/reverse-proxy, setup, upgrades, and backup/restore are in [self-hosting.md](self-hosting.md).
- Desktop: `desktop/app.json` is the app identity/version source. `desktop/scripts/eb-build.ts` generates the static view and Electrobun bundle. `desktop/scripts/ensure-pocketbase.ts` downloads pinned, SHA-256-verified PocketBase binaries for macOS arm64/x86_64 and Windows x64. The main process integrates Electrobun `Updater` for release-channel checks, background downloads, and safe restarts.
- Stable release: `.github/workflows/release-branch.yml` creates `release-<version>` after a merged release PR from `dev` or `pr/release-*`; `release.yml` validates native builds, publishes installers plus Electrobun updater metadata/full bundles, and updates the Homebrew cask from the macOS manifest.
- Release candidates: a merged `rc/<version>` PR with `desktop/app.json` set to `X.Y.Z-rc.N` creates `rc-<version>` and dispatches `release-candidate.yml`. Each run publishes the candidate prerelease and refreshes the fixed `rc-channel` updater, while `rc-channel` stays isolated from stable `latest`, `/releases/latest/download`, and the cask. RCs built from `rc.2` onward update among themselves; `rc.1` needs one manual install of `rc.2`, and switching to stable remains manual.
- Nix/direnv: `flake.nix` supplies Node, Bun, Docker Compose, and unzip; `.envrc` activates the flake.
