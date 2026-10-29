# D010 - `obol_sessions` as the BFF session registry

**Status**: accepted · **Date**: 2026-10-29 · **Target release**: 0.3.0 · **Related**: [D009](D009-remote-identity.md), [E006](../epics/E006-central-server-mobile.md)

## Context

D009 named the BFF-minted session registry `sessions`. E2E verification against the pinned PocketBase v0.40.6 image showed that name is unusable:

- PocketBase ships a reserved built-in collection `sessions`; after applying all migrations, `pb.collections.getOne('sessions').fields` contained only the system `id` field.
- D009's migration `1700000011_create_sessions_collection.js` uses `app.findCollectionByNameOrId('sessions')` and returns early when the collection already exists, so it silently treated PocketBase's built-in collection as the D009 registry and never created the intended fields.
- `createSession` therefore wrote records during login and `sessions.create` silently accepted and dropped the unsupported `userId`/`expiresAt`/`deviceLabel` fields. The built-in registry is not a valid session store, and remote login failed at the registry step with PocketBase 400s surfaced as `INTERNAL`. Only one-off in-memory auth tests (which bypass the migration-created collection shape) passed.

The problem is a name collision, not a contract problem: D009's endpoints, claims, one-owner model, and revocation/TTL rules are unaffected. This decision narrowly supersedes D009 only in the storage name; D009 stays accepted as written and is not edited.

## Decision

- 0.3.0 uses the custom PocketBase collection `obol_sessions` as the BFF session registry, with the exact D009 field set: `userId` (owner record id), `expiresAt`, `deviceLabel`, and an index on the lookup field used by the per-request revocation check.
- A new migration `db/pb_migrations/1700000014_create_obol_sessions_collection.js` creates `obol_sessions`; it preserves D009's guarantees verbatim: BFF-minted HS256 JWT with `sub`/`sid`, per-request existence-and-expiry check, deletion of the record as revocation, hard expiry 30 days, token lifetime 7 days, password change/reset deleting all owner sessions.
- Migration 0011 remains as-is, untouched. Editing an already-applied migration is unreliable (applied migrations may not re-run), and D009's accepted record stays intact; the collision is fixed additively with 0014, not by rewriting history.
- No data migration exists and none is needed: the invalid built-in `sessions` registry contains no user or session rows (it only ever exposes the system `id` field), so `obol_sessions` starts empty and the first login after deploying 0.3.0 creates the first valid record.
- The change alters internal persistence only. The HTTP route contract is unchanged: `/api/auth/session` and all D009 endpoints, error codes, and claims keep their names and behavior.

## Consequences

- Explicit local opt-out (safeguard shipped alongside this change): the standalone local RPC runtime (`desktop/electrobun/bun/index.ts`) constructs the server with `createServer(pb, null)`, so a developer's host-level `OBOL_SESSION_SECRET` can never accidentally enable — or corrupt with a different secret — remote-session enforcement in the purely local runtime. The local profile unlock (D007) remains its authentication boundary, independent of any session secret in the environment.
- Deployment of 0.3.0 ships one extra migration; no session data carries over, so every device must sign in again after upgrading, which is exactly D009's own rule for any session-registry revocation.
- Runbooks in `docs/self-hosting.md` now name `obol_sessions` wherever they refer to the stored records (reset logout sweep, revoke-by-hand, volume backup wording); the D009 endpoint names they cite are untouched.
- Any future refactor of the registry that changes names again requires a new ADR; the log records this as a narrow supersession of D009's storage detail, not a change to the session contract.

## Honesty notes

- `pb.collections.getOne('sessions')` post-0011 containing only the system `id` field is verified evidence from the pinned v0.40.6 image, not inference; the group of login failures is reproduced with the real BFF endpoints and resolved by the renamed registry.
- D009's accepted wording is unchanged; the supersession is recorded here and in `log.md`, and the BFF code and migration 0011 are intentionally not edited.

## Related decisions

- [D009 - Single-owner remote identity and session contract](D009-remote-identity.md) — own the contract; this decision supersedes only its storage name.
- [E006 - Central server for mobile/desktop clients](../epics/E006-central-server-mobile.md) — consumes the D009 endpoints unchanged.
