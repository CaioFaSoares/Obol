# E005 - Electrobun updater and 0.2.0a startup repair

**Status**: implementation in progress · **Completed**: —  
**Target release**: 0.2.0a  
**Related**: `desktop/electrobun/bun/index.ts`, `desktop/electrobun/shared-rpc.ts`, `desktop/electrobun/view/bridge.ts`, `app/components/DesktopUpdaterBanner.vue`, `desktop/scripts/gen-electrobun-config.ts`, `desktop/scripts/eb-verify.ts`, `desktop/scripts/eb-publish.ts`, `.github/workflows/release.yml`, `.github/workflows/release-branch.yml`

## Goal

Repair the published 0.2.0 macOS startup failure caused by PocketBase migrations being bundled at the wrong path, then add a safe in-app updater to the packaged desktop app.

## Migration path repair

The desktop runtime reads migrations from `Contents/Resources/app/resources/pb_migrations`, but the 0.2.0 package placed them at `Contents/Resources/app/pb_migrations`. The runtime error prevented the published macOS app from opening its local login screen. The 0.2.0a runtime will read the already-packaged `app/pb_migrations` directory, preserving the shorter tar paths required by Electrobun's self-extractor. Do not delete or recreate `pb_data`; preserve existing PocketBase records.

## Update behavior

- Use Electrobun 2.0.5's `Updater` from `electrobun/main`; do not add a custom update server or update format.
- Packaged stable builds check `release.baseUrl` on startup and download an available update in the background. Development builds do not check for updates.
- Show update state, version, download progress, and errors in a desktop-only banner. Offer retry after a failure and `Reiniciar para atualizar` only after the bundle is ready.
- Apply after the user chooses to restart. Stop the local Elysia/PocketBase runtime before replacement. If update handoff fails before quit, restore the unlocked backend using the in-memory session credential; never persist or log that credential.
- Publish Electrobun's stable update JSON and full `.tar.zst` bundles unchanged for macOS arm64/x86_64 and Windows x64. Preserve the custom macOS manifest as the Homebrew-cask contract and the Windows setup ZIP/SHA-256 sidecar.

## Release flow and bootstrap

The new release PR uses head branch `pr/release-0.2.0a` and base `main`, starting from the already published 0.2.0 release. PR validation builds all native targets but cannot publish. Merging creates `release-0.2.0a` and dispatches the existing release workflow. The branch collision guard must query the exact `refs/heads/release-0.2.0a`; a short `git ls-remote` pattern also matches the PR head `pr/release-0.2.0a`.

The published 0.2.0 app contains no updater and cannot update itself. Users must install 0.2.0a manually once. Later stable versions can update through the app.

## Acceptance

- [ ] A packaged macOS build contains migrations at `Contents/Resources/app/pb_migrations` and launches to the local login screen with an isolated profile.
- [ ] Electrobun's stable update JSON and full bundle are included in macOS and Windows release artifacts under the exact filenames referenced by `update.json`.
- [ ] The packaged main process checks for updates on launch, downloads available updates in the background, and skips the dev channel.
- [ ] The banner shows status/progress, retries errors, and exposes restart only when `updateReady` is true.
- [ ] Restart-to-update shuts down Elysia/PocketBase first. Failed handoff restores the unlocked backend without persisting credentials.
- [ ] A local/isolated packaged smoke detects and downloads a newer update without publishing a release or touching hosted `db/pb_data`.
- [ ] The `pr/release-0.2.0a` PR passes validation and remains unpublished until merge; merging it publishes `release-0.2.0a`.

## Risks and boundaries

The updater trusts the configured HTTPS release host; Electrobun's bundle hash is not a signing certificate. Windows setup installers remain unsigned and may prompt SmartScreen. The 0.2.0a update is a manual bootstrap for all earlier releases.
