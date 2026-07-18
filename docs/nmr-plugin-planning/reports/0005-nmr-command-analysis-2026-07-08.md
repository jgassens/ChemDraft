# Report 0005: NMR command + analysis integration (M8) — 2026-07-08

Assignment: M8 (executed inline this session). Worktree `~/Documents/programming/chemdraw-nmr`, branch `codex/nmr-plugin`. Build stamp `7.8.8.42-opus`.

## Outcome

**Milestone 8 complete — NMR prediction now works end-to-end in the app.**
Selecting a molecule and choosing **Analyze → Predict ¹³C NMR Shifts** runs the
fixture provider (in a worker where available, in-thread otherwise), writes an
`nmr.forward-prediction` record to the generic analysis store, and shows the
result in the declarative panel. Failures and cancellation surface uniformly.

Full path, wired and tested:

```text
Analyze menu (¹³C default / ¹H experimental, ADR-0011)
  → command handler → validate selection (exactly one molecule)
  → map selection → ChemicalStructureInput (reject unknown)
  → worker-backed (or in-thread) predictor
  → analysis.write(nmr.forward-prediction: complete/partial/failed)
  → declarative panel report (provenance + shift table + notices + synthetic disclaimer)
  → PluginCommandResult; desktop surfaces ok:false and thrown errors alike (ADR-0010)
```

Validation (all run):
- `pnpm lint`: clean.
- `pnpm test`: **1296 passed, 9 skipped, 96 files** (was 1279/9/93 → +17 tests, zero regressions).
- `pnpm --filter @chemdraft/desktop build:web`: success (~16s); `nmrWorker-*.js` chunk present.
- Native `tauri build`: not run (gated).

## What shipped

Plugin package `application/`:
- `mapSelection.ts` — `mapSelectedMoleculeToPredictionInput` (snapshot → narrow input, reject unknown/empty as a command error), `toCommandError`, `isCancellationError`.
- `determineAnalysisStatus.ts` — `complete` / `partial` (no-match/partial warning) / `failed` (no resonances).
- `workerPredictor.ts` — `createWorkerBackedPredictor(client)`: adapts `NmrWorkerClient` to `NmrPredictor` (initialize-once capabilities; forwards `sourceFingerprint`).
- `predictSelectedStructure.ts` — the orchestration returning `PluginCommandResult<NmrPredictionResult>`; writes the analysis record; cancellation writes nothing and leaves the panel.
- `register.ts` — `createNmrCommandHandlers` (¹³C + ¹H handlers).

Plugin package `report/composePredictionReport.ts` — `composePendingReport` / `composePredictionReport` (keyValue provenance + shift table + notices + synthetic-data disclaimer) / `composeErrorReport`. Declarative only; stick-spectrum SVG is M9.

New command error codes: `NMR_PERMISSION_UNAVAILABLE`, `NMR_NO_SELECTED_STRUCTURE`, `NMR_MULTIPLE_SELECTED_STRUCTURES`.

Desktop:
- `registerBundledPlugins.ts` — registers `nmrPredictorManifest` with the command handlers; picks a worker-backed predictor when `Worker` exists, else an **in-thread `FixtureHosePredictor`** fallback (graceful degradation, mirrors the conformer client's in-page fallback).
- `nmrWorkerClient.ts` — `createNmrWorkerClient` now returns `NmrWorkerClient | null` (null without `Worker`), and `getNmrWorkerClient()` too.
- `usePluginRuntime.ts` — `invokePluginCommand` returns the handler result; added `pluginCommandFailure()` helper.
- `MainWindow.tsx` — plugin-command dispatch inspects the resolved value and surfaces `{ ok: false }` in the status bar (**ADR-0010 implemented**), in addition to thrown errors.

Tests (+17): `predictSelectedStructure.test.ts` (8: permission/selection guards, unknown format, happy path + record write, partial, cancellation writes nothing, provider failure, ¹³C/¹H handler wiring), `determineAnalysisStatus.test.ts` (3), `composePredictionReport.test.ts` (3), `workerPredictor.test.ts` (2), and a MainWindow integration test (both NMR menu items in Analyze, no-selection click is safe, plugin listed in diagnostics).

## Decisions / deviations

- **In-thread fallback added** (small, justified): the fixture provider is fast and deterministic, so when `Worker` is unavailable (exotic webviews, jsdom tests) the desktop runs it in-thread rather than failing. This also lets the feature be exercised in the MainWindow DOM test.
- **ADR-0010 resolved & implemented**: status is `accepted` → now shipped. The desktop surfaces both failure channels.
- The full MainWindow **happy-path** panel (selecting a molecule, seeing the shift table) is proven at the command level (real `FixtureHosePredictor` + fake context asserting the record write and the two panel reports); the DOM test proves registration + menu + safe routing without the cost of scripting a molecule selection.

## Unresolved risks / carried forward

1. **Staleness (D-09) + `onPanelClosed` (ADR-0012) + stick spectrum** are M9. The analysis record already carries `source.sourceFingerprint`, so staleness has its input.
2. The ¹H path is wired and labeled experimental; it shares the fixture DB, so ¹H coverage is as narrow as the fixtures.
3. Worker chunk ~1.16 MB (OCL), lazy — revisit at M10 if it matters.

## Next milestone

M9: the declarative NMR panel — stick-spectrum SVG + polished prediction table
+ the report `source` ref for staleness (D-09) + `onPanelClosed` cancellation
(ADR-0012) + "Run again". Not started.
