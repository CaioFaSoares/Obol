# E007 - Native offline 0.4.0

**Status**: completed · **Target release**: 0.4.0 · **Shipped in**: 0.4.5 · **Completed**: 2026-11-01
**Related**: [D016](../decisions/D016-native-offline-sync.md) · canon [§12](../canon.md) · [D005](../decisions/D005-electrobun-local.md) · [D007](../decisions/D007-local-profile-unlock.md) · [D008](../decisions/D008-central-server-clients.md) · [D009](../decisions/D009-remote-identity.md) · [E003](E003-dashboard-operations.md) · [E004](E004-windows-release-pipeline.md) · [E005](E005-electrobun-auto-updater.md) · [E006](E006-central-server-mobile.md)

> **Delivered in 0.4.5.** The baseline below describes the repository before this program started (2026-10-31). The native iOS app, the durable offline stores, the desktop station and the D016 server sync shipped together in 0.4.5; see [0.4.5](../releases/0.4.5.md) for the release record. This epic keeps its original baseline so the starting point stays auditable.

## Goal

Ship Obol 0.4.0 as a complete release with:

1. Production self-hosting that still runs the Elysia/PocketBase BFF and the hosted/Coolify topology.
2. A native SwiftUI iOS app that replaces the Capacitor UI and supports connected-server workflows.
3. Durable native offline finance on iOS and on desktop local mode.
4. Explicit, retry-safe synchronization between those clients and the user's server under [D016](../decisions/D016-native-offline-sync.md).
5. Polished UX across web, desktop, and iOS, with no regression to the canon §§3-8 and §13 finance semantics.
6. Release evidence for deployment, backup/restore, simulator launch, offline/relaunch/reconnect, desktop packaging and updater, Windows runtime, TestFlight prerequisites, all 21 E003 dashboard scenarios, and the final artifacts.

The release is not a scaffold. Every capability below is either delivered and observed, or explicitly blocked with the missing runtime named.

## Current baseline

Verified against source on 2026-10-31. These facts define the starting point.

| Area | Current fact | Source |
|---|---|---|
| iOS UI | Capacitor 8 loads the Nuxt static SPA in a WKWebView. `AppDelegate.swift` and `SceneDelegate.swift` are the app shell. Bundle id `copland.obol.mobile`. Deployment target 15.0. | `app/ios/App/App/AppDelegate.swift`, `app/ios/App/App/SceneDelegate.swift`, `app/ios/App/App/Info.plist`, `app/ios/App/App.xcodeproj/project.pbxproj` |
| iOS data | The shipped app has no native financial store; the UI talks to the remote BFF with Bearer tokens stored by the Capacitor secure-storage plugin. An unshipped `ObolCore` package holds models, finance engine, and an atomic-JSON `LocalStore.swift`; the App target does not link it and no SQLite/outbox store exists. | `app/utils/api.ts`, `app/capacitor.config.ts`, `app/ios/ObolCore/Sources/ObolCore/LocalStore.swift`, E006 |
| Desktop local | Electrobun 2.0.5 starts a managed PocketBase v0.40.6 child and an in-process Elysia app. Data lives under `Utils.paths.appData/copland.obol/pb_data`. | `desktop/electrobun/bun/index.ts`, `desktop/app.json`, D005 |
| Desktop remote | The same Nuxt UI points at a configured central server with Bearer auth. Local and remote modes are separate. No data moves between them. | `app/composables/useRemoteSession.ts`, `app/utils/api.ts`, E006 |
| Sync | None. D008 says local/remote selection performs no implicit data transfer. | D008, E006 |
| Server writes | Use cases call repositories one write at a time. Multi-record financial effects are not atomic. | `server/src/application/use-cases/transactions/CreateTransactionUseCase.ts`, `server/src/application/use-cases/cards/PayInvoiceUseCase.ts`, `server/src/application/use-cases/transactions/DeleteTransactionUseCase.ts` |
| Revisions and tombstones | None. Repositories update or physically delete PocketBase records. | `server/src/infrastructure/repositories/` |
| Scheduler | Each runtime that starts the BFF also starts the daily cron. | `server/src/infrastructure/scheduler/index.ts`, `desktop/electrobun/bun/index.ts` |
| Auth | Single owner, BFF-minted HS256 sessions, Bearer for native clients, cookie for hosted web, revocable `obol_sessions`. | `server/src/infrastructure/plugins/remoteAuth.ts`, D009 |
| Release | macOS and Windows desktop artifacts, Electrobun updater metadata, separate RC channel, Capacitor TestFlight script. | `.github/workflows/release.yml`, `.github/workflows/release-candidate.yml`, `.github/workflows/ios-testflight.yml`, `app/scripts/ios-testflight.sh` |

## Current verified foundation

These are observed facts about the starting point, separate from the 0.4.0 target. They are not evidence that any 0.4.0 capability exists.

| Fact | Evidence |
|---|---|
| A Foundation-only Swift package exists at `app/ios/ObolCore` with four sources (`Models.swift`, `FinanceEngine.swift`, `ForecastEngine.swift`, `LocalStore.swift`) and `Package.swift`; it declares iOS 15/macOS 13 and imports only Foundation. | `app/ios/ObolCore/Package.swift`, `app/ios/ObolCore/Sources/ObolCore/*.swift` |
| `LocalStore.swift` is an atomic-JSON snapshot backend for local finance. It is not a SQLite store, has no outbox, conflicts, cursor, or revisions, and is not referenced by the App target. | `app/ios/ObolCore/Sources/ObolCore/LocalStore.swift` |
| The iOS app shell is still Capacitor: `AppDelegate.swift`, `SceneDelegate.swift`, and `CapApp-SPM` are the only App-target Swift files, and `project.pbxproj` does not link `ObolCore`. | `app/ios/App/App/AppDelegate.swift`, `app/ios/App/App/SceneDelegate.swift`, `app/ios/App/App.xcodeproj/project.pbxproj` |
| The BFF has no batch configuration, revision, journal, operation, outbox, or sync route. The only `batch` in `server/src` is a chunked delete loop. PocketBase operator settings currently patch only `meta.appURL` and `smtp`. | `server/src/infrastructure/plugins/pocketbase.ts`, `server/src/infrastructure/repositories/PocketbaseDatabaseMaintenanceRepository.ts` |
| Pinned dependency intent is Nuxt `^3.21.11`, Vue `^3.5.44`, Elysia `1.4.30` in `app/package.json`; Elysia `^1.4.30` in `server/package.json`. The patch is authored but its parent verification is still outstanding. | `app/package.json`, `server/package.json` |
| A digest-pinned Node 22 minimal production runner is authored at `app/Dockerfile.self-hosted` (builder plus unprivileged Nitro runner); the dev `app/Dockerfile` intentionally stays on `node:20-alpine`. The self-hosted image build is awaiting parent proof, so it is not claimed as verified. | `app/Dockerfile.self-hosted`, `app/Dockerfile`, `docker-compose.self-hosted.yml` |
| The prior Nuxt IPC defect is repaired and independently exercised; current `app`/`desktop` typechecks and the static build pass in the parent run. | parent run, 2026-10-31 |
| Two finance regressions were observed in the parent run and are release blockers: a failed transfer request left source `100 → 75` and destination `50` unchanged, and a realized simulation expense of `40` moved checking `850 → 810`. Both need a correction plus regression evidence. | parent run, 2026-10-31 |
| Verified PocketBase batch evidence: default `{ enabled: false, maxRequests: 50, timeout: 3, maxBodySize: 0 }`; an isolated proof volume enabled `{ enabled: true, maxRequests: 60000, timeout: 30, maxBodySize: 50331648 }`, proved a forced second-collection failure rolled back the first write, then committed a two-collection batch. The isolated setting is not a product fix. | <https://pocketbase.io/docs/api-records/#batch-createupdateupsertdelete-records>, <https://pocketbase.io/jsvm/interfaces/core.BatchConfig.html> |

No sync route, revision row, journal event, operation result, outbox, native SQLite store, or boot-verified batch configuration exists today. Those remain the 0.4.0 target.

The current iOS target keeps `DEVELOPMENT_TEAM = MCC2B4P5MZ` and `CODE_SIGN_STYLE = Automatic`. Implementation may add Swift files and build phases to `app/ios/App/App.xcodeproj/project.pbxproj`, but it must preserve the existing signing team and style. This epic does not edit that file.

## Target behavior

| Runtime | UI | Local data | Server connection | Time authority |
|---|---|---|---|---|
| Hosted web | Nuxt 3 SSR | None | Same-origin BFF cookie | Server |
| Self-hosted central | Nuxt 3 SSR | None | Same-origin BFF cookie | Server |
| iOS native | SwiftUI | SQLite store, offline-first | Optional, explicit pairing; Bearer session; sync endpoints only | Server when paired; local preview when offline |
| Desktop standalone | Electrobun + Nuxt SPA | Local PocketBase | None | Local BFF |
| Desktop station | Electrobun + Nuxt SPA | Local PocketBase plus station outbox | Optional, explicit pairing; Bearer session; sync endpoints | Server when paired; local preview when offline |
| Desktop remote | Electrobun + Nuxt SPA | None | Configured central BFF, Bearer | Server |

Intentional boundaries:

- The iOS app does not run Bun, PocketBase, or Electrobun. Its local store is SQLite.
- The desktop station still runs local PocketBase. It is a local working copy, not a second authority once paired.
- Hosted web and desktop remote do not synchronize. They are direct BFF clients.
- Pairing is never automatic. A local store with data is never silently merged into a server, and a server with data is never silently written over a local store.
- A financial conflict never resolves by timestamp, device order, or last writer. It needs an explicit user choice.

## Scope

In scope:

- Native SwiftUI iOS app with dashboard, ledger, cards, management, admin, onboarding, login, sync status, conflict resolution, and settings.
- SQLite local store with durable outbox, base records, revisions, cursor, and conflicts.
- Swift finance engine for canon §§4-8 and the §13 clarifications: transaction lifecycle, transfers, invoice engine, recurrence rules, forecast, budgets, projects.
- Server-side canon §13 corrections: exact-half currency rounding, realized-only project paid, planned budget basis, end-of-day forecast with overdue obligations on today, unassigned pending rows, investment isolation, and product-owned invoice projection.
- Desktop station mode with local PocketBase, operation recorder, outbox, pull loop, conflict UI, and pairing wizard.
- Server mutation gate, unit of work, revisions, change journal with commit groups, operation journal, station registry, backfill, sync endpoints (including the settled snapshot import route), and boot-verified PocketBase batch capability.
- Production self-hosting upgrade and fresh deployment, backup/restore, and rollback behavior.
- macOS arm64/x86_64 and Windows x64 desktop artifacts, Electrobun updater, Homebrew cask.
- iOS simulator build and launch, TestFlight archive/export prerequisites.
- All 21 E003 dashboard checklist scenarios on the surfaces where they apply.
- Final 0.4.0 artifact and version verification.

Out of scope:

- Multi-user deployments, per-record ownership, invitations, MFA, or family sharing. D009 remains single-owner.
- Changing canon §§3-8 field names. The canon §13 clarifications are in scope and correct the named 0.4.0 behaviors; the Swift engine ports the clarified rules.
- End-to-end encryption of local databases. iOS Data Protection and desktop OS disk protection are the stated boundary.
- Field-level merge or CRDT synchronization. D016 chooses operation conflicts.
- Journal compaction. D016 keeps the journal for 0.4.0.
- Real-time push, WebSockets, or background iOS execution guarantees. Sync runs on launch, foreground, user action, and a bounded timer while active.
- A Linux desktop build, Windows ARM64, App Store submission, or public TestFlight distribution beyond the existing manual workflow.
- Rewriting the Nuxt web UI. Desktop gets sync surfaces; web stays the same product.
- Editing accepted ADR merits. D016 is proposed and is the only new decision.

## Requirement trace

