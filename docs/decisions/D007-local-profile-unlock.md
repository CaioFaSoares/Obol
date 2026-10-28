# D007 - Local profile unlock and PocketBase credential recovery

**Status**: accepted · **Date**: 2026-10-28 · **Implemented**: 0.1.0a

## Context

Obol 0.1.0 generated a random PocketBase superuser password and stored it beside the local profile. If that sidecar was missing or no longer matched the local database, the app stopped before showing its window. Obol also had no first-run account or unlock screen.

## Decision

- The desktop opens on a local setup/unlock screen. Hosted web mode remains unchanged.
- One local profile belongs to each Obol application-data directory. First launch asks for a name, email, and password; later launches require that account's password.
- `desktop/electrobun/bun/local-auth.ts` derives a verifier and a domain-separated PocketBase superuser password from PBKDF2-HMAC-SHA256 with a per-profile salt and 600,000 iterations. `local_profile.json` stores the salt and verifier, never the plaintext password.
- Before starting the PocketBase child, the main process runs PocketBase 0.40.6 `superuser upsert` with the derived password. It then starts the child and authenticates the local Elysia client. This repairs a missing or stale 0.1.0 internal credential without dropping collections or records.
- The profile password gates the app UI; it does not encrypt PocketBase database files. Local files remain protected by the operating-system account and disk encryption such as macOS FileVault.
- The internal PocketBase email remains `obol@localhost.invalid`. The user email identifies the local profile and is not sent to a hosted service.

## Alternatives considered

- Keep a random password file as the only credential: rejected because losing or mismatching it blocks application startup.
- Reset or recreate `pb_data` after authentication failure: rejected because that would destroy the user's transactions.
- Treat the local login as database-at-rest encryption: rejected because PocketBase's SQLite files remain plaintext to the local operating-system account.

## Consequences

- Desktop setup is also the upgrade path for a 0.1.0 profile with no `local_profile.json`; PocketBase data remains in place.
- Desktop API requests remain RPC-only and are dispatched after a local profile unlock.
- Hosted authentication and hosted PocketBase data are unaffected.
