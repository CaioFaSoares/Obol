# D013 - Runtime repair of the legacy `sessions` retry loop (migration 0017)

**Status**: accepted · **Date**: 2026-10-29 · **Target release**: 0.3.0 · **Related**: [D009](D009-remote-identity.md), [D010](D010-obol-sessions-registry.md), [D011](D011-session-registry-field-repair.md), [D012](D012-pocketbase-session-metadata.md)

## Context

With migrations 0014, 0015, and 0016 now applying successfully, a fresh self-host Compose boot against the pinned PocketBase v0.40.6 image still repeats on every startup:

```
failed to apply migration 1700000011_create_sessions_collection.js: indexes: ... no such column: expiresAt
```

The cause is the same constructor defect documented in D012: 0011's `CreateCollection` step persists the bare `sessions` collection (system `id` only, the fields not yet stored), its next step builds `CREATE INDEX idx_sessions_expiresAt ON sessions (expiresAt)`, SQLite rejects the index at execution time because `expiresAt` does not exist yet, and the migration fails as a whole. Since the collection already exists, 0011's early return (`app.findCollectionByNameOrId("sessions")`) always finds it on the next run — but the failure is never recorded as applied in PocketBase's migration journal, so PocketBase retries 0011 on **every** startup, fails the same way, and the deployment logs the error forever even though the runtime still reaches healthy.

The service impact is cosmetic today: the BFF reads `obol_sessions` exclusively (D010-D012), and the residual id-only `sessions` collection is never served, referenced, or exposed. But a permanently failing migration in the startup log is operator noise, masks real migration failures behind a familiar error, and re-runs non-idempotent code on every boot. This is a runtime-repair problem, not a schema or contract problem: D009-D012 stand as written and 0011 itself is not edited.

## Decision

- **Additive repair migration**: a new migration `db/pb_migrations/1700000017_repair_legacy_sessions_collection.js` brings the orphan legacy `sessions` collection to the exact shape 0011 expects: it adds the `userId` (relation to `owner`, and only if adding an import-matching shape is possible — all added fields are optional), `expiresAt` (date), and `deviceLabel` (text) fields with `Collection.fields.add` in place and appends the `idx_sessions_expiresAt` index if absent. No collection is dropped or rebuilt; any rows from the partial create are preserved, and no fabricated values are written because every added field is optional.
- **Guards**: 0017 rejects a system collection outright (a future PocketBase built-in `sessions`, if one ever appears, must never be mutated here) and rejects a same-named field whose existing type differs from what 0011 declared, rather than silently keeping a malformed schema.
- **Two-boot convergence**: 0017 is the last migration in the sequence and does not touch 0011. On the first upgrade boot, the legacy 0011 failure is logged once more (expected, harmless), 0017 repairs the collection, and the boot completes. On the following PB startup, 0011's early return now finds a fully-shaped `sessions` collection and succeeds, so PocketBase records 0011 as applied and the retry loop ends. Neither boot requires operator action beyond the standard upgrade procedure.
- **Registry scope unchanged**: `obol_sessions` (0014, repaired by 0015, timestamped by 0016) remains the only live BFF session registry. The repaired `sessions` collection is dead compatibility debris: satisfied 0011, preserved rows, and nothing more. The BFF never reads, writes, or exposes it, and no client route reaches it.
- **0011 untouched**: editing already-applied or failing migrations remains out of scope (see D011's rationale). Repairing forward keeps the journal and the accepted decision record intact.
- **Rollback / removal**: 0017 is non-destructive like 0015/0016 — rolling back the code leaves the added fields and index in place, harmless. Once a deployment has converged (0011 recorded applied), 0017 becomes a no-op and is retained only for fresh deploys that carry the damaged state; whether to drop it later is a separate decision, not part of this one.
- **Operator backup requirement unchanged**: take the standard offline volume backup (`docs/self-hosting.md`, "Data, backups, restore") before upgrading into a deployment that picks up 0017, as with any schema-affecting migration.

**Supersession scope**: D013 supersedes D012's assumption that 0014/0015/0016 alone complete migration startup — a fourth migration is required to close the legacy 0011 record. It does not change D012's `createdAt` decision, its fail-closed semantics, or its corrected historical cause, and it edits none of the accepted D009-D012 documents.

## Consequences

- Fresh deployments of 0.3.0 can complete the full migration sequence (0000-0017) and, after one extra restart, end with every migration — including 0011 — recorded as applied, instead of retrying 0011 forever.
- Already-broken deployments converge in place with no data loss and no action beyond the routine upgrade steps in the runbook.
- The startup log shows the 0011 failure one extra time during the upgrade; operators are told in `docs/self-hosting.md` this is expected and self-terminating, and that a repeat after the next startup signals a different problem worth investigating.
- The legacy `sessions` collection stays in the database as inert debris; documenting that here prevents a future cleanup from mistaking it for live state.

## Honesty notes

- The repeated `no such column: expiresAt` failure on 0011 comes from the real v0.40.6 Compose production log, not inference; the mechanism (constructor persists the collection before fields, index fails, journal never records success) follows from that log plus D012's verified evidence.
- The two-boot convergence claim is the designed behavior of the repair migration, not yet a completed live-runtime verification: no accepted statement here may be read as "the next boot was already observed to mark 0011 applied." Live verification remains gated on the main agent's Compose probe, exactly as in D011/D012.

## Related decisions

- [D009](D009-remote-identity.md) — session contract; untouched.
- [D010](D010-obol-sessions-registry.md) — `obol_sessions` is the only registry; the legacy `sessions` collection is debris.
- [D011](D011-session-registry-field-repair.md) — additive `Collection.fields.add` repair convention 0017 reuses.
- [D012](D012-pocketbase-session-metadata.md) — corrected cause of the 0011/0014 failures; superseded here only on "0014-0016 are the last migrations needed."