| Requirement | Tickets |
|---|---|
| Production self-hosting | `REL-01`, `REL-02` |
| Native SwiftUI iOS connected-server workflows | `IOS-01`, `IOS-06`, `IOS-07`, `IOS-08`, `IOS-09` to `IOS-13` |
| Native offline iOS | `IOS-02` to `IOS-05`, `IOS-07`, `IOS-09` to `IOS-12` |
| Native offline desktop | `DESK-02`, `DESK-03`, `DESK-06` |
| Later sync on iOS and desktop | `SYNC-01` to `SYNC-10`, `DESK-03`, `IOS-07` |
| Polished UX | `IOS-14`, `DESK-04`, `DESK-05`, `VRF-04` |
| Preserve Elysia/PocketBase BFF | `SYNC-03`, `SYNC-04`, `REL-01` |
| Preserve Electrobun packaging | `DESK-06`, `REL-03` |
| Preserve hosted/Coolify | `REL-02` |
| Preserve Windows | `DESK-07`, `REL-05` |
| Preserve canon §§3-8 and §13 | `IOS-04`, `PAR-01`, `SYNC-06` |
| Identity and token safety | `IOS-05`, `IOS-06`, `DESK-01`, `SYNC-10` |
| Durable device and pending state | `IOS-03`, `IOS-07`, `DESK-01`, `DESK-03` |
| Retry-safe sync | `SYNC-03`, `SYNC-06`, `IOS-07`, `DESK-03` |
| Deletions | `SYNC-08` |
| Explicit conflicts | `SYNC-06`, `IOS-07`, `DESK-04` |
| Preexisting server data | `SYNC-05`, `SYNC-13`, `IOS-08`, `DESK-05` |
| Legacy desktop data without an operation log | `SYNC-12`, `DESK-05` |
| Never-paired profile with local finance and a recorded operation log | `SYNC-13`, `IOS-08`, `DESK-05`, `VRF-03` |
| Endpoint switches | `IOS-08`, `DESK-05` |
| Concurrency | `SYNC-03`, `SYNC-06` |
| Crash and restart | `SYNC-03`, `IOS-07`, `DESK-03`, `VRF-03` |
| Offline-first initialization | `IOS-03`, `IOS-08`, `DESK-02` |
| No automatic last-writer-wins | `SYNC-06`, `IOS-07`, `DESK-04`, `VRF-03` |
| 21 E003 dashboard scenarios | `VRF-01` |
| Deployment and backup/restore | `REL-01` |
| Simulator launch | `IOS-01`, `REL-04` |
| Offline workflows and relaunch/reconnect | `VRF-02` |
| Desktop packaging and updater | `DESK-06`, `REL-03` |
| Windows runtime smoke | `REL-05` |
| Signing and TestFlight prerequisites | `IOS-15`, `REL-04` |
| Final 0.4.0 artifact verification | `REL-06` |

## Domain boundaries

Six domains own the work. A file belongs to exactly one domain in a wave.

| Domain | Owns | Does not own |
|---|---|---|
| Sync server | `db/pb_migrations/`, `server/src/domain/sync/`, `server/src/application/use-cases/sync/`, `server/src/infrastructure/sync/`, `server/src/infrastructure/repositories/PocketbaseSyncRepository.ts`, `server/src/infrastructure/controllers/SyncController.ts`, `server/src/infrastructure/validators/syncSchemas.ts`, sync wiring in `server/src/index.ts`, `di/container.ts`, `use-case-routes/`, `scheduler/` | iOS, desktop view, release workflows |
| Finance semantics | `server/src/domain/`, `server/src/application/use-cases/`, `shared/finance-parity/`, `app/ios/ObolCore/Sources/ObolCore/FinanceEngine.swift`, `ForecastEngine.swift`, `Models.swift` | Transport, SQLite schema, UI |
| iOS core | `app/ios/ObolCore/` (existing Foundation package: models, finance engine, forecast, store backend), `app/ios/App/App/Core/Store/`, `app/ios/App/App/Core/Sync/`, `app/ios/App/App/Core/API/`, `app/ios/App/App/Core/Security/`, `app/ios/App/AppTests/`, `app/ios/App/App.xcodeproj/project.pbxproj` | `app/pages/`, `server/`, `desktop/` |
| iOS UI | `app/ios/App/App/Features/`, `app/ios/App/App/App/`, `app/ios/App/App/Assets.xcassets/` | `app/ios/ObolCore/`, `Core/Store/`, `Core/Sync/`, `Core/API/` |
| Desktop station | `desktop/electrobun/bun/sync/`, `desktop/electrobun/shared-rpc.ts`, `desktop/electrobun/bun/index.ts`, `app/components/Sync*.vue`, `app/composables/useSync.ts`, `app/pages/sync.vue`, `desktop/scripts/` | `server/` business logic, iOS |
| Release | `.github/workflows/`, `docker-compose*.yml`, `.env.self-hosted.example`, `docs/self-hosting.md`, `docs/ios-testflight.md`, `desktop/app.json`, `Casks/` | Finance code |

`server/src/index.ts` is owned by the sync server domain because it mounts the controller and boot backfill. Desktop may pass options to `createServer` but does not edit it.

## Dependency waves

### Wave 0 - Contract freeze

Deliverable: D016 proposed, canon §12 appended, E007 published. No code.

Exit: the operation table, wire shapes, persistence fields, conflict rule, and client lifecycle are fixed enough that server and client owners can implement against them without editing each other's files. This task delivers Wave 0.

### Wave 1 - Foundation, parallel and disjoint

This is the first implementation wave. No file below is edited by two owners. No owner may edit another owner's paths in this wave.

| Owner | Files | Deliverable | Exit |
|---|---|---|---|
| Server sync foundation | `db/pb_migrations/1700000018_create_sync_collections.js`, `1700000019_add_sync_fields.js`, `1700000020_add_sync_indexes.js`, `1700000021_snapshot_import.js`; `server/src/domain/sync/**`; `server/src/domain/errors/index.ts`; `server/src/infrastructure/sync/**` (journal, gate, unit of work, backfill); `server/src/infrastructure/repositories/PocketbaseSyncRepository.ts`; sync wiring in `server/src/infrastructure/di/container.ts`, `server/src/infrastructure/use-case-routes/dispatch.ts`, `server/src/infrastructure/scheduler/index.ts`, `server/src/index.ts`; all `server/src/infrastructure/repositories/Pocketbase*.ts` for unit-of-work write routing | Sync tables, mutation gate, unit of work, revision and journal recording, boot backfill, operation metadata types | Every write path records revisions and change events atomically; backfill is idempotent; no sync HTTP route is mounted yet |
| iOS foundation | `app/ios/ObolCore/**` (existing package: integrate, do not duplicate models/engine into `App/Core`); `app/ios/App/App/ObolApp.swift`, `app/ios/App/App/App/**`, `app/ios/App/App/Core/**`; `app/ios/App/App.xcodeproj/project.pbxproj`; `app/capacitor.config.ts`; `app/package.json`; `app/package-lock.json`; `app/scripts/ios-testflight.sh`; `shared/finance-parity/**` | Link `ObolCore` into the native target, native SwiftUI cutover, minimal offline root, SQLite schema and single transactional store replacing the interim JSON backend, finance engine parity, parity fixtures | The simulator launches a native app with no WebView; offline fixture suite matches server outputs for canon §§4-8; one SQLite store survives relaunch and backs the outbox; no network code |
| Desktop shell foundation | `desktop/electrobun/bun/sync/config.ts`; `desktop/electrobun/bun/sync/credentials.ts`; `desktop/electrobun/shared-rpc.ts` (additive types only); `desktop/scripts/eb-build.ts`; `desktop/scripts/eb-verify.ts` | Durable station config and credential handoff contract; packaged migration copy and presence check | Station state lives in local PocketBase, not a second SQLite database or config file; packaged build includes the 0018-0021 migrations; no sync loop yet |

Wave 1 rules:

- Wave 1 ownership is temporary. The iOS foundation owner holds the app shell, `ObolCore`, and parity fixtures only to boot the native target and prove the offline engine. From Wave 3 onward, `Features/` and `App/` belong to the iOS UI domain, while `app/ios/ObolCore/**`, `App/Core/**`, and `shared/finance-parity/` stay with the iOS core and finance owners.
- The server owner may change repository internals and DI. Other owners do not edit `server/`.
- The iOS owner executes `IOS-01` to `IOS-05` and may change the Xcode project. The desktop and server owners do not edit `app/ios/` or `app/package.json`.
- The desktop owner may change only the listed desktop shell and script files. It does not edit `desktop/electrobun/bun/index.ts` in this wave.
- `shared/finance-parity/` is owned by the iOS owner in Wave 1. The server owner may read fixtures but not edit them. Server fixtures for Wave 1 use inline data.
- If a contract ambiguity blocks a slice, it is resolved in D016 or canon §12 first, not by a private workaround in one slice.

Wave 1 exit criteria:

- A hosted-web write creates one change event per written entity in one commit group, one revision increment per entity, and no duplicate event on retry.
- Boot configures and verifies PocketBase batch capability through the authenticated settings API while preserving unrelated `smtp`/`meta` settings, and proves a forced second-collection failure rolls the first write back before a two-collection batch commits.
- A 0.3.0 database with financial rows backfills to a complete journal in complete bounded commit groups, and a second boot adds nothing.
- The iOS store applies create, realize, transfer, card purchase, invoice payment, recurrence launch, delete, forecast, and budget fixtures offline using the existing `ObolCore` engine, with no duplicated models.
- A desktop packaged build contains `pb_migrations/1700000018_create_sync_collections.js`, `1700000019_add_sync_fields.js`, `1700000020_add_sync_indexes.js`, and `1700000021_snapshot_import.js`.
- Existing hosted web, desktop local, and desktop remote paths remain available and no sync route is reachable. The canon §13 corrections and the delete error-handling change are intentional: end-of-day current/projected labeling, overdue obligations on today, realized-only past days, unassigned and investment row handling, exact-half rounding, realized-only project paid, planned budget basis, product-owned invoice projection, and aborts on a failed invoice or recurrence adjustment. Other behavior stays unchanged in this wave.

### Wave 2 - Synchronization, parallel with iOS UI shell

Depends on Wave 1.

| Owner | Tickets | Files |
|---|---|---|
| Server API | `SYNC-06` to `SYNC-10`, `SYNC-12`, `SYNC-13` | `server/src/application/use-cases/sync/`, `server/src/infrastructure/sync/StationRecorder.ts`, `StationMode.ts`, `UseCaseOperationMap.ts`, `server/src/application/use-cases/recurrences/ProcessMonthlyRecurrencesUseCase.ts`, `server/src/infrastructure/scheduler/index.ts`, `server/src/infrastructure/controllers/SyncController.ts`, `server/src/infrastructure/validators/syncSchemas.ts`, `server/src/infrastructure/repositories/PocketbaseSnapshotImportRepository.ts`, `server/src/infrastructure/di/container.ts`, `server/src/index.ts` |
| iOS networking | `IOS-06` to `IOS-08` | `app/ios/App/App/Core/API/`, `app/ios/App/App/Core/Sync/`, `app/ios/App/App/Features/Onboarding/` |
| Desktop station | `DESK-02` to `DESK-03` | `desktop/electrobun/bun/sync/`, `desktop/electrobun/bun/index.ts` |

Wave 2 exit: a paired desktop station and a paired iOS store complete push, pull, duplicate, conflict, delete, endpoint mismatch, and crash/relaunch scenarios against a real self-hosted stack.

Within Wave 2, `SYNC-09` lands the station mode option and recorder before `DESK-02` wires the desktop caller. The desktop owner consumes that contract and does not edit `server/`.

### Wave 3 - iOS UI parity

Depends on Wave 1 and `IOS-06`.

Tickets `IOS-09` to `IOS-13`. Files under `app/ios/App/App/Features/` and `app/ios/App/App/App/`. No server or desktop files.

Exit: every 0.3.0 user workflow has a native surface. The app is usable offline before the server work is finished because the local store and finance engine already exist.

### Wave 4 - UX polish and conflict surfaces

Depends on Wave 2 and Wave 3.

Tickets `IOS-14`, `DESK-04`, `DESK-05`, `VRF-04`. Exit: pairing, sync status, conflicts, offline states, error states, accessibility, and responsive layouts are complete on iOS and desktop.

### Wave 5 - Release hardening

Depends on all previous waves.

Tickets `SYNC-11`, `DESK-06`, `DESK-07`, `IOS-15`, `REL-01` to `REL-06`, `VRF-01` to `VRF-03`. No new product scope. Only fixes, evidence, and release mechanics.

## Tickets

### Sync server

#### SYNC-01 - Sync schema migration

