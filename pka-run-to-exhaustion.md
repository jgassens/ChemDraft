# Goal prompt: exhaust Codex's pKa matrix, report once at the end

Paste the block below as a single message. It is written to be re-pasteable: it restates every fact a
fresh session needs, so it works after a compaction or in a new session.

---

Work through **every remaining item** in `codex-suggestions.md` — the staged matrix (Stages 0–8), the
seven "experiments Claude missed", and the evaluation reset. Prove or disprove each one with a
measurement. **Do not stop to give me a progress update. Do not stop to ask a question. Do not stop
because of a licensing problem.** I want one report when the whole list is exhausted.

## What "exhausted" means

Already settled, do not redo: Stage 0 (frozen family-aware folds), Stage 1 (shells wins −0.0375, the
acid/base pair encoder is disproved twice), Stage 2 (AdamW survives; dropout, Huber, gradient clipping
and residual updates are dead), Stage 4 (forest blend disproved on the honest split), Stage 3's
sqrt-balancing half, and the interval-coverage gate on the leading arm.

Remaining, in this order — the order matters because compute is the binding constraint and I want the
most valuable things done first if you run out of runway:

1. **Export + parity path for shells, then every shipping gate.** This is first because it is a
   *falsification test*, not paperwork: shells has only ever been scored inside cross-validation, and
   H160 in this same tree won every scaffold-grouped fold (0.7281 → 0.7156) and then lost the external
   set (1.1286 → 1.1691). If shells has H160's relationship to held-out data, every later arm here is
   built on sand. Add an all-data 4-member train plus `pka_gnn.export()` to `pka_gnn_pair.py` behind a
   `shells: true` architecture flag; route `gnn_infer.py` on that flag; implement the features in
   `pkaGnn.ts` reusing the already-exported `distancesFrom` and `cyclesThrough` from
   `pkaAromaticity.ts`; regenerate the parity fixture with `gnn_parity.py`. Then run `external_eval.py`,
   `macro_validate.py`, artifact size, and desktop inference latency.
2. **Stage 3b — element/transition heads.** Never built. Shared trunk, per-element or per-transition
   heads. Full runs, not screens (see the noise floor below). Codex's gate: carbon improves ≥0.10 with
   overall regression <0.01.
3. **Stage 8 — quantile heads + conformalization.** Judge on coverage and sharpness, not MAE. The bar to
   beat is real and already measured: the leading arm's conformal intervals are
   0.428 / 0.604 / 0.936 at 67.6% coverage. A quantile head has to beat that, not the old
   0.492 / 0.666 / 0.975.
4. **Stage 6 — solvent-aware D2A multitask.** 4,445 nonaqueous rows across seven solvents are already
   reachable by the existing ingestion path. Solvent embedding or separate heads; every molecular family
   in one fold across all solvents. Gate: ≥0.05 carbon/neutral-acid gain with no aqueous regression.
5. **Missed-#7 — joint site detection and pKa learning.** Codex is right that every headline MAE here
   assumes the correct ionizing atom is supplied, and the product has to find it first. Site-existence
   and transition-class head; positives from the explicit acid/base pairs; hard negatives from other
   atoms in the same molecule; censored handling where only the strongest site is recorded. Report site
   precision/recall and full-pipeline accuracy separately from oracle-site MAE.
6. **Stage 5 — clean self-supervised / QM-auxiliary pretraining.** Split this in two and do the cheap
   half first: masked atom/charge/bond reconstruction and contrastive learning over equivalent SMILES
   and Kekulé forms need no download and can run on the corpus already on disk. Only then attempt QMugs
   (CC BY 4.0, ~665k molecules) if the download is feasible. Gate: ≥0.02 overall gain in nested CV *and*
   on external.
7. **Stage 7 — ChemAxon pseudo-label pretraining.** Codex's own research-only last arm. Run it as a
   measurement. See the licensing rule below.
8. **Evaluation reset.** Build the fresh locked test Codex demands: SAMPL6/8 and euroSAMPL with
   exhaustive family-overlap removal against pKaCHU, D2A, Dwar-iBond, QupKake, all calibration material
   and all pretraining structures — by normalized molecular family, not raw SMILES. Demote the 398-row
   set to development status in every file that describes it.

