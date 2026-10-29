# D009 - Single-owner remote identity and session contract

**Status**: accepted · **Date**: 2026-10-29 · **Target release**: 0.3.0 · **Related**: [E006](../epics/E006-central-server-mobile.md), [D008](D008-central-server-clients.md), [D007](D007-local-profile-unlock.md), [D005](D005-electrobun-local.md)

## Context

D008 proposes a shared central runtime for remote desktop and iOS clients but explicitly refuses to authorize remote access until an identity and tenancy model is recorded. The current facts it waits on:

- The BFF authenticates PocketBase as a superuser and has no end-user identity. All collection API rules are `null` (`db/pb_migrations/1700000000_init_schema.js`), so every valid PocketBase credential means full data access.
- The controllers, repositories, use cases, and scheduler carry no owner concept. `server/src/infrastructure/scheduler/index.ts` runs jobs from cron; `POST /api/jobs/*` (`JobController.ts`) and `GET /` are unauthenticated today.
- The repositories stay unscoped on purpose: every record belongs to the deployment's data, with no per-record ownership fields.
- PocketBase 0.40.6 (pinned for desktop in D007) is stateless: auth tokens are HS256 JWTs, there is no server-side session store, no logout endpoint, no per-request token verification endpoint (only `authRefresh`), and tokens are invalidated by changing the record's `tokenKey`/password or the collection token secret (`pocketbase.io/docs/authentication`).
- The desktop already treats its local login (D007) as a UI gate, not remote authentication, and the hosted web client talks to the BFF only through the same-origin Nuxt `/api/**` proxy.

This ADR resolves the gate so D008 and E006 workstream 2 can proceed.

## Decision

### D1 - A deployed server has exactly one owner

A 0.3.0 central deployment is single-owner and single-tenant. One PocketBase auth collection `owner` holds one record, created only through first-run setup. There is no registration endpoint, no invitation flow, and no second owner account. Multiple simultaneous devices are sessions of that one owner.

Honest consequence: the model has no cross-user isolation to enforce. Any request with a valid session sees and mutates all of the deployment's data. E006's "cross-user access is denied where the selected model has multiple users" clause is satisfied vacuously: this model has one user. Any future per-record isolation, family sharing, or separate administrator accounts requires a new ADR plus a per-record ownership migration; it cannot be inferred from this one.

Diffs required by a multi-tenant model (owner_id on all collections, owner-scoped repository signatures and queries, per-user scheduler rules) are exactly the work this release avoids. Keeping 0.3.0 single-owner is what makes the unscoped repositories safe.

### D2 - The BFF mints sessions; PocketBase stays a private credential checker

- Login: `POST /api/auth/login` forwards `email` + `password` to `pb.collection('owner').authWithPassword`. On success the BFF creates a `sessions` record (see D3) and mints its own JWT, HS256, signed with `OBOL_SESSION_SECRET`, claims `sub` (owner record id) and `sid` (session record id).
- Every authenticated request validates: signature, `exp`, and the existence of the session record with that `sid` and an unexpired `expiresAt`. Deleting the session record revokes the session on the next request. The extra indexed PocketBase lookup per request is the accepted cost of real revocation with stateless JWTs; it is one small `getOne` on a database that is consulted on every request anyway.
- Renewal: `POST /api/auth/session/renew` re-issues the JWT with a fresh `exp` and extends `expiresAt`. Sessions hard-expire 30 days after creation regardless of renewal; each individual token lives at most 7 days. The old token stays valid until its own `exp` (PocketBase semantics), so clients must treat any consequence-free overlap when swapping tokens.
- Password change or reset deletes all `sessions` records of that owner, revoking every device.
- Clients never receive a PocketBase token of any kind, never connect to PocketBase, and never see superuser credentials. The only client-facing credential is the BFF session token.

### D3 - API contract

All endpoints live under the existing typed Elysia `App`, so Eden Treaty stays end-to-end typed. Error bodies are uniform `{ code, message }`.

| Endpoint | Authorization | Behavior |
|---|---|---|
| `GET /api/setup/status` | public | `{ setupRequired, serverName, smtpConfigured }`; no user data |
| `POST /api/setup/init` | setup token only (D4), only while no owner exists | create the owner record; returns `serverName`; token invalidated and setup window closed |
| `POST /api/auth/login` | public; rate-limited | session token + `expiresAt` + `serverName`; generic `INVALID_CREDENTIALS` on failure |
| `POST /api/auth/session/renew` | session | new token and extended `expiresAt` |
| `GET /api/auth/session` | session | this deployment's sessions (id, created, device label) |
| `DELETE /api/auth/session` | session | revoke the calling session (logout) |
| `DELETE /api/auth/session/{id}` | session | revoke any session of the owner |
| `POST /api/auth/request-password-reset` | public; rate-limited | D5 flow; always returns a success body (enumeration protection) |
| `POST /api/auth/confirm-password-reset` | reset token from the email link | set new password, delete all owner sessions |
| every controller: `/api/transactions`, `/api/cards`, `/api/recurrences`, `/api/categories`, `/api/projects`, `/api/accounts`, `/api/forecast` | session (including GETs) | unchanged payloads |
| `POST /api/jobs/*` | session | unchanged payloads |
| `GET /` | public | health only; the current `admin: pb.authStore.record?.email` disclosure is removed (remediation in D8) |