**Files**: `db/pb_migrations/1700000018_create_sync_collections.js`, `db/pb_migrations/1700000019_add_sync_fields.js`, `db/pb_migrations/1700000020_add_sync_indexes.js`, `db/pb_migrations/1700000021_snapshot_import.js`
**Work**: Create the five central sync collections and four local station collections as bare shells in 0018, because PocketBase 0.40.6 does not persist inline constructor fields in this JSVM flow. Add every typed field with `collection.fields.add` in 0019, following the 0014-0016 pattern. Include `commitId`, `commitIndex`, and `commitSize` on `obol_sync_changes`, `effectiveAt` and `clientCreatedAt` on `obol_sync_operations` and `obol_station_outbox`, plus `headHash`, `prevHash`, `chainHash`, and `eventKey`. Add the unique and lookup indexes in 0020 after the fields exist, including unique `(commitId, commitIndex)`. In 0021 create only the private `obol_sync_snapshot_imports` receipt collection with its seven fields plus the PocketBase system id: `importId` text required, `stationId` text required, `payloadHash` text required with max 50, `serverInstanceId` text required, `dataEpoch` number required positive integer (min 1), `result` JSON required, and `createdAt` date required; add unique `importId` and index `stationId`. In the same 0021 add exactly four optional fields to the station collections: `pendingImport` JSON at most 12 MiB on `obol_station_state`, `baseRecord` JSON at most 1 MiB and `serverDeleted` bool on `obol_station_versions`, and `acknowledgement` JSON at most 2 MiB on `obol_station_outbox`. The existing `deleted` stays the optimistic-local flag; `serverDeleted` is the server tombstone; `serverRevision` and `localRevision` stay separate. `acknowledgement` carries only the minimal accepted causal receipt, never whole entities or secrets. All public rules are `null`, no finance field is added, and 0018-0020 are not edited. Every step is idempotent up and down.
**Acceptance**: Fresh PocketBase 0.40.6 boot creates all ten collections with the declared fields and indexes. Re-running the migrations is a no-op. A same-named field of another type aborts the migration. Down removes only `obol_sync_snapshot_imports` with its indexes and the four optional fields (`pendingImport`, `baseRecord`, `serverDeleted`, `acknowledgement`), preserving every preexisting row and existing field. Upgrade from a 0.3.0 database preserves every financial row and the owner/session data. The four station collections stay empty on a central deployment.

#### SYNC-02 - Domain sync contract

**Files**: `server/src/domain/sync/SyncOperation.ts`, `SyncRevision.ts`, `SyncChange.ts`, `SyncProtocol.ts`, `SyncClock.ts`, `MutationContext.ts`, `server/src/domain/errors/index.ts`
**Work**: Define operation types, the complete immutable envelope (including `effectiveAt`), the complete-envelope `payloadHash` and canonical-JSON encoding rules, commit-group types (`commitId`, `commitIndex`, `commitSize`), payload types, per-operation write-set metadata, revision keys, change events, conflict shapes, protocol bounds, and stable error codes. Define `SyncClock` as `now(): string` returning an ISO UTC instant, with one system implementation; no global mutable clock. No Elysia or PocketBase imports.
**Acceptance**: The operation table in D016 is exhaustive in code. An unknown type cannot be constructed through the typed API. Conflict construction names the base revision, current revision, and current record. Accepted results type every touched entity, including deleted tombstones with a null record. Canonical-JSON fixtures for decimals, `null`, unicode, escaping, negative zero, and the empty genesis hash produce byte-identical `sha256:` + unpadded base64url hashes in TypeScript, Swift, and Bun. `SyncClock` is the only time source the date-sensitive use cases may read.

#### SYNC-03 - Mutation gate and unit of work

**Files**: `server/src/infrastructure/sync/MutationCoordinator.ts`, `PocketbaseUnitOfWork.ts`, `RecordIds.ts`, `server/src/infrastructure/plugins/pocketbase.ts` (batch capability configuration), `server/src/infrastructure/di/container.ts`, `server/src/infrastructure/use-case-routes/dispatch.ts`, `server/src/infrastructure/scheduler/index.ts`
**Work**: Add one async mutation gate per BFF process. Create a scoped unit of work per mutation. Buffer creates, updates, and deletes; expose buffered reads to the use case; assign one `commitId`, contiguous `commitIndex`, and `commitSize` per commit; flush one PocketBase batch with finance writes, revision rows, change events, `lastSeq`, and `headHash`. Configure and verify PocketBase batch capability at boot through the authenticated settings update, patching only `batch` while preserving unrelated `smtp`/`meta` settings and failing closed instead of degrading to single writes. Make `executeUseCase` resolve use cases in a scope bound to the unit of work. Thread `SyncClock` into every date-sensitive use case: web, cron, and online admin get the system clock; a sync operation gets a scoped clock fixed at its `effectiveAt`. Do not mutate a global clock or use ambient time. Route scheduler jobs through the same gate. Reject a commit over 10,000 entity events before writing.
**Acceptance**: A forced batch failure leaves zero finance rows, zero revisions, zero change events, and no operation result. A successful transaction commits all of them as one commit group. Boot leaves batch explicitly enabled and verified; an untouched default `{ enabled: false, maxRequests: 50, timeout: 3, maxBodySize: 0 }` must not reach a write path. Two concurrent writes serialize; revisions are gap-free per entity. A use case that throws does not commit. Read-your-writes covers `findById`, the card+period invoice lookup, and the list queries used by the allowed operations. A realization, invoice payment, project payment, or recurrence launch reached through the unit of work dates its effect from the operation clock, while a direct web/cron call uses the system clock; no date-sensitive use case calls `Date()` for a financial date.

#### SYNC-04 - Repository and journal integration

**Files**: all `server/src/infrastructure/repositories/Pocketbase*.ts`, `server/src/domain/interfaces/Common.ts` if a shared write context is needed
**Work**: Route record creation, update, and deletion through the unit of work. Generate 15-character client-compatible ids when no id is supplied. Record actual entity writes with type and id. On delete, record a tombstone write. Do not swallow persistence errors.
**Acceptance**: Every committed operation produces exactly one change event per written entity, and those events form one commit group. Delete emits a delete event and a deleted version row. `DeleteTransactionUseCase` aborts on an invoice or recurrence failure; `UpdateTransactionUseCase` aborts on an invoice failure. Neither commits a partial state. No finance request path writes directly to PocketBase outside the unit of work. Auth and session writes remain outside the journal.

#### SYNC-05 - Boot backfill and server meta

**Files**: `server/src/infrastructure/sync/BootstrapJournal.ts`, `server/src/infrastructure/sync/ServerMeta.ts`, `server/src/index.ts`
**Work**: Before the HTTP listener binds, ensure `obol_sync_meta` has `serverInstanceId`, `dataEpoch`, and `headHash`. If `journalBackfilledAt` is absent, emit deterministic upsert events for every existing row in complete bounded commit groups (one `commitId`, contiguous `commitIndex`, at most 10,000 events per group), assign revision 1, compute each event's `prevHash` and `chainHash` including the group fields, update `lastSeq` and `headHash`, then set the marker. Use `eventKey = "backfill:<entityType>:<entityId>"` so a crash and retry resume without duplicates. Generate a new instance id only when no meta exists.
**Acceptance**: A 0.3.0 database with rows pulls from cursor 0 as a complete baseline in complete groups. A second boot adds no event and does not change the instance id. A crash during the first backfill resumes without duplicate events and leaves the cursor on a group boundary. A fresh empty database gets a meta row and a backfill marker with zero events. A restore of the database restores the same instance id, data epoch, journal, and cursor.

#### SYNC-06 - Apply operation and explicit conflicts

**Files**: `server/src/application/use-cases/sync/PushSyncOperationsUseCase.ts`, `ApplySyncOperationUseCase.ts`, `ResolveSyncDependencies.ts`, `server/src/application/use-cases/sync/`
**Work**: Validate protocol, station, epoch, op bounds, `opId` reuse, the complete-envelope hash, dependencies, and base revisions. Recompute `payloadHash` over the received immutable envelope and reject a mismatch. Pass `effectiveAt` to the use case through an injected operation clock. Map each operation type to its existing use case. For a scheduler-generated `transaction.create`, accept the sync-only canonical `recurrence_id` extension, require `is_recurring: true`, validate that the recurrence exists and is active and the occurrence is not skipped or beyond `total_installments`, and reject an already-generated recurrence month with `RECURRENCE_MONTH_EXISTS` without creating a second transaction. For any `transaction.create` carrying `card_id`, use `expected_date` as the purchase-date input exactly like the public DTO and route the invoice from it; a scheduler-generated occurrence reconstructs `expected_date` from its recorded `purchase_date`, and `purchase_date` is an optional redundant date that must agree with `expected_date` when supplied. Apply in order under the gate. Compare actual writes against declared base revisions. Return `applied`, `duplicate`, `conflict`, `rejected`, or `blocked` per operation.
**Acceptance**: Same `opId` and same complete envelope returns the stored result and applies nothing. Same `opId` with any changed envelope field, including only `effectiveAt`, `baseRevisions`, or `dependsOn`, returns `OP_ID_REUSED`. A declared hash that disagrees with the envelope bytes returns `ENVELOPE_HASH_MISMATCH` and writes nothing. An offline realization or payment keeps its `effectiveAt` date after replay; the reconnect date never replaces it. Stale revision returns `SYNC_CONFLICT` with the current record. Missing base revision returns `UNCOVERED_WRITE` and writes nothing, except the additive invoice delta from `SyncInvoiceUseCase`. Two offline card purchases for the same card and period add their amounts without loss. A scheduler-generated `transaction.create` with a missing, unknown, or inactive `recurrence_id`, or an invalid skipped/installment occurrence, is rejected; a valid one keeps its recurrence link, and a month the server already generated is rejected with `RECURRENCE_MONTH_EXISTS` without a second transaction; card routing uses `expected_date`, never a local `invoice_id`, and a supplied redundant `purchase_date` must agree. A concurrent payment or deletion still conflicts on the invoice revision. A rejected dependency marks dependents `blocked`; a blocked operation is retried and applies after its dependency is accepted. No path resolves a conflict by timestamp or last writer.

#### SYNC-07 - Push, pull, handshake routes

**Files**: `server/src/infrastructure/controllers/SyncController.ts`, `server/src/infrastructure/validators/syncSchemas.ts`, `server/src/index.ts`, `server/src/infrastructure/use-case-routes/registry.ts`
**Work**: Mount `POST /api/sync/handshake`, `POST /api/sync/push`, and `GET /api/sync/pull` under the D009 session guard. Implement D016 request and response schemas, commit-group pagination, the 10,000-event commit bound and 32 MiB page cap, cursor-boundary rejection, and request-level mismatch errors. Return 200 with per-operation results for mixed batches. Return 409 for request-level mismatch and mid-group cursors, 413 for bounds, and 401/403/429 as specified.
**Acceptance**: Anonymous requests get 401. A cookie request from an unrelated origin gets 403. Handshake accepts `clientCursor` and `clientCursorHash`, returns instance id, owner fingerprint, protocol range, data epoch, cursor, `cursorHash`, `headHash`, and data presence, detects a rollback or replaced journal, and rejects a mid-group cursor with `CURSOR_NOT_ON_COMMIT_BOUNDARY`. Push applies in order. Pull returns complete commit groups with `commitId`/`commitIndex`/`commitSize`, may exceed `limit` for a large first group up to 10,000 events, never splits a commit across pages, rejects a commit over 10,000 entity events with `COMMIT_TOO_LARGE` before writing, and returns `nextCursor` on a commit boundary; the client advances its stored cursor and last chain hash only after one committed local apply of a complete page.

#### SYNC-08 - Tombstones, reset, and data epoch

**Files**: `server/src/infrastructure/sync/DataEpoch.ts`, `server/src/application/use-cases/maintenance/ResetFinancialDataUseCase.ts`, `server/src/infrastructure/repositories/PocketbaseDatabaseMaintenanceRepository.ts`, `server/src/application/use-cases/cards/DeleteInvoiceUseCase.ts`
**Work**: Emit delete events for transaction and invoice deletions, and for administrative reset deletions. A recurrence `delete` operation is the existing status-`ended` update, not a physical delete. Increment `dataEpoch` in its own commit before the first reset delete batch, then delete in bounded mutation batches where each batch is one complete commit group with tombstones. Ensure child deletes produce their own tombstones in the same group. Reject create operations that reuse a deleted entity id.
**Acceptance**: Deleting a transaction removes it from a fresh pull and emits dependent upserts for account, invoice, and recurrence. A reset increments the epoch, emits deletes for every cleared row, and preserves owner, sessions, and operation history. A station with the old epoch gets `DATA_EPOCH_CHANGED`.

#### SYNC-09 - Station recorder for desktop local BFF

