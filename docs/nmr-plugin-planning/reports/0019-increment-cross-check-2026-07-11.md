# Report 0019 — M24: additive-increment second opinion for low-confidence ¹H

**Date:** 2026-07-11
**Worktree:** `~/Documents/programming/chemdraw-nmr` @ `codex/nmr-plugin`
**Decision:** [ADR-0022](../decisions/0022-increment-cross-check.md)

## Ask

User (comparing against ChemDraw): where a HOSE prediction is very low confidence, fall back to a
ChemDraw-style increment predictor — especially when the two disagree. Chosen design: **replace by
default** (absolute/2σ threshold) with a **toggle** to show both + flag.

## Built (commit `102d9e18`)

- **M24a — increment estimator** (`incrementEstimator.ts`): aromatic H = 7.26 + Σ o/m/p increments;
  aliphatic = Shoolery `0.23 + Σσ`; aldehyde/vinyl reuse coarse bases. Uses the OCL ring set for
  o/m/p position. Validated: nitrobenzene 8.21/7.43/7.59 (lit 8.2/7.5/7.7), ethylbenzene CH₂ 2.55
  (lit 2.65), benzaldehyde ring 7.48–7.82.
- **M24b — cross-check** (`OclHosePredictor`): low-confidence peaks (sphere ≤ 1 / n < 3) get an
  increment estimate + `disagrees` = |median − inc| > **max(0.4 ppm, 1.5σ)**. Percentage rejected (ppm
  is TMS-referenced). Rule-estimated peaks now use the increment value. Contract/schema:
  `NmrResonance.crossCheck { incrementPpm, disagrees }`.
- **M24c — UI**: figure-peak `alternativePpm` (plugin-api); composer sets it + writes `… · vs inc N`
  in the table (always transparent). `LinkedFigureView` gains `toRenderPeaks(mode)` +
  an **"Uncertain peaks: Prefer increment | Show both"** select; default replaces the disagreeing peak
  (drawn at the increment ppm, `ᵢ` label, brown), toggle draws both. Modal inherits the choice.

## Verification

`pnpm lint` clean; `pnpm test` → **1380 passed** (+6); web + Tauri build OK. End-to-end: disagreements
fire on genuine outliers (naphthylpropanal benzylic CH 2.03 vs 2.87; dichloroacetophenone CHCl₂ 6.12 vs
6.99) and stay silent where the methods concur. Build stamp `7.9.14.23-opus`.

## Honest limits (accepted, ADR-0022)

CH₃ Shoolery runs low; fused-PAH aromatic increments are approximate. Both are the low-confidence regime
already. Threshold constants are one-line tunable. The increment is a rule estimate, labelled as such.
