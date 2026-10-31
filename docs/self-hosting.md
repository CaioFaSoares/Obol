# Self-hosting the Obol central server

Operator guide for the dedicated production deployment (`docker-compose.self-hosted.yml`): the Elysia BFF, a private PocketBase, and a hosted Nuxt web client, with the remote identity contract of [D009](decisions/D009-remote-identity.md) implemented. The web client is the existing Nuxt app built by the dedicated `app/Dockerfile.self-hosted`; the existing dev and Coolify compose files, and `app/Dockerfile`, are unchanged and remain supported.

**Read this first**: the stack now enforces one owner, session-authenticated routes, and fail-closed startup — and it is only as exposed as you make it. The BFF and web ports are published on every host interface (LAN-reachable) by default; before exposing them beyond a private LAN you **must** have TLS in front of both ports and nonempty secrets in `.env.self-hosted` (`OBOL_SESSION_SECRET`, `OBOL_PUBLIC_URL`, the PocketBase superuser credentials). A deployment without TLS or with weaker secret hygiene must stay on a private LAN/VPN you own or a tunnel — the specifics are in the TLS / reverse proxy section below.

## What authentication you get

- The deployment has **exactly one owner** (D009 D1). All data belongs to that one deployment; any valid session sees and mutates all of it. There is no registration, invitation, or second account.
- Sessions are minted by the BFF, signed with `OBOL_SESSION_SECRET` (HS256, at most 7 days old, hard-expiring 30 days) and revocable per device. A password reset revokes every device at once.
- PocketBase never talks to clients: no published port, no credentials of any kind cross the boundary. Its superuser account is an operator-only recovery identity, separate from the owner login.

## Files

| File | Role |
| --- | --- |
| `docker-compose.self-hosted.yml` | Production stack: `obol-bff` (Elysia/Bun) + `obol-web` (Nuxt SSR) + `obol-pb` (PocketBase) |
| `app/Dockerfile.self-hosted` | Production image recipe for `obol-web`: SSR build with the internal BFF address baked in; separate from `app/Dockerfile`, which dev/Coolify keep using |
| `.env.self-hosted.example` | Copy to `.env.self-hosted`; holds every required and optional variable |
| `db/pb_migrations/` (host checkout) | JSVM migrations, mounted read-only into PocketBase |

## Requirements

- Docker Engine with Compose v2.17+ (verified with Compose v5.6.1).
- A checkout of this repo on the server: the compose context builds (`./server`) and binds the migrations (`./db/pb_migrations`) from the working tree. Data lives in a named Docker volume (`obol-self-hosted_obol_pb_data`), so sharing the repo with a dev checkout is fine.

## Quick start

```bash
# 1. From the repo root on the server
cp .env.self-hosted.example .env.self-hosted
# Keep the operator file private; it contains the server session and database credentials.
chmod 600 .env.self-hosted
$EDITOR .env.self-hosted
#    Required: OBOL_SESSION_SECRET (generate with: openssl rand -hex 32),
#              OBOL_PUBLIC_URL (the public https URL), OBOL_PB_ADMIN_EMAIL,
#              OBOL_PB_ADMIN_PASSWORD.
#    Optional: BFF_PORT, WEB_PORT, OBOL_CLIENT_ORIGINS, OBOL_SETUP_TOKEN,
#              PB_SMTP_* (owner password-reset mail).

# 2. Validate before starting (fails if a required value is missing or empty)
docker compose -f docker-compose.self-hosted.yml --env-file .env.self-hosted config

# 3. Provision the PocketBase superuser (operator identity, D009 D7).
#    Load credentials into this shell only; do not enable shell tracing.
set -a
. ./.env.self-hosted
set +a
#    On a fresh volume neither identity exists and no default exists:
#    create the superuser here, then create the owner through the API in step 5.
#    `OBOL_PB_ADMIN_*` are the operator-file keys; the PocketBase CLI itself
#    takes the values as plain arguments (its own env names are irrelevant
#    here, and the PB container receives no credentials).
docker compose -f docker-compose.self-hosted.yml --env-file .env.self-hosted run --rm -T --interactive=false --no-deps \
  --entrypoint /usr/local/bin/pocketbase obol-pb \
  --dir=/pb_data superuser upsert "$OBOL_PB_ADMIN_EMAIL" "$OBOL_PB_ADMIN_PASSWORD"
#    Override the image entrypoint: the pinned image's entrypoint routes any
#    leading `--flags` into `serve` (e.g. `--dir=/pb_data` becomes a serve
#    flag) and never reaches the `superuser` subcommand. Running the
#    `pocketbase` binary directly makes `--dir=/pb_data` a root-global flag
#    before the `superuser` subcommand, so the account lands on the mounted
#    volume inside `obol_pb_data`.

# 4. Build and start
docker compose -f docker-compose.self-hosted.yml --env-file .env.self-hosted up -d

# 5. Create the single owner through the API (First run below).
```

