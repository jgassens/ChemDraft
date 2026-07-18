# Report 0022 — M26: low-confidence spectrum label suppression

**Date:** 2026-07-11  
**Worktree:** `~/Documents/programming/chemdraw-nmr` @ `codex/nmr-plugin`  
**Build stamp:** `7.11.17.49-codex`

## Milestone completed

M26 is complete. Low-confidence predicted peaks still render as muted/dashed spectrum curves and remain hoverable, but their numeric labels are no longer printed above the spectrum. The same shifts remain labeled on the molecular drawing below the spectrum.

## What changed

- `LinkedFigureView` now skips the SVG `<text>` peak label for peaks whose confidence is `"low"`.
- The peak group, curve styling, line count metadata, and transparent hover target are preserved, so the peak remains visible and interactive.
- Molecular shift annotations are unchanged; low-confidence labels still appear on the structure where the local atom mapping gives useful context.
- The DOM regression test now checks all three pieces together: muted curve present, spectrum label absent, molecular label retained.

## Files changed for M26

- `apps/desktop/src/plugins/LinkedFigureView.tsx`
- `apps/desktop/src/plugins/LinkedFigureView.dom.test.ts`
- `AGENTS.md`
- `apps/desktop/src/MainWindow.tsx`
- `STATUS.md`
- `reports/0022-low-confidence-spectrum-labels-2026-07-11.md`

## Architecture decisions

1. This is a display-only change. The predictor payload, confidence semantics, export metadata, and analysis storage are unchanged.
2. Low-confidence peaks stay visible as curves because removing them would imply the prediction was omitted rather than lower-confidence.
3. Molecular labels remain the preferred place to show low-confidence numeric values because they tie the estimate to the atom environment without cluttering the spectral trace.

## Deviations from `PLANS.md`

- The canonical plan ends at M12. M26 is a user-directed presentation follow-up, recorded in `STATUS.md` and this report rather than renumbering the original plan.
- No new chemistry behavior, provider behavior, or plugin API contract was added.

## Dependencies

No dependencies were added, removed, or upgraded.

## Verification actually run

- `pnpm exec vitest run apps/desktop/src/plugins/LinkedFigureView.dom.test.ts`: **25 passed**.
- `pnpm lint`: passed.
- `pnpm test`: **1,469 passed, 9 skipped** across 111 test files.
- Labeled `pnpm build` with `CHEMDRAFT_WORKTREE_LABEL='chemdraw-nmr [codex/nmr-plugin]'`: Vite, release Rust binary, `.app`, and DMG produced.
- Built web assets contain `7.11.17.49-codex` and `chemdraw-nmr [codex/nmr-plugin]`.
- Native release binary contains `chemdraw-nmr [codex/nmr-plugin]`.
- `hdiutil imageinfo .../ChemDraft_0.0.0_aarch64.dmg`: passed on the approved outside-sandbox retry; UDZO, CRC32-checksummed, compressed, 17.4 MB file.
- `git diff --check`: passed.

### Commands that failed or needed retry

- The first targeted DOM test run was interrupted by the user before completion; the rerun passed.
- `pgrep -fl 'vitest|vite-node|pnpm exec vitest'` failed because the sandbox could not access macOS process listing (`sysmond service not found` / `Cannot get process list`).
- `hdiutil imageinfo apps/desktop/src-tauri/target/release/bundle/dmg/ChemDraft_0.0.0_aarch64.dmg` failed in the sandbox with `Device not configured`; the approved outside-sandbox retry passed.
- Vite retains the existing large-chunk warning; it does not fail the build.

## NMR implementation status

- **Active predictor:** `chemdraft.ocl-hose`; version/data version `nmrshiftdb2.nmredata.sd`.
- **Increment estimator:** `chemdraft.h1-additive-increment` v1.3.0.
- **Data provenance:** NMRShiftDB2 full NMReDATA export, retained aggregated bundle used by the OCL-HOSE adapter.
- **Synthetic values:** only the fixture provider is synthetic. Active HOSE values aggregate measured references; increments are disclosed rule calculations.
- **Supported nuclei:** 1H and 13C; additive-increment comparison is 1H-only.
- **Unsupported chemistry:** unsupported or unmatched environments continue to warn/omit rather than fabricate values.
- **`nmr-predictor`:** previously evaluated and rejected; not installed.
- **Bundling:** no duplicate OpenChemLib issue was introduced.

## Assumption discrepancies

None for this slice. The grey peaks were confirmed to be provider-marked low-confidence predictions, not increment-table alternatives.

## Unresolved risks

- Low-confidence spectrum values now require looking at the molecular drawing or table rather than the spectrum label itself.
- Scientific accuracy remains unvalidated against an independent holdout benchmark.
- Database rebuild reproducibility still needs explicit `n >= 5` pruning and a raw-input checksum.
- The app/DMG are local development artifacts, not signed or notarized release artifacts.

## Next milestone

The recommended next maintenance slice remains database rebuild reproducibility: enforce/test the documented `n >= 5` prune and record the raw NMReDATA input checksum.
