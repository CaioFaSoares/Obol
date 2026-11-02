# desktop/ — Electrobun packaging and local runtime

Implements D005 / E001; E004 adds Windows x64 packaging and E005 adds the built-in updater. `desktop/` is the local runtime shell around the existing Nuxt view and Elysia application, not a separate backend domain.

| Path | Role |
|---|---|
| `app.json` | Desktop identity, version, URL scheme, and window size; release workflow reads version here |
| `electrobun/bun/index.ts` | Boot order: resolve stable user-data path → create the WebView → local setup/unlock RPC → PocketBase `superuser upsert` → PB child → authenticate and build/listen Elysia; handles updater checks/downloads, RPC, and shutdown |
| `electrobun/view/bridge.ts` | Document-start preload; exposes local auth RPC, update status/actions, and (after unlock) `window.obol.apiFetch` |
| `electrobun/shared-rpc.ts` | Type-only contract shared by Bun main and WebView, including local setup/unlock and updater status |
| `scripts/ensure-pocketbase.ts` | Downloads pinned PocketBase v0.40.6 for macOS arm64/x86_64 and Windows x64; verifies official SHA-256 values before extraction |
| `scripts/eb-publish.ts`, `brew-cask.ts` | macOS Cask manifest, Windows setup archive, and Electrobun updater artifact publication. The macOS zip is store-only because the app payload is already zstd-compressed; the updater tar.zst is compressed once. |
| `scripts/windows-runtime-smoke.ts`, `scripts/windows-runtime-smoke/windows-probe.ps1` | REL-05 native Windows acceptance: runs the real setup executable, drives the installed app's UI and bridge, and stands up an isolated central BFF + PocketBase pair. Refuses every non-Windows-x64 host and requires `OBOL_WINDOWS_SMOKE_ISOLATED=1`. |
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

## Windows runtime smoke (REL-05)

`bun scripts/windows-runtime-smoke.ts` is release evidence, not a build check. Run it on a native Windows x64 runner after `bun run eb:build` and `bun run eb:verify`, from `desktop/`, with `OBOL_WINDOWS_SMOKE_ISOLATED=1` and (on GitHub Actions) `OBOL_WINDOWS_SMOKE_OUT=$RUNNER_TEMP/obol-windows-smoke`. Any other platform, arch, or isolation value exits non-zero before touching the machine.

Procedure:

1. Hash the setup ZIP built by this job and read the Windows/WebView2 versions. Every run gets a unique directory under the temp root holding `LOCALAPPDATA`, the central server's `pb_data`, installer staging and `evidence/`; no repository `db/pb_data`, hosted data or real user profile is used.
2. Stage the ZIP and run its real `Obol-Setup.exe` with `ELECTROBUN_INSTALLER_UI_AUTOCLOSE=1`, a documented Electrobun installer diagnostic that closes the native TaskDialog after the terminal state. It is not a silent-install flag: the installer still performs the extraction, shell integration, uninstall registration and app launch. Extracting the ZIP into the install location is never accepted as an install. Verify the installed `bin/launcher.exe`, the bundled `pocketbase.exe`, migrations 0018-0021 and `Resources/version.json`.
3. Launch the installed launcher with the isolated `LOCALAPPDATA` and a nonce `OBOL_APP_ID`, complete first-run setup through the real labels (`Name`, `Email`, `Password`, `Create local account`), then create an account with 1000 and a realized expense of 20 through `window.obol.apiFetch`; require the product to materialize 980 and queue the local operation. Restart and unlock the same profile, requiring the same 980 and the same pending opIds.
4. Start the installed `pocketbase.exe` with an isolated data directory and the installed migrations, then the real BFF (`server/src/index.ts`) on separate loopback ports with a generated `OBOL_SESSION_SECRET` and `OBOL_SETUP_TOKEN`. Complete D009 `POST /api/setup/init` and bearer login. Use `window.obol.sync.previewConnection`/`confirmConnection` to run the D7 settled snapshot import; require the server to hold account balance 980 with exactly one 20 expense.
5. Stop only the owned central processes, create a realized 5 expense offline (local 975, durable pending operation), force-kill only the owned app tree, relaunch and unlock the same profile, and require the pending opId/envelope-hash pairs to be identical. Restart PocketBase and the BFF on the same data volume and ports, require the same `serverInstanceId`/`dataEpoch`, synchronize over real HTTP, and require the server to hold 975 with exactly one 20 and one 5, an empty outbox, and a stored cursor that the server accepts as the current commit boundary. A second sync must not duplicate history.
6. Call `window.obol.updater.check()` through the real bridge and record the truthful result; never call `updater.install`. Clean up by stopping owned PIDs, running the installed uninstaller with `--quiet --delete-data`, and removing the isolated directories. Evidence (sanitized JSON report, screenshots, logs) is written under `evidence/` and uploaded by the workflows even when the smoke fails.

Known environment boundary: Electrobun 2.0.5 passes a fixed `AdditionalBrowserArguments` string to WebView2, and WebView2 ignores `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` when the host supplies its own arguments. The smoke still launches with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=... --remote-debugging-address=127.0.0.1` and fails honestly (with a native screenshot and report) when the loopback CDP endpoint never appears; it never substitutes a headless browser or another engine. The installer is locally built and unsigned, so SmartScreen is not exercised, and the updater check may observe an existing public release without applying it.
