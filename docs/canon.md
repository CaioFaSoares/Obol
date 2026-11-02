# Canon

Obol's numbered source of truth. Every other doc links into this one instead of repeating it. Sections are addressed as `canon §N` from anywhere in the repo. Rules change only by appending a new numbered subsection or superseding a decision in `decisions/` — history is never rewritten silently.

Related: [arquitetura.md](arquitetura.md) · [decisions/log.md](decisions/log.md) · [history/](history/README.md)

## §1 What Obol is

Obol is a personal cash-flow forecaster: granular control of accounts, credit cards, budgets and freelance projects, with a daily projection showing the exact day cash runs out. Unlike static budgeting tools, it reconstructs past balances from realized transactions and projects future balances from pending items, invoices and recurrences.

## §2 Architecture

Three layers with one responsibility each (D001), server layered by clean architecture (D003):

- `app/` — Nuxt 3 + Nuxt UI + Pinia + ECharts. Talks only to the BFF via Eden Treaty.
- `server/` — ElysiaJS on Bun, clean architecture (domain / application / infrastructure), awilix DI, isolated cron scheduler.
- `db/` — PocketBase persistence, public API rules `null`, JS migrations on boot. Desktop bundles pinned PocketBase 0.40.6 (D005); hosted Compose still uses the configured PocketBase image.

Module map and runtime topology: [arquitetura.md](arquitetura.md).

Runtime modes: hosted web uses the Nuxt same-origin proxy and HttpOnly cookie; local desktop uses Electrobun, a managed PocketBase child, and in-process Elysia RPC; optional central server mode serves desktop and native iOS from the same typed BFF API. Desktop users choose local or remote explicitly; there is no automatic data sync or migration. iOS uses a Capacitor shell around the Nuxt/Vue UI and stores bearer credentials in the Keychain. See [D008](decisions/D008-central-server-clients.md), [D009](decisions/D009-remote-identity.md), and [E006](epics/E006-central-server-mobile.md).

## §3 Data model

Collections (PocketBase): `accounts`, `cards`, `categories`, `invoices`, `projects`, `recurrences`, `transactions`. Entities in `server/src/domain/entities/`.

| Collection | Fields |
|---|---|
| `accounts` | `name`, `type` (`checking`\|`savings`\|`investment`), `initial_balance` |
| `cards` | `name`, `closing_day`, `due_day`, `limit` |
| `categories` | `name`, `type` (`fixed_budget`\|`variable`), `monthly_budget?` |
| `invoices` | `card_id`, `period` (`YYYY-MM`), `due_date`, `status` (`OPEN`\|`CLOSED`\|`PAID`), `total_amount`, `paid_amount?` |
| `projects` | `name`, `total_value`, `status` (`active`\|`completed`) |
| `recurrences` | `name`, `amount`, `payday`, `type` (`income`\|`expense`), `status` (`active`\|`paused`\|`ended`), `frequency?` (`monthly`\|`weekly`, absent = `monthly`), `weekday?` (ISO 1-7, weekly only), `account_id?`, `card_id?`, `category_id?`, `end_date?`, `total_installments?`, `skipped_periods?` |
| `transactions` | `title`, `amount`, `type` (`income`\|`expense`\|`transfer`), `status` (`pending`\|`realized`), `expected_date`, `realized_date?`, `purchase_date?`, `is_recurring?`, `is_silent?`, `is_simulated?`, `is_scheduled?`, `account_id?`, `card_id?`, `category_id?`, `project_id?`, `invoice_id?`, `recurrence_id?`, `destination_account_id?` |

Parent-child: `recurrences` is the *rule*, `transactions` are the *facts* it generates.

## §4 Transaction lifecycle

- Born `pending` with `expected_date`; card purchases are born pending with `expected_date = invoice.due_date` and `purchase_date` = real purchase date.
- Realize (`RealizeTransactionUseCase`): pending → realized, stamps `realized_date = now`, moves balances. `update_balance = false` = silent realize (`is_silent: true`): no balance mutation — for when the user already adjusted the balance manually.
- Transfers are atomic: subtract source, add destination, clear `category_id`/`card_id`, no net-worth impact.
- `is_scheduled` marks scheduled/agenda items; always cleared to `false` on realize.
- `is_simulated` marks what-if rows; excluded from realized/pending tabs and from the forecast unless `includeSimulations = 'true'`.
- Edit (`UpdateTransactionUseCase`) reverts the old financial effect, then applies the new one (balance- and invoice-aware).
- Delete (`DeleteTransactionUseCase`) reverts balances, adjusts the invoice total, and appends the purchase period to the source recurrence's `skipped_periods` so the cron does not regenerate it.

## §5 Invoice engine

- `SyncInvoiceUseCase`: `calculateCardDueDate(purchaseDate, closing_day, due_day)` (pure UTC math, month rollover safe) → period = due month → find/create invoice for card+period → delta into `total_amount`.
- Invoice status: `PAID` when all children realized, `CLOSED` past closing date, else `OPEN`.
- `GetCardInvoicesUseCase` computes per-invoice real debt (`total_amount − paid_amount`), gross spent, and injects *projected* rows for active card recurrences; one virtual `PROJECTED` invoice for the next period.
- `PayInvoiceUseCase`: requires `accountId`, validates `amountPaid` against `total_amount − paid_amount`, debits the account, records a realized `Pagamento Fatura <card> <period>` transaction; partial payments bump `paid_amount`; full payment flips child pendings to realized. `ignoreBalance` = silent payoff.
- `DeleteInvoiceUseCase`: removes children, appends periods to recurrence `skipped_periods`.

## §6 Recurrence engine (time)

- Scheduler: daily cron at 01:00 `America/Fortaleza` (`@elysiajs/cron`), runs `ReconcileInvoicesUseCase` then `ProcessMonthlyRecurrencesUseCase`.
- Monthly processing: expiry (`end_date`), finite installments (`total_installments` counted from existing children), month idempotency (skip if a transaction already exists for the month, matched on `purchase_date` or `expected_date`), `skipped_periods` skip, `payday` clamped to month length (payday 31 → 28).
- Weekly processing ([D019](decisions/D019-weekly-recurrences.md)): the same rule table over UTC ISO weeks. The occurrence is the chosen `weekday` of the current ISO week, dates are exact (no clamping), the skip key and the idempotency match are the occurrence day `YYYY-MM-DD`, and `total_installments` counts weekly children. A weekly card recurrence prices one child per occurrence into the invoice that covers it, so a monthly invoice carries four or five weekly lines.
- One cadence branch, not two engines: `frequency` absent means monthly, `payday` is never reinterpreted, and `skipped_periods` holds both key shapes.
- `LaunchRecurrenceUseCase` ("lançar agora"): generates the *next* month's (monthly) or next ISO week's (weekly) pending transaction on demand; `ConflictError` if it already exists.
- Pausing (`paused`) stops generation; manual launch and cron resume recognize prior months via idempotency.

