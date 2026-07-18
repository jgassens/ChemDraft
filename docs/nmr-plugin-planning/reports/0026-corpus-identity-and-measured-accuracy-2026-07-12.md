# Report 0026 — M30+M31: bundled DB reproduced with recorded identity; measured accuracy in the panel

**Date:** 2026-07-12
**Worktree:** `~/Documents/programming/chemdraw-nmr` @ `codex/nmr-plugin`, commit `79f7a691` (pushed)
**Build stamp:** `7.12.10.22-fable`
**Builds on:** M28 (reproducible rebuild), M29/ADR-0026 (benchmark)

## Milestones completed

- **M30:** the bundled `nmrshiftdb2.database.json` was regenerated from the raw corpus through the
  M28 pipeline, and the result **proves reproducibility**: all 40,024 entries are byte-identical to
  the 2026-07-09 artifact. The artifact's provenance now records its identity for real:
  `inputSha256 831a31e78b004a308c7c40989e27d30698a34c506e722a91c78b6ed448fc4720`,
  `inputBytes 284380903`, `minObservations 5`, `rawEntryCount 529738`.
- **M31:** the report's Reference-database section now displays the held-out benchmark error for the
  nuclei present in the result — e.g. *"Measured accuracy (¹H): median |Δ| 0.17 ppm
  (high 0.079 / medium 0.17 / low 0.48) — held-out benchmark, 2026-07-12"* — so users see measured
  error, not just tier names.

## The honesty mechanism (M31)

The claim is **checksum-gated**. `OclHosePredictor` emits a new optional `backend.dataChecksum`
(= the active database's `provenance.inputSha256`); the composer shows the accuracy rows only when
it equals `MEASURED_ACCURACY.corpusSha256` in `providers/ocl/measuredAccuracy.ts` (values
transcribed verbatim from the seed-1 run JSON, `reports/0025-benchmark-seed1.json`). Consequences:

- A database rebuilt from **any other corpus silently drops the claim** until the benchmark is rerun
  and the constants updated — an accuracy figure can never outlive the data it was measured on.
- The fixture provider (no checksum) and schema-v1 payloads from older sessions (optional field)
  never show the claim.
- Only nuclei actually present in the result get a row (a ¹³C-only report makes no ¹H claim).

## Correction to report 0025

Report 0025's caveat said the upstream export had "grown" to 64,710 records vs 49,628. That compared
two different counters: 64,710 is records with a molfile + assignments (benchmark parser); 49,628 is
structures that contributed ≥1 usable nucleus-mapped assignment (compiler). The M30 rebuild from the
same download produced the identical 529,738 raw environments / 49,628 structures / 40,024 entries —
**the corpus is the same export the bundled artifact was always built from.** The benchmark numbers
therefore describe exactly the shipped database's corpus, which is what makes the M31 gate exact.
(Corrected in place in report 0025.)

## Verification actually run

- Entry-level byte comparison of old vs regenerated artifact: **identical** (40,024/40,024).
- New tests: bundled-provenance test pins `dataChecksum` and prune metadata; composer tests cover
  the shown claim (matching checksum, per-nucleus) and the dropped claim (foreign/absent checksum).
- Strychnine and all other regressions unchanged. `pnpm lint`, `pnpm test` (**1,480 passed,
  9 skipped**), desktop `vite build` green; NMR worker chunk 7,555,923 B (+~150 B for the constants).
- `docs/architecture/nmr-prediction-data.md` updated with the reproduction result and the gate.

## Unresolved risks

- The benchmark is one seed on NMRShiftDB2-like chemistry; the panel line names the date and
  held-out protocol but a user can still over-generalize it to exotic chemistry.
- When the upstream export next changes, the refresh workflow is: rebuild (checksum embeds
  automatically) → rerun `run-benchmark.ts` → update `measuredAccuracy.ts` from its JSON. Until the
  last step the panel simply shows no accuracy line — safe, but easy to forget; the workflow is
  documented in the architecture doc.

## Next milestone

None queued. Optional future: multi-seed benchmark variance, and a solvent-aware corpus slice if
NMRShiftDB2's solvent tags prove reliable enough to condition on.
