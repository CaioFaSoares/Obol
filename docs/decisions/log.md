# Decision log

One line per decision, newest first. Accepted decisions are never edited in merit - they are superseded by a new numbered decision.

| ID | Date | Decision | Status |
|---|---|---|---|
| D019 | 2026-11-01 | Weekly recurrence cadence: optional `frequency` (`monthly`\|`weekly`) and `weekday` (ISO 1-7) on `recurrences`, UTC ISO weeks, `YYYY-MM-DD` occurrence keys inside the existing `skipped_periods`, one child per occurrence day, current-week materialization, next-week manual launch, weekly card children projected per invoice, no backfill on resume, protocol stays 1 | accepted |
| D018 | 2026-11-01 | `invoices.total_amount` becomes optional: PocketBase rejects the number 0 on a required numeric field, and canon §5 allows a card+period invoice with no purchases and zero debt; migration 1700000022 relaxes the constraint, rollback refuses while zero totals exist | accepted |
| D017 | 2026-11-01 | Migration 0011 edited in place to save only a bare `sessions` collection; 0017 adds its optional fields and index, matching every successfully migrated deployment. The inline-field create failed nondeterministically (5/30 fresh PocketBase 0.40.6 volumes) and aborted the whole batch; supersedes D015's no-failure claim and D013's "0011 untouched" | accepted |
| D016 | 2026-10-31 | Server-authoritative operation sync for native offline iOS and desktop stations: immutable envelopes and op ids, per-entity revisions, explicit conflicts, no last-writer-wins; a never-paired standalone profile transfers its complete settled seven-collection snapshot through `POST /api/sync/import` as frozen all-new-id rows with every reference rewritten, into an empty or populated server, guarded by a durable six-field `importId` receipt and never merged, overwritten, replayed from a partial log, or financially recomputed; gated by E007 | proposed |
| D015 | 2026-10-29 | PocketBase 0.40.6 probe: migration 0011/0017 recorded, both session schemas and indexes present, no 0011 failure on fresh boot or follow-up; supersedes D013's expected two-boot error timeline | accepted |
| D014 | 2026-10-29 | Remote desktop and iOS WebView fetches require exact CORS origins (`views://mainview`, `capacitor://localhost`) when configured; same-origin web and no-Origin tools need none | accepted |
| D013 | 2026-10-29 | Runtime repair of the legacy `sessions` retry loop via additive migration 0017; ends the forever-failing 0011 sequence without touching it; supersedes D012's "0014-0016 complete migration startup" assumption | accepted |
| D012 | 2026-10-29 | Session records carry app-owned `createdAt` (migration 0016, fail-closed for legacy rows); D010's built-in-`sessions` causal claim is superseded, `obol_sessions` name stands | accepted |
| D011 | 2026-10-29 | Additive repair of `obol_sessions` fields via migration 0015 (`Collection.fields.add`); D010's registry name stands, only the repair method is superseded | accepted |
| D010 | 2026-10-29 | BFF session registry stored in `obol_sessions` (PocketBase reserved `sessions` collided); D009 contract unchanged | accepted |
| D009 | 2026-10-29 | Single-owner deployment; BFF-minted revocable sessions; Bearer + `__Host-` cookie contract | accepted |
| D008 | 2026-10-29 | Optional central server remains a shared remote runtime for desktop and iOS; one-owner identity is D009, exact WebView CORS is D014, and local desktop remains standalone | accepted |
| D007 | 2026-10-28 | Local profile unlock and non-destructive PocketBase superuser recovery | accepted |
| D006 | 2026-10-28 | Typed controller-to-use-case dispatch; keep explicit Elysia routes and Awilix classes | accepted |
| D005 | 2026-10-28 | Local Electrobun app: Nuxt SPA + in-process Elysia/RPC + pinned local PocketBase | accepted |
| D004 | 2026-10-28 | Docs as plain markdown; SilverBullet dropped; Copland house style | accepted |
| D003 | 2026-06-03 | Clean Architecture on the BFF (domain/application/infrastructure, awilix DI) | accepted |
| D002 | 2026-05-26 | Invoices as a first-class table; accrual `purchase_date`; installment auto-termination | accepted |
| D001 | 2026-05-22 | The Triad: Nuxt app + Elysia BFF + PocketBase, typed end-to-end via Eden Treaty | accepted |