## §7 Forecast engine

`GenerateForecastUseCase`: inputs are non-investment accounts, transactions, active recurrences, unpaid invoices (upcoming `amountDue > 0` → dated due events). Past: reverses realized non-card non-silent transactions from a summed account snapshot, then rebuilds forward day-by-day. Future: pending transactions on `expected_date`, invoice due amounts on `due_date`, future recurrences on `payday` (monthly) or on the weekly occurrence date (weekly) unless already launched (`alreadyLaunched` check). A weekly recurrence projects every occurrence in the horizon, never a monthly equivalent. `includeSimulations` controls simulation rows. All math via `roundCurrency`.

## §8 Budgets, projects, reconciliation

- Budgets (`GetBudgetsUseCase`, accrual): expenses count on `purchase_date` when set (card), else `expected_date` — regardless of status; `spent` = expenses − incomes per category.
- Projects: `RegisterPaymentUseCase` records partial income transactions; `CompleteProjectUseCase` closes. Payment registration does not mutate `total_value`.
- `ReconcileInvoicesUseCase` (daily): reattaches orphan card transactions, recalculates `OPEN`/`CLOSED` invoice totals from children (rewrites if `|diff| > 0.01`), prunes `skipped_periods` older than 3 months.

## §9 Frontend data flow

- `stores/finance.ts` caches `accounts`/`cards`/`categories`/`projects` (`loadBaseData(force)`); `useRefresh` broadcasts a global refresh counter; every mutation triggers `triggerRefresh()` + refetch.
- Pages: dashboard (daily balance summary, 15/30/60/90-day forecast and simulation controls, daily balance calendar with shared chart/day details, trajectory chart, realized/pending/simulated transaction tabs with edit/realize actions, quick entry, and shortcuts to ledger/cards/management), `ledger` (paginated table, structured search/status/type/simulation/scheduled/date/entity filters, sort, filtered totals, lifecycle badges, CSV export), `cards` (invoice timeline + payment), `management` (Contas & Cartões / Recorrências / Orçamentos / Projetos), `admin` (manual recurrence trigger and destructive financial-data reset with typed `LIMPAR` confirmation; the owner account and sessions are preserved). The desktop `DesktopUpdaterBanner` shows update status, retry, download progress, and restart-to-install state; the updater checks and downloads in the packaged main process.
- Ledger summary returns filtered `incomeTotal`, `expenseTotal`, `netTotal`, and `count`; transfer rows contribute to count but not money totals. Account filters match both `account_id` and `destination_account_id`; realized-date filtering uses `realized_date`, otherwise date ranges use `expected_date`.

## §10 Operations

- Hosted dev: `nix develop` → `docker compose up -d --build` → app :13000, server :13080, PocketBase :13090 (admin `/_/`).
- Desktop: `nix develop`; install `app/`, `server/`, and `desktop/` dependencies. `cd desktop && bun run eb:dev` starts the isolated local identity `copland.obol.eb-dev`; the packaged identity/data use `copland.obol`. In the verified environment, the dev main process starts but Nuxt returns `Vite Node IPC socket path not configured`; the static release build and `eb:verify` pass.
- Desktop data: `Utils.paths.appData/copland.obol/pb_data`; no automatic import from hosted `db/pb_data`, which remains unchanged.
- Local login: one profile per application-data directory; `local_profile.json` stores a salted PBKDF2 verifier. Each unlock derives the internal PB superuser credential and runs `superuser upsert` before the service starts. The login does not encrypt PB files at rest.
- iOS TestFlight: `cd app && npm run ios:testflight` archives, exports, and uploads the IPA; the manual `ios testflight` workflow runs the same script after installing signing material from repository secrets. Prerequisites and secrets: [ios-testflight.md](ios-testflight.md).
- Deploy: `docker-compose.coolify.yml` retains the existing Coolify topology. Production self-hosting uses `docker-compose.self-hosted.yml`; follow [the operator runbook](self-hosting.md) for TLS, secrets, backups, restore, and upgrades.
- Stable release: merging `dev` or `pr/release-<version>` to `main` creates `release-<version>` and publishes platform installers plus Electrobun updater assets; only stable releases update `latest` and the Homebrew cask.
- Release candidates: for the first 0.3.0 candidate, set `desktop/app.json` to `0.3.0-rc.1` on branch `rc/0.3.0-rc.1` and merge its PR to `main`; the workflow creates `rc-0.3.0-rc.1` and publishes a prerelease plus the fixed `rc-channel` updater. Increment `rc.N` for every candidate; never reuse a tag. RC builds from `rc.2` onward embed `rc-channel`, which each candidate refreshes, so an installed RC updates itself to the next RC; `rc.1` predates the channel and needs one manual install of `rc.2`. Moving from an RC to the stable release still requires a manual stable install. Candidates never update stable `latest` or the cask.
- Env: hosted development uses `PB_ADMIN_EMAIL`, `PB_ADMIN_PASSWORD`, `POCKETBASE_URL`, and `PORT` from `.env`. Self-hosting uses `.env.self-hosted` with required `OBOL_SESSION_SECRET`, `OBOL_PUBLIC_URL`, and `OBOL_PB_ADMIN_*`; configure `OBOL_CLIENT_ORIGINS` for remote WebViews.
- Migrations: `db/pb_migrations/*.js` run at PocketBase startup. Central identity and session metadata are applied by migrations 0010–0017; `obol_sessions.createdAt` anchors the 30-day hard-expiry cap.

## §11 Roadmap

- Implemented epics: E001 — ledger hardening + local Electrobun runtime; E002 — typed use-case dispatch; E003 — daily dashboard/calendar; E004 — Windows x64 release pipeline; E005 — in-app updater; E006 — optional central server, remote desktop mode, and Capacitor iOS client (0.3.0).

- Completed for 0.3.0: [E006](epics/E006-central-server-mobile.md) delivers the optional self-hosted single-owner server, remote desktop/iOS access, and preserves standalone local desktop mode. The RC pipeline lets operators test `rc-*` prereleases before the stable `release-*` cut. Historical roadmap: [history/2026-05-map.md](history/2026-05-map.md).

