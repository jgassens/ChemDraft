# Journal feature verification record

Audit date: 2026-10-22. Branch: `codex/journal-formatting-presets`.
Current upstream base: `b1325d561ff273ca1e4c1a6ad6fa19b5665739e6`.
Build stamp: `10.22.20.00-codex`. Catalog: twenty partial profiles; unverified entries omitted.
Publication status belongs to the actual GitHub branch/PR and delivery report; this file is a test record.

## Current audit commands and observed outcomes

Run from the repository root unless a directory is specified. Node 24.19.0 was used. On the prepared
computer Node was invoked by its bundled absolute path; `node` below means that same executable.

- `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`: passed, exit 0.
- `node node_modules/vitest/vitest.mjs run apps/desktop/src/journal-presets apps/desktop/src/dialogCapabilities.test.ts apps/desktop/src/dialogs --maxWorkers=2`:
  **204 passed across 23 files**, exit 0, 10.04 seconds. Covers the updated shared dialogs, source
  permissions, Cell controls and exclusion of the five unverified identities.
- From `apps/desktop`, `node node_modules/vite/bin/vite.js build`: passed, exit 0, 31.19 seconds.
  Existing large-chunk and third-party annotation warnings remain.
- `node node_modules/vitest/vitest.mjs run --maxWorkers=2`: **8,318 passed, 38 skipped**, 407 files passed and seven skipped; exit 0,
  336.16 seconds. This run used the current upstream base and unchanged final feature code.
- `git diff --check HEAD`: passed before final document staging; repeat before publishing.
- Rust 1.97.1 `rustfmt --edition 2021 --check apps/desktop/src-tauri/src/dialog_windows.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/build.rs`:
  passed, exit 0. The temporary official checksum-verified formatter
  is outside the repository; formatting alone does not compile the code.

## Required native checks not verified

Cargo is not installed on this Mac (`command -v cargo` returned no path). Earlier attempts at
`cargo clippy --all-targets --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings` and
`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` exited 127, command not found.
Earlier `./run-app --dev` exited 1 before app launch, reporting the missing Rust/Cargo toolchain.

- Native macOS: build, clippy, Rust tests, real source-link opening, modeless ownership/focus,
  placement, native save/raster/PDF output and the full manual stress checklist remain unverified.
- Native Windows: build, types/tests on Windows, clippy/Rust tests, WebView2/menu/window ownership,
  multi-monitor behavior, source links, save/export and stress checks remain unverified.
- `node scripts/smoke-windows-menu-churn.mjs`: not run; needs the Windows host/app.
- Windows release installers must be built by the repository's CI workflow, not locally.
- New Rust validator/source-allowlist tests are written but not executed here.

The repository CI defines Linux web/type/test gates and native macOS/Windows gates. A PR must remain
a draft until required checks pass; a successful browser test is not native-platform verification.

## Scope of automated tests

Chemical atom/bond payloads and metadata, coordinate preservation/default versus explicit resizing,
selected group/page/document scope, one Undo/Redo, real native save-envelope/reopen, source snapshots,
repeated application without recursive metadata, malformed data/units/custom settings, font fallback,
export-renderer preview parity, physical dimension/format/DPI advisories, stale-preview rejection,
originating inactive tab, unfinished label drafts, exact preview gating, cancellation and both
platform keyboard branches. Native transport/window tests use mocks, not an actual desktop binary.

## Historical evidence, not current success claims

On the older `6bc42de` base, before Cell was enabled, the complete suite passed 7,541 tests with 38
skipped. After Cell was enabled, its focused suite passed 60 tests. Two full follow-ups were not clean:
one reported 7,371 passed / 76 failed / 38 skipped with two worker errors; another reported 7,535
passed / eight failed / 38 skipped with a worker timeout. Many failures were timeouts; their cause
was not conclusively established. The eight failures were rechecked with a name filter across four
files: ten tests passed and 426 unrelated cases were skipped (14.61 seconds). That does not turn the
failed full runs into full-suite passes. Current-base results above supersede historical baselines.

Earlier browser checks verified Nature/Advanced Materials Apply, Cancel and one-step Undo/Redo.
Cell's current official submission page and linked figure guide were read in the actual browser
when the research fetcher returned 403. Cell's picker/source/column controls were observed after the
build, but the interrupted follow-up did not establish completed Cell browser Apply/Undo; do not
claim it as done without a new observation. Current hands-on results will be recorded below.

## Final browser observation (2026-10-22)

Launched the rebuilt browser preview from `apps/desktop` with
`node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 5174 --strictPort`.
Observed `contribution [codex/journal-formatting-presets]`, build `10.22.20.00-codex`, base `b1325d5`.
Created a sample benzene through the actual canvas UI. Edit > Journal Presets loaded the optional
pack and displayed twenty approved journals, without the five omitted entries. Cell's preview
enabled Apply; applying set `journal.cell@1.0.1`. One Undo reported `Undid Apply Journal Preset`;
Redo reported `Redid Apply Journal Preset`. Opening a Nature Chemistry draft and cancelling retained
`journal.cell@1.0.1`. A screenshot of the final Cell picker is in the local review evidence package.
This verifies browser behavior only, and does not remove the native-platform limitations above.
