# D016 - Native offline clients and server-authoritative synchronization

**Status**: proposed · **Date**: 2026-10-31 · **Target release**: 0.4.0 · **Related**: [E007](../epics/E007-native-offline-040.md), [D005](D005-electrobun-local.md), [D007](D007-local-profile-unlock.md), [D008](D008-central-server-clients.md), [D009](D009-remote-identity.md), canon [§12](../canon.md)

> This decision is proposed. Nothing in it is implemented today. Current behavior remains E006: the iOS client is a Capacitor WebView around the Nuxt UI, the desktop app has local and remote modes, and no client synchronizes data with a server (D008). The contract below becomes current only when E007 ships and this decision is accepted.
>
> Foundation that does exist on 2026-10-31 is listed in E007 "Current verified foundation": a Foundation-only `app/ios/ObolCore` Swift package (five files: `Package.swift`, `Models.swift`, `FinanceEngine.swift`, `ForecastEngine.swift`, `LocalStore.swift`) and no sync, revision, journal, or batch capability anywhere. Those files are the verified foundation; the wire and persistence contract below remains the unimplemented 0.4.0 target.

## Context

Obol has three data surfaces today:

| Surface | Current fact | Source |
|---|---|---|
| iOS | Capacitor 8 wraps the Nuxt/Vue UI; credentials live in the Keychain; there is no native SwiftUI UI and no on-device financial store | `app/ios/App/App/AppDelegate.swift`, `app/ios/App/App/SceneDelegate.swift`, `app/capacitor.config.ts`, E006 |
| Desktop local | Electrobun 2.0.5 starts a managed PocketBase child at `Utils.paths.appData/copland.obol/pb_data` and runs Elysia in process | `desktop/electrobun/bun/index.ts`, D005, D007 |
| Central server | The BFF is the only data path; one owner; Bearer sessions or the hosted cookie; PocketBase is private | `server/src/infrastructure/plugins/remoteAuth.ts`, D008, D009 |

The 0.4.0 target adds a native SwiftUI iOS app with durable offline finance and explicit later synchronization, and adds synchronization to desktop local mode. The server stays authoritative. That requires a contract that does not exist today:

- Every business write goes through one use case, but a use case can perform several repository calls. `CreateTransactionUseCase` mutates an account and creates a transaction. `PayInvoiceUseCase` debits an account, creates a payment transaction, updates an invoice and realizes child transactions. `DeleteTransactionUseCase` reverts balances, adjusts an invoice, appends `skipped_periods`, then deletes the transaction, and currently logs invoice/recurrence failures instead of aborting (`server/src/application/use-cases/transactions/DeleteTransactionUseCase.ts`).
- Repositories call PocketBase directly and do not share a transaction. There is no revision, operation journal, tombstone, or idempotency key in any collection or repository.
- Deletes are physical (`PocketbaseDatabaseMaintenanceRepository.clearFinancialData()` and every repository `delete`), so a deleted row cannot be discovered by a later reader.
- Client writes in local desktop mode are applied by the local BFF only. No mechanism carries them to a central server, and D008 explicitly forbids implicit synchronization.
- There is no rule for two devices that edit the same financial entity while offline.

A synchronization design that copies rows in both directions would either lose writes or invent a last-writer-wins rule. Both are unacceptable for balances, invoices, recurrence periods, and transfers. This decision selects an operation protocol with explicit revisions and explicit conflicts.

## Decision

### D1 - The server is the only authority for applied financial state

A paired client keeps a local working copy for offline reads and writes. Only the BFF applies canonical mutations. Synchronization is not peer-to-peer merge, not row overwrite, and not a conflict-free replicated data type. Every accepted change is computed by the same application use cases that serve hosted web, desktop local, and the scheduler.

Consequences:

- Client projections are optimizations and offline previews. A server acceptance replaces the optimistic result.
- A client never computes a canonical account balance, invoice total, or recurrence period for another client. It computes the same values locally for immediate UI and for its optimistic operation, and the server result is authoritative.
- The protocol is server-authoritative even when the server is unreachable. Offline writes are durable intents that wait for acceptance.
- A local BFF that is not a central authority (desktop standalone or station) may run with the remote journal disabled. It still uses the mutation gate and unit of work for local atomicity. Station mode records into `obol_station_outbox` plus local revision rows; the native iOS store uses its own `sync_outbox`. Neither needs to be a journal authority.

### D2 - Operations are immutable, client-created, and idempotent

Each user-visible mutation becomes one operation:

```json
{
  "opId": "018f3b7e-6a2c-7c31-9f6e-2f0f9f6c1a11",
  "stationId": "018f3b7e-6a2c-7c31-9f6e-2f0f9f6c1a10",
  "protocolVersion": 1,
  "type": "transaction.realize",
  "entityType": "transaction",
  "entityId": "k3m9x2q7b1c8d4e",
  "baseRevisions": {
    "transaction:k3m9x2q7b1c8d4e": 4,
    "account:7h2p9q1m4x8c6v3": 7
  },
  "dependsOn": [],
  "payload": { "update_balance": true },
  "clientCreatedAt": "2026-10-31T12:00:00.000Z",
  "effectiveAt": "2026-10-30T09:15:00.000Z",
  "payloadHash": "sha256:..."
}
```

Rules:

1. `opId` is a UUIDv7 generated on the client before the local write. It is persisted with the local effect and never changes. A corrected or rebased intent is a new operation with a new `opId`; an accepted `opId` is never re-used for different content.
2. `stationId` is a durable UUID created once per installation and stored separately from the session token.
3. `entityId` is a 15-character lowercase alphanumeric PocketBase-compatible id generated on the client for creates. Existing entities reuse their server id.
4. `baseRevisions` names every existing entity the operation may write, with the revision the client observed. Creates set no base revision for the created entity. Before the first send, a still-queued operation may acquire dependency-derived base revisions and persist its final envelope and hash; after the first send the envelope is immutable.
5. `dependsOn` lists operations that must be accepted first. A create of a transaction that references an account created offline depends on the account create.
6. `clientCreatedAt` is audit data only. It never orders operations and never resolves a conflict.
7. `effectiveAt` is the business event time of the user's financial action: an ISO UTC timestamp captured locally when the user creates, realizes, pays, records a project payment, or launches a recurrence. It is supplied by the client on every operation and is never replaced with the reconnect time. It is business event time only; it never orders operations, never assigns revisions, and never decides a conflict.
8. The server stores the first accepted envelope hash for an `opId` and its result. A retry with the same `opId` and the same envelope hash returns the stored result without re-applying effects. A retry with a different envelope hash is rejected as `OP_ID_REUSED`. `payloadHash` keeps its name for wire compatibility but covers the complete envelope (rule 9), not the payload alone.
9. `payloadHash = "sha256:" + unpadded base64url(SHA-256(canonical envelope JSON))`, where the canonical envelope is exactly the eleven fields `protocolVersion, stationId, opId, type, entityType, entityId, payload, baseRevisions, dependsOn, clientCreatedAt, effectiveAt`. The transmitted `payloadHash` field itself is never part of that hashed input; a hash never covers itself. Canonical JSON sorts object keys recursively at every depth, emits UTF-8, contains no insignificant whitespace, and uses standard JSON scalar encoding. Every envelope field is present in the hashed form; an absent optional `dependsOn` is encoded as `[]`, never omitted. The same `sha256:` + unpadded base64url(SHA-256(bytes)) form is used for every hash on the wire and in storage (`payloadHash`, `chainHash`, `prevHash`, `headHash`, `cursorHash`, `ownerFingerprint`, record hashes). The empty genesis hash at `seq = 0` is the empty string, not a hash of empty bytes. Interoperability fixtures pin decimals, `null`, unicode, escaping, and negative zero so TypeScript, Swift, and Bun produce identical bytes.

Supported operation types map one-to-one to existing use cases. No operation patches arbitrary fields.

| Operation type | Use case | Writes |
|---|---|---|
| `account.create` | `CreateAccountUseCase` | account |
| `card.create` | `CreateCardUseCase` | card |
| `card.update` | `UpdateCardUseCase` | card |
| `category.create` | `CreateCategoryUseCase` | category |
| `project.create` | `CreateProjectUseCase` | project |
| `project.payment` | `RegisterPaymentUseCase` | transaction |
| `project.complete` | `CompleteProjectUseCase` | project |
| `recurrence.create` | `CreateRecurrenceUseCase` | recurrence |
| `recurrence.update` | `UpdateRecurrenceUseCase` | recurrence |
| `recurrence.delete` | `DeleteRecurrenceUseCase` | recurrence (status `ended`) |
| `recurrence.toggleStatus` | `ToggleRecurrenceStatusUseCase` | recurrence |
| `recurrence.launch` | `LaunchRecurrenceUseCase` | transaction, invoice |
| `transaction.create` | `CreateTransactionUseCase` | transaction, account(s), invoice |
| `transaction.update` | `UpdateTransactionUseCase` | transaction, account(s), invoice |
| `transaction.realize` | `RealizeTransactionUseCase` | transaction, account(s) |
| `transaction.delete` | `DeleteTransactionUseCase` | transaction, account(s), invoice, recurrence |
| `invoice.pay` | `PayInvoiceUseCase` | invoice, account, transaction, child transactions |
| `invoice.delete` | `DeleteInvoiceUseCase` | invoice, child transactions, recurrence |

