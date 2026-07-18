# Report 0020 — M17b: source-backed substituent-correction refinement

**Date:** 2026-07-11  
**Worktree:** `~/Documents/programming/chemdraw-nmr` @ `codex/nmr-plugin`  
**Build stamp:** `7.11.14.15-codex`  
**Decision:** [ADR-0023](../decisions/0023-source-backed-increment-refinement.md)

## Milestone completed

M17b is complete. The additive ¹H estimator is now version 1.2.0, source-backed for its
alpha/beta/gamma aliphatic model, conservative about applicability, available for both weak and
high-dispersion HOSE matches, and presented as a visible second opinion with HOSE as the default.
This closes the broader M17 accuracy/applicability milestone.

## What changed

### Scientific estimator

- Added `protonIncrementTable.ts` with separate CH4/CH3/CH2/CH bases and exact alpha/beta/gamma
  substituent rows from Beauchamp-Marquez (1997).
- Correctly distinguishes alkyl/aryl carbonyls, acids/esters, aryloxy/acyloxy groups, primary
  amine/amide contexts, acid chlorides, and distance through three saturated carbons.
- Preserved the accepted approximate fused-carbocyclic PAH comparison while rejecting fused
  heteroaromatics.
- Rejects out-of-table rings, imines, S/Si groups, peroxides, epoxides/cyclic ethers, carbonates,
  anhydrides, carbamates, sulfonamides, unsupported amine/amide substitution, noncanonical charged
  N/O groups, isotopes, and radicals. Unsupported environments are omitted with a reason; they do
  not receive a fabricated generic shift.
- Removed the former rule-estimate `standardDeviationPpm = 0.5`; the paper's approximate reliability
  statement is not a measured standard deviation.

### Cross-check policy and presentation

- A ¹H HOSE resonance may carry a comparison for weak applicability or high reference dispersion
  (`sigma >= 0.50 ppm`). Corpus audit: 1,212 of 10,461 sphere-2-or-deeper ¹H entries meet that
  dispersion trigger.
- HOSE remains `deltaPpm`, the default plotted value, and the default JCAMP export. The selector is
  **Shift comparison: Prefer HOSE | Show both (ᵢ = increment)**.
- The table always shows `vs inc X.XX`. Notices summarize whether applicable increment-table
  calculations are in general agreement, mixed, or not in general agreement with HOSE, and identify
  high-dispersion eligibility.
- Generic `linkedFigure` comparison labels are now provider-owned. The NMR plugin supplies the terms;
  desktop rendering/copy/export stays reusable for another method pair.

### Honest method and schema handling

- All-rule, mixed HOSE/rule, zero-result, fixture, and non-HOSE model reports now receive distinct,
  accurate method labels/disclaimers. Solvent context appears only when a HOSE resonance contributes.
- Canonical nitro N+/O- is no longer mislabeled as unsupported ionic chemistry, while noncanonical
  charged N/O structures remain rejected.
- New estimator/reason metadata remains optional when reading schema-v1 results, so older session
  payloads still parse; current producers always write full provenance.
- Added exact rule-parameter sources to `THIRD_PARTY_NOTICES.md` and architecture docs.

## Files changed

- **Estimator/provider:** `protonIncrementTable.ts`, `incrementEstimator.ts`, `oclTopology.ts`,
  `OclHosePredictor.ts`, `functionalGroupFallback.ts`.
- **Domain/application/report:** NMR contracts/schemas/warnings, normalization/status/worker paths,
  `composePredictionReport.ts`.
- **Generic desktop surface:** plugin API linked-figure comparison metadata, linked-figure rendering,
  copy/JCAMP export, panel controller/surface integration, styles, and focused tests.
- **Documentation/build identity:** NMR README, third-party notices, architecture docs, worktree label
  plumbing, and synchronized build stamp.

## Architecture decisions

1. HOSE remains the primary scientific value; an increment is a disclosed comparison, never a
   silent winner.
2. Applicability is allow-listed by chemical class. A missing table mapping returns no estimate.
3. High dispersion is an eligibility heuristic only; database sigma remains database provenance and
   is never assigned to a rule estimate.
4. Provider names live in plugin data, not the generic desktop renderer.
5. Schema-v1 compatibility is preserved with optional read-side metadata while current producers are
   tested to emit exact estimator ID/version/method.

## Deviations from `PLANS.md`

- The original M1-M12 plan has no detailed M17b prompt. M24 had already implemented the first weak-
  match increment comparison, so M17b refined and completed that path rather than creating a parallel
  predictor.
