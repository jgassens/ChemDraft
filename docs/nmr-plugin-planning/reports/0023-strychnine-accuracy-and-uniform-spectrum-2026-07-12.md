# Report 0023 — M27: strychnine accuracy check + confidence-free spectrum trace

**Date:** 2026-07-12
**Worktree:** `~/Documents/programming/chemdraw-nmr` @ `codex/nmr-plugin` (uncommitted)
**Build stamp:** `7.12.8.56-fable`
**Decision:** [ADR-0025](../decisions/0025-confidence-free-spectrum-trace.md)

## Milestone completed

M27 is complete. (a) The predicted strychnine ¹H spectrum was scored against the experimental SDBS
spectrum (No. 7596, CDCl₃). (b) Per user direction, the plotted spectrum no longer encodes
confidence: every peak draws as the same solid labeled curve; confidence stays in the structure
labels, table, and notices. Method provenance (rule-estimated grey-dash, alternative orange-dash)
still restyles the trace.

## Accuracy: predicted vs SDBS experimental (strychnine, ¹H)

Predictor run directly against the bundled corpus (median statistic, same path the app uses).
Experimental values are SDBS No. 7596 resolved peaks plus the standard strychnine assignment.

**Methines (6):**

| predicted | HOSE evidence | experimental | Δ (pred − exp) |
|---|---|---|---|
| 1.28 | sphere 2, n 5, σ 0.49 | 1.27 (H-13) | +0.01 |
| 2.71 | sphere 1, n 715, σ 1.01 (low) | 3.15 (H-14) | −0.44 |
| 4.27 | sphere 1, n 204, σ 0.96 (low) | 4.28 (H-12, OCH) | −0.01 |
| 4.60 | sphere 2, n 29, σ 0.54 | 3.93 / 3.85 (H-16 / H-8) | ≈ +0.7 |
| 4.70 | sphere 1, n 245, σ 0.96 (low) | 3.85 / 3.93 (H-8 / H-16) | ≈ +0.8 |
| 5.84 | sphere 2, n 6, σ 0.47; increment 5.70 agrees | 5.89 (H-22, vinylic) | −0.05 |

**Methylenes (6, predicted as one 2H line each vs the diastereotopic pair average):**

| predicted | experimental pair (avg) | Δ vs avg |
|---|---|---|
| 4.08 | 4.14 / 4.06 (4.10, H-23 OCH₂) | −0.02 |
| 3.20 | 3.71 / 2.74 (3.22, H-20) | −0.02 |
| 3.00 | 3.21 / 2.87 (3.04, H-18) | −0.04 |
| 2.84 | 3.12 / 2.66 (2.89, H-11) | −0.05 |
| 1.89 | 2.35 / 1.45 (1.90, H-15) | −0.01 |
| 1.84 | 1.88 / 1.88 (1.88, H-17) | −0.04 |

**Aromatics (4):** predicted 7.65 / 7.41 / 7.35 / 7.10 vs experimental 8.09 / 7.25 / 7.16 / 7.09 →
Δ −0.44 / +0.16 / +0.19 / +0.01. The peri-amide H-4 (8.09) is systematically underpredicted; its
match is sphere 3 but n 12, σ 0.69.

**Summary:** 10 of 16 lines within 0.05 ppm; 12 of 16 within 0.2 ppm; three real misses —
the two bridged N-CH methines (+0.7…0.8) and H-14 (−0.44), plus the peri-aromatic (−0.44).
Median |Δ| ≈ 0.045 ppm. The three worst misses are exactly the peaks the confidence system had
marked lowest (sphere-1 matches with σ ≈ 1 ppm): the signal was right, the presentation was the
problem. Caveats: methylene pair centroids hide the real diastereotopic spread (e.g. H-15 at
2.35/1.45 appears as one line at 1.89), which is why the calculated spectrum looks sparser between
2.3–3.7 ppm than the measured one; this is exactly the disclosure the M25 CH₂ warning makes.
This is a one-molecule spot check, not the leakage-free benchmark (still future work).

## What changed (code)

- `LinkedFigureView.tsx`: peak groups/curves no longer take an `is-low-confidence` class; the
  numeric spectrum label is always rendered (M26 suppression removed); `CurveStyle` reduced to
  `trusted | estimated | alternative`; the spectrum note drops "muted = lower confidence" and names
  grey-dash = rule-estimated only when such a curve is present.
- `App.css` / `spectrumExport.ts`: `is-low-confidence` styles removed in-app and in the standalone
  copied SVG; the exported note matches the in-app note logic (estimated/alternative named only when
  present).
- Structure-label confidence coloring (good/medium/rough + legend), the table Confidence column,
  notices, and all ADR-0023/0024 comparison behavior are unchanged.
- Tests updated: the M26 suppression test is inverted into the M27 contract (uniform trace, label
  always present, molecular quality classes still assert confidence coloring); cross-check and
  standalone-SVG tests updated to the confidence-free trace.

## Verification actually run

- Scratch predictor run on strychnine against the real bundled DB (source of the table above);
  scratch test deleted afterwards.
- `pnpm lint` — passed.
- `pnpm test` — **1,469 passed, 9 skipped** across 111 test files.
- `vite build` (web) — passed; OCL remains out of the desktop main bundle (worker chunk unchanged).
- Build stamp `7.12.8.56-fable` synchronized in `MainWindow.tsx` and `AGENTS.md`.

## Deviations / notes

- M26 shipped 2026-07-11 and is reverted by user direction one day later; report 0022 stands as the
  record of what M26 did. Both changes are honest states — the user chose where confidence renders.
- Everything in the worktree (M17b/M25/M26 + this M27) remains **uncommitted**; branch tip is still
  `102d9e18`. Commit/push was offered and not yet requested.

## Next milestone

Unchanged from report 0021/0022: database rebuild reproducibility (`n ≥ 5` prune + raw-input
checksum), and separately a leakage-free assigned-shift benchmark to turn spot checks like this one
into a real accuracy claim.
