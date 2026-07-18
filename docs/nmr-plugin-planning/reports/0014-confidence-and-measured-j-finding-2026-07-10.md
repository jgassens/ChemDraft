# Report 0014 — Accuracy milestone kickoff: measured-J data finding + confidence tier (M17a)

**Date:** 2026-07-10
**Worktree:** `~/Documents/programming/chemdraw-nmr` @ `codex/nmr-plugin`
**Decision:** [ADR-0020](../decisions/0020-measured-j-needs-np-mrd-confidence-from-applicability.md)

## Context

User picked the next milestones as "measured couplings" (option 1) + "prediction accuracy" (option
2), order at my discretion. Grounding option 1 in the actual data reordered the work.

## Finding that reordered the plan

NMRShiftDB2's NMReDATA export (the corpus we already bundle) has **no J magnitudes**:

- `NMREDATA_1D_1H` = shift + label only.
- 2D blocks = correlation networks (COSY/HSQC/HMBC/HMQC/NOESY/TOCSY); COSY gives coupling *partners*,
  not J.
- Zero `Hz`/`J=` coupling constants in the whole file.

So "measured J from data in hand" is impossible; measured J needs **NP-MRD** (CC BY-NC) — a dedicated,
license-gated ingestion milestone (M18), not a quick mine. Order becomes **2 (accuracy) before 1
(measured J)**. Also found: option 2's dispersion (±σ) was **already** surfaced — the real gap was the
*applicability* signal (sphere depth + n).

## What shipped — M17a (commit `7e190a55`)

A per-peak **Confidence** column in the predicted-shifts table, derived only from data the predictor
already computes:

- `high · s4, n=42` — deep, specific environment with a healthy reference population.
- `med · s2, n=5` — moderately supported.
- `low · s1, n=509` — a shallow (1-sphere) match is generic no matter how many share it.
- `est.` — rule-estimated (never a database match).

Thresholds mirror the existing `LowHoseSphereMatch` (sphere ≤ 1) and `SmallReferencePopulation`
(n < 3) notices, so the column and the notices never disagree. No engine change, no new data.

Real spread confirmed end-to-end via the bundled DB: ethylbenzene reads mostly `high`; ibuprofen's
benzylic CH shows `low(s1,n=509)` — the honest signal a chemist needs.

## Files

- `examples/plugins/nmr-predictor/src/report/composePredictionReport.ts` — `confidenceLabel` + column
- `.../tests/composePredictionReport.test.ts` — tier coverage + updated row shape
- `apps/desktop/src/MainWindow.tsx` — build stamp → `7.9.14.11-opus`

## Verification

`pnpm lint` clean; `pnpm test` → **1346 passed**; web + Tauri build OK.

## Next

- **M17a2** (queued, optional): reflect low/estimated confidence in the linked figure.
- **M17b** (queued): substituent-correction refinement for the weak/high-dispersion classes the
  confidence work exposes.
- **M18** (queued, research): NP-MRD measured-J feasibility — the real "measured couplings" path;
  needs a user-approved download + a CC BY-NC redistribution decision.