**Files**: `server/src/infrastructure/sync/StationRecorder.ts`, `server/src/infrastructure/sync/StationMode.ts`, `server/src/infrastructure/sync/UseCaseOperationMap.ts`, `server/src/application/use-cases/recurrences/ProcessMonthlyRecurrencesUseCase.ts`, `server/src/infrastructure/scheduler/index.ts`, `server/src/infrastructure/di/container.ts`, `server/src/index.ts`
**Work**: Add an optional `createServer(pb, null, { station })` mode for desktop local. In station mode, the unit of work records a local operation from one mutation descriptor (`type`, `entityId`, `payload`, `baseRevisions`, `effectiveAt`) with a generated `opId`, client entity ids, the complete-envelope hash, and local result through an injected station operation sink. Map use-case tokens and arguments to descriptors in `UseCaseOperationMap`; extend the recurrence job result with generated transaction records and changed recurrences so the scheduler can supply their descriptors. For each generated transaction the descriptor payload extends `TransactionDTO` with the canonical `recurrence_id` and sets `is_recurring: true`; it carries no `invoice_id`, and the server routes a card invoice from `purchase_date`. Internal invoice, balance, and reconciliation writes are effects, not separate operations. The sink contributes the `obol_station_outbox` and local revision records to the same local PocketBase batch as the finance writes; that batch depends on the verified batch capability. Run the recorder in standalone mode too, with `mode = standalone`, so a later pairing can replay the operation log; do not start a sync loop. Keep the local response synchronous. Do not mount remote sync routes in the local BFF. Disable the local `obol_sync_*` journal and boot backfill when the local BFF is not a central authority. Disable automatic scheduler jobs when joined.
**Acceptance**: A local desktop mutation creates exactly one queued operation and a local optimistic row in both standalone and joined modes. Scheduler-generated transactions and recurrence status changes create one operation each; each scheduler-generated `transaction.create` carries the canonical `recurrence_id` and `is_recurring: true` and no `invoice_id`; internal invoice and balance effects create none. The local UI receives the same response shape as today. A joined station does not run recurrence or reconciliation jobs and does not write the local remote journal or boot backfill. Standalone mode keeps the jobs, records the outbox, and starts no sync loop.

#### SYNC-10 - Limits, security, and observability

**Files**: `server/src/infrastructure/sync/SyncLimits.ts`, `server/src/infrastructure/controllers/SyncController.ts`, `server/src/infrastructure/sync/SyncLog.ts`
**Work**: Enforce 100 ops, 1 MiB request, 64 KiB per op, `limit` 1..500 as a pull target event count, the 10,000-event commit bound, and the 32 MiB serialized-events page cap, plus station registration limits. Add a per-station push/pull rate limit (60 requests per minute) with `429` and `Retry-After`. Add structured logs with op id, station id, result, and revision, with no token or payload body. Add basic counters for accepted, duplicate, conflict, rejected, and blocked.
**Acceptance**: Oversized requests get 413 before any write. A pull never splits a commit and never returns a partial group, even when the group exceeds `limit`; a group over 10,000 events is rejected as `COMMIT_TOO_LARGE` before writing. Logs contain no Authorization header, token, password, or full payload. A conflict is observable by op id and station id without reading the database.

#### SYNC-11 - Server verification suite

**Files**: `server/src/**/*.test.ts`, `server/test/` fixtures
**Work**: Cover atomic batch failure and batch-capability boot verification, backfill idempotency and chain continuity, idempotent push, complete-envelope hash reuse, operation-target reuse (same opId with changed `effectiveAt`/`baseRevisions`/`dependsOn`, and a rebased intent with a new opId applying to the same target), page-boundary atomicity (a commit group never split, a mid-group cursor rejected, a partial group rejected before apply, a first group larger than `limit` returned whole), offline economic time (an `effectiveAt` realization or payment replayed at reconnect keeps its financial date), scheduler `transaction.create` schema and replay fidelity (the canonical `recurrence_id` survives validation and replay, and a duplicate month is rejected), stale revision conflict, missing base revision, dependency blocking, deletes, reset epoch, rollback detection by cursor and by chain hash, settled snapshot import, protocol mismatch, endpoint mismatch, and auth rejection. The settled-import tests name: import into an empty and a populated server; all seven collections with client-minted 15-character ids and rewritten references; the server never mints or rewrites an id; exact `importId`/hash/station/instance/epoch replay after a lost response, restart, and reauthentication; `IMPORT_ID_REUSED`; collision rejection with zero finance rows, revisions, events, and receipt; paid and partial cash preservation with no silent conversion and no equal-payment dedupe; receipt cleared by reset; checkpoint atomicity; post-checkpoint local operations surviving acceptance and push; and no pull-cursor advance from the import response. Use an isolated PocketBase database; never the hosted `db/pb_data`.
**Acceptance**: The suite runs against PocketBase 0.40.6 and passes. Every D016 implementation gate has a named test or live probe. The three required test families are named: operation-target reuse, page-boundary atomicity, and offline economic time. No test uses real user data.

#### SYNC-12 - Legacy empty-server seed

**Files**: `server/src/application/use-cases/sync/SeedSyncSnapshotUseCase.ts`, `server/src/application/use-cases/sync/SeedSnapshotValidator.ts`, `server/src/infrastructure/controllers/SyncController.ts`, `server/src/infrastructure/validators/syncSchemas.ts`
**Work**: Implement `POST /api/sync/seed` for a 0.3.0 desktop database with no operation log. Require a handshake and a registered station. Refuse unless the server has no financial rows and no journal events beyond the backfill marker. Validate collection names, required fields, relation ids, duplicate ids, the 10 MiB/10,000-row bound, and the source counts. Write every row, revision 1, one commit group of `commitSize` equal to the row count, `lastSeq`, `headHash`, and the backfill marker in one atomic batch. Do not recompute balances or invoice totals.
**Acceptance**: A legacy snapshot seeds an empty server exactly in one complete commit group and a pull from 0 returns the seeded rows once. A second seed or a seed against a non-empty server returns `SERVER_NOT_EMPTY` and writes nothing. An invalid relation or duplicate id aborts the whole seed. A snapshot over 10,000 rows is refused before writing. The owner and sessions are untouched. A failed seed leaves no partial rows or events.

#### SYNC-13 - Settled snapshot import

**Files**: `server/src/application/use-cases/sync/SyncImportUseCase.ts`, `server/src/infrastructure/validators/SyncSnapshotValidators.ts`, `server/src/infrastructure/repositories/PocketbaseSnapshotImportRepository.ts`, `server/src/infrastructure/controllers/SyncController.ts`, `server/src/infrastructure/validators/SyncWireValidators.ts`
**Work**: Implement `POST /api/sync/import` for a never-paired standalone profile with local finance and a recorded operation log, into a server that is empty or populated. Mount it after D009 auth beside `createSyncController(runtime)`. The client mints every fresh 15-character id and rewrites every reference before it freezes the six-field hash; the server must never mint or rewrite an imported id. Require a registered station and matching identity, epoch, and hash before mutation; the six-field hash covers `protocolVersion`, `stationId`, `serverInstanceId`, `dataEpoch`, `importId`, `snapshot` (canonical UTF-8/SHA-256); bounds are 10 MiB for the complete request and 10,000 financial rows. A queue count is never treated as proof of a complete historical log. Validate the complete seven-collection financial schema, every reference, and every 15-character id against the frozen snapshot, and recompute the hash before any write; the path never replays the queued operations or a partial operation log. Under one exclusive lease and gate, reject ANY collision with an existing finance id as `IMPORT_ENTITY_ID_TAKEN` for the whole request, and reject different frozen content under the same `importId` as `IMPORT_ID_REUSED`. Never partial-merge, overwrite, recompute balances or invoice totals, convert realized to silent, invent openers, or dedupe equal payments. Commit all finance inserts, revision-1 rows, the complete continuous journal commit, and the `obol_sync_snapshot_imports` receipt (`importId`, `stationId`, `payloadHash`, `serverInstanceId`, `dataEpoch`, `result`, `createdAt`) as ONE PocketBase batch, and clear the receipts on an epoch reset. Return the stored original result unchanged for a retried identical request (same import id, hash, station, instance, and epoch). Do not advance a client's pull cursor from the import response; the next real pull converges imported and remote rows from the stored commit boundary.
**Acceptance**: A full seven-collection import into an empty or a populated server returns the exact source counts; an empty-server import is not refused as `SERVER_NOT_EMPTY` (that refusal is `/seed` behavior) and every imported row carries a client-minted all-new 15-character id with rewritten `invoice_id`, `source_invoice_id`, and `recurrence_id`; the server minted none. Post-import verification shows the returned `serverInstanceId`, `dataEpoch`, cursor, and singular `SyncEntityType` count keys, with paid and partial invoices preserved and no silent conversion. Same `importId`, hash, station, instance, and epoch replayed (including after a restarted client, reauthentication, and a mid-batch lost response) returns the stored result with zero additional effect. Different frozen content under the same `importId` is `IMPORT_ID_REUSED`. An existing-ID collision rejects the whole request with the server unchanged and no partial rows, versions, events, or receipt. A reset clears receipts; a post-reset import re-imports fresh. Local operations created after the checkpoint survive acceptance and restart, only covered old operations retire, covered dependencies are stripped only from never-sent later operations, only causal own base versions advance, and the pull cursor remains at the stored boundary until a real pull. A schema/SDK 400 mid-batch rolls back everything.

### iOS native

#### IOS-01 - Native SwiftUI target cutover

**Files**: `app/ios/App/App/ObolApp.swift`, `app/ios/App/App/App/RootView.swift`, `app/ios/App/App/App/AppState.swift`, `app/ios/App/App/Info.plist`, `app/ios/App/App/Assets.xcassets/`, `app/ios/App/App/AppDelegate.swift`, `app/ios/App/App/SceneDelegate.swift`, `app/ios/App/App/Base.lproj/Main.storyboard`, `app/ios/App/App/public/`, `app/ios/App/CapApp-SPM/`, `app/ios/App/App.xcodeproj/project.pbxproj`, `app/capacitor.config.ts`, `app/package.json`, `app/package-lock.json`, `app/scripts/ios-testflight.sh`
**Work**: Replace the Capacitor web shell with a SwiftUI app entry point inside the existing shell target `app/ios/App/App`. Link the existing `app/ios/ObolCore` package into the target as a package dependency instead of copying its models or engine into `App/Core`. Remove the WKWebView, Capacitor SPM package, storyboard main entry, and copied web assets from the iOS target. Keep bundle id `copland.obol.mobile` and the existing signing team/style. Set the deployment target to iOS 16.0 for both the app and `ObolCore`'s effective use. This intentionally drops iOS 15 support; the native app requires iOS 16 or later. Remove Capacitor-only npm dependencies and scripts that no longer apply. Preserve `DEVELOPMENT_TEAM = MCC2B4P5MZ` and `CODE_SIGN_STYLE = Automatic`.
**Acceptance**: The simulator launches a native SwiftUI root view with no WKWebView and no Capacitor framework. The target links `ObolCore` and no finance model or engine file exists twice. The bundle contains no `public/index.html`. Existing signing settings are unchanged. The app launches in airplane mode to an empty local state.

#### IOS-02 - Core models, ids, money, dates

**Files**: `app/ios/ObolCore/Package.swift`, `app/ios/ObolCore/Sources/ObolCore/Models.swift`, `FinanceEngine.swift`, `ForecastEngine.swift`, `LocalStore.swift`
**Work**: Complete the existing Foundation-only `ObolCore` package. `Models.swift` already mirrors the canon §3 entities; verify the fields and add only what is missing. Keep the 15-character lowercase alphanumeric id generation from UUIDv7 time and randomness, `roundCurrency`, `sum`, `sub`, and `mul` with canon §13.5 rounding: two decimals and an exact half toward positive infinity (`1.005 → 1.01`, `-1.005 → -1.00`, `10.075 → 10.08`). Keep UTC day keys and PocketBase date encode/decode in `Models.swift` rather than adding parallel model files. Do not create a second model set under `app/ios/App/App/Core`.
**Acceptance**: Field names match canon §3. Id generation produces unique 15-character ids at scale and rejects invalid input. Money fixtures match the TypeScript helpers for positive, negative, and all three half-cent boundaries. Date fixtures match UTC month rollover and PocketBase RFC3339 input.

#### IOS-03 - Durable SQLite store

**Files**: `app/ios/App/App/Core/Store/ObolDatabase.swift`, `SQLiteSchema.swift`, `StoreError.swift`, `SyncTypes.swift`, `OperationBuilder.swift`
**Work**: Create the single transactional SQLite store in Application Support with WAL, foreign keys, and `NSFileProtectionCompleteUntilFirstUserAuthentication`. Tables: base entities with `serverRevision`, `localRevision`, and `deleted`, `sync_outbox`, `sync_conflicts`, `sync_state`, `sync_applied_ops`. One writer connection. Finance rows and the outbox commit in one transaction. Exclude the store from iCloud backup so a restore does not clone the station id, cursor, or outbox. Schema versioning and migration from an empty store. Export and import a local JSON snapshot for the pairing wizard. The existing `app/ios/ObolCore/Sources/ObolCore/LocalStore.swift` atomic-JSON backend is the interim store; this ticket replaces it, wires the app to the SQLite store, and removes the obsolete JSON backend at cutover.
**Acceptance**: Data survives relaunch and process kill. A failed write rolls back finance rows and outbox together. Migration from schema 1 to the current schema is idempotent. Export produces a readable JSON file with counts and no token. The store opens offline without a network call. No second store or duplicated persistence path remains.

