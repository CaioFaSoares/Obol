# D005 - Local-first Electrobun packaging (Nod model)

**Status**: accepted · **Date**: 2026-10-28 · **Implemented**: E001

## Context

Obol's hosted form uses the Docker Triad. The local form must be a desktop application with no remote server or Docker dependency, using the Electrobun build/runtime pattern established by Nod.

## Decision

- Electrobun **2.0.5**, Bun main process, system WebView (`bundleCEF: false`), app id `copland.obol`, URL scheme `obol`, window size `1100x720`. Development uses `copland.obol.eb-dev` to isolate its data.
- The app view is Nuxt-generated static output (`OBOL_DESKTOP_STATIC=true`, `ssr:false`, relative base). Hosted Nuxt remains SSR.
- The WebView uses the typed Eden Treaty client. Its custom fetcher detects the Electrobun preload bridge, sends the request over RPC, and the Bun main process dispatches it to the in-process Elysia app via `app.handle(Request)`. The WebView never makes a network request to the BFF; there is no HTTP BFF port exposed to the UI.
- Elysia listens only on loopback port `13080` in the desktop main process to start the existing cron plugin and support Nuxt dev SSR. It is not a separately deployed service. Hosted startup continues to listen on `0.0.0.0` at the configured `PORT`.
- PocketBase is a managed child process bound to `127.0.0.1:13090`. The app waits for `/api/health`, then authenticates the BFF before showing the window. The PB binary is pinned to **0.40.6** with official release checksums in `desktop/pocketbase.json`; `pb_data` and a randomly generated superuser password live under `Utils.paths.appData/copland.obol`. The password file is mode `0600` on macOS/Linux.
- The child is terminated on normal app quit and startup failure. The hosted Compose files remain unchanged and continue to use PocketBase as a container.
- macOS arm64 and x86_64 are the release targets. Nod-derived `release-branch.yml`, `release.yml`, manifest publication, and Homebrew cask generation are implemented. The cask is generated from the first actual release manifest; no placeholder checksum is committed.

## Alternatives considered

- Replacing PocketBase with SQLite in the app: rejected. It would require rewriting seven repositories and retesting every persistence rule; a managed local PB binary keeps the D003 repository boundary intact.
- Downloading PocketBase `latest` at runtime: rejected. v0.40.6 is pinned and checksum-verified from the [official release metadata](https://api.github.com/repos/pocketbase/pocketbase/releases/tags/v0.40.6); upstream archived its GitHub repository on 2026-10-26 and announced that future releases would move elsewhere. A future PB upgrade requires an explicit source/checksum decision.
- Keeping Docker as the local desktop backend: rejected; it would still require an external runtime service and would not meet the local-first requirement.

## Consequences

- Desktop and hosted modes share the same application use cases and repositories; only startup and API transport differ.
- Local PB data persists across app restarts and is isolated from the repo's `db/pb_data/` and from the dev app identifier.
- Port `13090` is reserved for the local PB child. A collision is a visible startup error; no silent fallback or remote server is used.
- An actual GitHub release and Homebrew install are external release operations; the pipeline is in code, but this change does not publish a public release.
