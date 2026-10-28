# E001 - Local-first Obol: ledger hardening + Electrobun desktop packaging

**Status**: proposed · **Owner**: Caio · **Created**: 2026-10-28
**Related decisions**: D001 (Triad), D003 (clean architecture — the lever for this epic), D005 (Electrobun local packaging, proposed)

## Goal

Make Obol run locally as an Electrobun desktop app with no server to deploy, reusing Nod's build/deploy system — and harden the Ledger (`/ledger`) into a trustworthy audit surface first, because the desktop build is only worth opening if the ledger answers "what happened with my money" completely.

Two outcomes:

1. **Ledger as the audit surface** — server-authoritative filtering, totals, and lifecycle visibility (`canon §4`, `§9`).
2. **Zero-server desktop** — one window, local data, PocketBase and BFF owned by the app process (Nod model: in-process backend, no remote host required).

## Why this order

The ledger gaps are known and small (below); the Electrobun port is a structural change. Strengthening the ledger first means the first runnable desktop build exercises already-solid features, and the ledger's needs (pagination, totals) shape the desktop API instead of being reworked after.

## Sprint 1 — s01-ledger-hardening

Current state (verified from `app/pages/ledger.vue`, 2026-10-28): paginated table (20/page), debounced title search, status/type/simulation/scheduled filters, simulation→reality conversion modal, edit modal integration. Gaps:

| Gap | Change |
|---|---|
| No date-range filter | `expected_date`/`realized_date` range in the filter bar (mode follows status filter) |
| No entity filter | Account / card / category selects, joined into the PocketBase filter |
| No filtered-set totals | New `SummarizeTransactionsUseCase` + `/api/transactions/summary` returning income/expense/net/count for the exact same filter string; row above the table |
| Fixed sort | Sort selector (`expected_date`/`amount`/`created`, asc/desc) passed through `ListTransactionsUseCase` |
| Raw filter interpolation | Escape `'` and quotes in search text before building `title ~ '...'` (currently `ledger.vue:63` interpolates raw) |
| `confirm()` delete | App modal (matches the app's modal language) |
| Missing lifecycle badges | Show `is_silent`, `invoice_id` (invoice period), `recurrence_id` badges next to title |
| Swallowed fetch errors | Toast on fetch failure (`ledger.vue:106` currently `console.error` only) |
| No export | CSV export of the current filtered set (client-side from fetched pages, cap 1000) |

Acceptance:
- Filtering by date range + entity + status returns exactly the PocketBase filter result (verified via `/api/transactions` response count).
- Summary row totals reconcile with a manual sum over the filtered pages.
- No `confirm()`/`alert()` calls remain in `ledger.vue`.
- Server still typechecks; ledger page boots against the dev stack.

## Sprint 2 — s02-electrobun-shell

Port Nod's system (full inventory: Nod `docs/electrobun.md`, `docs/distribuicao.md`, its `scripts/`). Target facts from Nod: Electrobun 2.0.5, `bundleCEF: false`, system webview, Bun main process, IPC via `defineElectrobunRPC`, views bridge as document-start preload.

Architecture (the minimal-rework path — Nod pattern, adapted):

```
┌─ Electrobun window ─────────────────────────────────────────┐
│  view: Nuxt SPA build (ssr:false → nuxi generate → dist/)    │
│        Eden base = http://127.0.0.1:13080                    │
└──────────────▲──────────────────────────────────────────────┘
        IPC (bridge preload)
┌──────────────┴──────────────────────────────────────────────┐
│  main process (Bun) — electrobun/bun/index.ts                │
│   1. data dir = ~/Library/Application Support/copland.obol   │
│   2. spawn PocketBase binary child (--http 127.0.0.1:13090   │
│      --dir <datadir>/pb_data --migrationsDir bundled)        │
│   3. run Elysia BFF in-process (server/src, PORT=13080)      │
│   4. create window(s); exit policy on last window closed     │
└─────────────────────────────────────────────────────────────┘
```

Design choices (record as D005 when accepted):
- **Keep the Triad shapes, not the Docker shape.** PocketBase runs as a managed child process (MIT-licensed binary, per-OS builds published upstream) instead of a container; repositories in `server/src/infrastructure/repositories/` are untouched — that is D003's payoff.
- **Nuxt SPA, not SSR.** Desktop view is a static build; `NUXT_PUBLIC_API_BASE` becomes `127.0.0.1:13080`. Plugins are already client-safe (`echarts.client.ts`).
- **Server in-process** (import `App` and `listen` inside the main process) — single Bun runtime, no HTTP hop between two local processes.

Port checklist (from the Nod audit):

1. `app.json` — name Obol, id `copland.obol`, scheme `obol`, version, window size, permission strings (drop camera/microphone if unused).
2. `scripts/` — `gen-electrobun-config.ts`, `app-config.ts`, `eb-icon.ts`, `eb-build.ts`, `eb-dev.ts`, `eb-postwrap.ts`, `eb-postbuild.ts`, `eb-sign.ts` (rename every `NOD_*` env and `nod` prefix to `OBOL_*`/`obol`).
3. `electrobun/` — `bun/index.ts` (boot order above; drop the `tjs:sqlite` shim — Obol's server is Bun-native), `view/bridge.ts`, `shared-rpc.ts` (only window/dialog/clipboard methods Obol needs; no host sync), skip `native/` Swift helper for v1.
4. `package.json` — dev dep `electrobun@2.0.5`, scripts `eb:dev`, `eb:build`, `eb:verify`, `validate`.
5. PocketBase binary handling — download the per-OS binary at build time into `build/` (gitignore), bundle via `build.copy` into `Resources/`, locate via `app.paths().resources` at boot; fail loudly if missing.
6. `eb-dev.ts` — dev mode: vite dev server + spawned local PocketBase + BFF watch; dev id `copland.obol.eb-dev` (Nod refuses the release id in dev — keep that guard).

Acceptance:
- `bun run eb:dev` opens the window on macOS with dashboard + ledger functional against a local `pb_data`.
- `bun run eb:build` produces a signed `Obol.app` that boots, runs migrations on first launch, and holds data across restarts (relaunch test).
- No Docker involved anywhere in the local path.
- The hosted Triad (`docker-compose.yml`) keeps working unchanged — this is additive, not a cutover.

## Sprint 3 — s03-release-pipeline

Port Nod's release system: `release-branch.yml` (merge `dev`→`main` ⇒ push `release-<version>` ⇒ run), `release.yml` (prepare/build matrix/upload/merge manifests), `eb-publish.ts` (ditto zip + sha256 + `manifest.json`), `brew-cask.ts` (`Casks/obol.rb`, repo as its own tap, postflight `xattr -dr com.apple.quarantine`), version source of truth `app.json`, notes from `Release <version>:` commit subjects.

Acceptance: merge to `main` produces a GitHub release with `obol-<version>-macos-<arch>.zip` + `manifest.json`; `brew install --cask` of the tap installs and launches Obol.

## Risks

- **Nuxt inside Electrobun views**: the view loads from a custom `views://` scheme; Nuxt's SPA payload/router base must be relative (`--base=./`). Spike early in s02 (Nod hit this with vite `--base=./`).
- **PocketBase child lifecycle**: crash/kills need supervision (restart policy + window error surface). Simplest: watchdog in main process, exit app on repeated failure.
- **Port collisions** (13080/13090 already in use by a running Docker stack): boot-time port probe, fail with a human-readable message.
- **Windows/Linux**: defer — v1 targets macOS only (matches Nod's primary path); matrix legs are s03 scope.

## Non-goals

- Multi-user auth (Épico 1 security lock stays future work).
- Replacing PocketBase with embedded SQLite (rejected: would rewrite all repositories for no local-run benefit).
- Hosted sync between desktop instances.