#### IOS-04 - Swift finance engine

**Files**: `app/ios/ObolCore/Sources/ObolCore/FinanceEngine.swift`, `ForecastEngine.swift`, `Models.swift`, `app/ios/App/AppTests/`
**Work**: Complete the existing Foundation-only engine in `ObolCore` for canon §§4-8 and the §13 clarifications: pending/realized lifecycle, silent realize, transfer atomicity, card purchase invoice routing, invoice payment and partial payment, invoice deletion, recurrence launch, monthly idempotency, clamping, `skipped_periods`, forecast rollback and forward projection, budgets, project payments. The forecast is end-of-day cash with realized-only past days; overdue pending rows and unpaid invoices apply on today without redating; unassigned pending and simulated rows enter aggregate cash; investment-account rows stay out; a liquid-to-investment transfer changes only the liquid side. Project `paid` counts realized, non-simulated income only. Budgets keep the planned basis, including pending and simulated rows. `cardInvoiceSummaries` implements the projected timeline, including the virtual `PROJECTED` row, with a projection status separate from persisted `OPEN`/`CLOSED`/`PAID`. Use only core models and pure functions. No networking. No UI. Do not create an `App/Core/Finance` copy.
**Acceptance**: A shared fixture set in `shared/finance-parity/` produces identical results to the server use cases for every scenario, including `fcst-unassigned-pending`, `fcst-overdue-invoice-past`, and `fcst-transfer-to-investment`. The engine can run the full offline workflow on an empty store. Unpaired local mode runs recurrence processing on launch and foreground; a paired store disables automatic local generation. No currency math bypasses `Money`. Projection and paid totals are engine output; no adapter or view fills in a missing result.

#### IOS-05 - Local profile, session, and Keychain

**Files**: `app/ios/App/App/Core/Security/KeychainStore.swift`, `LocalProfile.swift`, `SessionStore.swift`, `TLSGuard.swift`
**Work**: Store the Bearer token and station id in the Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. Store server URL, instance id, owner fingerprint, cursor, epoch, and protocol version in the local store, not in the token. Refuse cleartext server URLs unless the development flag is on. Do not log tokens or credentials. Never delete local finance on logout or 401.
**Acceptance**: Token survives relaunch, is absent from the local database and logs, and is deleted on explicit sign-out. A 401 puts sync in `AUTH_REQUIRED` and preserves the store and outbox. A cleartext endpoint shows an explicit insecure warning and is refused by default.

#### IOS-06 - BFF auth client

**Files**: `app/ios/App/App/Core/API/BFFClient.swift`, `AuthAPI.swift`, `SyncAPI.swift`, `APIError.swift`, `RetryPolicy.swift`
**Work**: Implement setup status, login, session renew, session list, logout, request-password-reset, handshake, push, and pull with URLSession. The password-reset link opens the server's hosted web reset page; the native app handles the request, not the token. Use Bearer only. Decode uniform `{code, message}` errors. Implement 401, 403, 409, 413, 429, and 5xx handling. Add request ids for logs. No business GET endpoints.
**Acceptance**: Login stores a token and returns server name. Renew updates the token. A 401 maps to `AUTH_REQUIRED`. A 409 maps to a typed sync state, not a generic alert. Retries use bounded exponential backoff with jitter.

#### IOS-07 - Outbox, pull, and conflict engine

**Files**: `app/ios/App/App/Core/Sync/SyncEngine.swift`, `Outbox.swift`, `CursorStore.swift`, `ConflictStore.swift`, `SyncState.swift`, `app/ios/App/App/Core/Store/OperationBuilder.swift`
**Work**: Implement the D016 local write, push, pull, duplicate, conflict, blocked dependency, cursor, chain hash, and relaunch rules. Build the complete immutable envelope including `effectiveAt` captured at the user's action, compute `payloadHash` over the whole envelope with canonical JSON, and freeze it before the first send; a rebase or correction creates a new `opId`. Record the outbox even when unpaired, with `mode = local`, so a later pairing can replay it. Mark `in_flight` as `queued` at launch. Apply push results and complete pull pages in SQLite transactions. Validate every page's contiguous `seq`, complete commit groups, `commitIndex`/`commitSize` continuity, and hash continuity before applying; reject a mid-group cursor. Remap server-created ids and references, including dependent pending operations, as new operations. Detect `SERVER_ROLLBACK_DETECTED`, `DATA_EPOCH_CHANGED`, `ENDPOINT_MISMATCH`, and `PROTOCOL_UNSUPPORTED`. Do not overwrite a pending optimistic entity with a newer server event; record a preemptive conflict.
**Acceptance**: Offline writes queue and survive relaunch. An offline realization or payment keeps its `effectiveAt` date after reconnect and never adopts the reconnect date. Multiple offline edits to one entity serialize: only the first is pushed, later edits wait for its result, and no false stale-revision conflict appears. Every sync cycle starts with handshake, then pull, push, and pull again. Reconnect pushes in dependency order. Killing the app after server commit causes a duplicate on retry and no double effect. A stale revision produces a conflict record with both versions. A rejected operation blocks dependents. A rolled-back server stops sync with the outbox intact. A token renewed before expiry continues sync; an expired token stops at `AUTH_REQUIRED` without deleting the outbox. A cached page ending mid-commit is rejected and applies nothing.

#### IOS-08 - Pairing, import, and endpoint switch

**Files**: `app/ios/App/App/Features/Onboarding/PairingFlow.swift`, `ServerConnectView.swift`, `LoginView.swift`, `ImportLocalDataView.swift`, `EndpointSwitchView.swift`, `LocalOnlyView.swift`
**Work**: Implement the D016 pairing matrix, typed confirmation for destructive choices, local JSON export before discard, server URL validation, login, handshake, baseline pull, and endpoint switch. Import is the D7 settled snapshot import for a never-paired profile with local finance and a recorded operation log, whether the server is empty or populated: mint and rewrite every finance id/reference client-side, then before any network call persist a coherent checkpoint in Core/Sync (remapped fresh-id snapshot, immutable `importId`, six-field hash, complete request body, covered original `opId`s, identity tuple) in the SQLite state, pause ordinary push while it exists, and never mint a new import id on timeout or restart. After an accepted result, adopt revision-1 baselines and server versions for imported records, retire ONLY the covered old operations, strip covered dependencies only from never-sent later operations, advance only those operations' causal own base versions, and clear the checkpoint; local operations created after the checkpoint stay durable and push as fresh operations. Never edit a frozen envelope, never advance the pull cursor from the import response itself, and never auto-rebase an unrelated server change. Show server data presence, operation counts, and entity counts. Never auto-merge, never overwrite an existing server id, never dedupe equal payments, and never send old tokens or outbox ops to the new origin in a preview.
**Acceptance**: All allowed local/server states are reachable and produce only the allowed actions. Preexisting server data is never overwritten and the server mints no imported id. Import freezes the `importId` before the request; a lost response or restart resumes the same import and the server returns one exact result with no duplicated data. An expired session preserves the marker and intent; the same import resumes after relogin. An import collision leaves local finances intact and the server unchanged. Local operations created after the checkpoint survive acceptance and restart, retire only their covered predecessors, and the cursor stays at the stored boundary until a real pull converges. Endpoint mismatch blocks push, preserves the outbox, and offers only seed-if-empty or use-new-server-data; no partial outbox replay. A local-only user can use the app without ever pairing.

#### IOS-09 - Dashboard

**Files**: `app/ios/App/App/Features/Dashboard/DashboardView.swift`, `BalanceCards.swift`, `ForecastChart.swift`, `ForecastCalendar.swift`, `DayDetailView.swift`, `TransactionList.swift`, `QuickEntryView.swift`, `DashboardModel.swift`
**Work**: Native equivalents of `app/pages/index.vue`: current and projected balance with horizon label, range selector, simulation toggle, Swift Charts trajectory, month calendar with projected balances and muted out-of-range days, day details, realized/pending/simulated tabs, realize menu with both variants, edit, invoice routing, quick entry, and module shortcuts. Use local engine output.
**Acceptance**: Every dashboard guardrail in E003 holds with local data. Chart and calendar agree day by day. The calendar marks today and never shows an invented balance. Quick entry is reachable in one interaction. Realize is at most two interactions. Invoice rows route to the cards surface.

#### IOS-10 - Ledger

**Files**: `app/ios/App/App/Features/Ledger/LedgerView.swift`, `LedgerFilters.swift`, `LedgerRow.swift`, `LedgerExport.swift`, `LedgerModel.swift`
**Work**: Paginated table/list with title search, status, type, simulation, scheduled, date range, account, card, category, project, sort, filtered totals, lifecycle badges, CSV export, edit, realize, and delete. Mirror canon §9 ledger summary.
**Acceptance**: Filters produce the same counts and totals as the server list/summary fixtures. Transfers count in rows but not money totals. Export writes a shareable CSV. A transfer row is neutral. A deleted row disappears after the local delete and after pull.

#### IOS-11 - Cards and invoices

**Files**: `app/ios/App/App/Features/Cards/CardsView.swift`, `InvoiceTimeline.swift`, `PayInvoiceView.swift`, `InvoiceDetailView.swift`, `CardsModel.swift`
**Work**: Invoice timeline per card, real debt, gross spent, projected invoice, payment with account, partial payment, silent payoff, and invoice deletion. Route card purchases through the local invoice engine. The projected timeline, including the virtual `PROJECTED` row and its separate projection status, comes from `ObolCore.cardInvoiceSummaries`; the view renders it and computes no projection.
**Acceptance**: Invoice totals and status match the server fixtures. A partial payment updates `paid_amount` and keeps the invoice open. A full payment realizes children and flips `PAID`. Silent payoff does not debit an account. Deletion removes children and appends `skipped_periods`. No projected row or amount is synthesized in the view model.

#### IOS-12 - Management and projects

**Files**: `app/ios/App/App/Features/Management/ManagementView.swift`, `AccountsView.swift`, `CreateAccountView.swift`, `CreateCardView.swift`, `RecurrencesView.swift`, `RecurrenceEditor.swift`, `BudgetsView.swift`, `ProjectsView.swift`, `ProjectEditor.swift`
**Work**: Accounts and cards, recurrence create/edit/pause/resume/launch/delete, budgets, projects, project payments, and project completion. Use the local engine and outbox. The budget view states the planned basis (pending and simulated rows are included) from the product result; it does not introduce a new budget query or mode switch. Project paid totals render the product's realized, non-simulated income figure.
**Acceptance**: Every mutation is one operation. Recurrence launch respects idempotency and returns a conflict if the month exists. Budgets use accrual `purchase_date` first, include pending and simulated rows, and label the planned basis. Project payment does not mutate `total_value`, and `paid` excludes pending and simulated income. Completion closes the project.

#### IOS-13 - Admin, settings, and sync status

**Files**: `app/ios/App/App/Features/Settings/SettingsView.swift`, `SyncStatusView.swift`, `ConflictListView.swift`, `ConflictDetailView.swift`, `AdminView.swift`
**Work**: Local-only mode, server connection, account label, logout, station id display, last sync, pending count, conflict list, explicit conflict resolution, local export, and online-only admin actions. Admin reset and job triggers require a live session and never run from the outbox.
**Acceptance**: The conflict list shows base revision, current revision, and both records. Resolution choices are explicit. Logout preserves local data. Offline admin actions are disabled with a reason. A reset requires online confirmation and then applies the new data epoch.

#### IOS-14 - Native UX polish

**Files**: `app/ios/App/App/App/Theme.swift`, `Navigation.swift`, `Components/`, `Features/**` layout files, `app/ios/App/App/Assets.xcassets/`
**Work**: Apply the native design system: typography, spacing, currency and date formatting, color semantics, dark mode, Dynamic Type, VoiceOver, 44pt targets, haptics, pull-to-refresh, skeletons, empty states, error states with retry, offline banner, sync badge, and iPad layout. All new UI copy, accessibility labels, comments, and docs are written in English; the epic does not prescribe pt-BR for new native surfaces. Existing web copy is out of scope.
**Acceptance**: Usable at 320pt and 393pt widths and on iPad. No horizontal overflow. Amounts never truncate. Dynamic Type up to accessibility sizes does not clip critical values. VoiceOver reads labels for balances, tabs, calendar days, and conflicts. Chart data has a textual summary. No state is conveyed by color alone.

#### IOS-15 - TestFlight and signing prerequisites