Error codes and client obligations:

| Code | Client action |
|---|---|
| `UNAUTHENTICATED` | show connect/login screen; keep local mode intact |
| `SESSION_EXPIRED` | delete stored session, show login |
| `SETUP_REQUIRED` | guided by `GET /api/setup/status` |
| `INVALID_CREDENTIALS` | inline error, no retry storm |
| `RATE_LIMITED` | exponential backoff |

### D4 - Bootstrap and ownership takeover protection

- The server starts in setup mode when no `owner` record exists. On each boot in setup mode, the BFF generates a 32-hex-character setup token, prints it to container logs (`docker compose logs obol-server`), and accepts it until used or until a 30-minute TTL expires. `OBOL_SETUP_TOKEN` may pin a static token instead.
- Whoever proves the setup token proves compose access, which is the deployment's trust root: the attacker able to read container logs is inside the operator boundary already. The 30-minute window bounds the exposure of a public ingress during setup.
- After setup succeeds, `POST /api/setup/init` permanently refuses with `FORBIDDEN`; a second owner cannot be created through the API. Creating a second owner through PocketBase's private admin surface is an operator action outside the product contract.

### D5 - Credential lifecycle

- Password policy: minimum length 10 enforced by the `owner` collection options and by the BFF before hashing.
- Self-service reset requires SMTP. The production compose ships `PB_SMTP_*` variables wired into PocketBase settings, with PB mail templates pointing reset links at the hosted web client, which forwards the reset token to `POST /api/auth/confirm-password-reset`.
- No SMTP (personal deployments): a documented operator path recovers the owner password via `superuser upsert`-style server-internal access (server container + superuser credentials, never exposed to clients). Clients always have `UNAUTHENTICATED`/`SESSION_EXPIRED` to guide the user toward the hosting operator.
- Email change and email/OTP verification are out of scope for 0.3.0; changing owner identity is an operator action. Password-only login means MFA/OTP is a new-ADR decision later.

### D6 - Transport, cookies, CSRF, CORS, TLS

- Production ingress terminates TLS; clients use HTTPS. The BFF and PocketBase bind only to the Compose internal network in the production compose. The BFF itself stays plain HTTP behind the proxy; the documented deployment always fronts it with TLS, and clients require an explicit developer override before they will use an `http://` endpoint (the development compose is that override).
- Hosted web (Nuxt proxy) authenticates with an httpOnly, `Secure`, `SameSite=Lax` cookie `__Host-obol_session`. Same-origin proxying means no CORS involvement there.
- CSRF for cookie-based requests: `SameSite=Lax` plus an `Origin` check on non-GET requests against `OBOL_PUBLIC_URL`. Rejected origins get `FORBIDDEN`.
- Remote desktop and iOS clients authenticate with `Authorization: Bearer <jwt>`; header authentication carries no CSRF risk, so the Origin check does not apply to Bearer requests.
- CORS: the BFF emits `Access-Control-Allow-Origin` only for origins in `OBOL_CLIENT_ORIGINS` (comma-separated, default empty). iOS/Capacitor declares itself in that list or uses its native request plugin that bypasses web CORS. Adding an origin is an operator's explicit deployment choice, never a wildcard.

### D7 - PocketBase secret boundary

- `PB_ADMIN_EMAIL`/`PB_ADMIN_PASSWORD` are only for the server-side PocketBase client (`createPocketBaseClient`) and, system-privately, for recovery paths. They are never embedded in the SPA, installers, or clients, and are excluded from any error or log output surfaced to the UI.
- `OBOL_SESSION_SECRET` is independent of the PocketBase superuser password, at least 32 random bytes, and required in remote mode: the server fails closed (refuses to start) if it is unset when remote mode is enabled. Rotation invalidates all session JWTs at once; document it as the global-admin panic kill switch, since per-session revocation is the normal path.
- The production compose assigns no public ingress to PocketBase. Existing development and Coolify composes keep today's topology and remain out of this contract's scope.

### D8 - Background scheduler and administrative identity

- The cron scheduler keeps running as the server's superuser identity, with no end-user context. This is sound only because D1 guarantees one owner: the server is the data's administrator, so "background" never crosses an ownership boundary. This statement is precisely what a future multi-owner ADR must invalidate first.
- `POST /api/jobs/*` become owner-session-gated operator actions (same session, not a separate admin role; D1 forbids a second principal).
- `GET /` remains public health but drops the superuser email field (currently `pb.authStore.record?.email` in `server/src/index.ts`), so no credential-derived datum leaks from an unauthenticated route.

### D9 - Client session storage

| Client | Storage | Rationale |
|---|---|---|
| iOS | Keychain, after first unlock | standard mobile credential protection |
| Desktop remote mode | WebView `localStorage` of the desktop SPA | same protection class and threat model as D007's local profile and data: the operating-system account and disk encryption; no at-rest encryption is claimed |
| Hosted web | `__Host-obol_session` httpOnly cookie | never readable by scripts, immune to XSS token theft |