Not synchronizable:

- `GET` and projection endpoints (`/api/forecast`, `/api/categories/budgets`, summaries). Clients compute or read them locally. The SwiftUI client does not call business `GET` endpoints after pairing; its local store is the read model.
- `ResetFinancialDataUseCase` and `POST /api/jobs/*`. They are online-only administrative actions. A reset emits deletions and advances the data epoch (D12).
- `POST /api/sync/seed`. It is a one-time empty-server migration, not an operation, and is never available after the server has financial data.
- `SyncInvoiceUseCase` is internal to transaction operations and the scheduler, never a client operation.
- Automatic monthly recurrence processing. Only the authority runs it (D13).

Entity type names are singular: `account`, `card`, `category`, `invoice`, `project`, `recurrence`, `transaction`. Collection names stay plural in PocketBase.

Operation payloads reuse the existing HTTP DTO shapes, with one sync-only exception: a scheduler-generated `transaction.create` payload adds the canonical `recurrence_id` that the public `TransactionDTO` does not expose. The operation table below is the complete mapping; no other field names are invented, no finance collection gains a field, and no migration changes.

| Operation type | `entityId` | `payload` |
|---|---|---|
| `account.create` | new account id | `AccountDTO` |
| `card.create` | new card id | `CardDTO` |
| `card.update` | card id | partial `CardDTO` |
| `category.create` | new category id | `CategoryDTO` |
| `project.create` | new project id | `ProjectCreateDTO` |
| `project.payment` | project id | `ProjectPaymentDTO` |
| `project.complete` | project id | empty |
| `recurrence.create` | new recurrence id | `RecurrenceDTO` |
| `recurrence.update` | recurrence id | partial `RecurrenceDTO` |
| `recurrence.delete` | recurrence id | empty |
| `recurrence.toggleStatus` | recurrence id | `{ "status": "active" \| "paused" }` |
| `recurrence.launch` | recurrence id | empty |
| `transaction.create` | new transaction id | `TransactionDTO`, plus canonical `recurrence_id` when scheduler-generated |
| `transaction.update` | transaction id | partial `TransactionDTO` |
| `transaction.realize` | transaction id | `{ "update_balance": true \| false }` |
| `transaction.delete` | transaction id | empty |
| `invoice.pay` | invoice id | `{ "period": "YYYY-MM", "account_id": "...", "amount_paid": 123.45, "ignore_balance": false }` |
| `invoice.delete` | invoice id | `{ "card_id": "...", "period": "YYYY-MM" }` |

A payload `id` field is ignored. The record id for a create is always `entityId`.

An operation is created by the mutation boundary, not by each repository write. In station mode, `executeUseCase` maps the use-case token and arguments to one operation descriptor (`type`, `entityId`, `payload`, `baseRevisions`). The scheduler supplies descriptors for generated transactions and recurrence status changes. Internal invoice, account-balance, and reconciliation writes are effects of that operation, not separate operations.

