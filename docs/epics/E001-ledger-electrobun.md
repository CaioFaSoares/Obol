# E001 - Local-first Obol: ledger hardening + Electrobun desktop packaging

**Status**: implemented · **First release**: 0.1.0 published 2026-10-28 · **Hotfix**: 0.1.0a in preparation
**Related decisions**: D001 (Triad), D003 (clean architecture), D005 (local Electrobun), D007 (local profile unlock)

## Goal

Make Obol run locally as an Electrobun desktop app with no server to deploy, reusing Nod's build/deploy system — and harden the Ledger (`/ledger`) into a trustworthy audit surface first, because the desktop build is only worth opening if the ledger answers "what happened with my money" completely.

Two outcomes:

1. **Ledger as the audit surface** — server-authoritative filtering, totals, and lifecycle visibility (`canon §4`, `§9`).
2. **Zero-server desktop** — one window, local data, PocketBase and BFF owned by the app process (Nod model: in-process backend, no remote host required).

## Why this order

The ledger gaps are known and small (below); the Electrobun port is a structural change. Strengthening the ledger first means the first runnable desktop build exercises already-solid features, and the ledger's needs (pagination, totals) shape the desktop API instead of being reworked after.

## Sprint 1 — s01-ledger-hardening

### Baseline before E001

The ledger had pagination, title search, status/type/simulation/scheduled filters, and edit integration. It lacked date/entity filters, filtered-set totals, sorting, lifecycle context, reliable fetch errors, and export. The dashboard also passed raw PocketBase expressions in transaction requests.

### Implemented ledger contract

| Baseline gap | Implemented outcome |
|---|---|
| No date/entity filters | Structured date, account, card, and category filters, plus status/type/simulation/scheduled/search |
| No filtered-set totals | `/api/transactions/summary` uses the same structured filters; transfer rows count but do not affect income/expense/net |
| Fixed sort | Allowlisted sort by expected date, realized date, amount, or creation time |
| Raw filter interpolation | All app transaction-list callers use structured query parameters; unknown/raw PocketBase query keys are rejected at the HTTP boundary; repository expressions use PocketBase parameter binding |
| `confirm()` delete / missing lifecycle context | App delete modal and transaction lifecycle/invoice/recurrence badges |
| Swallowed fetch errors / no export | Visible error and success feedback; CSV export of current filters, capped at 1,000 rows |

Acceptance was exercised against PocketBase fixtures and in the browser: filters and summary totals matched, export included invoice period, and delete cancellation left the row unchanged.

## Sprint 2 — s02-electrobun-shell

Port Nod's system (full inventory: Nod `docs/electrobun.md`, `docs/distribuicao.md`, its `scripts/`). Target facts from Nod: Electrobun 2.0.5, `bundleCEF: false`, system webview, Bun main process, IPC via `defineElectrobunRPC`, views bridge as document-start preload.

