#!/usr/bin/env bash
# Build an App Store-signed archive of the NATIVE Obol iOS app, export the
# IPA, and upload it to TestFlight.
#
# The native app has no web bundle: there is no npm step, no asset generation,
# and no web-asset copy in this pipeline.
#
# Local usage:
#   APPLE_TEAM_ID=XXXXXXXXXX \
#   ASC_KEY_ID=XXXXXXXXXX \
#   ASC_ISSUER_ID=00000000-0000-0000-0000-000000000000 \
#   ASC_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8" \
#   bash app/scripts/ios-testflight.sh
#
# Build only (no App Store Connect credentials required):
#   SKIP_UPLOAD=1 BUILD_NUMBER=2026103001 bash app/scripts/ios-testflight.sh
#
# CI usage is the same command; the manual workflow installs the API key and
# distribution certificate into a temporary keychain first. Uploads fail
# closed: missing credentials never produce a fake success, and the script
# never reports an IPA or upload that was not actually produced.
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${APP_ROOT}/.." && pwd)"
PROJECT="${APP_ROOT}/ios/App/App.xcodeproj"
SCHEME="${IOS_SCHEME:-App}"
BUNDLE_ID="${IOS_BUNDLE_ID:-copland.obol.mobile}"

TEAM_ID="${APPLE_TEAM_ID:-}"
KEY_ID="${ASC_KEY_ID:-}"
ISSUER_ID="${ASC_ISSUER_ID:-}"
KEY_PATH="${ASC_KEY_PATH:-}"

OUT="${IOS_BUILD_DIR:-${APP_ROOT}/ios/build/testflight}"
ARCHIVE="${OUT}/Obol.xcarchive"
EXPORT_DIR="${OUT}/export"
EXPORT_PLIST="${OUT}/ExportOptions.plist"
SKIP_UPLOAD="${SKIP_UPLOAD:-0}"

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

case "${SKIP_UPLOAD}" in
  0|1) ;;
  *) die "SKIP_UPLOAD must be 0 or 1 (got '${SKIP_UPLOAD}')." ;;
esac

[[ -n "${OUT}" && "${OUT}" != "/" && "${OUT}" != "${HOME}" && "${OUT}" != "${REPO_ROOT}" && "${OUT}" != "${APP_ROOT}" ]] \
  || die "Refusing unsafe IOS_BUILD_DIR: ${OUT}"
[[ -d "${PROJECT}" ]] || die "Xcode project not found: ${PROJECT}"
command -v xcodebuild >/dev/null 2>&1 || die "xcodebuild not found; install a full Xcode."
[[ -n "${TEAM_ID}" ]] || die "APPLE_TEAM_ID is required (Apple Developer Team ID)."

if [[ "${SKIP_UPLOAD}" == "0" ]]; then
  [[ -n "${KEY_ID}" && -n "${ISSUER_ID}" && -n "${KEY_PATH}" ]] \
    || die "Upload requires ASC_KEY_ID, ASC_ISSUER_ID, and ASC_KEY_PATH. Set SKIP_UPLOAD=1 for an archive-only run."
  [[ -f "${KEY_PATH}" ]] || die "App Store Connect key not found: ${KEY_PATH}"
  xcrun --find altool >/dev/null 2>&1 || die "altool not found in the active Xcode."
fi

VERSION="${MARKETING_VERSION:-0.4.5}"
VERSION="${VERSION%%-*}"
VERSION="${VERSION%%+*}"
BUILD_NUMBER="${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M%S)}"

