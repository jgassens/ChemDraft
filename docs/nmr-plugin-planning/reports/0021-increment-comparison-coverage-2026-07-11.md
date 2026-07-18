# Report 0021 — M25: increment comparison availability, coverage, and CH2 disclosure

**Date:** 2026-07-11  
**Worktree:** `~/Documents/programming/chemdraw-nmr` @ `codex/nmr-plugin`  
**Build stamp:** `7.11.17.12-codex`  
**Decision:** [ADR-0024](../decisions/0024-applicable-increments-always-visible.md)

## Milestone completed

M25 is complete. Every chemically applicable 1H increment-table value can now accompany its HOSE
prediction, HOSE remains the default, the comparison selector stays visible in an explained disabled
state when no values apply, notices report comparison coverage conservatively, and stereogenic CH2
sites disclose possible proton nonequivalence without inventing separate shifts.

## What changed

### Predictor and scientific policy

- Removed HOSE confidence/dispersion as a visibility gate. The bounded estimator is now evaluated for
  every matched 1H host; only its existing chemistry applicability checks can suppress a value.
- Preserved the disagreement rule `abs(HOSE - increment) > max(0.4 ppm, 1.5 sigma)` and the 0.50 ppm
  broad-reference flag as interpretation metadata.
- Added `routine-applicability` beside the existing weak/high-dispersion comparison contexts.
- Advanced additive-increment provenance to v1.3.0; the v1.2 source-backed constants are unchanged.
- Added `NMR_POTENTIALLY_DIASTEREOTOPIC_HYDROGENS` for CH2 sites in a constitutionally stereogenic
  molecule. It is informational and never splits a carbon-hosted resonance.
- Added a permanent strychnine regression: HOSE 5.84 ppm remains primary and the applicable 5.70 ppm
  vinylic increment is carried as a non-disagreeing comparison.

### Report and desktop presentation

- Every 1H HOSE linked figure declares provider-owned `HOSE` / `increment` comparison labels, even
  when zero peaks have an alternative value.
- The desktop always shows the comparison state for that report. No alternatives produces a disabled
  **HOSE only — increment not applicable** selector; applicable values produce **Prefer HOSE** and
  **Show both (i = increment)**.
- A rerun resets stale show-both state safely when comparison availability changes.
- Notices report `compared / HOSE` coverage. Fewer than three values or less than 50% coverage receives
  a limited-comparison statement and no general-agreement conclusion.
- The orange comparison legend appears only while alternatives are visible. Alternative curves are
  dashed orange, alternative structure annotations have their own orange text, and the blue/magenta/
  red structure legend explicitly identifies HOSE confidence.
- JCAMP export normalizes stale show-both requests to HOSE-only when no alternatives exist; copied SVG
  visibly records HOSE-only versus HOSE-plus-increment mode and carries matching machine-readable
  comparison metadata, without claiming an orange series that is absent.

## Files changed for M25

- Predictor/domain: `OclHosePredictor.ts`, `incrementEstimator.ts`, NMR contracts, schemas, and warnings.
- Report: `composePredictionReport.ts`.
- Generic surface: plugin API comparison documentation, `LinkedFigureView.tsx`, `spectrumExport.ts`,
  `App.css`.
- Tests: predictor, report, worker serialization, linked-figure DOM, export, and estimator provenance.
- Documentation/build: NMR README, prediction architecture docs, `AGENTS.md`, and `MainWindow.tsx`.

## Architecture decisions

1. Applicability controls availability; HOSE confidence and dispersion control interpretation.
2. `spectrum.comparison` declares capability/labels; `alternativePpm` remains the per-peak availability
   source of truth. No redundant availability boolean was added.
3. HOSE remains primary in storage, rendering, and default export.
4. Limited comparison coverage cannot support a molecule-wide agreement claim.
5. Potential diastereotopic behavior is disclosed, not predicted.

## Deviations from `PLANS.md`

- The canonical plan ends at M12. M25 is another user-directed follow-up, recorded in `STATUS.md`
  rather than renumbering or rewriting the original sequence.