Implemented architecture (Nod's local-main-process model, with the existing Elysia app retained):

```
┌─ Electrobun window (`views://mainview`) ────────────────────────────┐
│  Nuxt static SPA (`app.baseURL = './'`)                        │
│  Eden Treaty custom fetcher → `window.obol.apiFetch` over RPC  │
└───────────────────────────┬───────────────────────────────────┘
                            │ typed RPC request/response
┌───────────────────────────▼───────────────────────────────────┐
│ Electrobun main process (Bun)                                  │
│  1. Create per-user data directory + mode-0600 PB secret       │
│  2. Start pinned PocketBase 0.40.6 child on 127.0.0.1:13090    │
│  3. Wait for health/migrations; authenticate admin client      │
│  4. Build existing Elysia app; start loopback lifecycle on     │
│     127.0.0.1:13080 (scheduler); dispatch UI RPC to app.handle │
└────────────────────────────────────────────────────────────────┘
```

The UI does not call the loopback BFF over HTTP. Elysia's loopback listener exists for hosted-compatible lifecycle/scheduler behavior; the desktop WebView reaches `app.handle(Request)` through Electrobun RPC. No external server, Docker, or network-facing port is needed.

Implemented decisions (D005):

- **Keep the Triad's business/application shape, not the Docker topology.** Elysia use cases and PocketBase repositories stay unchanged; `server/src/index.ts` now exports a side-effect-free `createServer(pb)` factory and `startHostedServer()` for Docker.
- **Electrobun 2.0.5, system WebView, macOS arm64/x86_64.** Identity is `copland.obol`, scheme `obol`, window `1100x720`; development identity is `copland.obol.eb-dev`.
- **Nuxt is static only in the packaged build.** `OBOL_DESKTOP_STATIC=true` sets `ssr:false` and a relative asset base; development keeps SSR/HMR. Nuxt UI v2 uses a local icon bundle so the app does not depend on Iconify's network API.
- **PocketBase is version-pinned, not `latest`.** `desktop/pocketbase.json` pins v0.40.6 and the official macOS arm64/amd64 asset SHA-256 values. The GitHub repository was archived on 2026-10-26; future PB upgrades need an explicit source/checksum decision.
- **Local lifecycle**: main process creates `Utils.paths.appData/copland.obol[/pb_data]`, stores a random superuser password mode 0600, launches PB on loopback :13090, waits for health/migrations, authenticates, then builds/listens on the Elysia app on loopback :13080 and opens the window. `before-quit` shuts down Elysia and the PB child. No Docker or remote host.
- **Desktop API transport**: Eden remains typed against `server/src/index.ts` `App`; the document-start preload exposes `window.obol.apiFetch`, RPC carries path/method/headers/body, and the main process passes a `Request` to `app.handle`. Only `/api/*` is accepted. This avoids a WebView-to-loopback HTTP/CORS surface.

## Implemented files

- `desktop/app.json`, `desktop/package.json`, `desktop/pocketbase.json`, generated `desktop/electrobun.config.ts`.
- `desktop/electrobun/{bun/index.ts,view/bridge.ts,shared-rpc.ts}`.
- `desktop/scripts/{ensure-pocketbase,prepare-migrations,gen-electrobun-config,eb-dev,eb-build,eb-sign,eb-verify,eb-publish,brew-cask}.ts`.
- `.github/workflows/{release-branch.yml,release.yml}`, `Casks/obol.rb` is generated by the first actual release (no placeholder hash is tracked).

Acceptance and observed results:

- `bun run eb:dev` launched the Electrobun app, started local PB, authenticated, and issued Ledger API calls through the RPC bridge.
- Created a smoke transaction through the local API, restarted the desktop app, confirmed the row persisted, then deleted the test row.
- `bun run eb:build` produced a signed `Obol.app`; `bun run eb:verify` checked bundle identity, signature, launcher, generated view, and staged PB/migration resources.
- The final stable launcher smoke started PocketBase under an isolated `OBOL_APP_ID`; `/api/health` returned 200, app quit stopped the child, and the temporary profile was removed.
- Nuxt production `npm run build` and desktop static `npm run generate` succeeded; app typecheck and server tests/typechecks passed.
- The hosted Docker Compose topology remains in place and its configuration validates.
- GitHub release `release-0.1.0` succeeded: macOS arm64/x86_64 archives, checksum manifest, and `Casks/obol.rb` were published. Version 0.1.0a adds first-run login and local PocketBase credential recovery.

## Risks and boundaries

- **Hosted data is not imported automatically.** A fresh desktop profile starts empty; an existing local 0.1.0 `pb_data` directory is retained during the 0.1.0a login migration.
- **PB version maintenance**: desktop pins v0.40.6 because the upstream GitHub repo was archived on 2026-10-26. Any upgrade requires a new trusted binary source, checksum, and migration test.
- **Port collisions**: PB binds 127.0.0.1:13090; the embedded Elysia lifecycle binds 127.0.0.1:13080. Startup shows an error and stops the PB child if either cannot start.
- **Unexpected PB exit**: the Electrobun `before-quit` hook stops Elysia and the child; an unexpected PB exit shows a native error and closes the app rather than continuing against an unavailable database.
- **Icon**: the app currently uses Electrobun's default icon; no designer-provided 1024×1024 icon asset was present.
- **Platform scope**: v1 builds macOS arm64 and x86_64. Windows/Linux Electrobun packaging is not implemented.
## Non-goals

- Multi-user/hosted authentication and sync remain out of scope; the desktop has one local profile with a setup/unlock gate (D007).
- Replacing PocketBase with embedded SQLite (rejected: would rewrite all repositories for no local-run benefit).
- Hosted sync between desktop instances.
