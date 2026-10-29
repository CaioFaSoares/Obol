# desktop/ — Electrobun packaging and local runtime

Implements D005 / E001; E004 adds Windows x64 packaging and E005 adds the built-in updater. `desktop/` is the local runtime shell around the existing Nuxt view and Elysia application, not a separate backend domain.

| Path | Role |
|---|---|
| `app.json` | Desktop identity, version, URL scheme, and window size; release workflow reads version here |
| `electrobun/bun/index.ts` | Boot order: resolve stable user-data path → create the WebView → local setup/unlock RPC → PocketBase `superuser upsert` → PB child → authenticate and build/listen Elysia; handles updater checks/downloads, RPC, and shutdown |
| `electrobun/view/bridge.ts` | Document-start preload; exposes local auth RPC, update status/actions, and (after unlock) `window.obol.apiFetch` |
| `electrobun/shared-rpc.ts` | Type-only contract shared by Bun main and WebView, including local setup/unlock and updater status |
| `scripts/ensure-pocketbase.ts` | Downloads pinned PocketBase v0.40.6 for macOS arm64/x86_64 and Windows x64; verifies official SHA-256 values before extraction |
| `scripts/eb-publish.ts`, `brew-cask.ts` | macOS Cask manifest, Windows setup archive, and Electrobun updater artifact publication |
| `.hutch/`, `build/`, `dist/`, `resources/`, generated `electrobun.config.ts` | Local/generated files; ignored by git |

Rules:

- Desktop PB data belongs under `Utils.paths.appData/copland.obol[/pb_data]`; development uses `copland.obol.eb-dev`. Never use the repository's `db/pb_data` in the packaged app.
- `local_profile.json` stores a salted PBKDF2 verifier, not the local password. POSIX builds create it with mode `0600` under a mode-`0700` app data directory; Windows relies on the current user's profile permissions. Use BitLocker or FileVault for at-rest protection.
- Before serving PB, the main process derives an internal superuser credential and runs `superuser upsert`. This repairs missing/stale 0.1.0 credentials without deleting PB data.
- The login gates the app but does not encrypt PocketBase files at rest.
- Bind PB and Elysia to loopback only. The unlocked UI API transport is RPC → `app.handle`; do not add a WebView HTTP/CORS bypass.
- The hosted startup path and `docker-compose*.yml` remain supported; the desktop cutover is additive.
- Keep PocketBase version/checksum pinned; upstream's GitHub repository was archived on 2026-10-26. Upgrade only with an explicit source/checksum decision.
- Release artifacts are built on native macOS and Windows x64 hosts and include Electrobun stable update metadata/full bundles. Windows setup ZIPs are unsigned; the Cask uses only the merged macOS manifest. Version 0.2.0 lacks an updater; 0.2.0a is the manual bootstrap.
