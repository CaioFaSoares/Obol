#!/usr/bin/env bash
# Build an App Store-signed iOS archive and upload it to TestFlight.
#
# Local usage:
#   APPLE_TEAM_ID=XXXXXXXXXX \
#   ASC_KEY_ID=XXXXXXXXXX \
#   ASC_ISSUER_ID=00000000-0000-0000-0000-000000000000 \
#   ASC_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8" \
#   npm run ios:testflight
#
# CI usage is the same command; `.github/workflows/ios-testflight.yml` installs
# the API key and distribution certificate into a temporary keychain first.
# Set SKIP_UPLOAD=1 to produce the IPA without uploading.
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
SKIP_WEB_BUILD="${SKIP_WEB_BUILD:-0}"

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[[ -n "${OUT}" && "${OUT}" != "/" && "${OUT}" != "${HOME}" && "${OUT}" != "${REPO_ROOT}" && "${OUT}" != "${APP_ROOT}" ]] \
  || die "Refusing unsafe IOS_BUILD_DIR: ${OUT}"

command -v xcodebuild >/dev/null 2>&1 || die "xcodebuild not found; install Xcode."
command -v node >/dev/null 2>&1 || die "node not found; run inside 'nix develop' or install Node."
[[ -d "${PROJECT}" ]] || die "Xcode project not found: ${PROJECT}"
[[ -n "${TEAM_ID}" ]] || die "APPLE_TEAM_ID is required (Apple Developer Team ID)."

DEFAULT_VERSION="$(node -p "require('${REPO_ROOT}/desktop/app.json').version")"
VERSION="${MARKETING_VERSION:-$(printf '%s' "${DEFAULT_VERSION}" | sed -E 's/[-+].*$//')}"
BUILD_NUMBER="${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M%S)}"

[[ "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || die "MARKETING_VERSION must be X.Y.Z (got '${VERSION}')."
[[ "${BUILD_NUMBER}" =~ ^[0-9]+$ ]] \
  || die "BUILD_NUMBER must be numeric (got '${BUILD_NUMBER}')."

KEY_ARGS=()
if [[ -n "${KEY_PATH}" || -n "${KEY_ID}" || -n "${ISSUER_ID}" ]]; then
  [[ -n "${KEY_PATH}" && -n "${KEY_ID}" && -n "${ISSUER_ID}" ]] \
    || die "ASC_KEY_PATH, ASC_KEY_ID and ASC_ISSUER_ID must be set together."
  [[ -f "${KEY_PATH}" ]] || die "App Store Connect key not found: ${KEY_PATH}"
  KEY_ARGS=(
    -authenticationKeyPath "${KEY_PATH}"
    -authenticationKeyID "${KEY_ID}"
    -authenticationKeyIssuerID "${ISSUER_ID}"
  )
fi

if [[ "${SKIP_UPLOAD}" != "1" ]]; then
  [[ ${#KEY_ARGS[@]} -gt 0 ]] \
    || die "Upload requires ASC_KEY_PATH, ASC_KEY_ID and ASC_ISSUER_ID."
  command -v xcrun >/dev/null 2>&1 || die "xcrun not found; install Xcode command line tools."
  xcrun --find altool >/dev/null 2>&1 || die "altool not found in the active Xcode."
fi

XC_MAJOR="$(xcodebuild -version | awk '/^Xcode / { split($2, parts, "."); print parts[1]; exit }')"
EXPORT_METHOD="${IOS_EXPORT_METHOD:-app-store-connect}"
if [[ "${EXPORT_METHOD}" == "app-store-connect" && "${XC_MAJOR:-0}" -lt 15 ]]; then
  EXPORT_METHOD="app-store"
fi

log "Obol ${VERSION} (build ${BUILD_NUMBER}) for ${BUNDLE_ID}"
log "Team ${TEAM_ID}; export method ${EXPORT_METHOD}; output ${OUT}"

if [[ "${SKIP_WEB_BUILD}" != "1" ]]; then
  log "Generating and syncing the iOS web bundle"
  (cd "${APP_ROOT}" && npm run ios:generate && npm run ios:sync)
fi

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

log "Archiving"
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

IPA="$(find "${EXPORT_DIR}" -maxdepth 1 -name '*.ipa' -print -quit)"
[[ -n "${IPA}" ]] || die "Export finished without an IPA in ${EXPORT_DIR}"

log "IPA: ${IPA}"
if [[ "${SKIP_UPLOAD}" == "1" ]]; then
  log "SKIP_UPLOAD=1; leaving the IPA in place."
  exit 0
fi

log "Uploading to TestFlight"
xcrun altool --upload-app \
  -f "${IPA}" \
  -t ios \
  --api-key "${KEY_ID}" \
  --api-issuer "${ISSUER_ID}" \
  --p8-file-path "${KEY_PATH}"

log "Upload accepted. App Store Connect processing is asynchronous; the build appears in TestFlight when processing finishes."
