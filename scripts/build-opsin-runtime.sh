#!/usr/bin/env bash
#
# Build the trimmed Java runtime that backs name → structure.
#
# Why this is a script and not a committed artifact: the image is ~47 MB, which is a poor thing to
# carry in git forever, and unlike the WASM engines it is reproducible from any JDK in under a minute.
# A build WITHOUT it still works — the OPSIN capability reports itself unavailable with a reason
# (`opsin_status`), the same way a missing engine is handled everywhere else in this repo. Run this
# before packaging a release, or whenever you want the feature live in a dev build.
#
# Provenance, the licence audit of the jar, and the module list are in
# apps/desktop/src-tauri/resources/opsin/BUILD.md.
set -euo pipefail

DEST="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/apps/desktop/src-tauri/resources/opsin/jre"

# The module set from `jdeps --print-module-deps --ignore-missing-deps` over the vendored jar.
# Deliberately the conservative answer: a hand-minimised set is 1 MB smaller but was only ever proven
# against one SMILES conversion, and would risk failing on OPSIN's CML or InChI output paths.
#
# java.desktop is the expensive module and it is log4j-core's doing, not OPSIN's — it reaches
# java.beans.PropertyChangeEvent, and without it the JVM dies before OPSIN parses anything.
MODULES="java.base,java.compiler,java.desktop,java.management,java.naming,java.rmi,java.scripting,java.sql,jdk.unsupported"

find_jlink() {
  if [[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/jlink" ]]; then
    echo "$JAVA_HOME/bin/jlink"; return
  fi
  if command -v jlink >/dev/null 2>&1; then
    command -v jlink; return
  fi
  # Homebrew keeps openjdk keg-only, so it is off PATH even when installed.
  for candidate in /opt/homebrew/opt/openjdk/bin/jlink /usr/local/opt/openjdk/bin/jlink; do
    [[ -x "$candidate" ]] && { echo "$candidate"; return; }
  done
  return 1
}

if ! JLINK="$(find_jlink)"; then
  echo "error: no jlink found. Install a JDK (e.g. 'brew install openjdk') or set JAVA_HOME." >&2
  exit 1
fi

echo "Using $JLINK"
rm -rf "$DEST"
"$JLINK" --add-modules "$MODULES" \
  --strip-debug --no-header-files --no-man-pages --compress=zip-9 \
  --output "$DEST"

# jlink emits its legal/ notices read-only, and Tauri's resource copier overwrites rather than
# replaces — so the SECOND build fails with EACCES on files the first build already copied. Making
# them writable is what keeps a rebuild working. The files themselves must stay: they are the
# GPLv2+CE and Classpath Exception texts this runtime is redistributed under.
chmod -R u+w "$DEST"

echo "Built $(du -sh "$DEST" | cut -f1) runtime at $DEST"

# Prove it before declaring success: a runtime that cannot run OPSIN is worse than none, because the
# capability would report itself available.
JAR="$(dirname "$DEST")/opsin-cli-2.9.0.jar"
if [[ -f "$JAR" ]]; then
  OUT="$(printf 'benzene\n' | "$DEST/bin/java" -jar "$JAR" -o smi 2>/dev/null | head -1)"
  if [[ "$OUT" == "C1=CC=CC=C1" ]]; then
    echo "smoke ok: benzene -> $OUT"
  else
    echo "error: runtime built but OPSIN did not convert benzene (got '$OUT')" >&2
    exit 1
  fi
else
  echo "warning: $JAR not found, skipping smoke test" >&2
fi
