# D015 - Verified PocketBase session migration behavior

**Status**: accepted · **Date**: 2026-10-29 · **Target release**: 0.3.0 · **Related**: [D009](D009-remote-identity.md), [D012](D012-pocketbase-session-metadata.md), [D013](D013-repair-legacy-sessions-migration.md)

## Context

D013 records an observed `0011_create_sessions_collection` failure and proposes a two-boot repair sequence. The first clean Compose run with migration 0017 present did not reproduce that sequence, so its expected failure count and extra-restart requirement needed a live check.

The isolated deployment used the pinned PocketBase 0.40.6 image. A fresh volume booted with the current migration set, and a follow-up PocketBase restart produced no `1700000011_create_sessions_collection.js` error. A PocketBase SDK schema probe found the legacy `sessions` fields and index, plus `obol_sessions` with `userId`, `expiresAt`, `deviceLabel`, `createdAt`, and its expiry index. A read-only SQLite probe of the live volume's `_migrations` journal found entries for both 0011 and 0017. The authenticated BFF session remained valid after PocketBase/BFF restart and offline backup/restore.

## Decision

- Keep migration 0017 as a non-destructive repair for id-only legacy `sessions` collections. Keep `obol_sessions` as the sole BFF registry and `createdAt` as the persisted hard-cap timestamp.
- Supersede D013's expected first-upgrade error and mandatory two-boot timeline. The verified 0.40.6 fresh boot and follow-up restart emitted no 0011 error; no extra operator restart is required by the supported migration path.
- On upgrades, use the standard backup and normal Compose startup. Confirm PocketBase health, session schema, and absence of a recurring 0011 error. For a volume that still reports the old index error, allow 0017 to run and inspect the migration journal/schema on the next normal startup; do not suppress recurring migration errors.
- Preserve 0011 and all prior migration files. D015 records the tested runtime result; it does not change the accepted schema or authentication contract.

## Consequences

- The runbook no longer instructs operators to expect an extra failure/restart.
- `sessions` remains compatibility state. The BFF serves and mutates only `obol_sessions`.
- Legacy `obol_sessions` rows without `createdAt` remain fail-closed; their devices must sign in again rather than receiving a guessed session age.

## Verification and limits

- Verified on Docker Compose and the pinned PocketBase 0.40.6 image with an isolated volume. The clean boot, second startup, live schema probe, and migration-journal probe passed.
- Verified BFF authentication, session list/renew/revocation, restart persistence, and offline volume restore on the same PocketBase version.
- This result does not authorize a PocketBase version or deployment topology other than the pinned configuration tested here.

## Related decisions

- [D012](D012-pocketbase-session-metadata.md) — `createdAt` storage and fail-closed hard expiry.
- [D013](D013-repair-legacy-sessions-migration.md) — migration 0017 repair; this decision supersedes only its expected two-boot timeline.
