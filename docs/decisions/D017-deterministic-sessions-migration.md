# D017 - Deterministic fresh install for migration 0011

**Status**: accepted · **Date**: 2026-11-01 · **Target release**: 0.4.0 · **Related**: [D009](D009-remote-identity.md), [D013](D013-repair-legacy-sessions-migration.md), [D015](D015-pocketbase-session-migrations-verified.md)

## Context

D015 recorded one clean fresh boot on the pinned PocketBase 0.40.6 image and concluded that `1700000011_create_sessions_collection.js` no longer fails. Repeated fresh-volume runs show the failure is nondeterministic, not absent:

- 30 fresh volumes running `pocketbase migrate up` against `db/pb_migrations`: 5 failed with `failed to apply migration 1700000011_create_sessions_collection.js: indexes: (0: Failed to create index idx_sessions_expiresAt - SQL logic error: no such column: expiresAt (1)..)`.
- A failing run rolls back the whole migration batch. The init migration's log line repeats on the next boot, PocketBase exits with status 1, and migration 0017 never runs. D013's two-boot convergence model does not hold.
- A Compose service with a restart policy reaches health only after a lucky retry. A fresh self-host install can fail its first `docker compose up --wait`.

Migrations 0015 and 0017 create or extend collections by saving first and then calling `fields.add` and appending indexes before a second save. They never failed across the same runs.

A deployment that migrated successfully carries a legacy `sessions` schema of `id`, `userId` (relation, optional), `expiresAt` (date, optional), `deviceLabel` (text, optional) and `idx_sessions_expiresAt`. Those optional fields come from 0017. Every successful historical run therefore persisted 0011 as a bare collection, and 0017 added the rest.

A first attempt that made 0011 add required fields after a bare save failed 40 of 40 fresh runs at 0017 (`fields.add: sessions.userId exists with incompatible type`). 0017's guard does not accept fields created by 0011.

## Decision

- Edit 0011 in place so it saves only a bare `sessions` base collection with all rules null. It declares no fields and no indexes.
- 0017 stays as written. It adds `userId`, `expiresAt`, `deviceLabel` and `idx_sessions_expiresAt`, which yields exactly the schema every successfully migrated deployment already has.
- Databases that already recorded 0011 never re-run it, so existing deployments are unaffected.
- This is a narrow exception to "never edit an applied migration". A later migration cannot repair 0011 because 0011's failure aborts the batch before any later migration runs.
- `sessions` stays compatibility debris. The BFF reads and writes only `obol_sessions`.
- Supersedes D015's claim that a fresh boot does not fail on 0011, and D013's "0011 untouched" constraint. Both decisions stand otherwise.

## Verification

- Repeated fresh-volume `migrate up` runs on the pinned image with zero 0011 failures.
- A fresh `sessions` schema probe shows `userId`, `expiresAt`, `deviceLabel` and `idx_sessions_expiresAt`.