**Files**: `app/scripts/ios-testflight.sh`, `.github/workflows/ios-testflight.yml`, `docs/ios-testflight.md`, `app/ios/App/App.xcodeproj/project.pbxproj`
**Work**: Update the archive/export/upload path for the native project. Keep bundle id `copland.obol.mobile`. Require `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8_BASE64`, `IOS_DISTRIBUTION_CERT_P12_BASE64`, and `IOS_DISTRIBUTION_CERT_PASSWORD`. Document the App Store Connect app record, bundle id, team, distribution certificate, provisioning, and monotonic build number prerequisites. Set `MARKETING_VERSION` to 0.4.0. Do not commit signing material or provisioning profiles.
**Acceptance**: A local archive and export produces an IPA with the native SwiftUI app. The workflow installs credentials, archives, exports, and uploads when secrets exist. If the app record, team, certificate, or a secret is missing, the workflow fails with a named missing prerequisite and no IPA is claimed. Simulator launch is verified separately.

### Desktop station

#### DESK-01 - Station config and credentials

**Files**: `desktop/electrobun/bun/sync/config.ts`, `desktop/electrobun/bun/sync/credentials.ts`, `desktop/electrobun/shared-rpc.ts`
**Work**: Store the station binding (`serverUrl`, `serverInstanceId`, `ownerFingerprint`, station id, data epoch, cursor, chain hash, mode) in `obol_station_state` inside local PocketBase. Do not add a separate sync config file. Receive the Bearer token from the WebView over RPC and keep it in Bun memory only. The view renews the session before expiry and supplies the new token over RPC. Add RPC methods for configure, status, push, resolve conflict, and disconnect.
**Acceptance**: Station state survives restart. The token is absent from local PocketBase, logs, and crash output. Disconnect preserves local data and outbox. The view can re-supply a token after restart. A renewed token continues sync without re-pairing. Endpoint mismatch is visible in status.

#### DESK-02 - Local station mode

**Files**: `desktop/electrobun/bun/index.ts`, `desktop/electrobun/bun/sync/station.ts`
**Work**: Start the local BFF with the station options delivered by `SYNC-09` after local unlock. Provide the station operation sink backed by local PocketBase: the outbox operation, local revision rows, and finance rows commit in one batch in the same PocketBase database. A second desktop SQLite database is not introduced. Record local operations through the server station recorder. Disable automatic recurrence and reconciliation jobs in joined mode. Keep standalone mode otherwise unchanged apart from the canon §13 corrections. Start the sync loop only after the local UI is usable.
**Acceptance**: Standalone local mode keeps the 0.3.0 workflows; where canon §13 corrects a finance result, the corrected result is expected. Local sync metadata may exist but no server connection is attempted. Joined mode records one operation per local mutation in local PocketBase, atomically with its finance writes. Joined mode does not run the daily jobs. The local UI responds before any network call. No second database or config file exists.

#### DESK-03 - Outbox replicator

**Files**: `desktop/electrobun/bun/sync/OutboxStore.ts`, `RevisionStore.ts`, `SyncLoop.ts`, `PushBatch.ts`, `PullApply.ts`, `Backoff.ts`
**Work**: Implement D016 push/pull in Bun. Keep `obol_station_outbox`, `obol_station_conflicts`, `obol_station_state`, and `obol_station_versions` in local PocketBase. Push queued operations with their frozen envelope and complete-envelope hash, in dependency order, apply results, pull complete commit groups, update the cursor only at a commit boundary, detect epoch/instance/rollback/protocol/page errors, and retry with jitter. Recover `in_flight` on launch. Store pre-operation entity snapshots with each queued operation so a rejection can restore the last accepted local state. Apply a pull page's finance rows, station versions, cursor, and chain hash in one local PocketBase batch only after validating contiguous `seq`, complete groups, and hash continuity. Store every pulled newer remote base in `obol_station_versions.baseRecord` with its `serverDeleted` tombstone, keeping `deleted` optimistic-local and `serverRevision`/`localRevision` separate; a newer remote base never overwrites an unaccepted local optimistic row. On an accepted result, write only the minimal `obol_station_outbox.acknowledgement` causal receipt, keep the row until no dependent still needs its causal versions, then remove row and receipt together. Remap server-created ids in dependent pending operations as new operations. Apply conflict payloads and block dependents.
**Acceptance**: Offline local writes queue, preserve `effectiveAt`, and survive relaunch. A relaunch after a pulled newer remote base reconstructs base plus pending exactly: the pending optimistic row survives, `baseRecord`/`serverDeleted` carry the remote base, and no remote base is applied over the local row. An accepted operation keeps its row with only the minimal `acknowledgement` receipt while a dependent needs its causal versions, and no operation row or entity record is copied into the receipt. Multiple offline edits to one entity serialize without a false stale-revision conflict. Every sync cycle starts with handshake, then pull, push, and pull again. Reconnect syncs without duplicates and a replayed payment keeps its business date. A kill after server commit returns duplicate on retry. A conflict is persisted and shown. A rollback or mid-group cursor stops sync with the outbox intact. A page with a partial commit group applies nothing. Backoff never busy-loops.

#### DESK-04 - Desktop sync UI

**Files**: `app/components/SyncStatusBanner.vue`, `app/components/SyncConflictModal.vue`, `app/components/SyncQueuePanel.vue`, `app/composables/useSync.ts`, `app/layouts/default.vue`
**Work**: Show local/standalone, paired/online, paired/offline, syncing, pending count, last sync, conflict count, and error states. Provide explicit conflict resolution: use server, retry with current revision, export and discard. Never auto-resolve.
**Acceptance**: The banner is visible without blocking the dashboard. A conflict opens both versions and requires a choice. The queue panel lists pending and blocked operations with reason. Resolving one conflict does not silently resolve another.

#### DESK-05 - Desktop pairing and endpoint switch

**Files**: `app/pages/sync.vue`, `app/components/SyncPairingModal.vue`, `app/components/SyncImportPreview.vue`, `app/composables/useSync.ts`
**Work**: Implement the D016 pairing matrix, server URL, login, handshake, data presence, operation and entity counts, typed confirmation, baseline pull, endpoint switch, and disconnect. Use the D7 settled snapshot import for a never-paired profile with local finance and a recorded operation log, whether the server is empty or populated: mint and rewrite every finance id/reference client-side, persist the coherent checkpoint (remapped fresh-id snapshot, immutable `importId`, six-field hash, complete request body, covered original `opId`s, identity tuple) as `pendingImport` on `obol_station_state` before any network call, pause ordinary push while it exists, and never mint a new import id on timeout or restart. After an accepted result, adopt revision-1 baselines, retire ONLY the covered old operations, preserve post-checkpoint local operations, strip covered dependencies only from never-sent later operations, advance only those operations' causal own base versions, and clear the marker. Never edit a frozen envelope, never advance the pull cursor from the import response itself, and never auto-rebase an unrelated server change. For a 0.3.0 database with no operation log, offer `Seed empty server` only when the server is empty; refuse to merge into a non-empty server. Preserve the local profile and the remote-mode configuration separately.
**Acceptance**: All allowed data states are reachable. A legacy database within the 10 MiB/10,000-row bound can seed an empty server exactly; an oversized database stays standalone with an export path; a non-empty server offers the settled snapshot import only when the profile has a recorded operation log, otherwise use-server-data or stay-standalone, and never `/seed`. Import freezes the `importId` first; a lost response or restart resumes the same import and replays server data exactly once, a collision leaves both sides unchanged, and the server mints no imported id. Local operations created after the checkpoint survive acceptance and restart, retire only their covered predecessors, and the cursor stays at the stored boundary until a real pull converges. Endpoint mismatch blocks push, preserves the outbox, and offers only seed-if-empty or use-new-server-data; no partial outbox replay. Disconnect keeps local data and stops sync.

#### DESK-06 - Packaging and updater

**Files**: `desktop/scripts/eb-build.ts`, `desktop/scripts/eb-verify.ts`, `desktop/scripts/eb-publish.ts`, `desktop/electrobun/bun/index.ts`, `desktop/app.json`
**Work**: Bundle migration 0018-0021 and any later sync migrations. Verify the packaged app contains `pb_migrations`, the sync migrations, and the local database schema, including the local `obol_station_*` tables. Ensure update restart stops sync cleanly, does not lose the outbox, and reopens the local store. Set version 0.4.0. Keep the existing macOS cask and Windows setup ZIP contracts.
**Acceptance**: `eb:verify` confirms the sync migration and sync resources in the package. A packaged macOS app launches, uses local data offline, syncs after pairing, and survives an updater restart without losing outbox rows. Windows setup includes the same resources.

#### DESK-07 - Windows station smoke preparation

**Files**: `desktop/context.md`, `desktop/scripts/windows-runtime-smoke.ts`, `desktop/scripts/windows-runtime-smoke/windows-probe.ps1`, `.github/workflows/release.yml`, `.github/workflows/release-candidate.yml`, `desktop/scripts/ensure-pocketbase.ts` (only if a path change is required)
**Work**: Document the Windows station flow and ensure the native Windows x64 build includes migration 0018, the sync config path, and the local PocketBase child. Do not change the unsigned installer contract.
**Acceptance**: A Windows x64 build is produced from a native runner. The runtime smoke in `REL-05` has a named procedure and isolated profile path. No hosted `db/pb_data` is touched.

### Release and verification

#### PAR-01 - Finance parity fixtures

**Files**: `shared/finance-parity/transactions.json`, `invoices.json`, `recurrences.json`, `forecast.json`, `budgets.json`, `projects.json`, `README.md`
**Work**: Define input/output fixtures for canon §§4-8 and §13. Include silent realize, transfer, partial invoice payment, full payment, invoice deletion, recurrence launch, month idempotency, payday clamping, skipped periods, forecast rollback, simulation toggle, unassigned pending forecast, overdue unpaid invoice in the past, liquid-to-investment transfer, budget accrual, and project payment. The TypeScript and Swift suites consume the same files. Adapters map, normalize, inject the case clock, and inject declared persistence faults only; product code owns every business result. Raw subcent inputs reach product code unrounded, and output is compared as decimal.
**Acceptance**: Both suites pass every case in every file; no capability-based skip counts as a pass. A fixture change requires a matching change in both suites in the same wave. A case whose expected result would require adapter-added projection, filtering, recomputation, or rounding fails the wave. No fixture contains real user data.

#### REL-01 - Production self-hosting 0.4.0

**Files**: `docker-compose.self-hosted.yml`, `.env.self-hosted.example`, `docs/self-hosting.md`, `db/pb_migrations/`
**Work**: Document and exercise a fresh 0.4.0 deployment and an upgrade from 0.3.0 with existing data. Apply migrations 0018-0021 and later at boot. Confirm boot configured and verified PocketBase batch capability through the authenticated settings API without disturbing operator SMTP/meta settings. Use a stop-start or recreate deployment, not a rolling strategy that runs two BFF processes at once, because the mutation gate is in-process. Verify the sync endpoints, backfill, legacy seed, settled snapshot import, session auth, CORS for native clients, TLS, backup, restore, and rollback detection. Document that native iOS does not send a browser Origin, so `capacitor://localhost` is no longer required for the native app; keep it only while a legacy build remains supported.
**Acceptance**: Fresh deploy creates owner and sync meta, pulls an empty baseline, and reports a verified enabled batch capability. Upgrade with data backfills and a client can pull from 0 without observing a partial commit group. A 0.3.0 desktop snapshot seeds an empty server exactly and is refused on a second attempt or a non-empty server. An offline volume backup restores with the same instance id, epoch, journal, and head hash. Restoring an older backup makes a newer station stop with rollback detection, including the case where the cursor still exists but its chain hash no longer matches. No PocketBase port is published.
**Current runtime caveat**: Do not claim a fresh deployment passes until the actual Compose run and probes are recorded. If Docker is unavailable, mark the item `BLOCKED (no Docker runtime)`.

#### REL-02 - Hosted and Coolify preservation

**Files**: `docker-compose.yml`, `docker-compose.coolify.yml`, `app/Dockerfile`, `app/Dockerfile.self-hosted`, `server/Dockerfile`
**Work**: Keep the existing hosted dev and Coolify topology. Verify the new sync collections do not change the web cookie flow. Ensure the Nuxt proxy still forwards `/api/**`. Keep the hosted web login and reset flow unchanged. Verify the Coolify deploy strategy does not overlap two BFF writers; use a stop-start/recreate strategy or record the overlap as a blocker. The Node 22 minimal production runner is authored at `app/Dockerfile.self-hosted` (digest-pinned, builder plus unprivileged Nitro runner) and is used by the self-hosted compose topology; its image build and runtime stay unproven until the parent build is recorded. The dev `app/Dockerfile` keeps `node:20-alpine`.
**Acceptance**: Hosted web login, dashboard read, and a financial write still work through the same-origin proxy. Coolify compose config remains valid and its deploy strategy is single-writer. No new required environment variable is added for hosted web-only deployments.

