# Standalone offshoot handoff

## Update to 1.1.0 main (2026-11-03)

- Merged `jgassens/main` at `8c27d4819df011c2e313b877f7f5796e045cfc1e`,
  including the published 1.1.0 version and update feeds. No release assets are republished.
- Preserved both the offshoot and current table/clipboard/template features when resolving
  conflicts in MainWindow, imports, exports and package documentation. Opening an offshoot,
  table-alignment, arrangement or Copy As flyout closes its siblings; a DOM regression covers this.
- Build stamp: `11.03.12.30-codex`. Native Rust files match current main.
- Local validation is sequential: root TypeScript passed with a bounded 4 GiB Node heap.
  The first attempt hit Node's default 2 GiB heap limit. All 406 tests in 11 focused files passed with
  `--maxWorkers=1 --no-file-parallelism`; project timeout settings are unchanged.
- Production web build, Rust formatting and `git diff --check` passed locally.
- First CI run `41693759962`: Windows passed all checks; Linux passed 14,737 tests but
  failed two existing label glyph-tightness assertions; macOS was cancelled. The Linux runner
  image changed from main's successful run earlier that day. The glyph test now explicitly
  loads one explicit font: Arial on macOS/Windows, Liberation Sans on Linux (installed by
  CI). No per-label system-font scan remains, and all assertions are unchanged. The original
  local glyph run timed out on font scans; all 18 tests passed after this fix with one worker.
- Fresh Linux/macOS/Windows CI is required before merging PR #201. Native hands-on checks
  and a packaged launch remain unverified on both platforms.

## Earlier standalone work

- Branch/worktree: `codex/offshoot-main-only` in `ChemDraft-offshoot-main`.
- Base: `jgassens/main` commit `20112a1` (fetched 2026-10-25).
- Replaces PR #201's stacked branch with a standalone offshoot change. Shared offshoot helpers
  were extracted from committed sources; no working-directory edits were copied.
- Excluded: #200 optional arrangement arrows and #202 formatted reaction conditions, their
  dialogs, preferences, native changes, rendering changes, and tests. Existing main's compound
  layout behavior remains in place. The original failing arrangement test is not part of this diff.
- Original working tree `ChemDraft` and its uncommitted changes are untouched.
- Validation: `pnpm lint` and 115 focused offshoot/direct-edit tests passed.
  The default full run completed with 422 passing, 18 failing and 7 skipped files
  (8,788 passing, 156 failing, 69 skipped tests); failures began with timeouts and included
  cascading React DOM errors. All 18 failing files subsequently passed across reruns:
  16 with two workers, the toolbar suite alone at its normal limit, and all 58 PDF tests
  with one worker and a local `--testTimeout=15000` diagnostic allowance. Project/CI timeout
  settings are unchanged. Do not describe the default full run as green.
- Web build: `pnpm --filter @chemdraft/desktop build:web` passed. No packaged build or application launch yet.
- Native Rust checks were not run locally; Rust files are unchanged from main.
- Delivery target: existing PR #201, branch `codex/offshoot-arrows`. Require fresh Linux/macOS/Windows CI.
  Native macOS/Windows hands-on checks remain unverified; use the Arrow offshoots section in
  `docs/manual-stress-checklist.md`.
- The previous stacked PR head is preserved locally as `codex/offshoot-stacked-backup`
  at `90ba5467355cb521a5f64293f37eeeb885a8baf1`. Update the existing PR branch with an exact
  force-with-lease guard, never an unconditional force push.

For a packaged preview, run this yourself in VS Code's integrated terminal:

```sh
cd "/Users/emily/ChemDraft Repository/ChemDraft-offshoot-main"
./run-app
```

Expected worktree label: `ChemDraft-offshoot-main [codex/offshoot-main-only]`.
This preview remains unverified until the new app is launched and checked. A fresh testing thread
can start from this handoff without carrying the earlier stacked-branch context.
