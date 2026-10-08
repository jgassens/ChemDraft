# pKa system review (Kimi, 2026-08-03)

**Process note:** Claude was live in this tree during the review. Files changed under me three
times (forest cvMae 1.252 → 1.208, fixture regenerated, prose updated, a stray `sigma_table.json`
deleted). I edited nothing — two agents writing the same files is how divergence happens. Everything
below is against the final snapshot: **all 182 pKa tests pass.**

## The strategy, as built

- **Site location**: Dimorphite-DL's 41-entry SMARTS table, values stripped after measuring them
  worse than predicting the dataset mean (2.77 vs 2.33 MAE). Table locates, never values.
- **Site valuation**: a random forest trained in-house on 3,031 per-site labels extracted from
  Dwar-iBond acid/base microstate pairs — clean provenance, no inherited predictor output.
  **cvMae 1.21** on Murcko-scaffold-grouped folds (honest grouping, hard-won), vs 2.94 baseline.
  92 features under a strict parity rule: everything computable identically from MinimalLib's
  Kekulé JSON, including a hand-rolled Hückel aromaticity (`pkaAromaticity.ts`) and site-centered
  radial context. Python↔TS parity pinned by a 10-molecule fixture.
- **Second method**: Hammett LFER from literature constants (nothing fitted to Dwar-iBond), reaches
  85 sites, MAE 0.158. Inverse-MAE-weighted consensus: 0.158 — but the real prize is the interval:
  cross-method disagreement tracks error at r = 0.88 and yields intervals **6.3× tighter than the
  model's at 92% coverage**.
- Acidic/basic transitions reported separately; basic values computed on the protonated microstate;
  metals declined outright (measured: zero metal structures in 1.57M rows of open pKa data);
  unactivated amine N-H acidity withheld (zero of 3,031 labels).

The honesty machinery — vendored training scripts, calibration-pairs recomputed by tests, parity
fixtures, decline-with-reason — is the best thing about it.

## Issues found

1. **`expect(...).toBeLessThan(cvMae + 1)` is a self-referencing gate**
   (`ionization.real.test.ts:412,415`). If the model regresses, the tolerance widens and the test
   stays green — the exact opposite of a regression test. It was added to absorb a real event:
   histidine's amine went from 9.03 (old model) to ~10.47 (new model) vs ChemAxon's 9.25. That is a
   single-site move within global noise, but the right response is to pin the value absolutely
   (parity-fixture style) and *look* at the regression, not widen the gate.
2. **Prose contradicts the shipped calibration** (`pkaModel.ts:247,256`): "1.5 because that is the
   multiplier whose coverage is closest to a conventional ~80% interval" — but `calibration.json`
   measures 90.2% at 1.5×sd (77.2% at 1.0×). Either the multiplier or the comment is wrong; in this
   repo, that class of mismatch is a bug.
3. **Training intermediates are untracked and unignored**: `pka.X.npy` (2.2 MB), `pka.y.npy`,
   `pka.meta.json` (469 KB), `__pycache__/`. Nothing in `.gitignore` covers them. `pka_calibrate.py`
   needs them — fine, but make it deliberate: commit with a note, or gitignore and document
   regeneration.
4. **No single pipeline entry point.** `pka_labels.py → pka_train.py → pka_calibrate.py →
   consensus_calibrate.py` (+ fixture emission) are run by hand; nothing proves the forest,
   calibration, consensus figures, and parity fixture all derive from the *same* feature-code
   version. During my review the fixture and forest were regenerated minutes apart — precisely the
   train/serve skew the fixture exists to catch, one level up. A 10-line `run_all.sh` closes it.
5. Stale figures in historical prose: PLANS.md:414,421,423 still carries 1.62-era r-values
   (0.84/0.42) in what reads like current narrative; minor, since §399-402 is now correct.

## Suggested improvements, prioritized by accuracy per unit effort

1. **Try gradient-boosted trees against the forest — cheap, likely 10–20% MAE.** A GBM is a
   weighted sum of trees plus a base score: the existing JSON-weights evaluator (`evaluateTree`)
   extends in ~15 lines, no new runtime, same parity-fixture discipline. Sweep it on the same
   Murcko folds and keep whichever wins; the forest can stay as the disagreement-interval source.
   This is the only remaining "free" model-class upgrade that respects the ship-in-TypeScript
   constraint.
2. **Extend the LFER family — the consensus interval is your crown jewel, and it reaches 2.8% of
   sites.** Add anilinium (ρ ≈ 2.9) and pyridinium (ρ ≈ 5–6) Hammett series, and Taft σ* for
   aliphatic carboxylic acids. Every new series compounds the value of machinery already built
   (`shellKey`, decline-with-reason, parity fixture) and extends the 6.3×-tighter interval to
   common chemistry. Requires widening `estimateHammettPka`'s site gate from O-only to N.
3. **Locally-calibrated (conformal) intervals instead of global 1.5×sd.** Quartile MAE spans
   0.38 → 2.31 — a fixed multiplier over-covers good sites and under-covers bad ones. Fit a
   monotone map sd → interval at target coverage on the 3,031 OOF pairs (isotonic or binned
   quantiles), ship it in `calibration.json`, recompute in `pka_calibrate.py`. Same honesty story,
   strictly better calibration.
4. **Per-site-type error breakdown in calibration output.** `calibration-pairs.json[i]` aligns by
   construction with `pka.meta.json` rows[i] — a few lines in `pka_calibrate.py` emits MAE by site
   type and by acidic/basic. This is what would have caught the histidine-amine move automatically,
   and tells users where the 1.21 actually lives (carboxyls vs tetrazoles).
5. **Vendor the external eval.** The Novartis+SAMPL n = 38 figure (1.24) is quoted in the contract,
   the header, and PLANS.md, but no script in the repo regenerates it — by your own rule, a number
   nobody can regenerate is a number nobody can check.
6. **Longer term**: protonation-state enumeration (already "still open" in PLANS.md) is the right
   answer to macro-pKa, and note Claude already measured and rejected the shortcut — recovered
   multi-microstate labels score 1.91 vs 1.17. If GBM isn't enough, site-centered ECFP counts are
   the next feature step; the cycle-walking infrastructure in `pkaAromaticity.ts` is most of the
   way there.

One suggestion for Claude directly: commit the current green state now. It is a coherent, tested
checkpoint (92-feature model, 1.21 MAE, all suites passing) and is currently scattered across
11 modified + 8 untracked files while still being edited.
