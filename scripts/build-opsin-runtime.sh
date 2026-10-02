#!/usr/bin/env bash
#
# Build the trimmed Java runtime that backs name → structure.
#
# The implementation lives in build-opsin-runtime.mjs so macOS, Windows and Linux share one copy of
# the module list, jlink flags, and smoke test. This wrapper keeps the documented entry point working.
set -euo pipefail

exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/build-opsin-runtime.mjs" "$@"