- Completed for 0.4.0: [E007](epics/E007-native-offline-040.md) delivers production self-hosting, the native SwiftUI iOS app, durable offline finance on iOS and desktop local, and explicit operation synchronization under [D016](decisions/D016-native-offline-sync.md).

- Completed for 0.4.5: [E008](epics/E008-tuist-and-weekly-recurrences-045.md) lands the iOS build-tooling corrections and the weekly recurrence cadence under [D019](decisions/D019-weekly-recurrences.md).

## §12 0.4.0: native offline clients and synchronization

> **Shipped in 0.4.0.** This section is the sync contract the released server, the iOS app and the desktop station implement. It was a target contract before 0.4.0 shipped; [D016](decisions/D016-native-offline-sync.md) and [E007](epics/E007-native-offline-040.md) carry the evidence trail.

### §12.1 Runtime contract

| Runtime | UI | Local finance | Server connection | Time authority |
|---|---|---|---|---|
| Hosted web | Nuxt 3 SSR | no | same-origin BFF cookie | server |
| Self-hosted central | Nuxt 3 SSR | no | same-origin BFF cookie | server |
| iOS native | SwiftUI | SQLite, offline-first | optional explicit pairing, Bearer session, sync endpoints only | server when paired; local preview when offline |
| Desktop standalone | Electrobun + Nuxt SPA | local PocketBase | none | local BFF |
| Desktop station | Electrobun + Nuxt SPA | local PocketBase and station outbox | optional explicit pairing, Bearer session, sync endpoints | server when paired; local preview when offline |
| Desktop remote | Electrobun + Nuxt SPA | no | configured central BFF, Bearer | server |

The Elysia/PocketBase BFF remains the only server data path. PocketBase stays private. Hosted web, Coolify, and the Electrobun packaging contracts remain supported. iOS does not run Bun, PocketBase, or Electrobun. Native iOS uses URLSession, so it sends no browser `Origin`; browser CORS origins are not its transport. A desktop local BFF may run with the remote journal disabled because it is not a central authority; station mode uses its outbox and remote revisions. A hosted or central public startup fails closed: if `OBOL_SESSION_SECRET` is missing, `createServer` refuses to listen instead of silently enabling open sessions; only the explicit trusted-local desktop factory opts into null authentication.

### §12.2 Authority and conflict rule

- The server is the only authority for applied financial state. A paired client keeps a local working copy for offline reads and writes. Only the BFF applies canonical mutations, through the same use cases used by hosted web, desktop local, and the scheduler.
- Each client mutation is one immutable operation with a client-generated `opId`, a durable `stationId`, and the base revisions the client observed.
- `payloadHash` keeps its name for compatibility but covers the complete immutable envelope: `protocolVersion`, `stationId`, `opId`, `type`, `entityType`, `entityId`, `payload`, `baseRevisions`, `dependsOn`, `clientCreatedAt`, `effectiveAt`. Those eleven fields are the hashed input; the transmitted `payloadHash` field itself is excluded. A still-queued operation may acquire dependency-derived base revisions and persist its final envelope and hash before its first send; after that send the envelope is frozen, and a corrected or rebased intent is a new operation with a new `opId`.
- Every hash (`payloadHash`, `prevHash`, `chainHash`, `headHash`, `cursorHash`, `ownerFingerprint`, record hashes) is `sha256:` plus unpadded base64url of SHA-256 over canonical bytes. Canonical JSON sorts object keys recursively, emits UTF-8, has no insignificant whitespace, and uses standard JSON scalar encoding; every envelope field is present in the hashed form, with an absent optional `dependsOn` encoded as `[]`. The genesis hash before the first event is the empty string. Interoperability fixtures cover decimals, `null`, unicode, escaping, and negative zero.
- Every operation carries `effectiveAt`, the ISO UTC business time of the user's financial action, captured on the device. `clientCreatedAt` is audit data. `effectiveAt` never orders operations, never assigns revisions, and never decides a conflict; it only dates the financial effect, so a replay at reconnect never moves an offline realization or payment to the reconnect date.
- Every synchronized entity has a monotonic integer revision in `obol_sync_entity_versions`. An operation must declare the current revision of every existing entity it writes.
- The only write-set exception is an invoice created or found by `SyncInvoiceUseCase` for a card purchase or recurrence launch. It is an additive delta keyed by `(card_id, period)`; the client does not need a base revision it could not know. A concurrent payment or deletion still declares the invoice revision and conflicts normally.
- A stale base revision is an explicit `SYNC_CONFLICT`. The response carries the base revision, current revision, and current server record. The client shows both. Resolution is a user choice: use the server record, or retry as a new operation with the current revision.
- No financial conflict is resolved by timestamp, device order, arrival order, or last writer. Forbidding automatic last-writer-wins is this contract's conservative safety choice, not a user-mandated rule. `clientCreatedAt` is audit data only.
- One live BFF process per deployment is a new explicit 0.4.0 constraint; D009 does not state it. Concurrent BFF processes, a load-balanced deployment, or a rolling deploy that overlaps old and new writers are unsupported because the mutation gate is in-process. Lifting that requires a database-backed lock and a new decision.

### §12.3 Wire contract

All routes require the D009 session and live under `/api/sync`.

| Route | Purpose |
|---|---|
| `POST /api/sync/handshake` | protocol range, `serverInstanceId`, `ownerFingerprint`, `dataEpoch`, cursor, `cursorHash`, `headHash`, server data presence; station registration and rollback detection |
| `POST /api/sync/push` | ordered operations, per-operation results, limits 100 ops / 1 MiB / 64 KiB per op |
| `GET /api/sync/pull?cursor=&limit=` | complete commit groups of ordered change events; `limit` 1..500 is a target event count, never permission to split a commit; a page may hold up to 10,000 events; `nextCursor` at a commit boundary; `hasMore` |
| `POST /api/sync/seed` | one-time legacy snapshot import into an empty server as one commit group of at most 10,000 events; refused on a non-empty server or second attempt; not an operation |
| `POST /api/sync/import` | one permanent settled-snapshot import of a never-paired standalone profile with local finance and a recorded operation log into a server that is empty or populated, as the client's frozen all-new-id rows with every reference rewritten (`SyncImportUseCase`); the server never mints or rewrites ids, merges by existing id, overwrites, or replays a partial log; guarded by a durable six-field `importId` receipt in `obol_sync_snapshot_imports`; response is the seed identity shape plus `importId`; not an operation |

Operation shape:

