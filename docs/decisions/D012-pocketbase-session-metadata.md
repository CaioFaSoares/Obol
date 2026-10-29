# D012 - Session record timestamps and the real `sessions` collision evidence

**Status**: accepted · **Date**: 2026-10-29 · **Target release**: 0.3.0 · **Related**: [D009](D009-remote-identity.md), [D010](D010-obol-sessions-registry.md), [D011](D011-session-registry-field-repair.md)

## Context

Rerunning the real self-host Compose deployment against the pinned PocketBase v0.40.6 image surfaced evidence that corrects D010's causal story, and a live SDK probe added a fact neither D010 nor D011 had recorded.

**The corrected evidence.** A fresh startup logged migrations `0011_create_sessions_collection` and `0014_create_obol_sessions_collection` both failing with `no such column expiresAt`, after which `sessions` existed with only the system `id` field. That collection was an **id-only custom collection created by the failing 0011 migration, not PocketBase's reserved built-in `sessions`**: the migration's create step (`CreateCollection` without a full field list) succeeded, its subsequent field/index steps failed, and 0014's early return `app.findCollectionByNameOrId('sessions')` then found it. D010's explanation — that PocketBase ships a reserved built-in `sessions` collection that silently swallowed the registry — is therefore not supported by the evidence and is superseded here. That is a correction of the *cause*, not of the *fix*: D010's chosen name `obol_sessions` stands, now understood as an explicit app-owned namespace rather than a workaround for a PB-reserved name. No API path changes.

**The timestamp gap.** A live SDK probe on this runtime showed that `obol_sessions.create()` returns no `created` property on the record it saves. PocketBase base collections created the way 0011/0014 created them carry only the system `id`; they do not auto-inject `created`/`updated` (consistent with the non-injected `id/created/updated` shape D005's migrations are written against). D009's immutable 30-day hard cap has always been computed from the stored record's creation timestamp, so the current auth code fails closed at login with `Session creation failed (PocketBase returned no created timestamp)`.

## Decision

- **Storage field**: `obol_sessions` gains an app-owned `createdAt` date field, added by migration `db/pb_migrations/1700000016_add_obol_session_created_at.js` using the same additive `Collection.fields.add` convention as 0015. 0014 and 0015 stay untouched; editing already-applied migrations remains out of scope.
- **Fail-closed semantics for old rows**: `createdAt` is added optional. Legacy `obol_sessions` rows that lack the field receive no guessed age; the BFF treats the cap as expired for them, so a pre-upgrade session fails closed rather than being silently minted a fresh 30-day window. New logins persist `createdAt` at record creation; renewal and the 30-day cap are computed only from this immutable persisted value, never from a token claim alone.
- **Response shape**: D009's session-list output keeps the API key `created` for client compatibility; the BFF maps it from the stored `createdAt`. The storage field name and the API response key are deliberately distinct; only the API contract name is unchanged.
- **Supersession scope**: this decision supersedes D010's reserved-built-in explanation and records the `created`-absence detail. D009, D010, and D011 remain accepted as written and are not edited; D010's registry name and D011's 0015 field repair (`userId`/`expiresAt`/`deviceLabel` and the lookup index, the final real schema) both stand.

## Consequences

- Deployments of 0.3.0 apply 0016 after 0014/0015 at PocketBase startup; the backup-before-upgrade rule from D011 applies unchanged.
- Every session record created after this ships carries `createdAt`; the hard cap no longer depends on PocketBase-provided record timestamps, which this runtime does not supply.
- Devices whose sessions predate the field must sign in again, matching D009's own rule that pre-upgrade session state is not carried across registry changes.

## Honesty notes

- The migration-failure evidence (`no such column expiresAt` on 0011 and 0014, id-only `sessions` afterwards) comes from the actual v0.40.6 Compose startup log, not inference. The conclusion that the residual `sessions` collection was created by failing 0011 follows directly from that log; the earlier claim of a PB built-in was an interpretation, now retracted.
- The absence of `created` on base-collection record creates is verified by a live SDK probe (`obol_sessions.create()` returning no `created` property). Live-runtime verification of 0016 itself remains gated on the main agent's Compose probe; this document records the plan, not a completed live check.

## Related decisions

- [D009](D009-remote-identity.md) — owns the 30-day immutable cap; this decision supplies the timestamp it needs.
- [D010](D010-obol-sessions-registry.md) — `obol_sessions` name stands; its built-in `sessions` causal claim is superseded.
- [D011](D011-session-registry-field-repair.md) — 0015 field repair stands; 0016 extends the same additive pattern.