#### REL-03 - Desktop release artifacts and updater

**Files**: `.github/workflows/release.yml`, `.github/workflows/release-candidate.yml`, `desktop/app.json`, `Casks/`, `desktop/scripts/eb-publish.ts`
**Work**: Publish macOS arm64/x86_64 zips, Electrobun update JSON and full bundles, Windows x64 setup zip plus SHA-256, and the Homebrew cask from the macOS manifest. Keep RC and stable channels separate. Version 0.4.0.
**Acceptance**: Artifacts are named with 0.4.0 and match `desktop/app.json`. `update.json` points to the full bundle. The cask names 0.4.0 and the correct checksum. Windows publishes no manifest entry. RC builds do not move `latest` or the cask.

#### REL-04 - iOS simulator and TestFlight

**Files**: `app/ios/App/App.xcodeproj/project.pbxproj`, `app/scripts/ios-testflight.sh`, `.github/workflows/ios-testflight.yml`, `docs/ios-testflight.md`
**Work**: Build and launch the native app in the iOS simulator. Exercise offline launch, local data creation, pairing, pull, push, conflict, relaunch, and reconnect. Archive and export the native app for TestFlight when signing material exists.
**Acceptance**: The simulator launches the native app and completes the offline/relaunch/reconnect matrix. The archive contains no Capacitor web assets. With secrets, the IPA uploads. Without secrets, the missing secret is named and the item stays blocked.
**Current runtime caveat**: TestFlight upload depends on external Apple credentials. Do not claim it passes until the upload result is recorded.

#### REL-05 - Windows runtime smoke

**Files**: `.github/workflows/release.yml`, `.github/workflows/release-candidate.yml`, `desktop/scripts/windows-runtime-smoke.ts`, `desktop/scripts/windows-runtime-smoke/windows-probe.ps1`, `desktop/context.md`
**Work**: On a native Windows x64 host, install the 0.4.0 setup, launch the app, complete first-run local profile setup, create an account and a transaction, confirm local PocketBase persistence after restart, pair with a self-hosted server, queue an offline write, kill and relaunch the app, confirm the outbox persists, reconnect, confirm sync, and check the updater. Use an isolated profile.
**Acceptance**: Every step is observed and recorded with the Windows version and artifact checksum. No hosted data is touched. If no Windows host is available, mark `BLOCKED (no Windows x64 runtime)`; do not infer a pass from the build job.

#### REL-06 - Final 0.4.0 artifact verification

**Files**: `docs/releases/0.4.0.md` (new), `desktop/app.json`, `app/ios/App/App.xcodeproj/project.pbxproj`, release workflow outputs
**Work**: Verify version consistency across `desktop/app.json`, the iOS `MARKETING_VERSION`, the release tag, the manifest, the cask, and the iOS build. Verify artifact checksums, updater metadata, migration contents, no Capacitor assets, no committed secrets, and no dumps or build artifacts. Record every artifact and the runtime used.
**Acceptance**: Every artifact and version reference agrees on 0.4.0. The macOS, Windows, and iOS artifacts are accounted for. The final release notes list known limitations and blocked items. No completion box is checked without a recorded command or observation.

#### VRF-01 - All 21 E003 dashboard scenarios

Run the E003 checklist against the 0.4.0 hosted web and desktop. Run the native equivalents on iOS. The E003 checklist remains the web/desktop contract; native iOS equivalents are listed in `IOS-09` and `IOS-13`.

| ID | E003 scenario | 0.4.0 surfaces | Evidence |
|---|---|---|---|
| E3-01 | [ ] Balance card shows current non-investment "Saldo disponível" and horizon-labeled "Projeção" with positive/negative colors | Hosted web, desktop, iOS | Screenshot plus forecast API or local engine values |
| E3-02 | [ ] Simulation toggle changes chart and simulated tab together, reverts cleanly, and does not change realized/pending lists | Hosted web, desktop, iOS | Toggle sequence, counts before/after |
| E3-03 | [ ] Each realize variant produces a distinct toast; silent variant leaves balance untouched | Hosted web, desktop, iOS | Balance before/after for both variants |
| E3-04 | [ ] A scheduled row shows "Agendado" and offers no realize menu | Hosted web, desktop, iOS | Row screenshot and action menu |
| E3-05 | [ ] A transfer renders neutral and does not add to money totals | Hosted web, desktop, iOS | Ledger totals and row |
| E3-06 | [ ] Edit from a row opens the shared edit modal; cancel leaves balances and lists untouched; a real edit refreshes chart, calendar, lists | Hosted web, desktop, iOS | Before/after balances and modal cancel |
| E3-07 | [ ] An invoice row routes to the card module pre-scoped to that card and pays there | Hosted web, desktop, iOS | Route target and payment |
| E3-08 | [ ] Current cash card equals the actual non-investment account sum, the calendar's today cell equals the end-of-day projection, any difference equals today's projected obligations for the same simulation setting, and both are labeled current vs projected | Hosted web, desktop, iOS | Two values, their difference, and the day's entries |
| E3-09 | [ ] All amounts use the shared formatter and mono/type coloring | Hosted web, desktop, iOS | Visual audit |
| E3-10 | [ ] Skeletons replace content during forecast load, then content appears without layout jump | Hosted web, desktop, iOS | Load trace or recording |
| E3-11 | [ ] Stopping the server produces the destructive alert, not a blank screen; changing range recovers | Hosted web, desktop | Error screen and recovery |
| E3-12 | [ ] Empty pending, realized, and simulated tabs show their specific copy | Hosted web, desktop, iOS | Three empty states |
| E3-13 | [ ] Calendar shows projected balance for every fetched day, muted out-of-range days, muted overflow | Hosted web, desktop, iOS | Month view |
| E3-14 | [ ] Selecting a calendar day opens day details with balance and entries | Hosted web, desktop, iOS | Day modal |
| E3-15 | [ ] Tab to the calendar and press Enter/Space selects a day and opens details | Hosted web, desktop, iOS | Keyboard/VoiceOver trace |
| E3-16 | [ ] Previous/next month navigation works and only received days show balances; today is marked | Hosted web, desktop, iOS | Navigation recording |
| E3-17 | [ ] Chart point click and same-day calendar click open identical details | Hosted web, desktop, iOS | Two detail views |
| E3-18 | [ ] Quick entry opens from the dashboard in one interaction; submission refreshes without reload | Hosted web, desktop, iOS | Interaction count and refresh |
| E3-19 | [ ] Layout at every breakpoint: cards stack, calendar reflows, amounts never truncate | Hosted web, desktop, iOS | 360/390/768/1280/1920 plus iPhone 320/393 |
| E3-20 | [ ] Realize is at most two interactions; edit is reachable from the row | Hosted web, desktop, iOS | Interaction count |
| E3-21 | [ ] Nav reaches ledger, cards, management and shares cached base data | Hosted web, desktop, iOS | Navigation and cache state |

No E3 box is checked by this epic. They are checked only by the release verification record.

#### VRF-02 - Offline, relaunch, and reconnect matrix

| Case | Required observation |
|---|---|
| Fresh iOS install, airplane mode | App launches, local store opens, account and transaction can be created, no network error wall |
| Fresh desktop station, server unreachable | Local unlock, local BFF, local data, sync status offline, no blocking spinner |
| Create, realize, transfer, card purchase, invoice payment offline | Each queues one operation with the user's `effectiveAt` and shows the local result |
| Kill and relaunch offline | Pending operations remain, local data remains, no duplicate |
| Reconnect | Push accepts queued operations, pull applies complete commit groups, cursor advances to a commit boundary, and no replayed payment moves to the reconnect date |
| Kill during push after server commit | Relaunch retries, server returns duplicate, no double balance effect |
| Token expired offline | Local app remains usable, sync shows `AUTH_REQUIRED`, outbox remains |
| Server restored to older backup | Station stops with rollback detection, outbox remains |
| Endpoint changed to a different deployment | Push blocked, outbox preserved, explicit re-pair required |
| Server reset while station offline | Station receives new epoch, pending operations require explicit discard or re-entry |

#### VRF-03 - Sync hostile matrix

- Two stations edit the same transaction from the same revision: one applies, one gets a conflict with both records.
- Two stations realize the same pending transaction: one applies, one conflicts; the balance moves once.
- Two stations pay the same invoice partially: the second conflicts on the invoice revision; no double debit.
- Two stations buy on the same card and period offline: both additive invoice deltas apply in separate commit groups; the invoice total is the sum and no purchase is lost.
- A station deletes a transaction while another edits it: the later operation conflicts on the tombstone revision; no resurrection.
- A station creates an entity with an id that already exists: `ENTITY_ID_TAKEN`, no overwrite.
- An operation depends on a rejected create: dependent is `blocked`, no partial write.
- A batch contains a valid operation followed by an invalid one: the valid one applies, the invalid one is rejected, results are per operation.
- The same `opId` is pushed twice with the identical complete envelope: one effect, `duplicate` returns the stored result. Any changed envelope field (`effectiveAt`, `baseRevisions`, `dependsOn`, `payload`) under the same `opId` is `OP_ID_REUSED` with no effect, while a locally rebased intent with a new `opId` targeting the same entity applies exactly once.
- A server batch is killed mid-commit: no finance row, no revision, no journal event, no partial commit group.
- A station pulls a page containing a partial commit group, or a cursor inside a group: the page is rejected with `PAGE_INVALID`/`CURSOR_NOT_ON_COMMIT_BOUNDARY`, cursor unchanged; retry from the last boundary applies once.
- A station pulls a page of complete groups and crashes after committing: cursor advanced to the group boundary; retry ignores old revisions.
- A station pulls a first group larger than `limit`: the whole group is returned, no commit is split, and the page may exceed `limit` up to the 10,000-event bound.
- A 0.3.0 server is upgraded with rows: pull from 0 returns all rows exactly once in complete groups.
- A legacy desktop snapshot seeds an empty server exactly in one commit group; a second seed and a non-empty server are refused with no writes.
- An invalid legacy snapshot relation aborts the whole seed.
- A settled snapshot import collides with an existing finance id (populated server): `IMPORT_ENTITY_ID_TAKEN`, the whole request is rejected, and no imported row, revision-1 version, journal event, or receipt exists.
- A never-paired profile with a nonzero queue pairs against an empty server: it imports the complete materialized snapshot with client-minted all-new ids (`/import`), no `SERVER_NOT_EMPTY` refusal, no log replay, and subsequent mutations push as ordinary 18-type operations.
- A never-paired profile imports into a populated server where none of its client-minted ids collide: all seven collections insert, every `invoice_id`, `source_invoice_id`, and `recurrence_id` points at an imported row, existing server rows are unchanged, and the server mints no id.
- An imported settled snapshot preserves paid and partial invoices: paid cash counts, invoice statuses, and realized facts survive exactly, with no silent conversion, no equal-payment dedupe (two equal legitimate payments are both imported), and no recomputed paid history.
- The import response is lost after the server commits: a restart, an expired session, and relogin resume the same frozen `importId` against the same station, instance, and epoch; the server replays the stored original result, and the imported data exists exactly once.
- A client crashes after acceptance but before applying the result: restart retries the same frozen request, adopts the stored result once, retires only covered operations, and leaves the pull cursor at the stored commit boundary until a real pull.
- Local operations created after the import checkpoint survive acceptance and restart and push as fresh operations; the original queue is retired only for the covered `opId`s, covered dependencies are stripped only from never-sent later operations, and only those operations' causal own base versions advance.
- The checkpoint cannot be persisted before the request: no network call is made, the local finance rows and outbox stay unchanged, and no half-written marker exists.
- A station pulls a newer remote base while a local write to the same entity is still unaccepted, then crashes and relaunches: the base is reconstructed from `obol_station_versions.baseRecord`/`serverDeleted` and the pending optimistic row survives untouched; the remote base is never applied over the local row and nothing is silently merged.
- An accepted operation whose dependent still needs its causal versions keeps its row with only the minimal `acknowledgement` receipt (`opId`, commit id, seq bound, per-entity versions); the receipt never contains whole entity records or tokens, and the row plus receipt are removed together once no dependent needs them.
- Sending different content under the same `importId` is `IMPORT_ID_REUSED` with no effect; a reset clears receipts and the pending-import checkpoint before any new import.
- A server is restored from an older backup: rollback detection by cursor, no push.
- A server is restored to a history where the station's cursor now names a different event: `clientCursorHash` mismatch is `SERVER_ROLLBACK_DETECTED`, no pull or push.
- A reset increments the epoch: pending operations stop, local data remains until explicit choice.
- A client with an unsupported protocol: `PROTOCOL_UNSUPPORTED`, local app still usable.
- A malformed operation payload: per-operation rejection, no crash, no partial apply.
- A request over 100 ops or 1 MiB, a commit over 10,000 events, or a page group that cannot fit the byte cap: 413 or `COMMIT_TOO_LARGE`/`COMMIT_PAGE_TOO_LARGE` before any write.