The order matters: the superuser is provisioned before the stack serves so the BFF never runs against an empty `_superusers` table; the owner cannot be created before the BFF is up because the setup flow is an HTTP endpoint. Re-running step 3 later rotates the superuser password with the same volume. Do not omit the `--dir=/pb_data` flag: a one-off `docker compose run` replaces the `obol-pb` service's `serve --dir=/pb_data` command, so without it the superuser would be written to PocketBase's default data directory outside the persistent `obol_pb_data` volume and the running stack would still boot without a superuser.

## First run: create the owner

While no `owner` record exists, the deployment runs in setup mode: business routes (`/api/transactions`, `/api/forecast`, `/api/jobs`, ...) reject with the `SETUP_REQUIRED` code, and the setup endpoints are open:

```bash
curl -s http://127.0.0.1:8080/api/setup/status
# {"setupRequired":true,"serverName":"...","smtpConfigured":false}
```

Get the setup token from the BFF logs (D009 D4): at every setup-mode boot the BFF generates a one-time 32-character token and accepts it for 30 minutes.

```bash
docker compose -f docker-compose.self-hosted.yml logs obol-bff | grep '🔐 Setup token'
# 🔐 Setup token (30 minutes): <32 hexadecimal characters>   <- copy the token
```

Then create the owner with a plain HTTP client (from the server, loopback; behind your TLS proxy, use `https://HOST/api/setup/init` on the TLS host — curl sends no `Origin`, so it bypasses the D6 CORS check):

```bash
curl -s -X POST http://127.0.0.1:8080/api/setup/init \
  -H 'content-type: application/json' \
  -d '{"setupToken":"<token from the logs>","email":"owner@your-domain.example","password":"a-long-owner-password"}'
# {"serverName":"..."}
```

Password policy: at least 10 characters (maximum 71). After success:

- the token is invalidated and the setup window closes permanently; `POST /api/setup/init` then answers `{"code":"FORBIDDEN"}` — a second owner cannot be created through the API, ever (D009 D4);
- `GET /api/setup/status` reports `"setupRequired":false`;
- The hosted web client sends `transport: "cookie"` and receives only the expiry plus an httpOnly `__Host-obol_session` cookie.
- Desktop and iOS clients send `transport: "bearer"` and receive the BFF session token plus expiry; neither receives a PocketBase credential.

If you set `OBOL_SETUP_TOKEN` in `.env.self-hosted`, the BFF uses that static token instead of printing a fresh one (it is only re-announced, not reprinted; store it like a secret). Whoever can read the container logs is inside the operator boundary, which is why the token proves compose access.

## What is running

| Service | Container | Networks | Host exposure |
| --- | --- | --- | --- |
| BFF (Elysia) | `obol-bff` | `frontend`, `backend` | `0.0.0.0:${BFF_PORT:-8080}` (all interfaces) |
| Web client (Nuxt SSR) | `obol-web` | `frontend` | `0.0.0.0:${WEB_PORT:-3000}` (all interfaces) |
| PocketBase | `obol-pb` | `internal` network `backend` | none |

