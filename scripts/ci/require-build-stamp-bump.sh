#!/usr/bin/env bash
#
# AGENTS.md §22 requires CURRENT_BUILD_STAMP to be updated at closeout. Nothing enforced it, so the
# stamp went stale while three commits changed MainWindow.tsx — and a stale stamp is actively
# misleading: it is printed in the status bar and the About box, so a build reports itself as one
# that shipped earlier.
#
# Only source changes require a bump. Docs, CI config, fixtures and tests do not: the stamp exists
# to identify a running build, and none of those change what runs.
#
# Lives in a script rather than inline YAML so it can be run locally:
#   BASE_SHA=origin/main HEAD_SHA=HEAD scripts/ci/require-build-stamp-bump.sh
set -euo pipefail

BASE_SHA="${BASE_SHA:?BASE_SHA is required}"
HEAD_SHA="${HEAD_SHA:?HEAD_SHA is required}"

STAMP_FILE="apps/desktop/src/MainWindow.tsx"

# Paths whose contents end up in a build a user can run.
SOURCE_PATHS=(
  "apps/desktop/src"
  "apps/desktop/src-tauri/src"
  "packages"
)

read_stamp() {
  # Deliberately anchored to the exact declaration: a loose grep would also match the two places
  # that interpolate the constant, and report one of those lines as the value.
  git show "$1:$STAMP_FILE" \
    | sed -n 's/^const CURRENT_BUILD_STAMP = "\(.*\)";$/\1/p' \
    | head -1
}

changed="$(git diff --name-only "$BASE_SHA" "$HEAD_SHA" -- "${SOURCE_PATHS[@]}" \
  | grep -vE '(^|/)[^/]*\.test\.[cm]?[jt]sx?$' \
  || true)"

if [ -z "$changed" ]; then
  echo "No runtime source changed under ${SOURCE_PATHS[*]} — no build-stamp bump required."
  exit 0
fi

base_stamp="$(read_stamp "$BASE_SHA")"
head_stamp="$(read_stamp "$HEAD_SHA")"

if [ -z "$head_stamp" ]; then
  echo "Could not read CURRENT_BUILD_STAMP from $STAMP_FILE at $HEAD_SHA." >&2
  echo "If the constant was renamed or moved, update this script to match." >&2
  exit 1
fi

if [ "$base_stamp" = "$head_stamp" ]; then
  changed_count="$(printf '%s\n' "$changed" | wc -l | tr -d ' ')"
  cat >&2 <<EOF
Build stamp not bumped.

  $changed_count runtime source file(s) changed, but CURRENT_BUILD_STAMP is still "$head_stamp".

AGENTS.md §22 requires updating it at closeout. Edit $STAMP_FILE:

  const CURRENT_BUILD_STAMP = "$head_stamp";   ->   the next value

Changed files:
$(printf '%s\n' "$changed" | sed 's/^/  /' | head -20)
EOF
  exit 1
fi

echo "Build stamp bumped: \"$base_stamp\" -> \"$head_stamp\"."