- The user explicitly reversed ADR-0022's increment-first figure default. ADR-0023 records the new
  HOSE-first default while preserving show-both and transparent table behavior.
- No leakage-free accuracy benchmark was claimed: the raw NMReDATA source corpus is not present in
  this checkout. Verification used primary source tables, invariance/applicability tests, and a
  read-only bundled-corpus dispersion audit.

## Dependencies

No dependencies were added, removed, or upgraded. The implementation reuses the existing
`openchemlib ^9.22.1`; no duplicate OpenChemLib runtime was introduced.

## Verification actually run

- `pnpm lint` — passed.
- Focused M17b/plugin/API/desktop tests — passed (121 tests in the final focused run; independent final
  audit also passed its 90-test counterexample set).
- `pnpm test` — **1,459 passed, 9 skipped** across 111 test files.
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` — **39 passed**.
- Labeled `pnpm build` with `CHEMDRAFT_WORKTREE_LABEL='chemdraw-nmr [codex/nmr-plugin]'` — Vite,
  release Rust binary, `.app`, and DMG produced. The label was verified in both the native binary and
  bundled web asset.
- `hdiutil imageinfo .../ChemDraft_0.0.0_aarch64.dmg` — passed; UDZO image is checksummed and readable
  (CRC32), 17 MB on disk.
- `git diff --check` — passed.

### Commands that failed

- The first sandboxed `pnpm build` reached the `.app` but failed in `bundle_dmg.sh`; macOS disk-image
  device access is blocked in the sandbox. The approved outside-sandbox rerun produced and validated
  the DMG.
- Sandboxed `hdiutil imageinfo` failed with `Device not configured`; the approved outside-sandbox
  validation passed.
- `codesign --verify --deep --strict` fails on the raw Tauri output because it is linker-signed ad hoc
  with no sealed app resources. Signing/notarization was not requested and was not performed.
- Vite reports the existing large-chunk warning; it does not fail the build.

## NMR implementation status

- **Active predictor:** `chemdraft.ocl-hose`; version/data version `nmrshiftdb2.nmredata.sd`.
- **Data provenance:** NMRShiftDB2 full NMReDATA export, 49,628 atom-assigned structures and 40,024
  retained aggregated environment entries; nmrshiftdb2 Database License (ODbL-derived).
- **Synthetic values:** only the deterministic fixture provider is synthetic. The active HOSE values
  are aggregated experimental reference shifts; v1.2 comparisons/fallbacks are explicitly rule data.
- **Supported nuclei:** ¹H and ¹³C. The v1.2 additive comparison is ¹H-only.
- **Unsupported chemistry:** any environment without an explicit database match or allow-listed rule,
  including the conservative exclusions listed above, is warned and omitted.
- **`nmr-predictor` evaluation:** completed and rejected in M11; it would introduce old duplicate OCL
  through `openchemlib-extended` and a remote database dependency. It is not installed.
- **Bundling:** no duplicate OCL issue. The NMR worker is about 7.55 MB and contributes to the existing
  Vite large-chunk warning.

## Assumption discrepancies

1. The queued M17b description implied weak-class comparison still needed implementation, but M24 had
   already shipped that first half; this slice refined it in place.
2. The bundled database contains no `n < 3` entries (all retained entries have `n >= 5`), so the sparse
   branch does not activate in production data. High dispersion is the meaningful added eligibility.
3. The bundled database metadata says environments were pruned to `n >= 5`, but the current rebuild
   code does not itself enforce that pruning step. Rebuilding from the raw dump is therefore not yet
   guaranteed to reproduce the shipped size/content.

## Unresolved risks

- This is not an independent scientific validation. Fused-PAH aromatic corrections and the coarse
  aldehyde/vinylic/alkynyl representative values remain approximate and are labelled accordingly.
- `sigma >= 0.50 ppm` is a transparent heuristic, not a confidence probability or accuracy guarantee.
- Database rebuild reproducibility needs an explicit `n >= 5` pruning implementation, test, and raw-
  input checksum before the next corpus refresh.
- The local `.app`/DMG are development artifacts, not signed or notarized release artifacts.

## Next milestone

No numbered NMR feature milestone remains queued. The recommended next bounded maintenance slice is
**database rebuild reproducibility**: implement/test the documented `n >= 5` prune and record the raw
NMReDATA input checksum before any database refresh. It was not implemented in this milestone.