- PocketBase has no published port on purpose. The `backend` network is `internal: true`, so it has no outbound internet either; only `obol-bff` and `obol-pb` are attached, and neither `obol-pb` nor the web container is published (internal networks cannot publish ports at all, verified on Docker 29).
- The `obol-web` container receives **no environment at all**: `NUXT_PUBLIC_API_BASE=http://obol-bff:8080` is baked into the SSR bundle and routeRules at build time (`app/Dockerfile.self-hosted`), so the running image already resolves the BFF through the Compose network. Nothing sensitive is embedded into the client: the bundle carries no token and no PocketBase secret, and the browser only ever talks to its own origin.
- The BFF container receives, next to the PocketBase URL and superuser credentials, the D009 block: `OBOL_SESSION_SECRET`, `OBOL_PUBLIC_URL`, `OBOL_CLIENT_ORIGINS`, `OBOL_SETUP_TOKEN`, and the `PB_SMTP_*` variables. Missing required values make `docker compose` fail during interpolation with `required variable ... is missing a value`; there are no fallback credentials anywhere in this file set.
- The `obol-pb` container receives **no environment at all**: the superuser credentials live with the BFF process, and SMTP is applied by the BFF through the authenticated PocketBase settings API (see PocketBase picture below), never as container variables — nothing sensitive to copy in, nothing to leak from image entrypoints.
- All three services use `security_opt: no-new-privileges`, `restart: unless-stopped`, and HTTP health checks. `docker compose ... ps` shows all three `healthy` ~30 s after start.

## Web client and client API endpoint

After `up` (and behind the TLS proxy below), one host serves both surfaces:

- **`https://HOST/`** — the hosted Nuxt web client: the same UI the desktop bundle wraps, with the remote auth gate on first load, login, budget/track views, and the password-reset form. The browser session is the httpOnly `__Host-obol_session` cookie (D6/D9): the login page posts to `/api/auth/login` with `transport: 'cookie'`, so the response body carries no readable token and the BFF sets an httpOnly, `Secure` (TLS required), host-only cookie instead.
- **`https://HOST/api/*`** — the BFF API, unchanged for native clients: the desktop and iOS clients authenticate with Bearer headers against the same public host and never receive a cookie.

Loopback health probes bypass the proxy and address the published ports directly:

```bash
curl http://127.0.0.1:8080/     # BFF health: {"status":"Online","message":"BFF connected to PocketBase"}
curl http://127.0.0.1:3000/     # web client HTML: the Nuxt UI entry page
```

The BFF health route returns only its sanitized status (D009 D8): no superuser email is disclosed. Every BFF business route lives under `/api` (transactions, forecast, budgets, jobs, ... — no path outside `/api` is ever exposed through the proxy) and requires a valid session; the public routes are `GET /api/setup/status`, `POST /api/setup/init`, `POST /api/auth/login`, and the two password-reset routes (D009 D3). Login and password-reset requests are rate limited (10 failures per IP and 5 per identity per 15 minutes). Clients never see PocketBase, its admin UI `/_/`, or superuser credentials.

## TLS / reverse proxy (secure exposure)

A deployment is only valid for network sharing when a reverse proxy terminates TLS in front of the two published ports. This is part of the D009 contract, not a preference: BFF and web client stay plain HTTP behind the proxy, and clients are expected to always use the `https` public URL. Both ports are published on every host interface so LAN clients can reach them without the proxy (see the two bullets below); keep them off the public internet.

- **LAN clients**: the BFF port is what the native clients talk to — the iOS app and desktop remote mode retarget their requests to `<server URL>/api/*` with a Bearer token, and their CORS origins (`capacitor://localhost`, `views://mainview`) must be in `OBOL_CLIENT_ORIGINS`. The web port serves the Nuxt UI to a LAN browser. Plain `http://HOST_IP:3000` can render the UI but cannot keep a login: the session cookie is `__Host-obol_session`, which browsers accept only over a secure origin. Use the TLS proxy (or the Bearer native clients) for real sign-in.