```json
{
  "opId": "018f3b7e-6a2c-7c31-9f6e-2f0f9f6c1a11",
  "stationId": "018f3b7e-6a2c-7c31-9f6e-2f0f9f6c1a10",
  "protocolVersion": 1,
  "type": "transaction.realize",
  "entityType": "transaction",
  "entityId": "k3m9x2q7b1c8d4e",
  "baseRevisions": { "transaction:k3m9x2q7b1c8d4e": 4, "account:7h2p9q1m4x8c6v3": 7 },
  "dependsOn": [],
  "payload": { "update_balance": true },
  "clientCreatedAt": "2026-10-31T12:00:00.000Z",
  "effectiveAt": "2026-10-30T09:15:00.000Z",
  "payloadHash": "sha256:..."
}
```

Per-operation status is `applied`, `duplicate`, `conflict`, `rejected`, or `blocked`. HTTP 200 does not mean every operation applied; clients read `results`. An applied result lists every entity the operation touched, including deleted tombstones with `record: null`, not only surviving records. A duplicate `opId` with the same complete-envelope hash returns the stored result; a duplicate `opId` with a different envelope is `OP_ID_REUSED` and writes nothing; a declared hash that disagrees with the received envelope is `ENVELOPE_HASH_MISMATCH`. A missing base revision for an existing entity the use case actually writes is `UNCOVERED_WRITE` and writes nothing. The use case receives `effectiveAt` through the injected operation clock, so an offline realization or payment keeps its business date when replayed at reconnect.

The public HTTP `TransactionDTO` omits `recurrence_id` even though the `transactions` collection has the optional field. A sync-only `transaction.create` emitted by an unpaired client's scheduler extends the payload with the canonical `recurrence_id` and requires `is_recurring: true`; the server validates the actual recurrence and occurrence (exists, active, not skipped, within `total_installments`, date clamped per §6) and applies §6 month idempotency, rejecting an already-generated month with `RECURRENCE_MONTH_EXISTS` instead of creating a second transaction. Any `transaction.create` carrying `card_id` uses `expected_date` as the purchase-date input, exactly like the public DTO, and the server routes its invoice from it; a scheduler-generated occurrence reconstructs `expected_date` from its recorded `purchase_date`, never from a local invoice due date. `purchase_date` is optional and redundant, must agree with `expected_date` when supplied, and is not required for an ordinary native card purchase. The payload carries no `invoice_id`, and a local invoice id never reaches the server. This is a wire-only extension: no new operation type, no finance-collection field, and no migration.

Change events are immutable, ordered by `seq`, and grouped by atomic commit:

```json
{
  "seq": 1300,
  "commitId": "b81d0e77-2a49-4f6e-b3c5-1a8d2e9f0c34",
  "commitIndex": 1,
  "commitSize": 2,
  "kind": "delete",
  "entityType": "transaction",
  "entityId": "p8w2m5n1c7v4b9x",
  "revision": 3,
  "record": null,
  "origin": "web",
  "prevHash": "sha256:...",
  "chainHash": "sha256:..."
}
```

Every event carries required `commitId`, `commitIndex` (0-based), and `commitSize` (positive). All events of one atomic financial operation share `commitId` and contiguous `seq`. Both stored and pulled events include the group fields in `chainHash`, which hashes the event and the previous `chainHash`. The client verifies hash continuity and complete groups. A pull returns only complete groups: if the first group at the cursor is larger than `limit`, the whole group is returned. A page may hold up to 10,000 events; a commit larger than 10,000 entity events is rejected before writing (`COMMIT_TOO_LARGE`). A page is also bounded by a 32 MiB serialized-`events` byte cap; a single commit that cannot fit it fails with `COMMIT_PAGE_TOO_LARGE` rather than being split. `nextCursor` always lands on a commit boundary, and a request cursor inside a group is rejected with `CURSOR_NOT_ON_COMMIT_BOUNDARY`.

The handshake compares the client's `clientCursorHash` with the server event at that cursor and requires that cursor to be a commit boundary. A mismatch or a mid-group cursor is `SERVER_ROLLBACK_DETECTED` or `CURSOR_NOT_ON_COMMIT_BOUNDARY`: the journal was restored or replaced, and nothing is applied.

The baseline is `pull?cursor=0`. A one-time boot backfill emits upsert events for every row that existed before 0.4.0 in complete bounded commit groups, so there is no separate snapshot endpoint and the first pull never observes a partial group.

### §12.4 Proposed server metadata

These are infrastructure collections, not new finance fields. Rules stay `null`; only the BFF superuser touches PocketBase. The proposed migrations are `1700000018_create_sync_collections.js` (bare collections), `1700000019_add_sync_fields.js` (`fields.add`, because PocketBase 0.40.6 does not persist inline constructor fields), `1700000020_add_sync_indexes.js`, and `1700000021_snapshot_import.js`. Migration 0021 creates only the private `obol_sync_snapshot_imports` receipt collection and adds four optional fields to the station collections created by 0018-0020: `obol_station_state.pendingImport` JSON at most 12 MiB, `obol_station_versions.baseRecord` JSON at most 1 MiB, `obol_station_versions.serverDeleted` bool, and `obol_station_outbox.acknowledgement` JSON at most 2 MiB. It never edits an applied 0018-0020 migration and adds no finance field.