#### VRF-04 - UX audit

**Files**: `app/ios/App/App/Features/`, `app/components/Sync*.vue`, `app/pages/sync.vue`
**Work**: Review every new surface for loading, error, empty, offline, conflict, destructive confirmation, accessibility, Dynamic Type, dark mode, and layout. Review that no UI shows a bare balance without a current/projected label and no transfer is colored as income or expense.
**Acceptance**: The audit records a screenshot or observation per surface. Any unresolved issue is listed as a release blocker, not waived silently.

## Release criteria

The release is complete only when all of these are observed. They are not checked in this plan.

- [ ] D016 accepted after every implementation gate passes.
- [ ] Boot configures and verifies PocketBase batch capability, with the rollback and two-collection commit observed through product configuration.
- [ ] Operation-target reuse, page-boundary atomicity, and offline economic time each have a passing named test.
- [ ] The observed transfer mutation (`100 → 75`, destination `50`) and realized-simulation debit (`40`, checking `850 → 810`) are corrected with regression evidence.
- [ ] `SYNC-01` to `SYNC-13` complete.
- [ ] `IOS-01` to `IOS-15` complete.
- [ ] `DESK-01` to `DESK-07` complete.
- [ ] `PAR-01` passes on TypeScript and Swift.
- [ ] `VRF-01` all 21 E003 scenarios pass on hosted web and desktop, with native equivalents on iOS.
- [ ] `VRF-02` offline, relaunch, and reconnect matrix passes.
- [ ] `VRF-03` hostile sync matrix passes.
- [ ] `VRF-04` UX audit closes with no blocker.
- [ ] Fresh self-hosted deployment and 0.3.0 upgrade with preexisting data pass.
- [ ] Legacy empty-server seed exactness and non-empty refusal pass.
- [ ] Offline backup and restore pass, including rollback detection.
- [ ] macOS arm64/x86_64, Windows x64, and iOS simulator artifacts are observed.
- [ ] TestFlight archive/export/upload is observed, or the missing Apple secret is named as a blocker.
- [ ] Windows runtime smoke is observed, or `BLOCKED (no Windows x64 runtime)` is recorded.
- [ ] Final 0.4.0 artifacts, versions, checksums, and release notes are verified.
- [ ] No requested capability and no operation allow-list entry is removed to declare completion; every failing gate is fixed.
- [ ] No secrets, dumps, build outputs, or signing material are committed.

## Hostile release grill

Answer every question with an observation, not an opinion. An unanswered question blocks the release.

| # | Hostile question | Required proof | Release blocked if |
|---|---|---|---|
| G1 | If two devices edit the same transaction offline, can either silently win? | Two-station conflict test with both records and revisions | Any path applies one without showing the other |
| G2 | If a device is killed after the server commits but before the response, can a balance move twice? | Kill/relaunch duplicate test with balance before/after | Balance moves twice, or the op applies twice |
| G3 | If PocketBase rejects the middle write of a multi-row operation, what remains? | Forced batch failure inspection of finance rows, revisions, journal, op result | Any partial finance row, revision, or event remains |
| G4 | If two users (one owner, two sessions) write at the same moment, are revisions race-free? | Concurrent push test with distinct entities and the same entity | Duplicate revisions, lost journal events, or interleaved partial effects |
| G5 | If the server is restored from an older backup, what do paired devices do? | Restore drill with a station cursor ahead of the server and a restore where the cursor exists but its chain hash differs | A station pulls silently, pushes, or loses its outbox |
| G6 | If a station has pending operations and the endpoint changes to another deployment, where do they go? | Endpoint-switch test with two instance ids | Any pending op reaches the new server |
| G7 | If a user pairs a populated local device with a populated server, is anything auto-merged? | Pairing matrix for all four states | Any automatic merge, overwrite, or heuristic dedupe |
| G8 | If a token expires while offline, is local finance lost? | Offline expiry test across relaunch | Local store or outbox deleted |
| G9 | If a recurrence cron runs on the server while a station has a pending local create, can a duplicate month appear? | Paired station with disabled local cron, a server-generated month, and a scheduler `transaction.create` carrying the canonical `recurrence_id` and `is_recurring: true` | Two transactions for one recurrence month, or the create is applied without recurrence/occurrence validation |
| G10 | If a transaction is deleted on one device while another edits it, can it reappear? | Delete/edit race test | Resurrection or silent edit |
| G11 | If an entity id collides, is the existing row overwritten? | Duplicate id create test | Overwrite or silent reassignment |
| G12 | If a client sends an unsupported operation, is it skipped? | Unsupported op push | It is skipped or applied partially |
| G13 | If a client sends 101 operations or 2 MiB, what happens? | Bounds test | Partial write or 200 with hidden drops |
| G14 | If the iOS app is offline on first launch, can the user complete a real financial workflow? | Fresh-install airplane-mode recording | Any network gate before local use |
| G15 | If the native finance engine disagrees with the server, which value does the user see? | Parity fixture run plus post-acceptance state | Local value survives acceptance |
| G16 | If the E3-11 server-down alert is not reachable on iOS, is the web/desktop contract still verified? | E3 run on hosted web and desktop plus native offline error surface | The web/desktop item is waived or iOS is claimed to replace it |
| G17 | If the Windows installer is unsigned, is the runtime smoke still claimed? | Windows x64 observation with SmartScreen noted | Smoke is inferred from a build job |
| G18 | If TestFlight secrets are missing, is the IPA claimed? | Workflow output naming the missing secret | Upload is claimed without a result |
| G19 | If the release tag, `desktop/app.json`, cask, manifest, and iOS version disagree, is 0.4.0 shipped? | Version consistency table with commands | Any version mismatch |
| G20 | If the packaged desktop updater restarts mid-sync, what happens to the outbox? | Packaged update/restart observation | Outbox lost, duplicated, or sync stuck |
| G21 | If a 0.3.0 desktop database with data pairs with a non-empty server, is anything merged? | Legacy pairing matrix and seed refusal test | Any merge, partial seed, or silent discard |
| G22 | If a never-paired device imports its settled snapshot and the response is lost, can the import run twice? | Import, kill the response, restart and reauthenticate with the same `importId`/hash/station/instance/epoch; compare counts and receipt | Duplicated rows, a new import id, or a partially applied import |
| G23 | If an imported id collides with an existing server id, is any part of the snapshot written? | Populated-server collision probe followed by full row/version/event/receipt inspection | Any imported row, revision-1 version, journal event, or receipt |
| G24 | If a local operation is created after the import checkpoint, does it survive acceptance? | Checkpoint, mutate locally, import, restart, then pull/push | Operation lost, frozen envelope edited, or pull cursor advanced from the import response |
| G25 | If the server were to remint or rewrite a frozen import, would the hash still identify it? | Inspect the accepted request and stored receipt against the client's frozen body | Server-minted ids, rewritten references, or a hash that no longer covers the committed rows |

## Risks

| Risk | Why it is real | Mitigation |
|---|---|---|
| Unit-of-work refactor regresses existing finance behavior | Every use case and repository participates; current code has sequential writes and swallowed delete/update errors | Land Wave 1 behind the current API, run the existing server suite, add parity fixtures, keep the gate and batch abort semantics |
| Legacy desktop data has no operation log | A 0.3.0 database cannot be replayed as operations | Seed only an empty server with a validated snapshot; refuse non-empty merges; export before discard; verify exact counts |
| Read-your-writes inside a buffered unit of work is incomplete | Use cases query repositories after writing; a filtered list or the card+period invoice lookup may not see buffered rows | Extend the unit of work until every allowed operation's queries are reproduced; make read-your-writes, including the invoice lookup, an implementation gate rather than dropping operations |
| Server-created internal invoice ids differ from optimistic local ids | `SyncInvoiceUseCase` creates invoices with server ids | Return the created invoice in the push result and remap local references before the next pull; add a fixture for a card purchase and an invoice payment |
| Local station tables grow inside PocketBase | Station state shares the local database with finance rows | Keep station tables small, prune accepted outbox rows after a retention window, and never add finance fields; verify migrations on upgrade |
| Swift and TypeScript finance engines drift | Two implementations of canon §§4-8 | Shared fixtures in `shared/finance-parity/`, one fixture change per wave, server result replaces optimistic result |
| An adapter compensates for a product gap | A fixture can show green while the product still lacks projection, filtering, or rounding behavior | Adapters only map, normalize, inject the clock, and inject faults; PAR-01 rejects adapter-added business results; the fix lands in the use case or `ObolCore` |
| PocketBase 0.40.6 batch capability is disabled by default | Verified 2026-10-31: the untouched default is `{ enabled: false, maxRequests: 50, timeout: 3, maxBodySize: 0 }`; a manual isolated enable proved rollback and commit, but nothing configures it in the product | Boot configures and verifies the batch subset through authenticated settings, preserves unrelated SMTP/meta, fails closed, and never degrades to single writes; the isolated manual setting is not a fix |
| Offline financial actions lose their business date on replay | A use case that reads `Date()` at execution time would date the effect at reconnect | Thread `SyncClock` into every date-sensitive use case, seed it from `effectiveAt`, assert with the offline economic-time test, and never use the clock for conflict precedence |
| A commit group is split or partially applied at a page boundary | A transfer or invoice payment writes several entities; a naive `limit` splits them | Required `commitId`/`commitIndex`/`commitSize`, complete-group pulls, cursor-boundary rejection, one transactional local apply, 10,000-event bound, and the page-boundary atomicity test |
| Journal grows without compaction | D016 keeps every event for 0.4.0 | Accepted for one owner; monitor row count and first-sync time; compaction is a later decision |
| Pull from cursor 0 is slow for a large deployment | Backfill replays every row | Paginate in complete commit groups, show progress, keep the UI usable; measure first sync |
| Paired desktop disables local cron | Users may expect recurrence rows while offline | The forecast simulates them; the server generates and pulls the facts; the UI explains the authority |
| iOS local store has no custom at-rest encryption | Data is protected by iOS Data Protection only | State the boundary; Keychain for token; no false encryption claim |
| Native app replaces Capacitor, so old TestFlight builds cannot update themselves | Different UI runtime | Ship 0.4.0 as a new native install; document the manual cutover; keep the same bundle id and signing |
| Xcode project edits can disturb signing | The project file contains the user's team | Preserve `DEVELOPMENT_TEAM`, `CODE_SIGN_STYLE`, bundle id; review the pbxproj diff for signing lines |
| Windows installer is unsigned | No Windows certificate exists | Keep the unsigned contract; run the smoke on a native host; do not claim a signed installer |
| TestFlight secrets may be unavailable | External Apple credentials | Name the missing secret; do not claim an upload |
| Conflict UI becomes a second workflow users avoid | Explicit conflicts are mandatory for financial safety | Show conflicts inline on the affected row, a queue count, and a one-screen resolution with both versions |
| Server restore rollback is easy to mishandle | Cursor, epoch, journal, and chain hash must agree | Handshake checks cursor regression, epoch, and `clientCursorHash`; stations stop before push; drill in `REL-01` |
| Multi-process deployment breaks the gate | The gate is in-process | Keep one BFF process; use stop-start/recreate deployments; document the unsupported scale-out; add a startup warning if a second process is detected through the DB lock later |
| A rolling deploy briefly runs two BFF writers | The old and new processes can both assign seq and revisions | Stop the old BFF before starting the new one; verify the Coolify and self-hosted deploy strategy in `REL-01`/`REL-02` |

## Deliberately not included

- Multi-user or multi-tenant synchronization.
- Merging a legacy local database into a non-empty server. Legacy data can seed only an empty server.
- Field-level merge, CRDTs, or automatic conflict resolution.
- Journal compaction or snapshot garbage collection.
- Real-time push or WebSocket sync. Sync runs on launch, foreground, user action, and a bounded timer while active.
- Background iOS sync guarantees.
- A native desktop UI rewrite. Desktop keeps the Nuxt UI inside Electrobun.
- Hosted web offline support.
- Linux packages or Windows ARM64.
- App Store submission, public TestFlight, or review metadata.
- Editing accepted ADRs, history files, or the user's signing settings.
- Claiming any runtime result that was not observed. A missing Docker, Windows, or Apple credential runtime is reported as a blocker.
