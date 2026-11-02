# iOS TestFlight builds

Builds a Release archive of the **native** Obol iOS app (SwiftUI, no WebView),
exports an App Store IPA, and uploads it to TestFlight. The same script runs
locally and in the manual GitHub Actions workflow. Nothing in this pipeline
generates, synchronizes, or uploads web assets.

## What it runs

`app/scripts/ios-testflight.sh`:

1. validates `APPLE_TEAM_ID`, the bundle ID, the numeric build number, and the
   marketing version;
2. archives `app/ios/App/App.xcodeproj` with scheme `App` for
   `generic/platform=iOS`, automatic signing, and the requested team;
3. resolves only the LOCAL Swift packages `app/ios/ObolCore` and the root
   `app/ios/Package.swift` product `ObolNativeRuntime`;
4. exports with `app-store-connect` (or `app-store` on Xcode 14);
5. when `SKIP_UPLOAD` is not `1`, uploads the produced IPA with
   `xcrun altool`.

The script verifies the archived `.app` and the exported `.ipa` before
reporting success. Build outputs go to `app/ios/build/testflight/`; no global
tool is installed and no credential is written into the repository.

## Prerequisites

| Requirement | Detail |
|---|---|
| Apple Developer Program | A paid team (project signing team `MCC2B4P5MZ`) with permission to create distribution certificates and App Store profiles. |
| Bundle ID | `copland.obol.mobile`, matching `PRODUCT_BUNDLE_IDENTIFIER` in the Xcode target. |
| App Store Connect app | An app record for the same bundle ID, a SKU, and a version matching the marketing version (currently `0.4.5`). |
| Distribution certificate | An `Apple Distribution` certificate with its private key, exported as `.p12`. |
| App Store Connect API key | A Team Key with a role that can manage signing assets. Download the `.p8` once; note the Key ID and Issuer ID. |
| Full Xcode | A complete Xcode with the iOS SDK, not only Command Line Tools. |

## Local Mac

```bash
export APPLE_TEAM_ID=ABCDE12345
export ASC_KEY_ID=XXXXXXXXXX
export ASC_ISSUER_ID=00000000-0000-0000-0000-000000000000
export ASC_KEY_PATH="$HOME/Downloads/AuthKey_XXXXXXXXXX.p8"

bash app/scripts/ios-testflight.sh
```

If Xcode is signed into the team and the distribution certificate is in the
login keychain, the archive can use it directly. The upload still needs the
API key. The script fails closed: missing upload credentials stop the run, and
`SKIP_UPLOAD=1` is the explicit archive-only path.

| Variable | Default | Purpose |
|---|---|---|
| `BUILD_NUMBER` | UTC timestamp (`YYYYMMDDHHMMSS`) | `CFBundleVersion`; must be numeric and unique for the marketing version. |
| `MARKETING_VERSION` | `0.4.5` | `CFBundleShortVersionString`; must be `X.Y.Z`. |
| `SKIP_UPLOAD=1` | unset | Produce the IPA only; no App Store Connect upload. |
| `IOS_BUNDLE_ID` | `copland.obol.mobile` | Override the bundle identifier. |
| `IOS_SCHEME` | `App` | Archive scheme. |
| `IOS_EXPORT_METHOD` | `app-store-connect` | Set `app-store` on older Xcode. |
| `IOS_BUILD_DIR` | `app/ios/build/testflight` | Output directory. |

Archive-only example:

```bash
SKIP_UPLOAD=1 BUILD_NUMBER=2026103001 bash app/scripts/ios-testflight.sh
```

## Simulator

`bash app/scripts/ios-run.sh` builds the `App` scheme for a simulator with an
isolated DerivedData directory, installs the produced `.app`, and launches it
with `simctl`. It never reads signing material. `IOS_SIMULATOR_ID` selects an
exact simulator; otherwise a booted iPhone is reused or the first available
iPhone is booted.

## GitHub Actions

Workflow: `.github/workflows/ios-testflight.yml` (`ios testflight`, manual
dispatch). It has no Node step: only the Apple toolchain, the signing material,
and `xcodebuild`/`altool` run.

The Swift parity suite runs in its own workflow,
`.github/workflows/ios-swift-test.yml` (`ios swift test`, job `swift-parity`):
`swift test` in `app/ios` on a `macos-15` runner, triggered by a push that
touches `app/ios/**` and by manual dispatch. It needs no secrets, no simulator,
and no web bundle.

Add these repository secrets:

| Secret | Value |
|---|---|
| `APPLE_TEAM_ID` | Apple Developer Team ID. |
| `ASC_KEY_ID` | App Store Connect API Key ID. |
| `ASC_ISSUER_ID` | App Store Connect Issuer ID. |
| `ASC_KEY_P8_BASE64` | `base64 -i AuthKey_XXXXXXXXXX.p8` output. |
| `IOS_DISTRIBUTION_CERT_P12_BASE64` | `base64 -i distribution.p12` output. |
| `IOS_DISTRIBUTION_CERT_PASSWORD` | Password chosen when exporting the `.p12`. |

Run it from the Actions tab, or:

```bash
gh workflow run ios-testflight.yml --repo CaioFaSoares/Obol
gh workflow run ios-testflight.yml --repo CaioFaSoares/Obol -f build_number=2026103001
```

The workflow installs the API key and certificate into a temporary keychain,
runs the same script, stores the IPA plus dSYMs as a short-lived artifact, and
removes the keychain. Set `upload` to `false` to build without uploading.

## Privacy and networking

`app/ios/App/App/PrivacyInfo.xcprivacy` declares no tracking, no tracking
domains, and no collected data types. It declares the app-only UserDefaults
required reason `CA92.1`. There is no analytics SDK, no advertising identifier,
and no third-party tracking library in the app.

`Info.plist` contains `NSLocalNetworkUsageDescription` for a self-hosted server
on the local network and scopes ATS with `NSAllowsLocalNetworking`. It does not
disable ATS globally, does not add arbitrary insecure-load exceptions, and does
not weaken TLS certificate validation: the Core transport guard still enforces
HTTPS in Release builds. `ITSAppUsesNonExemptEncryption` is `false`; the app
uses only standard system TLS and CryptoKit hashing (exempt encryption).

## TestFlight processing

After a successful upload, App Store Connect processes the build
asynchronously. It appears in TestFlight when processing completes. The app
declares `ITSAppUsesNonExemptEncryption = false`, so the usual export-compliance
prompt is skipped.

## Troubleshooting

| Symptom | Check |
|---|---|
| `No profiles for 'copland.obol.mobile' were found` | Team ID, App ID, certificate, and API key role. The key must be able to manage signing assets. |
| `No signing certificate "Apple Distribution" found` | Import an `Apple Distribution` `.p12` with its private key; the workflow requires that secret. |
| `Invalid Signature` | The certificate does not match the provisioning profile or team. Re-export the correct distribution certificate. |
| Build number already used | Increase `BUILD_NUMBER`; it must be unique for the marketing version. |
| `Invalid Version` | Create or select a matching version in App Store Connect, or set `MARKETING_VERSION` to that version. |
| `altool` authentication failure | Verify the Key ID, Issuer ID, and that `ASC_KEY_PATH` is the downloaded `.p8`. |
| Build uploaded but not in TestFlight | Wait for processing; check App Store Connect → TestFlight for validation messages. |
| Package resolution failure | Both local packages must exist in the checkout: `app/ios/ObolCore/Package.swift` and `app/ios/Package.swift`. No remote dependency download is needed. |
