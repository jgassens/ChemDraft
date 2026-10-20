# Resizable floating toolbar prototype

Local design prototype on `resizable-palettes-prototype`, integrated with upstream `085d99d`.
This is awaiting review, not a shipped slice.

- Preferences offers **Resizable floating toolbars**, off by default. Disabled toolbars follow
  main's original sizing behavior, ignore saved frames and show no Rotate button or grip.
  Enabling the preference opts into the following behavior.
- Untouched toolbars keep main's content-fit sizing and
  layout; toolbars without a declared/grid size keep their native opening frame.
- A genuine resize switches to a constrained viewport. Button grids wrap within the available
  width; saved orientation controls their direction rather than the frame's aspect ratio.
  Authored spacers, explicit slots and grid widgets retain their layout and scroll rather than
  being repacked. Rotate is available only for actual grids and transposes their real dimensions.
- Control widgets stay together as readable sections. Their minimum frame width is the smaller
  of 320 logical points and the original frame width, with a 96-point floor. Smaller viewports
  scroll instead of squeezing or hiding slider/input rows. Minimum height is 56 points.
- The bottom-right grip uses native resize dragging on Windows. Tauri's macOS backend does not
  support that API, so macOS uses captured pointer deltas in logical points. Native window edges
  remain resizable on both platforms.
  The grip keeps layout stable during dragging and saves once on completion; cancellation does
  not save. Native edges are observed through Windows size-loop and AppKit live-resize events.
- User frames persist per toolbar under `chemdraft.palette.frame.v1.<toolsetId>` in the dev app's
  local storage. Legacy prototype frame keys do not change fresh defaults. Invalid frames fall
  back to the original layout; dimensions are logical points and restoration clamps to the
  available screen without overwriting the user's remembered frame.
- Restore defaults clears the selected toolbar's saved and live frame; Reset All clears all
  toolbar frames. Dialog frame resets commit on Apply; Cancel preserves them and rolls back the
  existing live layout preview.
- Programmatic content-fit and DPI changes never save a user frame. Native eligibility rejects unknown
  callers, suspension, quitting, and minimized palette frames, including owner minimization on
  Windows. Main's shared suspension, native ownership, and offscreen recovery are retained.
  New native permissions are granted to exact toolset window labels, excluding flyouts/tooltips.

The standing [manual checklist](manual-stress-checklist.md) includes the resizing pass, control
usability, customization, mixed DPI, monitor loss, dialogs, restart, minimize, and quit.
The subsequent verification pass was authorized by the user on 2026-10-20. Tests exposed and
corrected a no-movement grip event bubbling into the window-drag handler and an SSR-time read of
`window`. The native permission cross-check now inspects the actual runtime capability builder,
including its exact toolbar window scope.

Windows verification:

- `pnpm.cmd lint`: passed, including the repeat performed by the production build.
- `pnpm.cmd vitest run --maxWorkers=4 --silent`: 351 files passed, six skipped;
  7,198 tests passed, 34 skipped, no failures or unhandled errors.
- `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check`: passed after formatting.
- `cargo clippy --all-targets --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings`: passed.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`: 320 passed, after correcting the
  capability test's assumption that all grants must be static.
- `pnpm.cmd --filter @chemdraft/desktop build:web` and `pnpm.cmd build`: passed; the latter produced
  MSI and NSIS dev installers under `apps/desktop/src-tauri/target/release/bundle/`.
- `node scripts/smoke-windows-menu-churn.mjs --exe <worktree>/apps/desktop/src-tauri/target/release/chemdraft.exe`:
  four launches, 100 rounds, clean exits, zero crash events.
- A temporary local DevTools probe confirmed `can_persist_toolset_size` is allowed in a real toolbar
  and denied in the document window. Observed stamp: `10.20.13.00-codex`,
  `ChemDraft [resizable-palettes-prototype]`, `80deea39+dirty`.

Diagnostic runs before the final green suite: the initial seven-file regression run had 129 passing
assertions but one unhandled grip event error; the two affected files then passed all 55 tests
cleanly. The initial unconstrained full run had 115 failures (including the SSR defect and
resource-sensitive timeouts/performance assertions) and two worker RPC timeouts. The 12-file rerun
with two workers passed 839 tests with one timeout and one skip; that remaining tabs file passed
all 191 tests in isolation. The final four-worker run above passed the entire suite without
changing test timeouts or weakening assertions.

The optional OPSIN Java runtime is absent in this dev build, as reported by the build script.
Native macOS builds/checks and hands-on Windows resize, mixed-DPI monitor and minimize/restore
checks remain unverified. No commit or push was performed.
