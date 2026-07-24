#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_DIR="$ROOT_DIR/apps/desktop/src-tauri"
FRAMEWORK_DIR="$TAURI_DIR/Sparkle.framework"
TOOLS_DIR="$TAURI_DIR/sparkle-bin"

# Keep the release and checksum together. Updating either value requires downloading the official
# Sparkle distribution, verifying it independently, and then changing both constants in one review.
SPARKLE_VERSION="2.9.4"
SPARKLE_SHA256="ce89daf967db1e1893ed3ebd67575ed82d3902563e3191ca92aaec9164fbdef9"
SPARKLE_ARCHIVE_URL="https://github.com/sparkle-project/Sparkle/releases/download/${SPARKLE_VERSION}/Sparkle-${SPARKLE_VERSION}.tar.xz"

framework_version() {
  /usr/libexec/PlistBuddy \
    -c "Print :CFBundleShortVersionString" \
    "$FRAMEWORK_DIR/Versions/B/Resources/Info.plist" \
    2>/dev/null || true
}

sign_sparkle_helper_executables() {
  if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
    return 0
  fi
  # Apple notarization rejects the app unless these nested Sparkle helpers carry Developer ID
  # signatures with secure timestamps (rejected submission bbbb4046 named exactly these two
  # executables). They live at the framework version root, outside every standard nested-code
  # location, so neither `codesign --deep` nor the bundler's framework signing ever reaches
  # them. Sign innermost-first with the hardened runtime, per Sparkle's distribution guidance.
  for sparkle_executable in \
    "$FRAMEWORK_DIR/Versions/B/Updater.app/Contents/MacOS/Updater" \
    "$FRAMEWORK_DIR/Versions/B/Updater.app" \
    "$FRAMEWORK_DIR/Versions/B/Autoupdate"; do
    codesign --force --options runtime --timestamp \
      --sign "$APPLE_SIGNING_IDENTITY" "$sparkle_executable"
  done
}

if [ -x "$FRAMEWORK_DIR/Versions/B/Sparkle" ] \
  && [ "$(framework_version)" = "$SPARKLE_VERSION" ] \
  && [ -x "$TOOLS_DIR/generate_keys" ] \
  && [ -x "$TOOLS_DIR/generate_appcast" ] \
  && [ -x "$TOOLS_DIR/sign_update" ]; then
  sign_sparkle_helper_executables
  echo "Sparkle ${SPARKLE_VERSION} is ready."
  exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to download the pinned Sparkle framework." >&2
  exit 1
fi

SPARKLE_TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/chemdraft-sparkle.XXXXXX")"
trap 'rm -rf "$SPARKLE_TEMP_DIR"' EXIT
ARCHIVE_PATH="$SPARKLE_TEMP_DIR/Sparkle-${SPARKLE_VERSION}.tar.xz"

echo "Downloading Sparkle ${SPARKLE_VERSION} from the official release..."
curl --fail --location --retry 3 --silent --show-error \
  "$SPARKLE_ARCHIVE_URL" \
  --output "$ARCHIVE_PATH"

ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE_PATH" | awk '{print $1}')"
if [ "$ACTUAL_SHA256" != "$SPARKLE_SHA256" ]; then
  echo "Sparkle archive checksum mismatch." >&2
  echo "Expected: $SPARKLE_SHA256" >&2
  echo "Actual:   $ACTUAL_SHA256" >&2
  exit 1
fi

tar -xf "$ARCHIVE_PATH" -C "$SPARKLE_TEMP_DIR" \
  ./Sparkle.framework \
  ./bin/generate_keys \
  ./bin/generate_appcast \
  ./bin/sign_update

# Replace only the two exact generated dependency locations after the verified archive is unpacked.
rm -rf "$FRAMEWORK_DIR" "$TOOLS_DIR"
/usr/bin/ditto "$SPARKLE_TEMP_DIR/Sparkle.framework" "$FRAMEWORK_DIR"
mkdir -p "$TOOLS_DIR"
for tool in generate_keys generate_appcast sign_update; do
  cp "$SPARKLE_TEMP_DIR/bin/$tool" "$TOOLS_DIR/$tool"
  chmod 755 "$TOOLS_DIR/$tool"
done

sign_sparkle_helper_executables
echo "Sparkle ${SPARKLE_VERSION} is ready."