| Collection | Proposed fields | Proposed indexes |
|---|---|---|
| `obol_sync_meta` | `serverInstanceId` text required, `dataEpoch` number required, `protocolMin` number required, `protocolMax` number required, `lastSeq` number required, `headHash` text required, `journalBackfilledAt` date optional, `journalBackfillVersion` number optional | singleton by convention |
| `obol_sync_entity_versions` | `entityType` text required, `entityId` text required, `revision` number required, `deleted` bool, `lastSeq` number | unique `(entityType, entityId)`, index `lastSeq` |
| `obol_sync_changes` | `seq` number required, `commitId` text required, `commitIndex` number required, `commitSize` number required, `kind` select `upsert`/`delete`, `entityType` text, `entityId` text, `revision` number, `record` json optional, `origin` select `station`/`web`/`job`/`admin`/`sync`/`seed`, `stationId` text optional, `opId` text optional, `eventKey` text optional, `createdAt` date required, `prevHash` text required, `chainHash` text required | unique `seq`, unique `chainHash`, index `eventKey`, index `createdAt`, unique `(commitId, commitIndex)` |
| `obol_sync_operations` | `opId` text required, `stationId` text required, `protocolVersion` number, `type` text, `entityType` text, `entityId` text, `payload` json, `payloadHash` text (complete-envelope hash), `baseRevisions` json, `dependsOn` json optional, `effectiveAt` date required, `clientCreatedAt` date required, `status` select `accepted`/`conflict`/`rejected`, `result` json optional, `conflict` json optional, `receivedAt` date required | unique `opId`, index `stationId, receivedAt` |
| `obol_sync_stations` | `stationId` text required, `deviceLabel` text, `platform` select `ios`/`macos`/`windows`, `firstSeenAt` date, `lastSeenAt` date, `lastCursor` number | unique `stationId` |
| `obol_sync_snapshot_imports` | `importId` text required (UUIDv7), `stationId` text required (UUIDv7), `payloadHash` text required (at most 50 characters), `serverInstanceId` text required (UUIDv7), `dataEpoch` number required (positive integer), `result` json required (stored original import response), `createdAt` date required | unique `importId`; index `stationId` |
| `obol_station_outbox` (local only) | `opId` text required, `protocolVersion` number, `type` text, `entityType` text, `entityId` text, `payload` json, `payloadHash` text (complete-envelope hash), `baseRevisions` json, `dependsOn` json optional, `effectiveAt` date required, `clientCreatedAt` date, `beforeSnapshots` json optional, `status` select `queued`/`in_flight`/`accepted`/`conflict`/`rejected`, `acknowledgement` json optional (minimal accepted causal receipt, at most 2 MiB), `attempts` number, `lastError` text optional, `createdAt` date, `updatedAt` date | unique `opId`, index `status, createdAt` |
| `obol_station_state` (local only) | `serverUrl` text, `serverInstanceId` text, `ownerFingerprint` text, `stationId` text, `cursor` number, `lastChainHash` text, `dataEpoch` number, `protocolVersion` number, `mode` select `standalone`/`station`, `pendingImport` json optional (at most 12 MiB) | singleton by convention |
| `obol_station_conflicts` (local only) | `opId` text required, `conflict` json, `resolution` select `pending`/`server`/`retry`/`discarded`, `createdAt` date, `updatedAt` date | unique `opId` |
| `obol_station_versions` (local only) | `entityType` text required, `entityId` text required, `serverRevision` number, `localRevision` number, `deleted` bool (optimistic-local deletion only), `serverDeleted` bool (server-side tombstone), `baseRecord` json optional (full latest remote base row, at most 1 MiB) | unique `(entityType, entityId)` |

The `obol_station_*` tables are created by migrations 0018-0020, with the four optional fields above added by 0021, and exist empty on a central deployment. Only a desktop local BFF uses them.

`obol_sync_snapshot_imports` is private metadata, not a finance field: its seven fields plus the system id are the receipt that makes `POST /api/sync/import` idempotent. A committed import means exactly one receipt row (one `importId`, one complete six-field `payloadHash`, one `serverInstanceId`, one positive integer `dataEpoch`, one `stationId`, one original `result` JSON, one `createdAt`). The import is valid on an empty or populated server and writes the client's frozen all-new-id snapshot, with every reference already rewritten; the server never mints or rewrites ids. A retry with the same `importId`, hash, station, and identity tuple replays the stored result; different frozen content under the same `importId` is `IMPORT_ID_REUSED`; any collision with an existing finance id is `IMPORT_ENTITY_ID_TAKEN` and rejects the whole request with no finance row, revision, journal event, or receipt written. The path never merges by existing id, overwrites, replays a partial operation log, recomputes a balance, invoice total, or paid history, converts a realized fact to silent, or dedupes equal payments. Receipt rows are created in the same PocketBase transaction as the imported finance rows, their revision-1 rows, and the journal commit; they are cleared when an administrative reset increments `dataEpoch`. The desktop `obol_station_state.pendingImport` checkpoint (at most 12 MiB) records the coherent pre-network import commit: the remapped fresh-ID snapshot, the immutable `importId`, the six-field hash, the complete request body, the covered original local `opId`s, and the identity tuple. The namespace remap, every reference rewrite, the station binding, and the checkpoint commit in one local transaction; a crash leaves all of them or none. The checkpoint is written before any network call, is never a source of tokens or secrets, is removed only after the accepted result is applied locally, and survives reauthentication, restart, and transport failure so the same import resumes; an uncertain marker is never cleared just to start a different import. Native iOS holds the same checkpoint in its SQLite state instead of the `pendingImport` JSON.

Desktop replica persistence survives a crash without inventing a merge: `obol_station_versions.serverDeleted` is the server-side tombstone and stays distinct from `deleted`, which only records an optimistic-local deletion, and `serverRevision`/`localRevision` stay separate counters. Pulling a newer remote base stores its complete row in optional `obol_station_versions.baseRecord` (at most 1 MiB), and its tombstone in `serverDeleted`, without overwriting an unaccepted local optimistic row; after a crash the station reconstructs the base and pending layers exactly: accepted remote base from `baseRecord`, local intent from the outbox, and no remote base is silently applied over an unaccepted local write, which would be last-writer-wins. `beforeSnapshots` retains only the pre-mutation local state and cannot retain the newer remote base, so `baseRecord`, not a snapshot, is the durable remote-base input for reconstruction. The local version plan upserts the union of the operation's working writes and the received base keys once per transaction; an ordinary local write increments `localRevision` and does not clobber `serverRevision`, `serverDeleted`, or `baseRecord`, while a base-only update preserves `localRevision`. Inbound transaction metadata commits through the same unit-of-work metadata batch as the working rows and base overrides. When an accepted push result arrives, `obol_station_outbox.acknowledgement` (at most 2 MiB) stores ONLY the minimal causal receipt: `opId`, commit id, seq bound, and the per-entity versions the server assigned. It never stores whole entity records and never tokens. An accepted row stays in the outbox until no dependent pending operation still needs its causal versions, then the row and its receipt are removed together.

No change is proposed to §§3-8 fields or rules. Entity revisions and tombstones live outside the finance collections. iOS keeps base records with `serverRevision`, `localRevision`, and a deleted flag plus `sync_outbox`, `sync_conflicts`, `sync_state`, and `sync_applied_ops` in one SQLite database. Desktop keeps finance rows and `obol_station_outbox`, `obol_station_state`, `obol_station_conflicts`, and `obol_station_versions` in local PocketBase, so a station mutation and its outbox operation commit in one batch. No sync columns are added to finance collections. `baseRevisions` on the wire always uses `serverRevision`.

