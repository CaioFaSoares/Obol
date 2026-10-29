# D008 - Central server as an optional shared client runtime

**Status**: accepted · **Date**: 2026-10-29 · **Target release**: 0.3.0 · **Related**: [E006](../epics/E006-central-server-mobile.md), [D005](D005-electrobun-local.md), [D009](D009-remote-identity.md)

## Context

Obol has a hosted Nuxt/Elysia/PocketBase deployment and a standalone Electrobun desktop runtime. The hosted BFF authenticates to PocketBase as a superuser; the desktop starts a local PocketBase child and an in-process Elysia app. Neither runtime currently defines remote end-user identity and authorization for a shared central database (`docs/arquitetura.md`, `server/src/index.ts`, `server/src/infrastructure/plugins/pocketbase.ts`). A mobile client cannot rely on the desktop's Bun/Electrobun/PocketBase process model.

## Decision

For 0.3.0, make a self-hosted central server an optional runtime that can serve a remote desktop client and a new iOS client through the existing typed BFF API. Preserve standalone local desktop operation. Treat the server as the only application-facing data boundary; keep PocketBase and its superuser credentials private to the server. Distribute the central server through a dedicated production Docker Compose configuration.

Remote identity and authorization follow accepted [D009](D009-remote-identity.md): each deployment has one owner; the BFF owns setup, login, revocable sessions, cookie/Bearer transport, and protects all business routes. Desktop remote mode and the iOS client use that contract; PocketBase and its superuser credentials stay private. [D014](D014-electrobun-cors-origin.md) records the exact WebView CORS origins. This decision authorizes the optional central runtime described in E006, not a hosted service operated by the Obol project.

## Consequences

- The BFF needs a remote authentication and authorization boundary that covers all business, administrative, and background operations.
- The deployment needs explicit secret provisioning, durable storage, health checks, upgrade/migration, TLS/reverse-proxy, and backup/restore contracts.
- Desktop will support both local RPC and remote API transports without implicit data migration or synchronization.
- iOS uses the Capacitor 8 native shell with the existing Nuxt/Vue UI and Keychain-backed session storage. The iOS simulator target is built and launched from the shared app source; distribution signing and store submission are outside the release pipeline.
- Existing hosted web and Coolify workflows remain supported unless a later decision explicitly supersedes them.

## Acceptance evidence

D009 and D014 clear the identity, authorization, transport, and origin gates. The production Compose stack, operator runbook, explicit desktop local/remote mode, Capacitor iOS project, and RC-only release workflow implement the accepted direction. E006 records the runtime checks and delivered files.