A scheduler-generated `transaction.create` is the only operation whose payload extends a public DTO; it remains `transaction.create`, with no extra operation type. The payload adds the canonical `recurrence_id` (the recurrence's accepted server id; if that id is not yet known, the operation is an unpaired scheduler intent whose local id is remapped to a fresh server id during a settled snapshot import, empty or populated server, per D7) and must set `is_recurring: true`. The server validates the actual recurrence and occurrence before applying: the recurrence exists and is active, the occurrence month is not listed in `skipped_periods`, the generated installment does not exceed `total_installments`, and the date is clamped per canon §6. It then applies the canon §6 month idempotency rule: when the server already generated a transaction for that recurrence month, the operation is deduplicated and creates no second transaction; it returns `rejected` with a stable `RECURRENCE_MONTH_EXISTS` code, so the client drops its optimistic duplicate and reconciles from the server row. For any `transaction.create` carrying `card_id`, `expected_date` is the purchase-date input, exactly like the public `TransactionDTO`: the server routes the invoice through `SyncInvoiceUseCase` from `expected_date` and derives the invoice period and due date from it. A scheduler-generated occurrence reconstructs `expected_date` from its recorded `purchase_date`, never from a local invoice due date. `purchase_date` is an optional redundant date: when supplied it must agree with `expected_date`, and it is not newly required for an ordinary native card purchase. The payload carries no `invoice_id`, and a local invoice id is never accepted or used. This extension changes no finance collection field and no migration.

If an operation needs a base revision that another pending operation will create or change, the client sends it only after that operation is accepted. `dependsOn` covers same-batch ordering when no prior base revision is needed, such as a create that references another create. The client never predicts a server revision it has not observed.

`payloadHash` is computed over the complete immutable envelope, never over `payload` alone (rule 9). A client writes the final envelope and its hash to the outbox before the first send; from then on the queued bytes are frozen. Any local rebase that changes `baseRevisions`, `dependsOn`, or `payload` produces a new `opId` and a new envelope instead of mutating a sent operation.

### D3 - Revisions are per entity and explicit

Every synchronized entity has a monotonic integer revision. Revisions live in `obol_sync_entity_versions`, keyed by `(entityType, entityId)`, not as a new business field on the finance collections.

- Create: revision 1.
- Update: current revision + 1.
- Delete: current revision + 1, with `deleted = true`; the entity row is removed.
- A new entity created in the same operation starts at 1; an entity updated twice in one operation still advances once per committed operation, not once per repository call.
- Revisions are assigned under the mutation gate (D9) and committed with the business effects (D10).

An operation is accepted only when every existing entity it writes has a declared base revision equal to the current revision. The unit of work records every entity the use case actually writes. If a written existing entity has no declared base revision, the server aborts the whole operation with `UNCOVERED_WRITE`; it never applies a partial conflict check.

One deliberate exception: an invoice created or found by `SyncInvoiceUseCase` for a card purchase or recurrence launch is an additive delta keyed by `(card_id, period)`. A client that did not know the invoice does not declare a base revision for it. The server applies the delta under the gate and returns the authoritative invoice. This is the only write-set exception. It is additive, not a last-writer overwrite. A concurrent payment or deletion still declares the invoice revision and conflicts normally.

Extra base revisions for entities the operation does not write are ignored. A base revision for an entity that does not exist is `MISSING_ENTITY`, unless a dependency created it earlier in the same batch.

A stale base revision produces an explicit conflict:
```json
{
  "opId": "018f3b7e-6a2c-7c31-9f6e-2f0f9f6c1a11",
  "status": "conflict",
  "code": "SYNC_CONFLICT",
  "conflicts": [
    {
      "entityType": "transaction",
      "entityId": "k3m9x2q7b1c8d4e",
      "baseRevision": 4,
      "currentRevision": 5,
      "current": { "id": "k3m9x2q7b1c8d4e", "status": "realized", "amount": 120.5 }
    }
  ]
}
```

No conflict is resolved automatically. The client shows both versions. Resolving with "use server" applies the server row and discards the operation. Resolving with "retry" creates a new operation with a new `opId` and the current server revision. A timestamp never decides a financial conflict.

### D4 - Push, pull, and handshake are the complete wire contract

All routes require the D009 session and live under `/api/sync`. Bearer is used by native clients. The cookie transport is accepted for same-origin tooling but is not used by the native apps.

#### `POST /api/sync/handshake`

Request:

```json
{
  "protocolVersion": 1,
  "stationId": "018f3b7e-6a2c-7c31-9f6e-2f0f9f6c1a10",
  "platform": "ios",
  "deviceLabel": "iPhone",
  "clientCursor": 1240,
  "clientCursorHash": "sha256:...",
  "dataEpoch": 1,
  "serverInstanceId": "2a7c9e10-4f6d-4e8a-9b71-7c2a1d0e5f33"
}
```

Response:

```json
{
  "serverInstanceId": "2a7c9e10-4f6d-4e8a-9b71-7c2a1d0e5f33",
  "ownerFingerprint": "sha256:...",
  "protocolVersion": 1,
  "protocolMin": 1,
  "protocolMax": 1,
  "dataEpoch": 1,
  "cursor": 1298,
  "cursorHash": "sha256:...",
  "headHash": "sha256:...",
  "hasFinancialData": true,
  "serverName": "Obol"
}
```

- `stationId` is registered or refreshed idempotently. A station is a durable installation, not a session.
- On the first handshake, `serverInstanceId`, `dataEpoch`, `clientCursor`, and `clientCursorHash` are omitted or sent as `null`. A later handshake sends the stored values so the server can detect an endpoint or rollback mismatch.
- `ownerFingerprint` is `sha256:` + unpadded base64url(SHA-256(owner record id bytes)) per D2 rule 9. It binds the local store to the deployment's owner without exposing the record id.
- `hasFinancialData` lets the pairing wizard distinguish an empty server from a populated one without a full pull.
- `clientCursor` must name a commit boundary. The event at `clientCursor` must satisfy `commitIndex = commitSize - 1`; a cursor inside a commit group is rejected with HTTP 409 `CURSOR_NOT_ON_COMMIT_BOUNDARY` and is never silently advanced. The response `cursor` is the last written event, which always ends a commit group.
- Every hash in the request and response uses the `sha256:` + unpadded base64url form of D2 rule 9. The empty genesis values at cursor 0 are the empty string.
- If `clientCursor > cursor`, the server was restored to an older backup or reset. Return `SERVER_ROLLBACK_DETECTED` and do not sync.
- If the server has no event at `clientCursor`, or the event's `chainHash` differs from `clientCursorHash`, the journal was replaced or restored to a different history. Return `SERVER_ROLLBACK_DETECTED`, even when `cursor >= clientCursor`.
- If `dataEpoch` differs, return `DATA_EPOCH_CHANGED`.
- If `serverInstanceId` differs from the client's stored value, return `ENDPOINT_MISMATCH`.
- If `protocolVersion` is outside `[protocolMin, protocolMax]`, return `PROTOCOL_UNSUPPORTED`.
- Handshake failures are HTTP 409 with a uniform `{ code, message }` body. Authentication failures stay HTTP 401.

A sync cycle is handshake, pull until drained, push queued operations, then pull again. A client never pulls or pushes without a successful handshake in the same cycle.

#### `POST /api/sync/push`
Request:

```json
{
  "protocolVersion": 1,
  "stationId": "018f3b7e-6a2c-7c31-9f6e-2f0f9f6c1a10",
  "serverInstanceId": "2a7c9e10-4f6d-4e8a-9b71-7c2a1d0e5f33",
  "dataEpoch": 1,
  "ops": []
}
```

- Bounds: at most 100 operations, 1 MiB request body, 64 KiB per operation. `limit`-style event paging does not apply to push; an operation that would write more than 10,000 entity events is rejected as `COMMIT_TOO_LARGE` before any write.
- The server recomputes `payloadHash` over the received immutable envelope (D2 rule 9). A mismatch is a per-operation `ENVELOPE_HASH_MISMATCH` rejection and writes nothing; the server never stores an envelope whose declared hash disagrees with its bytes.
- Each accepted operation reaches its use case with the client's `effectiveAt` through an injected domain clock or scoped operation clock. A replay, a retry, and a batch applied at reconnect time never substitute the server's receipt time for `effectiveAt`, so an offline realization or payment keeps the date the user performed it.
- Each accepted operation produces exactly one commit group: one `commitId`, and one change event per written entity with contiguous `seq`, `commitIndex`, and the group `commitSize`. That group is the atomic unit of a later pull.
- A push from a station that has not completed handshake is rejected with `STATION_NOT_REGISTERED` and no writes.
- The push request holds the mutation gate for the whole ordered batch. Each operation still commits in its own atomic PocketBase transaction. This prevents another writer from interleaving between operations in the same batch.
- Operations are applied in array order.
- Per-operation results are returned in the same order, in an HTTP 200 body:

```json
{
  "serverInstanceId": "2a7c9e10-4f6d-4e8a-9b71-7c2a1d0e5f33",
  "dataEpoch": 1,
  "cursor": 1301,
  "results": [
    {
      "opId": "018f3b7e-6a2c-7c31-9f6e-2f0f9f6c1a11",
      "status": "applied",
      "entityVersions": [
        { "entityType": "transaction", "entityId": "k3m9x2q7b1c8d4e", "revision": 5 }
      ],
      "entities": [
        { "entityType": "transaction", "entityId": "k3m9x2q7b1c8d4e", "revision": 5, "record": { } }
      ]
    }
  ]
}
```

- `status` is one of `applied`, `duplicate`, `conflict`, `rejected`, `blocked`.
- `entities` and `entityVersions` list every entity the operation touched, not only surviving records. A deleted entity carries its new tombstone revision and `record: null`, so an accepted delete can atomically remove the accepted base row together with its outbox intent instead of transiently resurrecting the row before the next pull.
- `duplicate` returns the stored original result.
- `conflict` returns the conflict payload from D3.
- `rejected` returns a stable code and message. A rejected `opId` is final; the client must create a new operation to retry a corrected intent.
- `blocked` means a `dependsOn` entry was not accepted in this batch and is not already accepted. Nothing was written. A blocked operation is not recorded in `obol_sync_operations`; the client keeps it queued and retries after the dependency is accepted.
- HTTP 200 does not mean every operation applied. Clients must read `results`.
- The push response `cursor` is informational. The client advances its stored cursor only through `pull`, so it never skips another writer's events or breaks the chain check.
- Malformed JSON, an unknown operation type, an invalid payload, a missing `baseRevisions` entry, or an operation body over the limit rejects only that operation unless the request itself is malformed.
- A request-level `serverInstanceId`, `dataEpoch`, or protocol mismatch rejects the whole request with HTTP 409 and no writes.

#### `GET /api/sync/pull?cursor=<int>&limit=<1..500>`

Response:

```json
{
  "serverInstanceId": "2a7c9e10-4f6d-4e8a-9b71-7c2a1d0e5f33",
  "dataEpoch": 1,
  "events": [
    {
      "seq": 1299,
      "commitId": "3f1c2a54-9e7b-4c11-8d2a-6b0e4f7a9c21",
      "commitIndex": 0,
      "commitSize": 2,
      "kind": "upsert",
      "entityType": "transaction",
      "entityId": "k3m9x2q7b1c8d4e",
      "revision": 5,
      "record": { "id": "k3m9x2q7b1c8d4e", "status": "realized" },
      "origin": "station",
      "stationId": "018f3b7e-6a2c-7c31-9f6e-2f0f9f6c1a10",
      "opId": "018f3b7e-6a2c-7c31-9f6e-2f0f9f6c1a11",
      "prevHash": "sha256:...",
      "chainHash": "sha256:..."
    },
    {
      "seq": 1300,
      "commitId": "3f1c2a54-9e7b-4c11-8d2a-6b0e4f7a9c21",
      "commitIndex": 1,
      "commitSize": 2,
      "kind": "upsert",
      "entityType": "account",
      "entityId": "7h2p9q1m4x8c6v3",
      "revision": 12,
      "record": { "id": "7h2p9q1m4x8c6v3", "initial_balance": 655.1 },
      "origin": "station",
      "stationId": "018f3b7e-6a2c-7c31-9f6e-2f0f9f6c1a10",
      "opId": "018f3b7e-6a2c-7c31-9f6e-2f0f9f6c1a11",
      "prevHash": "sha256:...",
      "chainHash": "sha256:..."
    },
    {
      "seq": 1301,
      "commitId": "b81d0e77-2a49-4f6e-b3c5-1a8d2e9f0c34",
      "commitIndex": 0,
      "commitSize": 1,
      "kind": "delete",
      "entityType": "transaction",
      "entityId": "p8w2m5n1c7v4b9x",
      "revision": 3,
      "record": null,
      "origin": "web",
      "prevHash": "sha256:...",
      "chainHash": "sha256:..."
    }
  ],
  "nextCursor": 1301,
  "hasMore": false
}
```

- Events are ordered by `seq` and are immutable once written.
- Every event carries the required commit-group identity of the atomic financial commit that produced it: `commitId` (UUID of the commit), `commitIndex` (0-based integer within the commit), and `commitSize` (positive integer, the number of entity events in the commit). All events for one atomic financial operation share `commitId` and occupy contiguous `seq` values.
- `record` is the complete server record after the change, or `null` for a delete.
- A delete event is the tombstone. Physical deletion is allowed; the journal is the durable record.
- `chainHash` is `"sha256:" + unpadded base64url(SHA-256(canonical JSON of seq, commitId, commitIndex, commitSize, kind, entityType, entityId, revision, recordHash, origin, stationId, opId, createdAt, prevHash))`. `prevHash` is the previous event's `chainHash`, or the empty string at `seq = 1`. The chain detects a replaced or restored journal. Before the first event, `headHash` and the cursor hash at 0 are the empty string.
- `limit` (1..500) is the target event count for a page, not permission to split a commit. The server returns only complete commit groups. If the first complete group at the cursor is larger than `limit`, the page contains that entire group and may exceed `limit`. A page may therefore contain up to 10,000 events, which is the hard bound of a single commit.
- One commit contains at most 10,000 entity events. A write that would exceed the bound is rejected before any write (`COMMIT_TOO_LARGE`); the server never writes a partial or oversized commit. The 10,000-row legacy seed is exactly one commit of that size.
- Page size is additionally bounded by a documented byte cap (32 MiB of serialized `events` in one response). Because a single commit can exceed the event target, the server keeps the response within the byte cap only by refusing to split a commit; a commit that cannot fit the byte cap is a contract violation and fails the request with `COMMIT_PAGE_TOO_LARGE` instead of returning a partial group. Operators size `limit` and payloads accordingly.
- The cursor always advances to a commit boundary. `nextCursor` is the `seq` of the last event of the last complete group returned. A request whose `cursor` names an event inside a commit group is rejected with HTTP 409 `CURSOR_NOT_ON_COMMIT_BOUNDARY`; the server never silently advances it to the group end.
- A client validates the page before applying it: contiguous `seq`, contiguous `commitIndex` from 0 to `commitSize - 1` within each `commitId`, a consistent `commitSize`, complete groups only, and `prevHash` continuity against its stored last hash. Any violation is `SERVER_ROLLBACK_DETECTED` or `PAGE_INVALID`, and nothing is applied.
- The client applies one page, including every complete commit group in it, in one local transaction; the cursor and last `chainHash` advance in the same transaction. Re-applying a page is safe because an event is ignored when its `revision` is not greater than the local revision.
- The client verifies `prevHash` against its stored last hash and rejects a gap or mismatch as `SERVER_ROLLBACK_DETECTED` before applying the page.
- The journal is not compacted in 0.4.0. Personal-scale data and one owner make unbounded retention acceptable. Compaction requires a later decision with a station-cursor protocol.
- The initial baseline is `pull?cursor=0`. A one-time journal backfill covers rows that existed before 0.4.0, so there is no separate snapshot endpoint. Backfill and seed emit complete bounded commit groups too, so the first pull never observes a partial backfill group.

#### `POST /api/sync/seed`

One-time migration for a 0.3.0 desktop database that has finance rows but no operation log. It is not an operation and has no `opId`.

Request:

```json
{
  "protocolVersion": 1,
  "stationId": "018f3b7e-6a2c-7c31-9f6e-2f0f9f6c1a10",
  "serverInstanceId": "2a7c9e10-4f6d-4e8a-9b71-7c2a1d0e5f33",
  "dataEpoch": 1,
  "snapshot": {
    "accounts": [],
    "cards": [],
    "categories": [],
    "projects": [],
    "recurrences": [],
    "invoices": [],
    "transactions": []
  }
}
```

Rules:

- Requires a successful handshake and a registered station.
- Refused with HTTP 409 `SERVER_NOT_EMPTY` when `hasFinancialData` is true or any `obol_sync_changes` event exists beyond the backfill marker. The server must never merge a seed into existing data.
- Bounds: 10 MiB and 10,000 rows total. The seed is one atomic PocketBase batch and exactly one commit group: every row event shares one `commitId`, has contiguous `commitIndex`, and `commitSize` equals the emitted row-event count. The 10,000-row bound is the maximum commit size, so a larger legacy database cannot be seeded; the client keeps it standalone and exports it.
- Validates collection names, required fields, relation ids, and duplicate ids. It does not recompute balances or invoice totals; it preserves the source database exactly.
- Writes every row, assigns revision 1, emits one `upsert` event per row in the backfill order, and sets `lastSeq`, `headHash`, and the backfill marker in one atomic batch. The gate is held for the whole seed.
- Returns counts and the new cursor. A failed seed commits nothing.
- After a successful seed, the client pulls from cursor 0 and starts normal synchronization.

#### `POST /api/sync/import`

`POST /api/sync/import` is listed in D7. It accepts an empty or populated server, writes the client's frozen all-new-id snapshot without merging, overwriting, minting server-side ids, or replaying a partial log, shares the seed's response shape plus `importId`, responds 409 `IMPORT_ID_REUSED` or `IMPORT_ENTITY_ID_TAKEN`, and commits at most once per durable `importId`; it is not an operation.

### D5 - The journal is backfilled for preexisting server data

A 0.3.0 deployment already has financial rows and no sync journal. On the first 0.4.0 boot:

1. Create or read `obol_sync_meta`.
2. If `journalBackfilledAt` is absent, assign `serverInstanceId` and `dataEpoch = 1` if absent.
3. Emit one `upsert` event per existing row in deterministic order: collection order `accounts`, `cards`, `categories`, `projects`, `recurrences`, `invoices`, `transactions`, then `id` ascending within each collection. Financial collections do not guarantee a system `created` field, so no timestamp is used for ordering. Each event carries `eventKey = "backfill:<entityType>:<entityId>"`; a retry skips an entity whose `eventKey` already exists. The backfill runs in bounded batches where each batch is a complete commit group: one `commitId`, contiguous `commitIndex` from 0, and `commitSize` equal to the events in that batch, at most 10,000. Assign sequential `seq` values, compute `prevHash` and `chainHash` for each event including the group fields, and update `lastSeq` and `headHash` as each group commits. A crash between groups leaves only completed groups behind, and the next pull starts at a commit boundary.
4. Assign revision 1 to each row in `obol_sync_entity_versions` in the same batch as its event, so an event and its version row never diverge.
5. Set `journalBackfilledAt` and `journalBackfillVersion` only after every row has an event and a version row.

The backfill runs under the mutation gate before the HTTP listener binds. Running it twice is a no-op. A fresh empty deployment records the backfill marker with zero events.

This is why pairing a new client to an existing server is a pull from cursor 0, not an empty baseline.

### D6 - Deletions are tombstones in the journal

Deletion keeps the current physical delete in PocketBase and adds two records in the same commit:

- `obol_sync_entity_versions` row with `deleted = true` and the next revision.
- `obol_sync_changes` event with `kind = "delete"`, `record = null`, and the revision.

The accepted operation result lists that deleted entity with its tombstone revision and `record: null`, alongside every dependent updated entity, so the client removes the base row and its outbox intent in one local transaction.

Deleting a transaction can also update accounts, an invoice, and a recurrence. Those entities get their own revision and `upsert` events, all in the same commit group (`commitId`, contiguous `commitIndex`, `commitSize`). The client applies the whole group in one local transaction and never observes a half-applied delete. A delete commit and its dependent updates never straddle a page boundary.

A deleted entity id is not reused. A create operation with an id whose version row is deleted is rejected as `ENTITY_ID_TAKEN`.

### D7 - Pairing with preexisting data is explicit

On first pairing, the client knows its local operation log, local row counts, and the server's `hasFinancialData`. A 0.4.0 client records every local mutation in the outbox even when it has no server, so `Import this device` retires local operations after acceptance; the transfer itself is the complete settled materialized snapshot, not a log replay.

| Local | Server | Allowed actions |
|---|---|---|
| empty | empty | pair and pull the empty baseline |
| operation log, any rows | empty | `Import this device as new records` (settled materialized snapshot import with fresh ids) or `Discard local data` (typed confirmation) |
| legacy rows, no operation log | empty | `Seed empty server` (one-time validated snapshot) or `Discard local data` (typed confirmation) |
| empty | non-empty | `Use server data` (default) |
| operation log, any rows | non-empty | `Import this device as new records` (complete settled snapshot import with fresh ids) or `Replace this device with server data` (typed confirmation) |
| legacy rows, no operation log | non-empty | no merge: `Use server data` after export, or `Stay standalone` |

There is no automatic merge and no heuristic deduplication in 0.4.0, and no dedupe of equal payments: two distinct legitimate payments can be equal in amount, card, and period, and both survive an import.

- `Import this device as new records` is for a never-paired standalone profile with local finance and a recorded operation log, of any queue length; a nonzero queue is not evidence that the history is complete. It imports into a server that is empty or populated. It does not replay the queued operations or a partial operation log into a foreign server and does not reconstruct results from incomplete historical operations, which is why the transfer is the materialized snapshot. Previously paired devices never replay into another server, and a same-identity resume keeps the originally frozen bytes. The transferred payload is the COMPLETE settled materialized snapshot: all seven finance collections, with realized facts kept realized, partial and paid invoices kept as they are, documented card totals preserved, no invented opening balance, no recomputed paid history, and no equal-payment dedupe.
- The client mints the new identity before freezing the hash. For every finance row it mints a fresh 15-character lowercase alphanumeric id and rewrites every reference, including `invoice_id`, `source_invoice_id`, and `recurrence_id`. `stationId`, `opId`, and `importId` keep their own UUID namespaces; only finance entity ids change. The server never mints or rewrites ids for an import: it validates the frozen request and rejects it whole when the snapshot is invalid or an id collides. After acceptance, ordinary local mutations push as the unchanged 18 operation types.
- Before the network call, the client persists one coherent checkpoint in one local transaction: the remapped fresh-id snapshot, the immutable `importId` (UUIDv7), the six-field `payloadHash`, the complete request body, the covered original local `opId`s, and the identity tuple (`serverUrl`/`serverInstanceId`, `dataEpoch`, `stationId`). The namespace remap, every reference rewrite, the station binding, and the checkpoint commit together in that transaction; a crash leaves all of them or none. Desktop stores the checkpoint as `obol_station_state.pendingImport` (at most 12 MiB); native iOS stores it in its SQLite state. The checkpoint contains no token, password, or other secret. Ordinary push is paused while it exists, and no new import id is minted on timeout or restart.
- Local mutations made AFTER the checkpoint stay durable and are not part of the immutable snapshot. The original queue is preserved until the import is accepted; only the covered old operations retire on acceptance, and post-checkpoint operations then push as fresh operations.
- The transfer is `POST /api/sync/import`, not `/seed`. `/seed` remains the 0.3.0 log-free, exact-id, empty-server migration; `/import` always writes new ids and is valid on an empty or populated server. Request fields are `protocolVersion`, `stationId`, `serverInstanceId`, `dataEpoch`, `importId`, `snapshot`, and `payloadHash`. The hash covers exactly the six fields `protocolVersion`, `stationId`, `serverInstanceId`, `dataEpoch`, `importId`, and `snapshot`, excludes `payloadHash`, and uses the shared canonical UTF-8/SHA-256 form (`sha256:` plus unpadded base64url). Bounds are 10 MiB for the complete request and 10,000 financial rows.
- The server requires a successful handshake and a registered station, validates the identity and epoch, the complete seven-collection financial schema and references, every 15-character id, and the recomputed hash before any mutation, and holds the exclusive mutation gate for the whole import. It does not recompute a balance, invoice total, or paid history, does not convert a realized fact to silent, and does not dedupe an equal payment.
  - Same `importId`, same hash, same `stationId`, and same (`serverInstanceId`, `dataEpoch`) replays the stored original result and applies no change. This is the exact lost-response, restart, and reauthentication retry.
  - Same `importId` with different frozen content is `IMPORT_ID_REUSED` (409) and writes nothing.
  - ANY collision between an imported finance id and an existing finance id is `IMPORT_ENTITY_ID_TAKEN` (409) and rejects the whole request. There is no partial merge, no partial remap, no overwrite, and no server-side minting of replacement ids.
  All finance inserts, their revision-1 rows, the complete continuous journal commit, and the receipt row in `obol_sync_snapshot_imports` are ONE PocketBase batch. The response is the seed identity shape: server instance, epoch, cursor, and per-entity counts keyed by singular `SyncEntityType`, plus `importId`; the receipt is cleared when a reset increments `dataEpoch`.
- Authentication loss or offline state preserves the marker and the intent; the same import resumes after reauthentication at the same server and epoch. A different server or epoch stops safely with explicit recovery. An uncertain marker is never cleared just to start a different import, because the server may already have committed the original one; only a confirmed result or an explicit discard of the local import intent is safe.
- On an accepted result the client atomically adopts revision-1 baselines and server versions for every imported record, retires ONLY the covered old operations, preserves local work created after the checkpoint, strips dependencies on covered operations only from never-sent later operations, and advances only those operations' causal own base versions. It never edits a frozen envelope and never auto-rebases an unrelated server change. It does not advance its pull cursor from the import response alone; the next pull from the stored commit boundary converges the remote's existing rows, the imported rows, and the later local facts exactly once.
- A failure or id-collision rejection leaves the old local finance and the server unchanged, so the user can still choose `Use server data` or `Stay standalone`.
- `Seed empty server` is only for a 0.3.0 desktop database that has rows but no operation log. It calls `POST /api/sync/seed` with the complete local snapshot. The server refuses unless it has no financial rows and no journal events. It validates the snapshot and writes it once in one atomic batch, preserving rows, invoice totals, and account balances. The limit is 10 MiB and 10,000 rows; a larger database stays standalone and can be exported. It cannot merge into a non-empty server.
- `Replace this device` (`Use server data` with destructive discard) requires the typed `REPLACE` confirmation and a completed export receipt that the backend verifies at confirmation. A real native save dialog plus a successful filesystem write is required; a canceled or failed save yields no receipt, and a Blob click or a download start is never a completed export. The export contains finance data and pending intents but no tokens or secrets; its receipt excludes `exportedAt` and invalidates if the data, outbox, or binding changes. A non-empty legacy local database must be exported before discard.

### D8 - Endpoint and identity binding

The local store is bound to one tuple:

```
(serverUrl, serverInstanceId, ownerFingerprint, stationId)
```

- A different `serverInstanceId` or `ownerFingerprint` is `ENDPOINT_MISMATCH`.
- In `ENDPOINT_MISMATCH` the client must not push pending operations to the new endpoint. It preserves the outbox and requires an explicit re-pair choice based on the new server's data:
  - new server empty: seed it with the full local snapshot (10 MiB/10,000-row bound) or discard local data after export;
  - new server non-empty: use the new server data after exporting local data, or stay on the old server.
  A partial outbox replay is not offered because accepted history is not retained as operations. Old operation ids are never sent to the new instance.
- A URL change that resolves to the same `serverInstanceId` and `ownerFingerprint` is allowed. Running two live copies of one instance id is unsupported; moving a deployment keeps the instance id and is allowed only with one live authority.
- The station id is never derived from a token, session, email, or device name. Rotating a session does not create a new station. Running two live copies of one station id is unsupported.
- The server records station id, platform, first seen, last seen, and last cursor for diagnostics. It never treats a station as an authorization principal: the session authorizes every request.

### D9 - Concurrency is serialized by one mutation gate

The BFF holds one in-process asynchronous mutation gate around every financial write: HTTP routes, scheduler jobs, sync operation application, and station recording in desktop local mode.

- 0.4.0 introduces a new explicit constraint: one live BFF process per deployment. D009 does not contain this rule; it constrains sessions and identity, not process cardinality. The gate is valid only because that single process is the only writer.
- Multiple BFF processes, workers, a load-balanced deployment, or a rolling deploy that runs the old and new process at the same time are unsupported. Enabling them requires a database-backed lock and a new decision.
- The gate serializes revision assignment, conflict checks, entity id uniqueness checks, and journal sequence assignment.
- PocketBase itself remains the durable store. The gate does not replace database constraints; unique indexes on `opId`, `seq`, and `(entityType, entityId)` are the last line of defense.

### D10 - Effects, revisions, journal, and operation result commit atomically

Each operation executes in one PocketBase batch transaction:

1. Acquire the mutation gate.
2. Read current revisions and resolve dependencies.
3. Check base revisions for every entity the use case will write. The unit of work records actual touches.
4. Execute the use case against repositories bound to a unit of work. Reads see buffered writes; writes are buffered, not sent.
5. Assign client-provided or generated entity ids.
6. Append business writes, revision rows, one change event per written entity carrying the commit's `commitId`, contiguous `commitIndex`, and `commitSize`, the `obol_sync_operations` result row, and the `obol_sync_meta.lastSeq` update to one batch. In desktop station mode, append the `obol_station_outbox` operation and local revision rows instead of the central journal.
7. Commit the batch. Release the gate.
8. Return the per-operation result.

The batch is the atomicity boundary. A crash before commit applies nothing. A crash after commit leaves the operation result durable. A lost response is retried with the same `opId` and returns the stored result. There is no `applying` state and no recovery replay of half-applied financial effects.

Requirements for the implementation gate:

- The PocketBase client version pinned by the BFF supports atomic multi-collection batches, and the BFF configures and verifies the required batch capability at boot through the authenticated settings API. Verified on 2026-10-31 against the pinned runtime: an untouched PocketBase default is `batch = { enabled: false, maxRequests: 50, timeout: 3, maxBodySize: 0 }` (body size in bytes). In an isolated proof volume, setting `batch = { enabled: true, maxRequests: 60000, timeout: 30, maxBodySize: 50331648 }` made a forced failure of the second collection's write roll back the first collection's write, and then a two-collection batch committed atomically. Sources: <https://pocketbase.io/docs/api-records/#batch-createupdateupsertdelete-records>, <https://pocketbase.io/jsvm/interfaces/core.BatchConfig.html>. That manual setting in the isolated volume is not a product fix.
- Production boot patches only the `batch` settings subset through the authenticated settings update, preserving unrelated `smtp`/`meta` settings, never logging secrets, and failing closed when the batch capability is disabled or cannot be verified. There is no silent non-atomic fallback and no per-record degradation.
- Every commit bound fits the configured capacity: at most 10,000 entity events per commit, push at most 100 operations / 1 MiB / 64 KiB per operation, seed at most 10 MiB / 10,000 rows. `maxRequests` covers the largest expected commit request count, `maxBodySize` covers the largest expected body, and `timeout` covers the largest expected commit. A write whose commit cannot fit the configured capacity is rejected before any write.
- Desktop standalone atomicity uses the same capability from its managed local PocketBase child, and station mode's local batch (finance rows plus outbox operation) depends on it as well.
- No use case swallows a persistence error. `DeleteTransactionUseCase` must propagate invoice and recurrence failures; `UpdateTransactionUseCase` must propagate invoice failures. The batch aborts instead of committing a partial financial state.
- No finance repository writes outside the unit of work in a request path. Authentication and session records remain direct writes and are not synchronized. The scheduler and admin reset use the same finance boundary.
- The unit of work provides read-your-writes for `findById`, the card+period invoice lookup used by `SyncInvoiceUseCase`, and every list query used by an allowed operation. A list query it cannot yet reproduce must be added to the unit of work; it is not grounds for dropping the operation from the allow-list.
- A use case that reads an entity only to validate a write records that read for diagnostics. The hard conflict check applies to the write set, not to every read.

If a use case cannot be expressed as buffered reads and writes in 0.4.0, the unit of work must be extended until it can. The operation table in D2 is the requested release scope and the complete allow-list; it is never reduced to declare the release done. A failing gate is fixed.

### D11 - Client state is durable and two-layered

Both native clients keep:

1. A **base layer**: the last accepted server records, each with `serverRevision` from the server and `localRevision` for the optimistic local state.
2. A **pending layer**: durable operations that have not been accepted, with their optimistic local effects.

`baseRevisions` in every operation always uses `serverRevision`. `localRevision` exists only for local ordering and conflict display; it is never sent as a base revision.

The UI reads base plus pending for normal display. When a pending operation conflicts, the entity is marked conflicted and the UI shows both the server record from the conflict payload and the local intent. Normal rows do not silently adopt the server value while a conflicting pending operation exists.

If an entity already has an older unaccepted operation, a new operation for the same entity depends on it and is not pushed until the older operation is accepted. At that point the client refreshes the newer operation's base revisions from the server result. This serializes offline edits per entity without predicting a server revision.

Local write path for a native client:

1. Assign `opId` and, for creates, `entityId`; capture `effectiveAt` at the moment the user performs the financial action and `clientCreatedAt` for audit.
2. Compute the local effect in one SQLite transaction: base rows as needed, the pre-operation snapshots of every entity it changes, the pending operation row including its complete envelope and `payloadHash` over that envelope, and `localRevision` bookkeeping. `serverRevision` changes only after an accepted server result.
3. Persist the final envelope before the first send. After that send the envelope and its hash are immutable; a rebase or correction creates a new `opId`.
4. Return to the UI immediately.
5. A background sync loop pushes queued operations in dependency order.
6. On `applied` or `duplicate`, replace optimistic rows with the returned server entities, record the new `serverRevision`, and delete the pending operation in one SQLite transaction. Desktop stations keep the row instead of deleting it immediately, with only a minimal `obol_station_outbox.acknowledgement` causal receipt (`opId`, commit id, seq bound, per-entity versions, at most 2 MiB), and remove it once no dependent pending operation still needs its causal versions; dependent pending operations keep referencing the accepted causal versions until then. If the server created an entity with an id the client did not choose (for example, an invoice from a card purchase or a project payment transaction), replace the optimistic local row with the server id and rewrite local references, including the `entityId`, `baseRevisions`, and payload references of dependent pending operations, before the next pull. A rewritten dependent is a new operation with a new `opId`.
7. On `conflict`, persist the conflict payload, mark the operation `conflict`, and mark dependent operations `blocked`. Do not delete the local intent.
8. On `blocked`, keep the operation queued and retry it after the dependency is accepted. Nothing is written.
9. On `rejected`, persist the code and message, mark dependents `blocked`, and keep the pre-operation snapshots until the user acknowledges. Acknowledging restores those snapshots so the local store returns to the last accepted state.
10. On transport failure, keep the operation `queued` with a retry deadline.

Pull path:

1. Fetch a page from the stored cursor, which is always a commit boundary.
2. Validate the whole page before applying anything: contiguous `seq`; within each `commitId`, `commitIndex` from 0 to `commitSize - 1` with a constant `commitSize`; no partial group at either end; `prevHash` equal to the stored last hash. A partial group, a cursor inside a group, or a hash gap rejects the page (`PAGE_INVALID` or `SERVER_ROLLBACK_DETECTED`) and applies nothing.
3. In one SQLite transaction, apply complete commit groups: every event of a group whose revision is greater than the local `serverRevision`.
4. If an event's revision is not greater, ignore it.
5. If an event targets an entity with a pending operation whose base revision is lower than the event revision, record a preemptive conflict with the event's server record and revision, mark that operation `conflict`, and do not overwrite the pending optimistic row. A pending create with no base revision whose entity id appears in a pull event is a preemptive `ENTITY_ID_TAKEN` conflict. The cursor still advances; the conflict store is the durable source for resolution. A conflicted operation is not pushed until the user resolves it. If more events arrive for the same entity, keep the latest revision and record.
6. Persist `nextCursor` and the last `chainHash` in the same transaction, only at a commit boundary.
7. Repeat while `hasMore`.

Crash and relaunch:

- An operation is persisted before its HTTP request starts. An operation marked `in_flight` at launch returns to `queued`.
- The cursor and last chain hash advance only after a page is committed locally.
- A push response is applied before the operation is removed. A crash between server commit and local removal causes a retry; the server returns `duplicate`.
- The local database uses SQLite WAL mode and a single writer connection per process.

### D12 - Data epoch, reset, and server restore

`obol_sync_meta.dataEpoch` starts at 1. It increments when an administrative reset clears financial data. The increment commits before the first delete batch, so stations stop before observing a partial reset. The reset then deletes rows in bounded mutation batches, each batch being one complete commit group, emitting a delete event for every cleared row. Stations with pending operations receive `DATA_EPOCH_CHANGED`; the user must explicitly discard pending operations or re-enter them. A reset never silently discards a station's outbox. The reset also clears the `obol_sync_snapshot_imports` receipts and any `obol_station_state.pendingImport` checkpoint, so no imported snapshot evidence outlives the epoch that imported it.

A server restore from a backup restores `serverInstanceId`, `dataEpoch`, `lastSeq`, `headHash`, the journal, and the operation results. A station whose cursor is greater than the restored server's cursor receives `SERVER_ROLLBACK_DETECTED`. A station whose cursor is not greater but whose `clientCursorHash` does not match the server's event at that cursor also receives `SERVER_ROLLBACK_DETECTED`. The station stops. The user must choose:

- restore a newer backup on the server, or
- rebase the station from the restored server, explicitly discarding accepted changes that the restored backup does not contain, after an export.

Pending operations are preserved until that choice. The client never pushes into a rolled-back server, because the server may lack operations that the pending operations depend on.

### D13 - The authority runs time-based finance

When a desktop station or an iOS store is paired, its local automatic recurrence and invoice reconciliation jobs are disabled. The central server runs the daily scheduler and emits its changes into the journal. The station receives generated transactions and invoice updates by pull. A paired client can simulate future recurrences locally for the forecast, but it does not persist generated recurrence facts while paired.

An unpaired client is the sole authority for its local store. It still records every local mutation in the outbox so a later pairing can replay it. Desktop standalone keeps its local scheduler. The iOS store runs the local recurrence processor on launch and foreground while it has no server binding. Those generated transactions are recorded as `transaction.create` outbox intents: the payload extends `TransactionDTO` with the canonical `recurrence_id` and sets `is_recurring: true`, so the recurrence link and month idempotency survive pairing (D2). Pairing imports them explicitly (D7) and the preview warns about recurrence months that the server may also generate. After pairing, automatic local generation stops.

Manual `recurrence.launch` is an operation and applies on the server when paired. The local optimistic result is replaced by the server result. The idempotency rule in canon §6 remains server-side.

Economic time is preserved across replay. Every use case that currently calls `Date()` to realize a transaction, pay an invoice, record a project payment, or launch a recurrence receives its financial date from an injected domain clock or scoped operation clock instead:

- Web requests, cron, and online-only admin actions use the server clock.
- A sync operation seeds the scoped clock from the operation's `effectiveAt`. The reconnect time is never substituted, so an offline realization or payment keeps the date the user performed it.
- `effectiveAt` is business event time only. Revisions, ordering, and conflict precedence never read it. Financial date validation keeps the existing DTO semantics; an `effectiveAt` that fails them is rejected as a payload error rather than silently replaced.

A desktop station pairing changes the local BFF's time authority and requires a restart of the local BFF. The transition is explicit and reversible only through the pairing wizard.

### D14 - Identity and token safety

- iOS stores the bearer token and station id in the Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. The local finance database uses iOS Data Protection (`NSFileProtectionCompleteUntilFirstUserAuthentication`). The local store is excluded from iCloud backup so a restore does not clone the station id, cursor, or outbox. No additional at-rest encryption is claimed.
- Desktop remote mode keeps the bearer token in the WebView `localStorage` per D009 D9. The Bun sync process receives the token over RPC and holds it in memory only. It is never written to local PocketBase, logs, crash reports, or operation payloads.
- Desktop station binding (`serverUrl`, `serverInstanceId`, `ownerFingerprint`, station id, data epoch, cursor, chain hash, mode) lives in `obol_station_state` inside local PocketBase. There is no separate sync config file. No station file contains a token.
- Tokens are sent only in the `Authorization` header. Never in URLs, query strings, logs, analytics, or error messages.
- Hosted and central public startup fails closed: a missing `OBOL_SESSION_SECRET` refuses to listen instead of silently serving open sessions. Only the explicit trusted-local desktop factory opts into null authentication; the hosted path has no such default.
- `401`/`SESSION_EXPIRED` stops sync, keeps the local store and outbox, and shows re-authentication. It never deletes local data.
- `403` and `ENDPOINT_MISMATCH` stop sync and keep the outbox.
- `429` uses exponential backoff with jitter. `5xx` and network failures retry with backoff. There is no tight retry loop.
- TLS is required for every endpoint except the documented development override. A cleartext endpoint is refused by the native clients unless the user enables the development flag, and the UI labels it as insecure.

### D15 - Offline-first initialization

- A fresh iOS install can create a local profile and use local finance with no network. Pairing is optional and can happen later.
- A paired app that launches offline reads and writes the local store. It does not block on a network call, and it does not show a login wall for a valid stored session.
- A token that cannot be renewed while offline does not evict the local store. The app continues in local-only mode and shows `AUTH_REQUIRED` on the sync surface.
- A desktop station starts its local BFF and PocketBase before any network sync. Sync starts after the local UI is usable.
- The first sync after pairing is a pull from cursor 0 for a chosen baseline. The UI remains usable while pages apply.

### D16 - Protocol compatibility and unknown operations

- `protocolVersion` is an integer. The server advertises `protocolMin` and `protocolMax`.
- An unknown operation type is rejected, never skipped.
- Unknown fields in an operation payload are rejected by the TypeBox schema, not ignored.
- A client that cannot speak a supported protocol remains usable offline but cannot sync. It shows `PROTOCOL_UNSUPPORTED`.
- The server may add optional response fields. Clients must ignore unknown response fields. This is the only forward-compatible direction in 0.4.0.

## Proposed persistence metadata

These are infrastructure collections, not new finance fields. Rules stay `null` like every collection; only the BFF superuser touches PocketBase. Names use the `obol_` prefix to avoid PocketBase reserved names, as `obol_sessions` does.

| Collection | Fields | Indexes |
|---|---|---|
| `obol_sync_meta` | `serverInstanceId` text required, `dataEpoch` number required, `protocolMin` number required, `protocolMax` number required, `lastSeq` number required, `headHash` text required, `journalBackfilledAt` date optional, `journalBackfillVersion` number optional | singleton by convention |
| `obol_sync_entity_versions` | `entityType` text required, `entityId` text required, `revision` number required, `deleted` bool, `lastSeq` number | unique `(entityType, entityId)`; index `lastSeq` |
| `obol_sync_changes` | `seq` number required, `commitId` text required, `commitIndex` number required, `commitSize` number required, `kind` select `upsert`/`delete`, `entityType` text, `entityId` text, `revision` number, `record` json optional, `origin` select `station`/`web`/`job`/`admin`/`sync`/`seed`, `stationId` text optional, `opId` text optional, `eventKey` text optional, `createdAt` date required, `prevHash` text required, `chainHash` text required | unique `seq`; unique `chainHash`; index `eventKey`; index `createdAt`; unique `(commitId, commitIndex)` |
| `obol_sync_operations` | `opId` text required, `stationId` text required, `protocolVersion` number, `type` text, `entityType` text, `entityId` text, `payload` json, `payloadHash` text (complete-envelope hash, D2 rule 9), `baseRevisions` json, `dependsOn` json optional, `effectiveAt` date required, `clientCreatedAt` date required, `status` select `accepted`/`conflict`/`rejected`, `result` json optional, `conflict` json optional, `receivedAt` date required | unique `opId`; index `stationId, receivedAt` |
| `obol_sync_stations` | `stationId` text required, `deviceLabel` text, `platform` select `ios`/`macos`/`windows`, `firstSeenAt` date, `lastSeenAt` date, `lastCursor` number | unique `stationId` |
| `obol_sync_snapshot_imports` | `importId` text required (UUIDv7), `stationId` text required (UUIDv7), `payloadHash` text required (at most 50 characters), `serverInstanceId` text required (UUIDv7), `dataEpoch` number required (positive integer), `result` json required (stored original response), `createdAt` date required | unique `importId`; index `stationId` |
| `obol_station_outbox` (local only) | `opId` text required, `protocolVersion` number, `type` text, `entityType` text, `entityId` text, `payload` json, `payloadHash` text (complete-envelope hash), `baseRevisions` json, `dependsOn` json optional, `effectiveAt` date required, `clientCreatedAt` date, `beforeSnapshots` json optional, `status` select `queued`/`in_flight`/`accepted`/`conflict`/`rejected`, `acknowledgement` json optional (minimal accepted causal receipt, at most 2 MiB), `attempts` number, `lastError` text optional, `createdAt` date, `updatedAt` date | unique `opId`; index `status, createdAt` |
| `obol_station_state` (local only) | `serverUrl` text, `serverInstanceId` text, `ownerFingerprint` text, `stationId` text, `cursor` number, `lastChainHash` text, `dataEpoch` number, `protocolVersion` number, `mode` select `standalone`/`station`, `pendingImport` json optional (at most 12 MiB; coherent pre-network import checkpoint, no tokens or secrets) | singleton by convention |
| `obol_station_conflicts` (local only) | `opId` text required, `conflict` json, `resolution` select `pending`/`server`/`retry`/`discarded`, `createdAt` date, `updatedAt` date | unique `opId` |
| `obol_station_versions` (local only) | `entityType` text required, `entityId` text required, `serverRevision` number, `localRevision` number, `deleted` bool (optimistic-local deletion only), `serverDeleted` bool (server-side tombstone), `baseRecord` json optional (full latest remote base row, at most 1 MiB) | unique `(entityType, entityId)` |

Client-side state:

| Store | Purpose |
|---|---|
| iOS SQLite database | Base entity rows (with `serverRevision`, `localRevision`, `deleted`), `sync_outbox`, `sync_conflicts`, `sync_state`, `sync_applied_ops` |
| Desktop local PocketBase | Finance rows plus `obol_station_outbox`, `obol_station_state`, `obol_station_conflicts`, `obol_station_versions`; no new finance fields |

iOS keeps the base and pending layers in one transaction. Desktop keeps finance rows and station state in the same PocketBase database, so one station mutation writes the finance rows, local revisions, and the outbox operation in one batch. A crash leaves either the whole batch or none. The station engine reads and updates the outbox in place. A pull page applies its finance rows, station version rows, cursor, and chain hash in one batch. No separate dual-write database exists.

After a crash, the desktop station reconstructs its base and pending layers exactly: `obol_station_versions.serverDeleted` is the server-side tombstone and stays distinct from `deleted`, which records only an optimistic-local deletion, and `serverRevision`/`localRevision` stay separate counters. A pulled newer remote base is stored whole in optional `obol_station_versions.baseRecord` (at most 1 MiB) and its tombstone in `serverDeleted`, without overwriting an unaccepted local optimistic row; silently applying the remote base over the local row would be last-writer-wins. `beforeSnapshots` keeps only the pre-mutation local state and cannot retain the newer remote base, so `baseRecord` is the durable remote-base input. Inbound transaction metadata is appended through the same unit-of-work metadata batch as the working rows and base overrides, so the pull's finance rows, versions, cursor, and chain hash commit atomically. The local version plan upserts the union of working writes and received keys once per transaction. An ordinary local write increments `localRevision` and does not clobber `serverRevision`, `serverDeleted`, or `baseRecord`; a base-only update preserves `localRevision`. On acceptance, `obol_station_outbox.acknowledgement` (at most 2 MiB) stores only the minimal causal receipt (`opId`, commit id, seq bound, per-entity versions), never whole entity records and never tokens; an accepted row remains until no dependent still needs its causal versions, then the row and its receipt are removed together.

The local BFF's `station` mode records operations into `obol_station_outbox` and never reuses the central server journal as the remote journal. The central server ignores the `obol_station_*` tables.

`obol_station_state.cursor` and the iOS `sync_state` cursor always store a commit boundary (the `seq` of a group's last event). A persisted cursor that does not satisfy `commitIndex = commitSize - 1` is invalid state, is rejected at handshake with `CURSOR_NOT_ON_COMMIT_BOUNDARY`, and is never silently repaired.

The native iOS target store is one SQLite database holding finance rows and the outbox/pending layer, written in one transaction. `app/ios/ObolCore` is a Foundation-only Swift package today (`Models.swift`, `FinanceEngine.swift`, `ForecastEngine.swift`, `LocalStore.swift`); its `LocalStore.swift` is an atomic-JSON snapshot backend and is not evidence that the SQLite/outbox store exists. The 0.4.0 App integration replaces that backend with the single SQLite store and deletes the obsolete JSON path at cutover. Those models and engine are not duplicated into `app/ios/App/App/Core`.

## Alternatives considered

| Alternative | Verdict |
|---|---|
| Row-level last-writer-wins on `updated` | Rejected. It silently loses balance, invoice, transfer, and recurrence effects. No user requirement or accepted decision mandates LWW; forbidding automatic LWW is this decision's own conservative financial-safety choice. |
| Client-generated full snapshots uploaded wholesale | Rejected. It overwrites concurrent server changes and cannot represent deletions or partial operations. |
| CRDT counters and sets for balances | Rejected. Balances are derived from realized transactions and account snapshots, not mergeable counters. Invoice totals and recurrence periods have invariants that a CRDT would not preserve. |
| Server-side diff and three-way merge | Rejected for 0.4.0. It requires a field-level merge policy for every financial invariant and invites silent resolution. Explicit conflicts are boring and auditable. |
| Row-copy import for every client | Rejected as a general mechanism. Copying raw rows blind reuses stale ids and can violate references. The D7 exception is deliberate and bounded: a never-paired standalone profile with local finance and a recorded operation log transfers its complete settled materialized snapshot under a durable `importId`, with every finance id remapped and every reference rewritten client-side before the hash freezes, into an empty or populated server, in one server transaction. A queue count is never treated as proof of a complete history, and the path never merges by existing id, replays a partial log, or recomputes finance. |
| Opaque vectored revisions per field | Deferred. Per-entity revisions are enough for the entity sizes in this domain; field-level merging can be added later without changing operation identity. |
| A local SQLite BFF on iOS | Rejected. iOS does not run Bun, PocketBase, or Electrobun (D008); shipping a second BFF would duplicate the server contract and create a second authority. |
| Sync only through a hosted service operated by Obol | Rejected. D008 says Obol does not operate a service. Synchronization is between the user's devices and the user's self-hosted server. |
| Desktop remote mode as a sync peer | Rejected. Remote desktop is a direct client of the server and has no local store. Only local desktop stations and native iOS stores synchronize. |

## Implementation gates

D016 is accepted only when E007 proves all of these against the pinned runtime:

1. **Atomic batch.** Boot configures and verifies PocketBase batch capability through authenticated settings while preserving unrelated SMTP/meta settings, without logging secrets, and without a silent non-atomic fallback (the isolated default `{ enabled: false, maxRequests: 50, timeout: 3, maxBodySize: 0 }` must become an explicitly verified enabled capacity). PocketBase 0.40.6 then accepts a batch that writes finance rows, one commit group (`commitId`, contiguous `commitIndex`, `commitSize`), revision rows, sync metadata, and the operation result as one commit. An induced failure of the second collection leaves none of them; a successful two-collection batch commits both. Desktop standalone proves the same capability from its managed local PocketBase.
2. **Backfill.** A 0.3.0 database with rows and no journal produces a complete, deterministic pull from cursor 0 after the 0.4.0 boot, in complete bounded commit groups. A second boot adds no duplicate events. A crash between groups leaves the cursor on a group boundary.
3. **Idempotency and operation-target reuse.** Repeating a push with the same `opId` and the same complete-envelope hash returns the stored result and applies no effect. Reusing an `opId` with a different envelope is rejected (`OP_ID_REUSED`), including the case where only `effectiveAt`, `baseRevisions`, or `dependsOn` changed. A frozen queued envelope followed by a local rebase must produce a new `opId` and both operations must apply or conflict deterministically by target. A declared `payloadHash` that disagrees with the received envelope bytes is `ENVELOPE_HASH_MISMATCH` and writes nothing.
4. **Conflict.** Two stations with the same base revision produce one acceptance and one explicit conflict. The conflict contains the server record and the current revision. No LWW, and `effectiveAt` never decides the winner.
5. **Deletion.** A delete produces a tombstone event and dependent revisions in one commit group; a station that pulls after the delete removes the row and never observes a partial group.
6. **Rollback.** Restoring an older server backup makes a station with a higher cursor stop with `SERVER_ROLLBACK_DETECTED`, with the outbox intact. A restore that leaves a higher server cursor but a different event at the station's cursor also stops with `SERVER_ROLLBACK_DETECTED` because `clientCursorHash` does not match. A cursor that lands inside a commit group, or a page with a partial group or broken `commitIndex`/`commitSize` continuity, is rejected as `CURSOR_NOT_ON_COMMIT_BOUNDARY` or `PAGE_INVALID` and never silently advanced.
7. **Endpoint switch.** A second deployment with a different `serverInstanceId` yields `ENDPOINT_MISMATCH` and no push.
8. **Crash.** Killing the client after server commit but before response, then relaunching, returns `duplicate` and no double effect. Killing the server during a batch leaves no partial finance change. Crashing between a page fetch and its local apply leaves the cursor on the previous commit boundary; retrying applies each group once.
9. **Offline first and economic time.** A fresh iOS install works without network. A paired app works offline across relaunch and syncs after reconnect. An offline realization or payment keeps its `effectiveAt` business date after replay; the reconnect date never replaces it, while an invalid financial date is rejected by the existing DTO rules.
10. **Parity.** The Swift finance engine and the TypeScript use cases produce identical results for the shared fixture set covering canon §§4-8 and the §13 clarifications, including the unassigned pending, overdue unpaid invoice, and liquid-to-investment transfer cases, and the canonical-JSON hash fixtures for decimals, `null`, unicode, escaping, negative zero, and full-envelope idempotency. An adapter may map, normalize, inject the case clock, and inject declared faults; it may not add projection, filter, recompute, or round a business result.
11. **Seed.** A legacy snapshot seeds an empty server exactly in one commit group of at most 10,000 events, is refused on a non-empty server or a second attempt, and a failed seed commits nothing.
12. **Settled snapshot import.** A never-paired standalone profile with local finance and a recorded operation log imports its complete settled seven-collection snapshot through `POST /api/sync/import` whether the server is empty or populated. The client mints every fresh 15-character id and rewrites every reference before the six-field hash is frozen; the server validates that frozen request and never remints or rewrites an imported id. The import path commits all finance inserts, revision-1 rows, the continuous journal commit, and the `obol_sync_snapshot_imports` receipt as one batch. A retried request with the same `importId`, hash, station, instance, and epoch replays the stored result with zero effect, including after a lost response, process restart, and reauthentication. Different frozen content under the same `importId` is `IMPORT_ID_REUSED`; any collision with an existing finance id rejects the whole request as `IMPORT_ENTITY_ID_TAKEN` with no finance row, revision, event, or receipt written. Paid and partial invoice states and realized facts survive unchanged, with no silent conversion, no equal-payment dedupe, and no recomputed balance, invoice total, or paid history. The pre-network checkpoint (desktop `obol_station_state.pendingImport`, at most 12 MiB, no secrets; iOS SQLite state) is durable, no new import id is minted on timeout or restart, and local operations created after the checkpoint stay durable and push as fresh operations after acceptance. Acceptance adopts revision-1 baselines, retires only the covered old operations, strips covered dependencies only from never-sent later operations, advances only their causal own base versions, and does not advance the pull cursor from the import response alone. A reset clears the receipt and the checkpoint.

If a gate fails, the gate is fixed. No requested capability and no entry in the D2 allow-list is removed, downgraded, or deferred to declare the release complete, and the protocol is not weakened to make a gate pass.

## Consequences

- The BFF gains a mutation coordinator, unit of work, revision journal, operation journal, station registry, and sync endpoints. Every repository and every write path participates.
- The server becomes the time authority when a desktop station or iOS store is paired. The local automatic jobs stop.
- iOS gains a real SwiftUI app, a SQLite store, and a Swift finance engine that must match the server fixtures.
- Desktop local mode gains a station mode and a sync loop in the Bun main process, plus sync UI in the Nuxt view.
- Hosted web and Coolify keep the same BFF and PocketBase topology. The only server-visible change is the new sync tables and endpoints.
- Release verification grows: concurrency, crash, restore, endpoint switch, Windows, simulator, TestFlight, and all E003 dashboard scenarios.
- The operation journal is not compacted in 0.4.0. This is accepted for one owner and personal-scale data.
- Multi-process BFF deployment is a new 0.4.0 prohibition introduced here (D009 does not say it); the mutation gate is the concrete reason. Lifting it requires a database-backed lock and a new decision.

## Status rationale

Proposed, not accepted. The design is complete enough to implement, but no gate above has been exercised. The only related code that exists today is the Foundation-only `app/ios/ObolCore` package and its atomic-JSON `LocalStore.swift`; there is no revision, journal, operation, outbox, sync route, or verified PocketBase batch configuration. E007 owns the implementation and the evidence. Until E007 ships, the current Capacitor iOS client, local/remote desktop separation, and no-sync rule of D008 remain the only authorized behavior.