[[ "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || die "MARKETING_VERSION must be X.Y.Z (got '${VERSION}')."
[[ "${BUILD_NUMBER}" =~ ^[0-9]+$ ]] \
  || die "BUILD_NUMBER must be numeric (got '${BUILD_NUMBER}')."

KEY_ARGS=()
if [[ -n "${KEY_ID}" && -n "${ISSUER_ID}" && -n "${KEY_PATH}" ]]; then
  KEY_ARGS=(
    -authenticationKeyPath "${KEY_PATH}"
    -authenticationKeyID "${KEY_ID}"
    -authenticationKeyIssuerID "${ISSUER_ID}"
  )
fi

XC_MAJOR="$(xcodebuild -version | awk '/^Xcode / { split($2, parts, "."); print parts[1]; exit }')"
EXPORT_METHOD="${IOS_EXPORT_METHOD:-app-store-connect}"
if [[ "${EXPORT_METHOD}" == "app-store-connect" && "${XC_MAJOR:-0}" -lt 15 ]]; then
  EXPORT_METHOD="app-store"
fi

log "Obol ${VERSION} (build ${BUILD_NUMBER}) for ${BUNDLE_ID}; team ${TEAM_ID}"
log "Export method: ${EXPORT_METHOD}; output: ${OUT}"

rm -rf "${OUT}"
mkdir -p "${EXPORT_DIR}"

cat > "${EXPORT_PLIST}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>${EXPORT_METHOD}</string>
  <key>destination</key>
  <string>export</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>teamID</key>
  <string>${TEAM_ID}</string>
  <key>uploadSymbols</key>
  <true/>
  <key>stripSwiftSymbols</key>
  <true/>
</dict>
</plist>
EOF

log "Archiving the native app"
ARCHIVE_CMD=(
  xcodebuild
  -project "${PROJECT}"
  -scheme "${SCHEME}"
  -configuration Release
  -destination "generic/platform=iOS"
  -archivePath "${ARCHIVE}"
  -allowProvisioningUpdates
)
if [[ ${#KEY_ARGS[@]} -gt 0 ]]; then
  ARCHIVE_CMD+=("${KEY_ARGS[@]}")
fi
ARCHIVE_CMD+=(
  DEVELOPMENT_TEAM="${TEAM_ID}"
  CODE_SIGN_STYLE=Automatic
  CODE_SIGN_IDENTITY="Apple Distribution"
  PRODUCT_BUNDLE_IDENTIFIER="${BUNDLE_ID}"
  MARKETING_VERSION="${VERSION}"
  CURRENT_PROJECT_VERSION="${BUILD_NUMBER}"
  archive
)
"${ARCHIVE_CMD[@]}"

ARCHIVED_APP="${ARCHIVE}/Products/Applications/App.app"
[[ -d "${ARCHIVED_APP}" ]] || die "Archive finished without the expected app at ${ARCHIVED_APP}."

log "Exporting the App Store IPA"
EXPORT_CMD=(
  xcodebuild
  -exportArchive
  -archivePath "${ARCHIVE}"
  -exportPath "${EXPORT_DIR}"
  -exportOptionsPlist "${EXPORT_PLIST}"
  -allowProvisioningUpdates
)
if [[ ${#KEY_ARGS[@]} -gt 0 ]]; then
  EXPORT_CMD+=("${KEY_ARGS[@]}")
fi
"${EXPORT_CMD[@]}"

IPA="$(find "${EXPORT_DIR}" -maxdepth 1 -type f -name '*.ipa' -print | sed -n '1p')"
[[ -n "${IPA}" && -f "${IPA}" && -s "${IPA}" ]] || die "Export finished without a usable IPA in ${EXPORT_DIR}."

log "IPA: ${IPA}"
if [[ "${SKIP_UPLOAD}" == "1" ]]; then
  log "SKIP_UPLOAD=1; leaving the IPA in place."
  exit 0
fi

log "Uploading to TestFlight"
API_PRIVATE_KEYS_DIR="$(cd "$(dirname "${KEY_PATH}")" && pwd)" \
xcrun altool --upload-app \
  -f "${IPA}" \
  -t ios \
  --api-key "${KEY_ID}" \
  --api-issuer "${ISSUER_ID}" \
  --p8-file-path "${KEY_PATH}"

log "Upload accepted. App Store Connect processing is asynchronous; the build appears in TestFlight after processing finishes."
