# Electron-mark verification

Branch: `codex/reposition-electron-marks`. The feature started directly on upstream main
`20112a1`; latest upstream main `ecb104e` was subsequently merged at the owner’s request.
Verification: 2026-10-25–26. No unrelated PR branches were included.

## Automated results before the main update

- `pnpm vitest run --maxWorkers=1 --minWorkers=1`: 435 files passed, seven files skipped;
  8,944 tests passed, 34 skipped. Three raster tests in `packages/export-engine/src/pdf.test.ts`
  exceeded their default five-second limit. This initial run was not green.
- Reran the complete PDF, layout-engine and Art toolbar suites with one worker and
  `--testTimeout=20000`: all 58 PDF, 135 layout-engine and 27 toolbar tests passed.
  The three raster tests took roughly six seconds each on this host.
- `electronMarkStress.test.ts`: eight cases passed. Each variant repeats 30 size, thickness,
  resize and native serialization/reopen cycles (240 cycles total). The checks compare complete
  molecule data, mark identity, atom anchors, stored thickness, dimensions and object counts.
  Radical-ion dots and lone-pair dots must remain separate at the tested extremes.
- The full run includes all 131 canvas-layer tests, 571 document-workflow tests, pointer/drag
  suites, agent-bridge and drawing-tool tests, plus macOS/Windows parameterized DOM tests.
- `pnpm lint`: passed.
- `git diff --check`: passed.
- Rust formatting and all-target clippy with `-D warnings`: passed.
- Native Rust suite: 543 passed, eight ignored; the fake-sidecar protocol fixture failed
  during the combined run. Its exact isolated rerun passed (one test, 0.87 seconds).

## Visual checks and corrections

Rendered all eight symbol variants at 18, 60 and 108 px with default, minimum and maximum
thickness. The first render exposed overlapping lone-pair dots and radical dots touching
charge signs at large thickness. The corrected geometry keeps the pair separated and fits
single-charge radical-ion dots and signs inside the symbol frame. Inspected the corrected PNG.
The rendering check uses the same layout/export implementation as the canvas.

## Verification after merging main `ecb104e`

- The merge preserved main's timing-probe startup function and set the build stamp to
  `10.26.09.01-codex`. That was the only merge conflict.
- Seventeen focused suites passed: 968 tests covering the canvas layers, Art toolbar,
  eight-variant stress checks, app shell, agent bridge, drawing tools, layout engine,
  plugin canvas overlay and the new performance-probe integration.
- Root type checking and Rust formatting passed on the merged tree.
- The entire repository suite was not repeated. Additional native test/build reruns were
  not performed after this merge. The native build, clippy and Rust results below apply to
  the feature before the main update; they are not a native sign-off of the merged tree.

## Native verification

`CARGO_BUILD_JOBS=1 ./run-app` built and launched the packaged macOS app successfully.
`pnpm running-build` confirmed `10.25.12.01-codex`, label
`ChemDraft [codex/reposition-electron-marks]`, identifier
`org.chemdraft.desktop.dev.chemdraft`, from
`app/ChemDraft (dev).app`. The stable app was left untouched.
These results precede the subsequently requested merge of newer upstream main.

The native UI automation service failed to start, including after retrying. Real WKWebView
pointer capture, native palette focus, file dialogs and live Undo/Redo have therefore **not**
been verified by this pass. No Windows host was available; WebView2 native checks remain
unverified. Parameterized DOM tests do not replace those checks.

The first unrestricted test run ended without a final result after the editor crash. Its
results were discarded. The replacement run used one worker. The cause of the VS Code crash
was not established.

Before merging this PR, run the electron-mark items in `manual-stress-checklist.md` in the native
macOS and Windows apps and obtain green CI.