The desktop keeps its local RPC path (`window.obol.apiFetch`) and local profile unlock exactly as is; remote sessions are a second, separate configuration, never silently backfilling local data (D008's no-sync rule).

### D10 - Where the auth middleware activates

The auth plugin is created with the `OBOL_SESSION_SECRET` check: when the variable is absent (desktop local runtime), the app composes exactly as today, preserving the local RPC and hosted-web-behind-legacy-proxy behavior until the login UI ships. When it is present (hosted and central deployments), every route in D3 is enforced, including for the existing hosted web, which gets the login UI in the same deploy.

## Implementation requirements (conditions for remote exposure)

Migrations under `db/pb_migrations`, in the existing numbering style:

1. `1700000010_create_owner_collection.js`: auth collection `owner` (identity/password only, minimum password length 10, others explicitly disabled; verification email flow off).
2. `1700000011_create_sessions_collection.js`: base collection `sessions` with fields `userId` (relation to `owner`), `expiresAt` (date), `deviceLabel` (text), and an index on `expiresAt`; created by the BFF superuser at runtime; collection rules `null` as everywhere, since clients never reach PocketBase.

Servers:

3. Auth middleware plus the D3 routes in `server/src`, hooked into the existing typed routing (D006), with `OBOL_SESSION_SECRET`, `OBOL_PUBLIC_URL`, `OBOL_CLIENT_ORIGINS`, `OBOL_SETUP_TOKEN`, and `PB_SMTP_*` environment handling and the fail-closed start.
4. `GET /` remediation (remove superuser email) in the same change.
5. Login rate limiting: in-process per-IP and per-identity counters (10 failures/15 min per IP, 5 per identity) at the BFF. Bounded to a single process, which D1 makes real (no horizontal scaling contract in 0.3.0).

Clients:

6. Cookies and Bearer token issuance handled per D6 and D9; the Nuxt app adds a login screen and clears sessions on D3 codes; the desktop adds a "connect to server" flow that stores `serverUrl` + session token separate from local profile; the iOS client (packaging ADR still to be prototyped) consumes the same contract.
7. Production compose (E006 workstream 2) wires the new env block, internal-only PocketBase, and TLS ingress; setup-token retrieval goes in the deployment runbook.

Operational docs: an owner-setup runbook plus SMTP TLS (not MFA) notes; password reset test path; revocation drill (kill one device, keep other sessions alive; rotate secret; confirm data stays).

## Migration and operations behavior

- Upgrade: run PB migrations, then deploy the BFF with `OBOL_SESSION_SECRET`, deploying the hosted web login UI in the same release. Before any of this, current deployments keep working unchanged because D10 keeps auth off without the secret.
- Data: no row changes. Existing records are implicitly the first owner's; setup simply creates the owner identity, so no per-record migration or backfill exists to run or fail.
- Failed setup before deployment: the server boots into setup mode, business routes return `SETUP_REQUIRED`, and no one is locked out or leaked into.
- Backup/restore: `pb_data` volumes carry `owner` and `sessions` just like the rest; restoring the volume restores the identity. Deleting only the `owner` record (operator recovery) sends the server back to setup mode; sessions referencing a dead owner fail closed with `SESSION_EXPIRED`, never leaking the existence of a deleted owner.
- Secret rotation: a new `OBOL_SESSION_SECRET` invalidates every JWT; stale `sessions` rows are cleaned up on the next renew attempt of a session that can no longer validate. Documented as global revocation in D7.

## Alternatives considered

| Alternative | Verdict |
|---|---|
| Pass through PocketBase-issued owner tokens to clients | Rejected: no per-request verification (only `authRefresh`), revocation only by tokenKey/password/secret change, and it gives clients a PocketBase-API-shaped credential, eroding the BFF boundary D008 emphasizes. |
| Multi-tenant deployments with per-record `owner_id` | Rejected for 0.3.0: touches every collection, repository signature, use case, and scheduler rule; E006 explicitly holds new data-model fields behind an ADR. Recorded as the explicit next gate in D1, not silently deferred. |
| Opaque random session tokens only (no JWT) | Same registry property (session lookup per request) without the self-contained `exp`; JWT chosen because HS256 signing plus registry lookup gives the revocation of the opaque variant at the same cost, with standard tooling. |
| API keys per device instead of sessions | Rejected: PocketBase lacks durable revocable keys, and device naming/revocation UX (a real requirement of E006 workstream 1) maps naturally to sessions, not static keys. |

## Status rationale

Accepted, not proposed. Nothing precedes or blocks this decision: D008's and E006's gates name exactly this missing contract and wait on it; every mechanism chosen exists in the pinned PocketBase 0.40.6 (auth collections, password reset, base-collection session registry, token invalidation) and the BFF's current typed-route architecture (D006). Existing accepted decisions (D001/D005/D006/D007) are unaffected; D008 remains proposed until its implementation gates land, but this ADR clears its precondition. The lists above are requirements, not options: remote endpoints are only exposed once items 1-7 ship, and until then today's unauthenticated fallback behavior is the only authorized exposure.