- ADR-0023 deliberately gated comparisons to weak/high-dispersion HOSE matches. The user-directed
  requirement supersedes that eligibility rule while retaining its HOSE-first presentation.
- The absent dropdown was verified as eligibility filtering, not an old packaged build or missing UI
  implementation.
- A benchmark and true diastereotopic shift prediction remain outside this bounded slice.

## Dependencies

No dependencies were added, removed, or upgraded. The implementation continues to use the existing
`openchemlib ^9.22.1`; no duplicate OpenChemLib runtime was introduced.

## Verification actually run

- Focused predictor/report/API/UI/export tests: **138 passed**, followed by a final focused regression
  run of **73 passed** including strychnine.
- `pnpm lint`: passed (also rerun by the production build).
- `pnpm test`: **1,469 passed, 9 skipped** across 111 test files.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`: final rerun **39 passed**.
- Labeled `pnpm build` with `CHEMDRAFT_WORKTREE_LABEL='chemdraw-nmr [codex/nmr-plugin]'`: Vite,
  release Rust binary, `.app`, and DMG produced.
- Native binary contains `chemdraw-nmr [codex/nmr-plugin]`; built web/NMR-worker assets contain the
  M25 build stamp and new comparison/warning strings.
- `hdiutil imageinfo .../ChemDraft_0.0.0_aarch64.dmg`: passed; UDZO, CRC32-checksummed, 17.4 MB.
- `git diff --check`: passed.

### Commands that failed or needed retry

- The first Rust suite run had one unrelated process-sensitive engine3d sidecar test fail while 38
  passed. The test passed alone, and the complete rerun passed all 39.
- The first sandboxed Tauri build produced the web bundle, release binary, and `.app` but macOS denied
  the DMG helper. The approved outside-sandbox rerun produced both bundles successfully.
- Vite retains the existing large-chunk warning; it does not fail the build.

## NMR implementation status

- **Active predictor:** `chemdraft.ocl-hose`; version/data version `nmrshiftdb2.nmredata.sd`.
- **Increment estimator:** `chemdraft.h1-additive-increment` v1.3.0; source-backed table values plus
  explicitly identified coarse aldehyde/vinylic/alkynyl class heuristics.
- **Data provenance:** NMRShiftDB2 full NMReDATA export, 49,628 atom-assigned structures and 40,024
  retained aggregated entries; nmrshiftdb2 Database License (ODbL-derived).
- **Synthetic values:** only the fixture provider is synthetic. Active HOSE values aggregate measured
  references; increments are disclosed rule calculations.
- **Supported nuclei:** 1H and 13C; increment comparison and diastereotopic disclosure are 1H-only.
- **Unsupported chemistry:** any environment outside the explicit increment tables remains
  inapplicable; unmatched unsupported environments are warned and omitted.
- **`nmr-predictor`:** previously evaluated and rejected; not installed.
- **Bundling:** no duplicate OCL issue. The NMR worker remains about 7.56 MB and participates in the
  existing Vite large-chunk warning.

## Assumption discrepancies

1. The source and release asset already contained the dropdown; visibility was controlled by data.
2. Strychnine had one applicable vinylic increment, but the former 0.50 ppm gate hid it because its
   HOSE spread was 0.47 ppm.
3. CH2 nonequivalence can be disclosed from stereogenic topology, but this provider cannot honestly
   predict separate diastereotopic values.
4. No independent accuracy benchmark exists, so limited coverage cannot justify general agreement.

## Unresolved risks

- This remains unvalidated scientifically against an independent holdout set.
- Applicability is conservative and will leave many fused/bridged environments HOSE-only.
- The CH2 warning may be broad: it identifies possible nonequivalence, not a guaranteed measurable
  shift separation.
- Database rebuild reproducibility still needs explicit `n >= 5` pruning and a raw-input checksum.
- The app/DMG are local development artifacts, not signed or notarized release artifacts.

## Next milestone

The recommended next maintenance slice remains database rebuild reproducibility: enforce/test the
documented `n >= 5` prune and record the raw NMReDATA input checksum. A separate future scientific
milestone may add the assigned experimental benchmark; neither was implemented here.
