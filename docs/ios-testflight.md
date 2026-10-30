# iOS TestFlight builds

Builds a Release iOS archive, exports an App Store IPA, and uploads it to TestFlight. The same command runs locally and in the manual GitHub Actions workflow.

## What it runs

`app/scripts/ios-testflight.sh`:

1. regenerates the Nuxt static bundle and runs `cap sync ios`;
2. archives `app/ios/App/App.xcodeproj` for `generic/platform=iOS` with automatic signing;
3. exports with `app-store-connect` (or `app-store` on Xcode 14);
4. uploads the IPA with `xcrun altool`.

Build outputs go to `app/ios/build/testflight/`.

## Prerequisites

| Requirement | Detail |
|---|---|
| Apple Developer Program | A paid team with permission to create distribution certificates and App Store profiles. |
| Bundle ID | `copland.obol.mobile`, matching `app/capacitor.config.ts` and the Xcode target. |
| App Store Connect app | An app record for the same bundle ID, a SKU, and a version matching the marketing version (currently `0.3.0`). |
| Distribution certificate | An `Apple Distribution` certificate with its private key, exported as `.p12`. |
| App Store Connect API key | A Team Key with the **Admin** role. Download the `.p8` once; note the Key ID and Issuer ID. |

The bundle ID is configurable with `IOS_BUNDLE_ID`, but the App Store Connect record and the Xcode target must still match it.

## Local Mac

```bash
cd app
npm ci

export APPLE_TEAM_ID=ABCDE12345
export ASC_KEY_ID=XXXXXXXXXX
export ASC_ISSUER_ID=00000000-0000-0000-0000-000000000000
export ASC_KEY_PATH="$HOME/Downloads/AuthKey_XXXXXXXXXX.p8"

npm run ios:testflight
```

If Xcode is signed into the team and the distribution certificate is in the login keychain, the archive step can use it directly. The upload still needs the API key.

Useful overrides:

| Variable | Default | Purpose |
|---|---|---|
| `BUILD_NUMBER` | UTC timestamp (`YYYYMMDDHHMMSS`) | `CFBundleVersion`; must be numeric and unique for the marketing version. |
| `MARKETING_VERSION` | `desktop/app.json` version without `-rc.N` | `CFBundleShortVersionString`; must be `X.Y.Z`. |
| `SKIP_UPLOAD=1` | unset | Build the IPA only. |
| `SKIP_WEB_BUILD=1` | unset | Reuse an existing `dist` and iOS public folder. |
| `IOS_BUNDLE_ID` | `copland.obol.mobile` | Override the bundle identifier. |
| `IOS_EXPORT_METHOD` | `app-store-connect` | Set `app-store` on older Xcode. |
| `IOS_BUILD_DIR` | `app/ios/build/testflight` | Output directory. |

Example build-only run:

```bash
SKIP_UPLOAD=1 BUILD_NUMBER=2026103001 npm run ios:testflight
```

## GitHub Actions

Workflow: `.github/workflows/ios-testflight.yml` (`ios testflight`, manual dispatch).

Add these repository secrets:

| Secret | Value |
|---|---|
| `APPLE_TEAM_ID` | Apple Developer Team ID. |
| `ASC_KEY_ID` | App Store Connect API Key ID. |
| `ASC_ISSUER_ID` | App Store Connect Issuer ID. |
| `ASC_KEY_P8_BASE64` | `base64 -i AuthKey_XXXXXXXXXX.p8` output. |
| `IOS_DISTRIBUTION_CERT_P12_BASE64` | `base64 -i distribution.p12` output. |
| `IOS_DISTRIBUTION_CERT_PASSWORD` | Password chosen when exporting the `.p12`. |

Base64 on macOS:

```bash
base64 -i AuthKey_XXXXXXXXXX.p8 | pbcopy
base64 -i distribution.p12 | pbcopy
```

Run it from the Actions tab, or:

```bash
gh workflow run ios-testflight.yml --repo CaioFaSoares/Obol
gh workflow run ios-testflight.yml --repo CaioFaSoares/Obol -f build_number=2026103001
```

The workflow installs the API key and certificate into a temporary keychain, runs the same `npm run ios:testflight`, uploads the IPA, and stores the IPA plus dSYMs as a short-lived artifact. Set `upload` to `false` to build without uploading.

## TestFlight processing

After a successful upload, App Store Connect processes the build asynchronously. It appears in TestFlight when processing completes. The app declares `ITSAppUsesNonExemptEncryption = false`, so the usual export-compliance prompt is skipped.

## Troubleshooting

| Symptom | Check |
|---|---|
| `No profiles for 'copland.obol.mobile' were found` | Team ID, App ID, certificate, and API key role. The key must be able to manage signing assets. |
| `No signing certificate "iOS Distribution" found` | Import an `Apple Distribution` `.p12` with its private key; the workflow requires that secret. |
| `Invalid Signature` | The certificate does not match the provisioning profile or team. Re-export the correct distribution certificate. |
| Build number already used | Increase `BUILD_NUMBER`; it must be unique for the marketing version. |
| `Invalid Version` | Create or select a matching version in App Store Connect, or set `MARKETING_VERSION` to that version. |
| `altool` authentication failure | Verify the Key ID, Issuer ID, and that the `.p8` path is the downloaded key. |
| Build uploaded but not in TestFlight | Wait for processing; check App Store Connect → TestFlight for validation messages. |
