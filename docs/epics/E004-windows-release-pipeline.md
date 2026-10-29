# E004 - Windows x64 release pipeline (0.2.0)

**Status**: implementation in progress · **Completed**: —
**Related**: `desktop/scripts/ensure-pocketbase.ts`, `desktop/scripts/eb-build.ts`, `desktop/scripts/eb-verify.ts`, `desktop/scripts/eb-publish.ts`, `.github/workflows/release.yml`, `desktop/context.md`, `docs/arquitetura.md`

## Goal

Add a native Windows x64 package to the existing release flow without changing macOS artifacts, the macOS-only update manifest, or the Homebrew cask. The Windows package uses Electrobun 2.0.5's stable setup ZIP and a SHA-256 sidecar.

## Platform contract

- Build on `windows-2022` x64. Electrobun builds for its host OS; Windows packaging is not cross-compiled from macOS.
- Bundle PocketBase v0.40.6 `windows_amd64` from the official release asset. Its archive SHA-256 is pinned in `desktop/pocketbase.json` and verified before extraction.
- Use `pocketbase.exe` in the generated Electrobun resource mapping and local runtime.
- Electrobun's stable output is `desktop/artifacts/win-x64-Obol-Setup.zip`. Verify that it contains the setup executable and adjacent installer payload.
- Publish as `obol-<version>-windows-x64-setup.zip` with `obol-<version>-windows-x64-setup.zip.sha256`. Do not add a Windows entry to `manifest.json`; that manifest remains the macOS Homebrew-cask contract.
- Windows packages are unsigned because the repository has no Windows signing certificate configured. Windows ARM64 and Linux are outside this scope.

## Release flow

A pull request targeting `main` runs the native macOS and Windows build matrix as validation only. It has read-only contents permission and cannot create a release, tag, or Cask commit. The existing release process remains unchanged: merging a `dev` → `main` PR creates `release-<version>`, then dispatches the publishing workflow. The merge is the publication boundary.

## Acceptance

- [ ] `ensure-pocketbase.ts` downloads only the pinned Windows x64 asset, verifies its checksum, extracts `pocketbase.exe`, and validates its version.
- [ ] `eb:build` succeeds on a native Windows x64 runner, generates the static Nuxt view, bundles PB and migrations, and skips macOS codesigning.
- [ ] `eb:verify` validates the Windows setup archive and installer payload; the macOS identity, payload, path-length, and codesign checks remain intact.
- [ ] The publisher emits the versioned setup ZIP and a matching SHA-256 sidecar, with no Windows `manifest.json`.
- [ ] A release PR runs all three platform legs and cannot publish. After merge, the release workflow includes the Windows assets while the merged macOS manifest still drives only the Cask.
- [ ] Windows installer launch, first-run setup/unlock, local PocketBase persistence, and clean application shutdown pass on Windows x64.

## Risks and boundaries

Windows setup downloads are unsigned and may prompt SmartScreen. Do not add certificate-signing configuration without a trusted certificate and GitHub secret. The Windows smoke test must use an isolated profile; it must not touch hosted `db/pb_data`.