`obol_station_state.cursor` and `sync_state.cursor` always store a commit boundary. A persisted mid-group cursor is invalid and is rejected at handshake (`CURSOR_NOT_ON_COMMIT_BOUNDARY`), never silently advanced.

The BFF must configure and verify PocketBase batch capability at boot through the authenticated settings API, patching only the `batch` subset so unrelated SMTP/meta settings survive, never logging secrets, and failing closed instead of falling back to non-atomic single writes. Verified pinned baseline on 2026-10-31: an untouched default is `batch = { enabled: false, maxRequests: 50, timeout: 3, maxBodySize: 0 }` (bytes); in an isolated proof volume, `{ enabled: true, maxRequests: 60000, timeout: 30, maxBodySize: 50331648 }` made a forced second-collection failure roll the first write back, and a two-collection batch then committed atomically (<https://pocketbase.io/docs/api-records/#batch-createupdateupsertdelete-records>, <https://pocketbase.io/jsvm/interfaces/core.BatchConfig.html>). The manual isolated setting is not a product fix, and desktop standalone depends on the same capability from its managed local PocketBase child. Per-commit limits stay inside that capacity: at most 10,000 entity events per commit, push 100 ops / 1 MiB / 64 KiB per op, seed 10 MiB / 10,000 rows.

The native iOS target is one SQLite database holding finance rows and the outbox/pending layer in one transaction. `app/ios/ObolCore` is today a Foundation-only package whose `LocalStore.swift` is an atomic-JSON snapshot backend; it is not the SQLite/outbox store, and the finance models and engine are not duplicated into `app/ios/App/App/Core`. App integration replaces the JSON backend at cutover.

### §12.5 Client durability and lifecycle

- A local mutation writes its optimistic effect, the complete operation envelope, and its `payloadHash` in one local transaction before any network call.
- `opId` is generated on the client and never changes. Creates use a client-generated 15-character lowercase alphanumeric entity id. A deleted id is never reused. A corrected, rebased, or re-identified intent is a new operation with a new `opId`; an envelope is never edited after its first send.
- `effectiveAt` is captured when the user performs the financial action and stored with the pending operation. It is never recomputed from the sync time.
- The outbox is durable across relaunch. An operation marked `in_flight` returns to `queued` at launch.
- Push results and pull pages commit to the local store atomically with the cursor and the last chain hash. A crash before commit leaves the cursor unchanged; a retry is safe.
- Before applying a page, the client validates contiguous `seq`, complete commit groups (`commitIndex` 0..`commitSize`-1 per `commitId`), a constant `commitSize`, and `prevHash` continuity. A malformed or partial page is rejected and nothing is applied.
- The cursor and last chain hash advance only to a commit boundary.
- A kill after the server commits but before the client records the result causes a retry. The server returns `duplicate`; the effect is not repeated.
- A pull event whose revision is not greater than the local `serverRevision` is ignored.
- Multiple offline edits to one entity serialize locally. A newer operation depends on the older unaccepted operation and is sent only after that result, with refreshed base revisions. The client does not predict a server revision.
- A server-created entity id the client did not choose (an internal invoice or a project payment transaction) replaces the optimistic local id, and dependent pending operations have their `entityId`, `baseRevisions`, and payload references rewritten before the next pull.
- A pull event that would invalidate a pending operation creates a preemptive conflict. The client does not overwrite the pending optimistic row.
- A conflict marks dependents `blocked`. It never silently drops them.
- The local store is the read model. Native iOS does not call business `GET` endpoints after pairing.

### §12.6 Pairing, endpoint, and token rules

| Local data | Server data | Allowed outcomes |
|---|---|---|
| empty | empty | pair and pull an empty baseline |
| operation log, any rows | empty | import the complete settled snapshot as client-minted all-new-id records (`POST /api/sync/import`), or discard local with typed confirmation |
| legacy rows, no operation log | empty | seed the empty server with a validated snapshot, or discard local with typed confirmation |
| empty | non-empty | use server data |
| operation log, any rows | non-empty | import the complete settled snapshot as client-minted all-new-id records with rewritten references (`POST /api/sync/import`), or replace local with server data with typed confirmation |
| legacy rows, no operation log | non-empty | no merge: use server data after export, or stay standalone |

There is no automatic merge and no heuristic deduplication in 0.4.0, and equal amounts, cards, or periods never dedupe payments: two distinct legitimate payments can be equal. A 0.4.0 client records every local mutation in its outbox even when unpaired. A never-paired standalone profile with local finance and a recorded operation log imports through `POST /api/sync/import` whether the server is empty or populated; the queue length is never treated as proof of a complete history, and a queue count never substitutes for the materialized snapshot. The client mints fresh 15-character lowercase alphanumeric ids for every imported entity and rewrites every reference (including `invoice_id`, `source_invoice_id`, and `recurrence_id`) before freezing the six-field hash; `stationId`, `opId`, and `importId` keep their own UUID namespaces. The transfer carries the complete settled snapshot — all seven finance collections, including paid and partial invoices — as exactly-once all-new-id rows under one frozen `importId` and hash. It never replays the original queue or a partial operation log, reconstructs from incomplete historical operations, merges by existing id, overwrites an existing row, turns realized facts silent, invents an opening balance, recomputes paid history, or dedupes payments by equal amount. The server validates the frozen request and never mints or rewrites an imported id. On acceptance the client adopts revision-1 baselines, retires only the covered old operations, preserves local operations created after the checkpoint, strips covered dependencies only from never-sent later operations, advances only their causal own base versions, and does not advance the pull cursor from the import response. A failure or collision leaves local finance and the server unchanged. After the import, ordinary local mutations push as the unchanged 18 operation types. A 0.3.0 desktop database has no operation log, so it keeps `POST /api/sync/seed` exact-ID semantics against an empty server and cannot merge into a non-empty one, where it must use server data or stay standalone. A 0.4.0 never-paired profile with local finance and a recorded operation log uses `/import` on either server state. The wizard reports operation and entity counts and warns about locally generated recurrence months the server may also generate.

Destructive `Use server data` and discard require the typed `REPLACE` confirmation plus a completed export receipt that the backend verifies at confirmation. A real native save dialog and successful filesystem write are required; a canceled or failed save yields no receipt, and a Blob click or download start is never a completed export. The export contains finance data and pending intents but no tokens or secrets; its receipt excludes `exportedAt` and invalidates if the data, outbox, or binding changes.

The local store binds to `(serverUrl, serverInstanceId, ownerFingerprint, stationId)`.

- A different instance or owner fingerprint is `ENDPOINT_MISMATCH`. Pending operations never reach the new endpoint; the outbox is preserved until an explicit re-pair. Re-pair offers seed-if-empty, use-new-server-data, or stay-on-old-server; it never replays a partial outbox.
- A URL change that resolves to the same instance and owner is allowed. Running two live copies of one instance id is unsupported; moving a deployment keeps the instance id and is allowed only with one live authority.
- A station id is not derived from a token, session, email, or device name. Rotating a session does not create a new station. Running two live copies of one station id is unsupported.
- iOS stores the bearer token and station id in the Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. The local database uses iOS Data Protection and is excluded from iCloud backup so a restore does not clone the station id, cursor, or outbox. No additional at-rest encryption is claimed.
- Desktop remote mode keeps the Bearer token in WebView `localStorage` per D009 D9. The Bun sync process receives it over RPC and holds it in memory only. The station binding lives in `obol_station_state` inside local PocketBase; no station file contains a token.
- A `401` or `SESSION_EXPIRED` stops sync and preserves the local store and outbox. It never deletes local finance.
- TLS is required except for the documented development override. Tokens never appear in URLs, logs, analytics, or operation payloads.

### §12.7 Time authority and finance semantics

- Canon §§3-8 remain the finance contract. Native clients port the rules; they do not redefine them. §13 records the 0.4.0 clarifications and the named corrections; where §13 is more specific, it governs the parity target.
- The Swift engine and the TypeScript use cases consume the same `shared/finance-parity/` fixtures. A mismatch is a release blocker.
- The server result replaces the optimistic local result after acceptance. A local engine value never survives in place of an accepted server value.
- Server use cases that date a realization, invoice payment, project payment, or recurrence launch take that date from an injected domain clock or scoped operation clock instead of calling `Date()` directly. Web, cron, and online admin actions use the server clock; a sync operation seeds the clock from `effectiveAt`. Replaying at reconnect never moves an offline realization or payment to the reconnect date. `effectiveAt` never decides ordering or conflict precedence, and financial date validation keeps the existing DTO rules.
- When a desktop station or iOS store is paired, its automatic recurrence and invoice reconciliation jobs are disabled locally. The central server runs the daily scheduler and its changes arrive by pull.
- An unpaired client is the sole authority for its local store and still records every local mutation in its outbox. Desktop standalone keeps its scheduler; the iOS store runs the local recurrence processor on launch and foreground. Pairing replays those operations explicitly and warns about months the server may also generate. After pairing, automatic local generation stops.
- A scheduler-generated transaction from an unpaired client is queued as a `transaction.create` whose payload extends `TransactionDTO` with the canonical `recurrence_id` and requires `is_recurring: true`. The payload carries no `invoice_id`; on replay the server validates the recurrence and occurrence and routes any card invoice from `expected_date`, exactly like the public DTO, rejecting an already-generated month with `RECURRENCE_MONTH_EXISTS`. A scheduler-generated occurrence reconstructs `expected_date` from its recorded `purchase_date`; `purchase_date` is an optional redundant date that must agree with `expected_date` when supplied.
- Manual `recurrence.launch` is a sync operation. The server's idempotency rule still decides whether a month already exists.
- Administrative reset and job triggers are online-only. They are not sync operations.

### §12.8 Deletions, reset, and restore

- Deletion keeps the physical PocketBase delete and writes, in the same commit, a `delete` change event and a `deleted = true` version row. The journal is the durable tombstone. The accepted operation result lists the deleted entity with its tombstone revision and `record: null`, so the client removes the accepted base row and its outbox intent in one local transaction.
- Deleting a transaction also emits `upsert` events for every account, invoice, and recurrence it changes, in the same commit group (`commitId`, contiguous `commitIndex`, `commitSize`), so a page boundary never exposes half a delete.
- A create with an id whose version row is deleted is `ENTITY_ID_TAKEN`.
- Administrative reset increments `dataEpoch` in its own commit before the first delete batch, then clears financial rows in bounded mutation batches and emits delete events. It preserves the owner, sessions, and operation history. A station with pending operations must explicitly discard or re-enter them after `DATA_EPOCH_CHANGED`. The reset also clears the `obol_sync_snapshot_imports` receipts and any `obol_station_state.pendingImport` checkpoint: an import committed under the old epoch must not be replayed or resumed as if it belonged to the new one.
- A backup restore restores `serverInstanceId`, `dataEpoch`, `lastSeq`, `headHash`, journal, and operation results. A station whose cursor is greater than the restored server's cursor stops with `SERVER_ROLLBACK_DETECTED` and keeps its outbox. A station whose cursor is not greater but whose `clientCursorHash` does not match the server event at that cursor also stops with `SERVER_ROLLBACK_DETECTED`. It never pushes into a rolled-back server.
- Journal compaction is not part of 0.4.0. The unbounded journal is accepted for one owner and personal-scale data.

### §12.9 Release gates

The 0.4.0 target is not current until all of these are observed:

- D016 accepted after its twelve implementation gates pass.
- PocketBase batch capability configured and verified at boot through authenticated settings, with the rollback and successful two-collection commit observed through product configuration rather than a manual volume setting.
- Named tests for complete-envelope idempotency and operation-target reuse, commit-group page-boundary atomicity, and offline economic time (`effectiveAt`) after replay.
- E007 tickets complete with no scaffolds.
- Fresh self-hosted deployment and upgrade from a 0.3.0 database with preexisting rows.
- Hosted web and Coolify remain functional on a single-writer deploy strategy.
- Offline volume backup and restore, including rollback detection.
- Legacy empty-server seed exactness and refusal on a non-empty server or second attempt.
- Settled snapshot import exactness: a never-paired local profile imports all seven collections into an empty or populated server with client-minted all-new 15-character ids and every reference rewritten; the six-field hash is frozen before the request; same `importId`/hash/station/identity replays the stored result, `IMPORT_ID_REUSED` and `IMPORT_ENTITY_ID_TAKEN` reject whole with no server change, paid and partial invoices survive, the receipt and finance rows commit atomically, lost-response/restart plus post-checkpoint local changes converge, the pull cursor does not advance from the import response alone, and a reset clears the receipt and checkpoint.
- Offline, relaunch, reconnect, duplicate, conflict, delete, endpoint-switch, and crash matrices on iOS and desktop.
- All 21 E003 dashboard scenarios on hosted web and desktop, with native equivalents on iOS.
- Native iOS simulator launch, and TestFlight archive/export/upload or a named missing Apple credential.
- macOS arm64/x86_64, Windows x64, and iOS artifacts with consistent 0.4.0 versions and checksums.
- Windows runtime smoke or a recorded `BLOCKED (no Windows x64 runtime)`.
- No secrets, dumps, build outputs, or signing material committed.
- No requested capability or operation allow-list entry is dropped to declare 0.4.0 complete; a failing gate is fixed.

A missing runtime is recorded as a blocker. It is never reported as a pass.

## §13 0.4.0 financial policy clarifications

> **Target rule.** This section is the authoritative clarification of §§4-8 for the 0.4.0 parity and native work. Where an inherited requirement, fixture, or current implementation disagrees with §13, §13 governs and the mismatch is a defect to fix. It appends; it does not rewrite the earlier sections. It does not rename fields or add finance schema. `shared/finance-parity/` is the executable form of these rules.

### §13.1 Cash snapshot and end-of-day timeline

- "Current cash" is the actual snapshot: the sum of current non-investment account `initial_balance` values. Investment accounts stay outside it.
- The forecast timeline is **end-of-day** cash. Past days reconstruct only realized, non-silent real effects. Today and future days include projected obligations. The starting point is the current cash snapshot, rolled back to the requested start date.
- Current cash and today's timeline point need not be equal. They differ when today has pending obligations, an unpaid invoice falling due, or another projected event.
- Every surface that quotes a balance labels it current or projected, and names the projection horizon. A bare balance is not allowed.
- The inherited E003 guardrail 8 and scenario E3-08 equated current cash with today's timeline unconditionally. That equality was wrong. The corrected requirement compares the actual non-investment cash snapshot with the end-of-day projection and explains any difference by today's projected events for the same `includeSimulations` and range settings. It is not waived.

### §13.2 Overdue obligations and past reconstruction

- A still-unpaid obligation past its stored date is projected conservatively on **today**. This covers overdue pending transactions and unpaid invoices. The stored `expected_date` or `due_date` is never changed, and the row is never marked realized.
- Reason: the run replaces the old server-drop/native-carry divergence with one complete view of obligations that remain unpaid. It does not silently redate a record or mutate a real account.
- Past reconstructed days contain only realized, non-silent real effects. They never contain pending rows or unpaid invoice deductions.
- An unpaid invoice due before today is projected on today, not at its stored past date inside the reconstruction window. Its `upcoming_invoices` entry keeps the stored due date and `OPEN` status.

### §13.3 Unassigned rows, simulations, and investment isolation

- `account_id` and `card_id` are optional. A valid pending income or expense without an assigned account still affects aggregate cash on its `expected_date`. A scheduled item may be unassigned. See `app/components/FastEntryModal.vue:53,70,86-95,193`.
- Included what-if simulations follow the same aggregate rule when `includeSimulations` is true.
- A realized row without an account, such as a project payment recorded without a cash account, changed no account and must not invent a historical cash movement. It is ignored by both the rollback and the realized-day walk.
- Transactions explicitly assigned to an investment account do not affect the liquid-cash forecast.
- A transfer between liquid accounts is neutral. A transfer into or out of an investment account moves liquid cash by only the liquid side, while total net worth is preserved.

### §13.4 Simulation purity and write semantics

- Simulations never mutate real cash or physical invoice totals. Realization requires an explicit conversion to a non-simulated row first.
- Conversion, edit, and delete reverse only genuine financial effects, then apply the new effect. A partial patch is evaluated against the stored record plus the patch, not only the fields repeated in the patch.
- Scheduled and silent semantics stay as in §4: `is_scheduled` marks an agenda item and is cleared on realize; `is_silent` realize changes no balance.
- Missing or identical transfer accounts and conflicting account/card origins are validated before any write.
- Errors propagate. A persistence or invoice/recurrence adjustment failure aborts the command; it is not logged and ignored.

### §13.5 Money precision

- Currency is stored and computed at two decimal places. An exact half rounds toward positive infinity: `1.005` becomes `1.01`, `-1.005` becomes `-1.00`, and `10.075` becomes `10.08`.
- The writer stores the rounded amount and moves exactly the stored amount, so the row and the balance never disagree.
- The Swift `Decimal` implementation in `app/ios/ObolCore/Sources/ObolCore/Models.swift` is the exact reference.
- `server/src/domain/utils/mathUtils.ts` rounds from the shortest decimal form of the number, so `1.005 * 100` is not evaluated in binary floating point; it uses no decimal dependency and must keep the three boundary tests. Any future replacement keeps the same contract.
- Adapters pass raw subcent inputs into real product code and compare the product's decimal output. They never pre-round an input or rewrite an output to pass a fixture.

### §13.6 Cards, invoices, and recurrences

- A card purchase and an active card recurrence affect cash only at the invoice due date, never directly on the purchase date or payday. Actual and projected invoice children are not counted twice.
- Closing-day and year rollover keep the §5 `calculateCardDueDate` semantics.
- The native `cardInvoiceSummaries` projection is product behavior. It must build the real projected invoice timeline, including the virtual next-period `PROJECTED` row, from active card recurrences. It is not adapter work.
- Persisted invoice status stays `OPEN`, `CLOSED`, or `PAID`. A projection status is separate from the persisted status.
- Recurrence dates are UTC and clamped to the month length. An ended recurrence cannot be launched manually. Pause, resume, and manual launch otherwise keep §6 behavior. End-date, finite-installment, and skipped-period generation stays idempotent.

### §13.7 Clock injection

- Every date-sensitive server use case receives an injectable clock with `now()` returning an ISO UTC string. One default implementation uses the system clock.
- The unit of work overrides that clock with the operation's `effectiveAt` for sync replay. Web, cron, and online admin actions use the server clock.
- Do not mutate a global fake time or rely on ambient clock state. Offline replay preserves the actual business event time; it never moves a realization, payment, project payment, or recurrence launch to the reconnect date.
- A financial date that fails the existing DTO rules is rejected, not silently replaced.

### §13.8 Projects and budgets

- Project paid totals count realized, non-simulated income rows only. Payments never change `total_value`; `remaining` is `total_value - paid`.
- Budget accrual deliberately keeps the current planned-budget semantics, including pending and simulated transactions, with `spent` = expenses minus incomes on `purchase_date` when set, otherwise `expected_date`.
- The budget UI must state that the basis is planned and includes pending and simulated rows. A new budget query or mode switch is not required for 0.4.0.
- The confirmed budget fixture `410.50` is correct: `120.50 - 50.00 + 300.00 + 40.00`. The `40.00` simulated row stays; it is not removed to simplify a label.
