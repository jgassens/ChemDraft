# Assignment 08: Strip bundled NMR from the union — the core-only ChemDraft

- **Status:** ready to issue
- **Milestones:** M39 (STATUS.md → "Milestones"); Phase 3 of `PLAN-plugin-separation.md` (the user's
  "TestBranch")
- **Depends on:** M38 / `reports/0033-runtime-union-merge-2026-07-16.md` + its 2026-07-17 GUI-pass
  addendum (the union works end-to-end, install→predict→uninstall verified by hand)
- **Next:** Phase 4 — the from-zero GUI install test on this build (driven by the control room, not by
  you); Phase 2 — SDK publishability prep. Do **not** start either.

## Where you work

Worktree `~/Documents/programming/chemdraw-plugin-union`, currently on `merge/plugin-union` @
`2d9bdef1` (verify; tree must be clean — if a push retry left anything odd, report). Create branch
**`core-only`** from it and work there. You MAY commit on `core-only` (no pushes; never touch
`merge/plugin-union`, `main`, or `codex/nmr-plugin`).

## The goal

A ChemDraft that **does not know the NMR plugin exists** — no bundled registration, no source, no
workspace dependency, no NMR chunks in the built bundle — while the **entire plugin system remains
fully functional**, because Phase 4 will install `nmr-predictor-0.0.0.zip` into exactly this build and
every NMR feature must come back through the installer alone.

## Remove (and prove removed)

1. `examples/plugins/nmr-predictor/` — the whole directory. (History is safe: the plugin's full history
   lives on `codex/nmr-plugin`, from which the standalone repo will be subtree-split in Phase 6.)
2. `@chemdraft/plugin-nmr-predictor` from `apps/desktop/package.json` (and any other package.json);
   regenerate the lockfile.
3. The NMR entries in `apps/desktop/src/plugins/registerBundledPlugins.ts` (descriptor, worker factory,
   imports). Mass-fragment and molscribe stay (D-16).
4. `apps/desktop/src/plugins/workers/nmrPredictorPluginWorker.ts` (the static worker entry) and
   `apps/desktop/src/plugins/nmrWorkerClient.ts` if it exists there — plus any other desktop file whose
   only purpose is the bundled NMR plugin. Investigate before deleting anything shared.
5. NMR-specific tests that exercise the *bundled* plugin. Tests of generic machinery that merely use NMR
   as a fixture must be **re-pointed at mass-fragment**, not deleted — the M35/M36 packaging and
   packaged-load suites especially (`plugin:package`/`loadPackagedPlugin` must remain fully tested using
   `examples/plugins/mass-fragment-demo`).

## Keep — this is where the test's value lives; deleting any of it invalidates Phase 4

- **The entire generic report renderer, including `LinkedFigureView` and `spectrumExport`**
  (copy-PNG/SVG + JCAMP). They render a generic `linkedFigure` report section; the *installed* NMR zip
  will need them. If the linked figure dies with the bundled plugin, the installed plugin loses its
  figure and Phase 4 fails.
- The worker bridge, installer, staging FS, serving hook (JS + Rust), manager UI, panel
  controller/surface/window, panelBridge, native menu sync, toolset stage, storage, patch tray.
- Mass-fragment + molscribe bundled and working.
- `tools/plugin-extract` and `tools/plugin-package` (they operate on `examples/plugins/*` paths that
  still exist — mass-fragment remains their in-repo test subject).

## Proof of removal (each is an acceptance criterion)

1. `grep -ri "nmr" apps/desktop/src packages tools --include="*.ts" --include="*.tsx" --include="*.rs" --include="*.json"`
   → only hits that are *generic* (e.g. none, or clearly-generic identifiers you justify one by one in
   the report). No `@chemdraft/plugin-nmr-predictor` anywhere.
2. The **built bundle** (full `pnpm build`) contains **no** `nmrWorker-*`, **no** `OclHosePredictor-*`,
   and **no** ~6 MB database asset; report the dist file list sizes before/after.
3. The running app's Analyze menu shows **no NMR items** (assert via the menu-model tests; the GUI look
   happens in Phase 4).
4. Mass-fragment still predicts (its tests + the packaged-load equivalence test now running on
   mass-fragment).
5. `pnpm lint`, `pnpm test`, `pnpm build` green; report the final test count vs the union's 1,807 and
   enumerate every deleted/re-pointed test file with one-line justifications.
6. `pnpm plugin:package -- examples/plugins/mass-fragment-demo` still produces a valid package on the
   committed tree.

## Final report

For verbatim archiving as `reports/0034-core-only-strip-2026-07-17.md`: what was removed (file list);
what was kept and why; every grep hit from criterion 1 with its justification; the dist-diff proving the
chunks are gone; test-count reconciliation (union 1,807 → core-only N, with the delta itemized);
deviations; risks; and confirmation that Phase 4's install test is ready to run against this build.
Commit(s) on `core-only` listed with hashes. Stop after M39.
