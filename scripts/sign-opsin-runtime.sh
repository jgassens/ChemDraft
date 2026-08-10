#!/usr/bin/env bash
set -euo pipefail

# Sign every Mach-O file inside the bundled OPSIN Java runtime, innermost-first.
#
# WHY THIS SCRIPT EXISTS
#
# `tauri.conf.json` ships `resources/opsin/jre` as a bundle resource. That directory is a jlink'd JRE:
# a `bin/java` launcher, a `lib/jspawnhelper`, and ~30 `.dylib`s — 31 Mach-O files in total, all of
# them CODE, all sitting under `Contents/Resources/` where nothing signs them.
#
# The outer `codesign` on the .app does not reach them. Signing a bundle signs the bundle's own
# executable and its standard nested-code locations (Frameworks, PlugIns, XPCServices); arbitrary
# Mach-O files under Resources are not among those, and Apple deprecates `--deep` for signing
# precisely because it papers over cases like this with the wrong identity and no entitlements. The
# notary service, meanwhile, walks every Mach-O in the payload and rejects the submission with
# "The binary is not signed with a valid Developer ID certificate" for each one it finds unsigned.
#
# This is the same failure `prepare-sparkle.sh` was written for — its comment names rejected
# submission bbbb4046 and two Sparkle helpers "outside every standard nested-code location". The JRE
# is that problem again, 31 files wider, and it arrived with this branch.
#
# ORDER MATTERS. A bundle's signature covers its contents, so signing outside-in invalidates itself:
# every nested file must be signed before anything that encloses it. This script only handles the
# JRE's flat contents, so it must run BEFORE the .app is signed.
#
# NOT YET EXERCISED AGAINST THE NOTARY SERVICE. This closes the gap the review identified and follows
# the documented flow, but no signed submission has been made with it — the first release build is
# what proves it. Treat a green run here as "the files are signed", not as "notarization will pass".

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAURI_DIR="$ROOT_DIR/apps/desktop/src-tauri"
JRE_DIR="$TAURI_DIR/resources/opsin/jre"
ENTITLEMENTS="$TAURI_DIR/chemdraft.entitlements"

if [ -z "${APPLE_SIGNING_IDENTITY:-}" ]; then
  echo "APPLE_SIGNING_IDENTITY is not set; skipping OPSIN runtime signing." >&2
  echo "That is correct for a local/dev build and WRONG for a release build." >&2
  exit 0
fi

if [ ! -d "$JRE_DIR" ]; then
  # A build without the runtime is supported — `opsin.rs` reports the capability unavailable. There
  # is simply nothing to sign.
  echo "No OPSIN runtime at $JRE_DIR; nothing to sign."
  exit 0
fi

if [ ! -f "$ENTITLEMENTS" ]; then
  echo "error: entitlements file missing at $ENTITLEMENTS" >&2
  exit 1
fi

# Every Mach-O under the runtime, deepest path first. `file` rather than an extension test, because
# `bin/java`, `lib/jspawnhelper` and the `.dylib`s have three different naming conventions and a
# missed one is a rejected submission rather than a warning.
#
# `while read` rather than `mapfile`, which is bash 4+. macOS ships bash 3.2 at /bin/bash, and a
# release script that silently needs a Homebrew bash is a release script that fails on a clean
# machine.
MACH_O=()
while IFS= read -r binary; do
  MACH_O+=("$binary")
done < <(
  find "$JRE_DIR" -type f -print0 \
    | xargs -0 file --no-pad \
    | grep 'Mach-O' \
    | cut -d: -f1 \
    | awk '{ print gsub(/\//, "/") "\t" $0 }' \
    | sort -rn \
    | cut -f2-
)

if [ "${#MACH_O[@]}" -eq 0 ]; then
  echo "error: no Mach-O files found under $JRE_DIR — the runtime looks empty or corrupt." >&2
  exit 1
fi

echo "Signing ${#MACH_O[@]} Mach-O files in the OPSIN runtime..."
for binary in "${MACH_O[@]}"; do
  # `--options runtime` is the hardened runtime, required for Developer ID notarization.
  # `--timestamp` is a secure timestamp, also required. `--force` replaces the JDK vendor's own
  # signature, which is not ours and does not carry our entitlements.
  codesign --force --options runtime --timestamp \
    --entitlements "$ENTITLEMENTS" \
    --sign "$APPLE_SIGNING_IDENTITY" "$binary"
done

# Prove it, rather than trusting the loop's exit status: `codesign --verify` on each file catches a
# signature that was written but is malformed.
for binary in "${MACH_O[@]}"; do
  codesign --verify --strict "$binary"
done

echo "OPSIN runtime signed and verified (${#MACH_O[@]} files)."

# THE JAR IS ALSO A CODE CONTAINER. The notary service unpacks zip archives — including jars — and
# walks the Mach-O files inside them. opsin-cli ships JNA's libjnidispatch.jnilib and jna-inchi's
# libjnainchi.dylib for darwin in both architectures, and submission 2026-08-10 was rejected on
# exactly those four entries. The Linux/BSD .so entries are ELF and invisible to the notary.
#
# The jar is git-tracked, so this signs the darwin natives IN PLACE and the signed jar is meant to
# be committed. The verify-first check keeps the step idempotent: once the committed jar carries our
# signatures, release builds leave it byte-identical and the working tree stays clean.
for JAR in "$TAURI_DIR"/resources/opsin/*.jar; do
  [ -f "$JAR" ] || continue

  NATIVES=()
  while IFS= read -r entry; do
    NATIVES+=("$entry")
  done < <(unzip -Z1 "$JAR" | grep -E '\.(dylib|jnilib)$' || true)
  [ "${#NATIVES[@]}" -gt 0 ] || continue

  JAR_TMP="$(mktemp -d)"
  trap 'rm -rf "$JAR_TMP"' EXIT
  (cd "$JAR_TMP" && unzip -q -o "$JAR" "${NATIVES[@]}")

  ALREADY_SIGNED=1
  for entry in "${NATIVES[@]}"; do
    if ! codesign --verify --strict "$JAR_TMP/$entry" 2>/dev/null; then
      ALREADY_SIGNED=0
      break
    fi
    # No `grep -q` on a live pipe: under pipefail, grep quitting at the first match can SIGPIPE
    # codesign and fail the pipeline even though the signature is ours.
    SIGN_INFO="$(codesign -dvv "$JAR_TMP/$entry" 2>&1 || true)"
    case "$SIGN_INFO" in
      *"Authority=$APPLE_SIGNING_IDENTITY"*) ;;
      *) ALREADY_SIGNED=0; break ;;
    esac
  done

  if [ "$ALREADY_SIGNED" -eq 1 ]; then
    echo "$(basename "$JAR"): ${#NATIVES[@]} embedded natives already signed; jar untouched."
    continue
  fi

  echo "Signing ${#NATIVES[@]} embedded natives in $(basename "$JAR")..."
  for entry in "${NATIVES[@]}"; do
    codesign --force --options runtime --timestamp \
      --entitlements "$ENTITLEMENTS" \
      --sign "$APPLE_SIGNING_IDENTITY" "$JAR_TMP/$entry"
    codesign --verify --strict "$JAR_TMP/$entry"
  done
  (cd "$JAR_TMP" && zip -q "$JAR" "${NATIVES[@]}")
  echo "$(basename "$JAR"): embedded natives signed and jar updated in place."
done
