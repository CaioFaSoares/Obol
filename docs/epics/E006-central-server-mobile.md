# E006 - Central server and mobile clients

**Status**: complete
**Target release**: 0.3.0  
**Related**: `app/`, `server/`, `db/`, `desktop/`, Compose deployment files

## Goal

Make a self-hosted Obol server an optional shared runtime for the existing desktop app and a new iOS app, while preserving the existing standalone local desktop mode. A user can deploy the server with Docker Compose, connect supported clients to it, and use the same financial API from desktop and mobile.

The 0.3.0 contract is now selected and delivered: D009 defines one owner per deployment and BFF-minted sessions; Capacitor 8 packages the existing Nuxt/Vue UI for iOS. Desktop retains standalone local mode alongside explicit remote mode.

## Delivered constraints

- Each central deployment has one owner. Multiple devices share the same data; there is no second-user or per-record isolation model (D009).
- The BFF is the only client-facing data path. PocketBase and its superuser credentials remain private. Every `/api/**` business, administrative, and job route requires a BFF session.
- Desktop local unlock remains a local-only profile gate and does not encrypt PocketBase files at rest. Central mode is explicitly selected and does not migrate or sync local data.
- iOS runs the shared Nuxt/Vue UI in a Capacitor WebView. It does not run Bun, PocketBase, or Electrobun.
- Production self-hosting is separate from the unchanged development and Coolify Compose files.

## Delivered workstreams

### 1. Product and security contract

- [D009](../decisions/D009-remote-identity.md) selects a single owner per deployment, setup-token bootstrap, password login, revocable BFF sessions, password reset, CORS/CSRF, TLS, and operator recovery.
- All business, job, and administrative `/api/**` routes require a valid session. The one-owner contract makes per-record ownership unnecessary; multi-user tenancy is not part of 0.3.0.

### 2. Self-hosted server distribution

- `docker-compose.self-hosted.yml` runs the BFF, Nuxt web client, and private PocketBase with a durable named volume, pinned images, explicit secrets, and health checks.
- `docs/self-hosting.md` documents setup, exact reverse-proxy routes, TLS, CORS origins, migrations, SMTP, backup/restore, upgrades, and recovery.
- The real PocketBase 0.40.6 Compose deployment was exercised with isolated data, a fresh setup, authenticated and anonymous requests, restart, migration, offline backup, and restore.

### 3. Shared client API and desktop connection mode

- `app/utils/api.ts` keeps the typed Eden client and selects local Electrobun RPC, hosted cookie, or remote Bearer transport.
- Desktop remote mode has an explicit endpoint/login gate and stores the remote session separately from local profile state. Endpoint changes, session expiry, server unavailability, session revocation, and returning to local mode are handled without data sync.
- The existing hosted web cookie path and local desktop RPC path remain separate.

### 4. iOS client

- Capacitor 8 packages the same Nuxt/Vue UI in `app/ios/`; the Xcode target includes the Keychain-backed secure-storage plugin.
- iOS uses the same remote Bearer API and can choose a self-hosted HTTPS server. It does not run the desktop PocketBase/Bun runtime.
- Core pages and forms were checked at 320px and 390px; the native simulator shows the server-connection gate with the iOS keyboard and safe-area layout.

## Delivery sequence

1. D009 and D014 accepted the identity, tenancy, threat-model, session, and exact CORS-origin contracts.
2. Auth guards cover all business, scheduler, and administrative routes; server tests and live PocketBase requests cover rejection and session lifecycle.
3. The production Compose deployment and operator runbook were built and exercised with isolated data.
4. Desktop local/remote selection, Bearer transport, session expiration, endpoint changes, and the local fallback are implemented.
5. The Capacitor iOS project builds and launches in the iOS simulator; remote-origin API reads and writes were exercised against the same BFF.
6. Stable and RC release workflows have separate branches, tags, and updater bases.

## Acceptance

- [x] An operator can configure and deploy the central server from `docker-compose.self-hosted.yml` without source edits or usable default credentials.
- [x] PocketBase has no published host port; the BFF is the sole client data path, and server credentials do not reach clients.
- [x] The accepted single-owner contract is enforced across business, scheduler, and administrative API operations.
- [x] Desktop remote mode authenticates to the central API; standalone local mode remains separate and performs no implicit data transfer.
- [x] The Capacitor iOS client builds and runs in the simulator; the same Bearer API contract completes representative authenticated reads and writes with the iOS CORS origin.
- [x] The hosted web flow and existing Coolify topology remain supported; the hosted web cookie flow was exercised through the production reverse-proxy route.
- [x] Setup, TLS/reverse proxy, secrets, CORS, persistence, backup/restore, upgrades, troubleshooting, and client setup are documented.
- [x] Isolated verification covers fresh deployment, authorization rejection, session lifecycle, restart/restore, migrations, and local/remote client mode boundaries. No real user data was used.

## Verification evidence

- `server/`: `bun test` passes 69 tests. The live Compose probe created the owner, rejected an anonymous financial request with 401, exercised Bearer login/session list/renew/revoke, and verified hosted cookie attributes (`HttpOnly`, `Secure`, `SameSite=Lax`) with no JavaScript-readable token.
- PocketBase 0.40.6: migrations 0010–0017 and both session schemas/indexes were probed. Bearer sessions survived BFF/PocketBase restart and an offline named-volume backup/restore.
- Remote client origins: BFF preflight/login accepted `views://mainview` and `capacitor://localhost` only after exact allowlist configuration. An unrelated origin was not reflected.
- Financial writes: an authenticated request carrying `Origin: capacitor://localhost` created/read an account and transaction, then deleted the transaction and verified its absence.
- Desktop: `nix develop --command bun run eb:build` and `nix develop --command bun run eb:verify` passed. The remote/local-gate browser smoke used an injected `window.obol.auth` bridge, not a live Electrobun WebView. `eb:dev` started the local main process but its Nuxt dev route returned `Vite Node IPC socket path not configured`; the packaged static build did not show this failure.
- iOS: `npm run ios:generate`, `npm run ios:sync`, Xcode simulator build, and native simulator launch passed. The server URL gate was visually checked on an iPhone 17e simulator.
- Mobile layout: core routes at 320px and 390px had no page-width overflow; the transaction modal fit the narrow viewport.
- RC workflows: YAML and embedded shell validation passed, and version-gate scenarios confirmed RC/stable separation. No GitHub release was dispatched.

## Boundaries

- 0.3.0 remains single-owner. Multiple sessions share all deployment data. Multi-user access, invitations, MFA, and per-record ownership need a new decision and schema migration.
- Central server mode is optional. It does not imply a hosted service operated by Obol or local-to-central data sync.
- iOS simulator packaging is included. App Store signing, provisioning, and submission are not part of the desktop release workflow.