- **Route contract**: two upstreams, one host, no path rewriting. `/api/*` forwards to the BFF (`http://127.0.0.1:${BFF_PORT:-8080}`); every other path forwards to the web client (`http://127.0.0.1:${WEB_PORT:-3000}`), which serves the Nuxt UI at `/`. All forwards preserve `Host`, `X-Forwarded-For`/`X-Forwarded-Proto`, and never strip `/api` (the BFF serves with the `/api` prefix, and the session cookie is issued against the public host). Hanging requests: none known today (no websockets in either container), so default proxy timeouts are fine.
- **Upstreams**: both are published on every host interface (`0.0.0.0:${BFF_PORT:-8080}` and `0.0.0.0:${WEB_PORT:-3000}`), so a same-host proxy can keep using `127.0.0.1` and a LAN client uses the host IP. Never forward either port to the internet. Because the web port is published, its built-in `/api` route rule (Nuxt's routeRules proxy to the BFF) answers on the LAN as well; it forwards to the same BFF, which still enforces the session, but a public hostname must keep the reverse proxy's `/api` decision.
- **CORS/D6**: the hosted web client is same-origin through this proxy and involves no CORS. A request with an `Origin` header receives CORS access only when that origin appears verbatim (scheme + host + exact port, no wildcard) in `OBOL_CLIENT_ORIGINS`; requests without `Origin` (curl, API tools) bypass the check. Bearer auth does not exempt browser clients from CORS. The Electrobun renderer loads from `views://mainview/index.html` and remote desktop fetches need `views://mainview` in the allowlist. The Capacitor iOS app uses WKWebView `fetch`, which sends `Origin: capacitor://localhost`, so include that origin when serving iOS. For both remote desktop and iOS, set `OBOL_CLIENT_ORIGINS=views://mainview,capacitor://localhost`; remove unused origins. The BFF reflects an exact allowed origin, answers preflights, and never uses `*`.
- **Caddy** (minimal; Caddy sets `X-Forwarded-For`/`X-Forwarded-Proto` and preserves `Host` automatically):

```
HOST.example {
    handle /api/* {
        reverse_proxy 127.0.0.1:8080
    }
    handle {
        reverse_proxy 127.0.0.1:3000
    }
}
```

- **Nginx** (minimal):

```nginx
server {
  server_name HOST.example;

  location /api/ {
    proxy_pass http://127.0.0.1:8080;   # no trailing slash: /api stays
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

  `proxy_pass http://127.0.0.1:8080;` inside `location /api/` (no URI part) forwards `/api/...` verbatim; a trailing `/...` URI there would strip the prefix and break every route. Both snippets leave `Set-Cookie` untouched by default.

- **Do not proxy `obol-pb`** through anything, not even `/_/`. PocketBase stays private unless a separately justified decision changes it. If the superuser UI is genuinely needed (operator recovery, below), this one-off socat tunnel is the temporary escape hatch, then delete it:

```bash
docker run --rm -d --name obol-pb-ui \
  --network obol-self-hosted_frontend --network obol-self-hosted_backend \
  -p 127.0.0.1:18090:18090 alpine/socat \
  tcp-listen:18090,fork tcp:obol-pb:8090
# view http://127.0.0.1:18090/_/ on the server (or via SSH tunnel port 18090)
docker rm -f obol-pb-ui      # remove as soon as you are done
```

The relay stays joined to `frontend` (so its published port works; publishing from `internal: true` networks does not) and `backend` (so it can reach `obol-pb`). This is the only sanctioned way in for the admin UI; keep it short-lived.

## Owner passwords and reset mail

Two credentials never mix:

- **Owner** (end user, `owner` auth collection): created once in first run; used by clients through `POST /api/auth/login`. Not superuser, no PocketBase UI.
- **PocketBase superuser** (`_superusers`, operator-only): provisioned with `superuser upsert` in step 3 of Quick start. It is for server-side authentication (the BFF client) and operator recovery; rotating it via a later `superuser upsert` does not touch the owner account and vice versa.

**Self-service reset needs SMTP.** When `PB_SMTP_HOST` is set in `.env.self-hosted`, the BFF applies the `PB_SMTP_*` values to PocketBase's SMTP settings at every boot through its authenticated settings API, using the verified v0.23+ settings shape (`smtp`: `enabled`/`host`/`port`/`username`/`password`/`authMethod`/`tls`/`localName`, plus `meta.appURL` set from `OBOL_PUBLIC_URL`) — patching only those keys, never overwriting other `meta.*` fields, never logging credentials, and **failing the boot closed** when the values are unusable (bad port, unknown auth method, a rejected update): a deployment can never report `smtpConfigured` and then lack working mail. An empty `PB_SMTP_HOST` changes nothing: existing SMTP settings (or none) stay exactly as they are and password reset stays unavailable.

- `POST /api/auth/request-password-reset {"email"}` always returns a success body (enumeration protection); PocketBase sends mail only for a known address and only with mail configured.

**The reset link opens the hosted web client.** The reset email carries `{{.AppURL}}/#/reset?resetToken={{.Token}}`, where `AppURL` is `OBOL_PUBLIC_URL` — the public `https://HOST/` that serves `obol-web`. The token stays in the URL fragment and is not sent in the HTTP request. The Nuxt client consumes it, removes it from browser history, and shows the built-in reset form; submitting posts to `POST /api/auth/confirm-password-reset` at the same host (the proxy forwards `/api/*` to the BFF). That route returns only `{success: true}` — the owner then signs in once more through the hosted login form, and the new session arrives as the httpOnly `__Host-obol_session` cookie. The browser never receives a readable session token.

A successful reset deletes every stored `obol_sessions` record: all devices are logged out and must sign in again (D009 D2/D5). An operator password change made only in the admin UI leaves BFF session records intact; revoke them deliberately (delete the `obol_sessions` records there) if you also want to log devices out.

**No SMTP:** password reset is unavailable — the emailed link cannot exist. Owner recovery is an operator path through the private admin UI via the socat tunnel above: open the `owner` record in the auth collection and set a new password there (that rotates its token key at once, so every device must sign in again), or delete the `owner` record — the server then re-enters setup mode, every reference to the deleted owner fails closed with `SESSION_EXPIRED`, and a new owner is created exactly as in First run.

## Image pinning (verified facts)

> **Session registry**: `obol_sessions` (D010/D011/D012) — a custom app-namespace collection. The D011 repair migration `1700000015` fills its `userId`/`expiresAt`/`deviceLabel` fields and the lookup index at PocketBase startup, and `1700000016` adds the `createdAt` date the BFF uses for the immutable 30-day cap (both additive, data-preserving; legacy rows without `createdAt` fail closed). Startup upgrade boots also apply `1700000017`, a one-time non-destructive repair of the legacy `sessions` collection left behind by the failed migration 0011 (see "Upgrades and migrations" below). Take the volume backup before upgrading (see "Data, backups, restore").

The pocketbase container is `ghcr.io/muchobien/pocketbase`, pinned to `0.40.6` with the multi-arch manifest digest used while writing this guide:

```
ghcr.io/muchobien/pocketbase:0.40.6@sha256:9a0be68a80ca1348ba8d15f217b3f983be4c094b3c571a09b3ebdeb357259338
```

Facts verified against the actual image (`docker run --rm ... --version`) and this repo:

- Image `latest` and `0.40.6` both resolve to PocketBase `0.40.6` today, matching the version the desktop bundle pins (`desktop/context.md`, pinned via `desktop/scripts/ensure-pocketbase.ts` v0.40.6 with official SHA-256 checks). Collections created by the dev stack's 19 JSVM migrations in `db/pb_migrations/` are written against v0.23+ collection shapes (`_superusers`, non-injected `id/created/updated`), which v0.40.6 enforces.
- The image entrypoint runs from Alpine and executes `pocketbase` with the args you pass. With no args it would `serve` with defaults and create/update a superuser from `PB_ADMIN_*` environment; this compose always passes an explicit `serve` command with `--migrationsDir`, and the PB container receives no credentials, so a deployment can never run with built-in or default credentials.
- Verified on this checkout: fresh `serve` boot applies all migrations from the read-only mount ("No new migrations to apply." on a follow-up `migrate up`), and `superuser upsert` creates the account.
- The BFF is built inline in the compose file (same recipe as `server/Dockerfile`) with the base pinned to `oven/bun:1.4.4` (index digest `sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d`, matching the repo's Bun/lockfile). If `server/Dockerfile` changes, update the inline block; do not copy a diverged Dockerfile blindly. Rebuilds keep the `obol-bff:self-hosted` tag.
- The web client is built from `app/Dockerfile.self-hosted` with the same Node major as `app/Dockerfile` (`node:20-alpine`, Alpine 3.23), pinned to the `node:20-alpine` multi-arch index digest `sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293` (verified with `docker buildx imagetools inspect node:20-alpine` while writing this guide). It installs with `npm ci` from the committed `app/package-lock.json` and runs `npm run build` with `NUXT_PUBLIC_API_BASE=http://obol-bff:8080` set first — an SSR Nuxt build that bakes the internal BFF address into `runtimeConfig.public.apiBase` and the generated `/api/**` routeRules; `OBOL_DESKTOP_STATIC` is never set, so the image is the server runtime (`.output/server/index.mjs`), not the static desktop bundle.

Do not swap to a different PocketBase major without re-running `migrate up` against a backup.

## Data, backups, restore

Data lives in the named volume `obol-self-hosted_obol_pb_data` (PocketBase `pb_data`: SQLite data.db + auxiliary.db and blob `storage/`). It carries the **owner identity and every `obol_sessions` record** (with their `userId`/`expiresAt`/`deviceLabel`/`createdAt` fields) just like the financial tables: restoring the volume restores the identity and session state wholesale. Migrations are not stored there; they come from the checkout mount, so volume backup + pinned migrations reproduce a deployment.

**Backup (offline copy is the only reliable method; stop write paths first):**

```bash
cd /path/to/repo
docker compose -f docker-compose.self-hosted.yml --env-file .env.self-hosted stop
# verify obol-self-hosted_obol_pb_data via `docker volume ls` (name comes from the project name)
docker run --rm -v obol-self-hosted_obol_pb_data:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/obol_pb_data-$(date +%F-%H%M).tgz -C /data .
docker compose -f docker-compose.self-hosted.yml --env-file .env.self-hosted start
```

Copy the `.tgz` off-host. Store the `.env.self-hosted` secrets in a password manager, not next to the backup: the backup is identity-carrying now, but still useless without credentials to re-enter the deployment.

**Restore on a clean host (the backup already contains the superuser and owner accounts, so no explicit provisioning is needed; re-apply the same `.env.self-hosted` values, including the same `OBOL_SESSION_SECRET`, or every existing session dies):**

```bash
docker compose -f docker-compose.self-hosted.yml --env-file .env.self-hosted stop
docker run --rm -v obol-self-hosted_obol_pb_data:/data -v "$PWD":/backup alpine \
  sh -c 'rm -rf /data/* && tar xzf /backup/obol_pb_data-YYYY-MM-DD-HHMM.tgz -C /data'
docker compose -f docker-compose.self-hosted.yml --env-file .env.self-hosted start
docker compose -f docker-compose.self-hosted.yml --env-file .env.self-hosted ps   # wait for healthy
```

## Upgrades and migrations

Compose only pins `obol-pb`, the BFF base, and the web base; Bun dependencies follow `bun.lock`, npm dependencies follow `app/package-lock.json`, and the JSVM migrations follow the checkout.

```bash
cd /path/to/repo
git pull
# if migrations changed, they are applied automatically on next start of obol-pb
docker compose -f docker-compose.self-hosted.yml --env-file .env.self-hosted build obol-bff obol-web
docker compose -f docker-compose.self-hosted.yml --env-file .env.self-hosted up -d
docker compose -f docker-compose.self-hosted.yml --env-file .env.self-hosted logs -f obol-pb obol-bff obol-web
```

Upgrade order:

1. **Back up the volume** (simplest to do this before everything, even before `up`).
2. `git pull`. PocketBase migrations come from the mount; they apply at boot. The final migration sequence ends with `1700000014` (creates `obol_sessions`, the session registry) followed by `1700000015` (repairing `obol_sessions` with the `userId`/`expiresAt`/`deviceLabel` fields and the revocation-check index) and `1700000016` (adding the `createdAt` date field the BFF computes the immutable 30-day cap from), and `1700000017` (repairing the legacy `sessions` collection). 0015, 0016, and 0017 run additively at PB startup and never delete data; 0017 is a one-time compatibility repair of the id-only `sessions` collection that the failed migration 0011 left behind, not part of the live session registry — the BFF serves only `obol_sessions`.

**Legacy session migration verification (PocketBase 0.40.6)**: migration 0017 repairs the orphan `sessions` collection additively; the BFF continues to use only `obol_sessions`. The live migration journal contains 0011 and 0017, the schema probe found both collections' fields and indexes, and a fresh isolated Compose boot plus one PB restart produced no 0011 failure. No extra operator restart is required. For a volume that still logs `failed to apply migration 1700000011_create_sessions_collection.js`, let normal startup apply 0017, then verify the migration journal and schema. If the failure remains on a later startup, do not ignore it; inspect `docker compose ... logs obol-pb` and restore from the pre-upgrade backup if needed. Rows without `createdAt` receive no guessed age; their devices must sign in again.

3. Rebuild/restart: `up -d` recreates any changed container; the BFF and web restart while PocketBase stays healthy because of the pinned tag.
4. Verify `curl http://127.0.0.1:8080/` returns `{"status":"Online"}` and the web client answers through the TLS proxy at `https://HOST/`.
5. Bumping the PocketBase *major* is out of routine scope: first run `docker run --rm -v <volume>:/pb_data image migrate up` against a fresh backup, then change the pinned digest, then bring the stack up.

**Rollback**: revert `git pull`, rebuild the BFF and web images, bring the stack back down/up. PocketBase data itself is not downgraded; if a migration moved the schema forward, restore from the backup taken in step 1. Additive repairs such as 0015-0017 are harmless to roll back: the fields they add (and any data written under them) simply stay in place; they are never removed and no records are deleted.

## Secure configuration checklist

- **Secrets before exposure**: no defaults exist; the stack refuses to start without `OBOL_SESSION_SECRET` (32+ random bytes from `openssl rand -hex 32`), `OBOL_PUBLIC_URL`, `OBOL_PB_ADMIN_EMAIL`, `OBOL_PB_ADMIN_PASSWORD`. The operator file deliberately uses the `OBOL_PB_ADMIN_*` names — not `PB_ADMIN_EMAIL`/`PB_ADMIN_PASSWORD` — because shells that also run the dev stack often export those and Compose interpolation would prefer them over the file; Compose maps them into the BFF's server-internal `PB_ADMIN_*` environment, which is the only place the PocketBase credentials exist. TLS in front of the two published ports is what makes the public URL legitimate (the `__Host-obol_session` cookie requires `Secure`); `OBOL_CLIENT_ORIGINS` only ever lists exact origins and must include `capacitor://localhost` when the iOS client is used.
- **Rotation**: `OBOL_SESSION_SECRET` rotation is the global session kill switch — it invalidates every device token at once (safe fallback if a device is stolen). Rotate the superuser with `superuser upsert` whenever the `.env.self-hosted` password changes; do not change credentials in the DB console while the BFF is running.
- **Setup discipline**: the setup token is a one-time, 30-minute credential printed to logs while no owner exists; treat the log line like a secret and never leave the logs shipped to a shared sink indefinitely. Once setup completed, `POST /api/setup/init` refuses permanently.
- **Expose only via the TLS proxy**; never publish the `backend` network or any PocketBase port.
- **Keep the migrations mount read-only**: new migration files go into `db/pb_migrations/` on the host, then `up -d`.
- **No `--dev`**: never add PocketBase's `--dev`; it logs sensitive details.
- **Settings encryption** (optional hardening): add `- --encryptionEnv=PB_ENCRYPTION_KEY` to the `obol-pb` command and set a 32-char key in `.env.self-hosted` before first boot; once data is initialized, changing it needs a re-init (PocketBase can no longer read existing settings without the old key).
- **Single-owner model (D009 D1)**: every session sees and mutates all of the deployment's data — that is by design, not an access-control gap. Anything beyond one principal (families, shared servers) needs a new identity ADR first.
- **No agents**: the deployment runs three normal containers (`obol-bff`, `obol-web`, `obol-pb`); anything else in `docker ps` should be explainable.

## Troubleshooting

- `compose` config error "required variable ... missing" → a required value is missing or empty in `.env.self-hosted` (the file must exist next to the compose file and be passed with `--env-file .env.self-hosted`).
- BFF restart loops with "Could not authenticate PocketBase superuser" → no superuser exists: run the Quick start provisioning. Also verify that the values in `.env.self-hosted` are what `superuser upsert` got.
- Boot stops with "Applying PocketBase operator settings ... failed" or a `PB_SMTP_*` validation error → the SMTP block is set but unusable (wrong port, TLS/auth-method spelling, relay rejecting the update). Fix the values; the BFF deliberately refuses to start rather than serve with broken password-reset mail.
- Every request to `/api/transactions` answers `SETUP_REQUIRED` / `{"setupRequired":true}` → no owner has been created yet: run First run.
- `POST /api/setup/init` answering `INVALID_SETUP_TOKEN` → the token printed at the last setup-mode boot expired (30 minutes) or was already consumed (each boot mints a new one); open `docker compose ... logs obol-bff` for the current one.
- `obol-pb` unhealthy → check the mounted migrations (`git status` on `db/pb_migrations`) and stop `--dev`-style add-ons to the command.
- Startup log shows `failed to apply migration 1700000011_create_sessions_collection.js: indexes: ... no such column: expiresAt` once during an upgrade boot → expected once: migration 0017 repairs the legacy `sessions` collection, and the following PocketBase startup records 0011 applied so the line stops repeating. If it keeps appearing on every boot after that restart, share the full `docker compose ... logs obol-pb`.
- `obol-web` unhealthy or restarting → check `docker compose ... logs obol-web`; a build that ran before the last `nuxt.config.ts`/`app/Dockerfile.self-hosted` change can be stale, so `build obol-web` and `up -d` again.
- Browser opens the UI but the API answers differently than expected → the reverse proxy is not forwarding `/api/*` unrewritten to the BFF, or `WEB_PORT`/`BFF_PORT` in `.env.self-hosted` disagree with the proxy's upstream ports.
- Password-reset mail arrives but the link opens a broken page → `OBOL_PUBLIC_URL` does not match the proxy-facing host (the mail is built from `OBOL_PUBLIC_URL`, and the link must land on `https://HOST/?resetToken=...` of the same TLS host).
- iOS client API calls fail network errors → `OBOL_CLIENT_ORIGINS` is missing the required `capacitor://localhost` entry (WKWebView `fetch` sends that Origin even for Bearer-authenticated requests).
- Port conflict on 8080 → set `BFF_PORT` in `.env.self-hosted` (or both there and in the proxy upstream). Port conflict on 3000 → set `WEB_PORT` the same way and update the proxy upstream.