If step 1 kills shells, do not stop — **rebase** steps 2–7 onto acid-only, say so in the ledger, and
promote step 8 up the order, because that outcome means cross-validation is non-decisive in this tree
twice over.

## Licensing: document, never block

I will have legal resolve all of it afterwards. Your job is to make their job possible, not to make the
call.

- **Never stop, never ask, never decline an arm on licensing grounds.** Run it and record it.
- Maintain one `pka-provenance.md` with a row per corpus: upstream licence, what that licence actually
  covers (software vs data — QupKake's BSD is a *software* grant and the 4,022 experimental rows are
  upstream **CC BY 4.0**), whether it feeds the shipped corpus or is research-only, and the open question
  for legal.
- Fix the two statements that are currently wrong in text that reaches a user through
  `ionizationContract()`: the QupKake licence attribution, and Dwar-iBond's 3,031 rows being unresolved.
- Keep legal's decision open by keeping it off the shipped tree: weights or artifacts derived from an
  encumbered corpus (ChemAxon pseudo-labels, IUPAC CC BY-NC, unclarified D2A nonaqueous) land in
  `~/pka-runs/`, never in `packages/`. Do not add a redistributability claim to `NOTICE` for anything
  unresolved.

## Measurement discipline — this has been earned the hard way, do not relax it

- The frozen split only: `~/pka-runs/folds.json`. Never assign folds inline.
- Paired, **molecular-family-clustered** bootstrap CIs. A per-row standard error treats related
  measurements as independent and overstates certainty.
- **Screens resolve about 0.04 at best.** Measured: identical configs returned 0.7446 and 0.7322 on the
  baseline, and −0.0238 then +0.0076 for AdamW. Codex's ≥0.02 screen stop rule sits *below* its own
  screen's resolution. Any claim tighter than 0.04 — and anything about carbon, which is 449 rows —
  requires full 5-fold runs.
- Count per **atom**, never per bond. Kekulé invariance has shipped wrong five times in this repo.
- Anything that ships must compute identically in TypeScript and Python, and the parity fixture must be
  regenerated and passing. No feature ships without it.
- Report RMSE beside MAE every time. Every gain so far is in the body of the distribution — RMSE has not
  moved at all (1.2004 → 1.2015) — and I want to know the moment that changes.
- Background the long trainings and keep working; do not block a shell on a two-hour run.

## Keep a durable ledger as you go

Append to `pka-experiment-ledger.md` the moment each arm finishes — before starting the next one, so
nothing is lost to a context boundary. Per arm: name, config, N, MAE, RMSE, per-element MAE, the paired
family-clustered CI against its stated comparator, the verdict against Codex's promotion rule, wall
clock, and where the artifacts landed.

A negative result is a finished arm. Record it and move to the next one — do not surface it to me.

## Environment

- Python with torch 2.13 / rdkit / sklearn: `~/.venvs/chemdraft-pka/bin/python3`
- Runs and frozen folds: `~/pka-runs/`, existing arm outputs in `~/pka-runs/pairexp/`
- Harnesses: `pka_gnn_pair.py` (arms), `pka_gnn_screen.py` (screens), `pka_folds.py` (the frozen split),
  `pka_forest_oof.py`, all in `packages/rdkit-adapter/vendor/pka-model/`
- Nothing is committed and the shipped model artifacts are untouched. Keep it that way — no commits, no
  PR, no artifact replacement — until the final report.
- A Codex session shares this checkout. Verify the branch before any write, stage explicit paths, and
  preserve edits you did not make.

## The one report I want at the end

- A table of every arm ever run, with its verdict against Codex's own promotion rule.
- Which of Codex's claims held and which did not, in his numbering, so I can read it against his review.
- Whether a shippable candidate exists, and which of the eight final shipping gates it clears — with the
  external and macro numbers, not just cross-validation.
- What is still unmeasured and what it would cost.
- The provenance ledger and the open questions for legal.
- Plain English at the top. Bottom-line it before the tables.
