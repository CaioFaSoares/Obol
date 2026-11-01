#!/usr/bin/env bash
# Build, install, and launch the NATIVE Obol iOS app on a simulator.
#
# Usage (from the repository root or app/):
#   bash app/scripts/ios-run.sh
#   IOS_SIMULATOR_ID=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX bash app/scripts/ios-run.sh
#
# The script picks the requested simulator, a booted iPhone, or the first
# available iPhone; builds the `App` scheme with an isolated DerivedData
# directory; installs the produced .app; and launches it with simctl. It does
# not download tools, does not install anything outside the simulator, and
# does not touch signing material. Every xcodebuild/simctl failure propagates
# with its real exit code.
set -euo pipefail

APP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${APP_ROOT}/ios/App/App.xcodeproj"
SCHEME="${IOS_SCHEME:-App}"
BUNDLE_ID="${IOS_BUNDLE_ID:-copland.obol.mobile}"
DERIVED_DATA_ROOT="${IOS_DERIVED_DATA_ROOT:-${APP_ROOT}/ios/build/ios-run/DerivedData}"

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v xcodebuild >/dev/null 2>&1 || die "xcodebuild not found; run this on macOS with a full Xcode installation."
command -v xcrun >/dev/null 2>&1 || die "xcrun not found; run this on macOS with a full Xcode installation."
xcrun simctl list devices >/dev/null 2>&1 || die "simctl is not available from the active Xcode."
[[ -d "${PROJECT}" ]] || die "Xcode project not found: ${PROJECT}"

extract_udid() {
  # Prints the first simulator UDID on the piped line, if any.
  sed -n -E 's/.*\(([0-9A-Fa-f-]{36})\).*/\1/p'
}

select_simulator() {
  local requested="${IOS_SIMULATOR_ID:-}"
  local devices
  devices="$(xcrun simctl list devices)"

  if [[ -n "${requested}" ]]; then
    local requested_line
    requested_line="$(printf '%s\n' "${devices}" | grep -F "${requested}" | sed -n '1p' || true)"
    [[ -n "${requested_line}" ]] || die "IOS_SIMULATOR_ID '${requested}' is not a known simulator."
    if ! printf '%s\n' "${requested_line}" | grep -q "(Booted)"; then
      log "Booting requested simulator ${requested}"
      xcrun simctl boot "${requested}" || true
    fi
    printf '%s\n' "${requested}"
    return 0
  fi

  local booted
  booted="$(xcrun simctl list devices booted | grep -E '(iPhone|iPad) \(' | extract_udid | sed -n '1p' || true)"
  if [[ -n "${booted}" ]]; then
    log "Using booted simulator ${booted}"
    printf '%s\n' "${booted}"
    return 0
  fi

  local chosen
  chosen="$(xcrun simctl list devices available | grep -E 'iPhone \(' | extract_udid | sed -n '1p' || true)"
  if [[ -z "${chosen}" ]]; then
    chosen="$(xcrun simctl list devices available | grep -E 'iPad \(' | extract_udid | sed -n '1p' || true)"
  fi
  [[ -n "${chosen}" ]] || die "No available simulator was found; install an iOS simulator runtime in Xcode."
  log "Booting simulator ${chosen}"
  xcrun simctl boot "${chosen}" || true
  printf '%s\n' "${chosen}"
}

SIMULATOR_UDID="$(select_simulator)"
[[ -n "${SIMULATOR_UDID}" ]] || die "Simulator selection failed."
log "Simulator: ${SIMULATOR_UDID}"
xcrun simctl bootstatus "${SIMULATOR_UDID}" -b

LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/obol-ios-run.XXXXXX")"
BUILD_LOG="${LOG_DIR}/xcodebuild.log"

log "Building ${SCHEME} for the iOS Simulator"
if ! xcodebuild \
  -project "${PROJECT}" \
  -scheme "${SCHEME}" \
  -configuration Debug \
  -destination "platform=iOS Simulator,id=${SIMULATOR_UDID}" \
  -derivedDataPath "${DERIVED_DATA_ROOT}" \
  build 2>&1 | tee "${BUILD_LOG}"; then
  die "xcodebuild failed. Full log: ${BUILD_LOG}"
fi

APP_BUNDLE="${DERIVED_DATA_ROOT}/Build/Products/Debug-iphonesimulator/App.app"
if [[ ! -d "${APP_BUNDLE}" ]]; then
  APP_BUNDLE="$(find "${DERIVED_DATA_ROOT}/Build/Products" -maxdepth 4 -type d -name 'App.app' -print | sed -n '1p')"
fi
[[ -n "${APP_BUNDLE}" && -d "${APP_BUNDLE}" ]] || die "Build finished without App.app under ${DERIVED_DATA_ROOT}/Build/Products."
rm -rf "${LOG_DIR}"

log "Installing $(basename "${APP_BUNDLE}") on ${SIMULATOR_UDID}"
xcrun simctl install "${SIMULATOR_UDID}" "${APP_BUNDLE}"

log "Launching ${BUNDLE_ID}"
xcrun simctl launch "${SIMULATOR_UDID}" "${BUNDLE_ID}"

log "Obol is running on simulator ${SIMULATOR_UDID}."
