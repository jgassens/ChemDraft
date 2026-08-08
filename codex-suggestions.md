# ChemDraft pKa Predictor: Current Scientific Audit and Predictive-Power Plan

**Review date:** 2026-08-07

**Worktree:** `chemdraft-analyzers`

**Reviewed commit:** `715a544f`, plus Claude's uncommitted pKa experiments present in the worktree

**Scope:** code, artifacts, Claude's supplied analysis, datasets, dependencies, literature, licensing, evaluation design, and end-to-end chemistry

**Change made by this review:** this report only; the in-progress implementation files were not edited

## Executive conclusion

Yes. There is meaningful predictive power left to extract, but Claude's proposed priority order is wrong.

The highest-value missed signal is already in the repository: **8,074 of the 12,096 training rows contain an explicit acid-to-conjugate-base structure pair, but the GNN loader discards the base structure.** It trains on only the acid graph, a marked atom, and the pKa label. A shared-encoder acid/base-pair model would expose the charge redistribution, bond-order changes, and resonance stabilization that define deprotonation. That is a more direct and legally cleaner experiment than first teaching the model 1.55 million ChemAxon predictions.

The second major lever is site-relative representation. The current model has three message-passing layers and a global sum, so it has a weak description of where a substituent lies relative to the ionizing atom. Add topological distance-to-site encodings, radial shell pooling, and chemically relevant bond/atom features before adding width or depth.

The third requirement is statistical rather than architectural: the current 398-row external set has repeatedly selected models, so it is now a development set. Protonation/tautomer relatives also cross current folds. A new family-aware split and a fresh locked test are prerequisites for believing any claimed gain.

The recommended immediate experiment is therefore:

```text
frozen protonation/tautomer-family splits
  -> current acid-only GNN baseline
  -> + site-distance shells and chemistry features
  -> + shared acid/base encoder
  -> + both
  -> regularization and class balancing
  -> cross-fitted diverse ensemble
  -> fresh, never-touched external test
```

This can plausibly improve the site-level model. It will not by itself make the full product first-in-class: chemically valid protomer/tautomer state generation, representation invariance, site detection, and thermodynamic consistency remain separate release gates.

## What the current system actually is

The shipped artifact is not one 426,244-parameter network. It is an ensemble of **four independent 106,561-parameter members**, each with 96 hidden units and three message-passing layers. The ensemble total is 426,244 parameters.

The model's current inputs are sparse:

- atom element, formal charge, hydrogen count, degree, aromatic/ring flags, and one site flag;
- bond aromaticity, bond order, and ring membership;
- a three-bond learned receptive field; and
- a final concatenation of the site embedding with a global sum over atom embeddings.

The relevant implementation is [`pka_gnn.py`](packages/rdkit-adapter/vendor/pka-model/pka_gnn.py). Its `load` function reads `acid`, `acidAtomIdx`, and `pKa`; it does not read the row's `base` structure. Its training loop uses Adam, OneCycle scheduling, fixed 60 epochs, and L1 loss, with no weight decay, dropout, validation-based early stopping, gradient clipping, or residual/normalization path.

### Current numerical picture

| Measurement | Current result | Interpretation |
|---|---:|---|
| Training rows | 12,096 | pKaCHU 4,419; QupKake experimental 4,022; Dwar-iBond 3,031; D2A aqueous 624 |
| Rows with explicit conjugate-base structure | 8,074 | 66.7% of all labels; currently unused by the GNN |
| Scaffold-grouped out-of-fold MAE | 0.7281 | Useful development result, not end-to-end product accuracy |
| Dense pKa 2-12 subset | 11,350 rows; MAE 0.6665 | Explains the approximately 0.66 figure; it excludes difficult tails |
| Current 398-row external MAE | 1.1286 | Harder distribution; no longer a blind test because it has selected models |
| Carbon-centered rows | 449; MAE 1.456 | Only 3.7% of training and the clearest weak class |
| Nitrogen-centered rows | 6,789; MAE 0.726 | Dominates the corpus |
| Oxygen-centered rows | 4,669; MAE 0.663 | Better-supported class |
| Sulfur-centered rows | 189; MAE 0.669 | Small sample; estimate is unstable |
| Macro validation | 32 values on 15 molecules; MAE 0.2635 | Encouraging fixture result, much too small for a broad claim |

The tails are genuinely difficult: 95 observations below pKa 0 and 105 above 14 have very large errors. Reporting only 2-12 changes the question and makes the score look better; it does not improve the predictor.

## Review of Claude's six proposals

### 1. Pretrain on 1.55 million ChemAxon-labelled ChEMBL/QupKake structures

**Verdict: plausible research A/B, but not the first or cleanest experiment. The claimed 20-40% gain is unsupported.**

Large teacher-labelled pretraining has precedent. For example, pkasolver reported improvement after pretraining on hundreds of thousands of Epik-generated values and fine-tuning on experimental data. That establishes plausibility, not a transferable effect size, and the authors could not distribute the Epik-trained model because of licensing. See the [pkasolver study](https://www.frontiersin.org/journals/chemistry/articles/10.3389/fchem.2022.866585/full).

QupKake's large corpus contains ChemAxon-predicted strongest-acid/strongest-base values over ChEMBL structures. Fine-tuning does not erase the teacher's systematic bias or the provenance of the learned signal. ChEMBL itself is [CC BY-SA 3.0](https://www.ebi.ac.uk/chembl/), while ChemAxon's terms separately govern bulk calculated output; the QupKake software's BSD license is not evidence that those calculated labels are freely redistributable. The official [ChemAxon licensing material](https://docs.chemaxon.com/lts-krypton/reactor-licensing.html) is restrictive enough that redistributed weights should not be assumed clear without written permission.

Run this only after the clean experiments below, remove all benchmark-family overlap, label it as inherited-predictor pretraining, and obtain permission before distributing resulting weights.

### 2. Learn a residual against Hammett

**Verdict: very low remaining headroom. Keep Hammett as a specialist.**

Claude's numbers are stale. The current overlap is 342 sites, not 94. Hammett MAE is 0.2594, GNN MAE on those same sites is 0.5086, and the current consensus is 0.2394. The overlap is still only 2.8% of the 12,096-row corpus.

A cross-fitted per-series residual stack reached approximately 0.237 in this audit—only about 0.002 better than the existing consensus and well inside sampling/model noise. Extending chemically defensible Hammett/Taft series could broaden a transparent specialist method, but it is not the route to a large global gain.

### 3. Use “40,000+ DMSO pKas” as an auxiliary task

**Verdict: the stated data count is wrong; a smaller solvent-aware experiment is still worthwhile.**

The approximately 40,000 iBonD figure describes measurements across solvents, not 40,000 DMSO labels. The concrete source already integrated here is [D2A-pKa](https://zenodo.org/records/15277342): 8,241 values over eight solvents. This tree currently uses 624 aqueous rows and has 4,445 usable nonaqueous rows across seven solvents available to its ingestion path.

If the D2A authors confirm that downstream model redistribution is compatible with its incorporated iBonD/IUPAC material, train a solvent embedding or separate solvent heads and keep every molecule family in one fold across all solvents. This is most likely to help neutral and carbon acids. It will not supply the missing weak-base nitrogen chemistry.

### 4. Build an architecturally diverse ensemble

**Verdict: yes, but select weights inside cross-validation rather than on the external set.**

The GNN and forest have signed residual correlation of approximately 0.692, so some complementary error exists. A fixed 10% forest blend changed OOF MAE from 0.7281 to 0.7249 and the current external score from 1.1286 to 1.1034. That is a small but consistent signal.

The apparent optimum on the external set is closer to 30%, but choosing it there would overfit the test. A stronger design is two acid-only/site-shell members plus two acid/base-pair members, with any blending rule learned only on inner folds.

### 5. Use quantile regression

**Verdict: useful for uncertainty, not a likely point-accuracy improvement.**

The median quantile loss is the L1 loss the model already uses. Additional quantile heads can estimate asymmetry, but they do not repair representation, labels, or chemistry. They also still require grouped conformal calibration under scaffold shift. Judge this experiment on interval coverage and sharpness, not lower point MAE.

### 6. Purge extreme labels and audit scales

**Verdict: audit conditions aggressively; do not delete rows merely because the pKa is extreme.**

There are roughly 100 values on each side of the ordinary aqueous 0-14 range. Blind removal lowers the reported MAE because the hardest cases vanish, not because the model improves. Retain chemically legitimate strong-acid/base measurements. Quarantine only rows proven to use another solvent, acidity function, temperature/convention, or erroneous structure/site mapping.

Claude's current `carbon_prune.py` experiment reached the same broader lesson. Removing 100 carbon labels the deployed locator could not present made both the shared OOF set and the external score worse. Those labels were useful auxiliary chemistry even when they were not direct product queries.

## Highest-value experiments Claude missed

### 1. Shared acid/base-pair encoder

This is the best immediate bet.

For each mapped transition `HA -> A- + H+`, encode both structures with the same graph network and predict from:

```text
site state in HA
site state in A-
difference between those site embeddings
difference between pooled molecular embeddings
explicit changes in charge, hydrogen count, and local bond order
```

Conceptually:

```text
h_acid = encoder(acid graph, mapped site)
h_base = encoder(base graph, mapped site)
pKa = readout(h_acid, h_base, h_base - h_acid, transition features)
```

This directly represents the response to deprotonation. It should learn resonance and charge delocalization more readily than asking an acid-only network to infer a missing product state.

Implementation constraints:

- use one shared encoder, not separate acid/base networks;
- preserve atom mapping through normalization;
- add a reverse-pair/antisymmetry consistency test where chemically defined;
- keep the 4,022 acid-only QupKake experimental rows through an auxiliary acid-only head or generate only validated conjugate states—do not discard them;
- compare against a [Chemprop v2](https://github.com/chemprop/chemprop) reaction/multicomponent model offline as an MIT-licensed research baseline; and
- export or distill only a compact parity-tested model for the TypeScript runtime.

### 2. Site-distance encoding and radial pooling

The current one-hot site flag plus three message-passing layers communicates local chemistry only about three bonds. Global sum pooling says which atoms exist, but weakly says where a remote substituent sits relative to the ionizing site.

Add:

- shortest-path distance from every atom to the site, clipped at seven bonds;
- learned distance embeddings;
- pooled shells such as 0-1, 2-3, 4-5, and 6-7 bonds;
- electronegativity or directed bond-polarization features;
- hybridization and valence state;
- ring size rather than only a ring Boolean;
- molecular and local formal charge; and
- a parity-safe, task-specific conjugation definition.

The 2026 [pKaLearn paper](https://www.nature.com/articles/s42004-026-01983-y) is the strongest open architecture donor for these ideas. It reports that chemically relevant effects can extend to roughly seven bonds and emphasizes bond polarization, revised conjugation, and ring features. Use its design ideas; do not ingest its entire 12,817-row CSV without a row-level audit because it mixes DataWarrior/F1000Res lineage, Epik-generated rows, and SAMPL/euroSAMPL benchmark molecules.

Do not simply increase the message-passing depth to seven. The current depth sweep already showed little benefit, and deeper undifferentiated propagation risks oversmoothing. Distance features and shell pooling preserve location explicitly.

### 3. Regularization and training control

The wider H160 model improved every current CV fold but worsened the 398-row external score from 1.1286 to 1.1691. That is evidence that capacity is not the first bottleneck. The negative result is documented in [`BUILD.md`](packages/rdkit-adapter/vendor/pka-model/BUILD.md).

Run a small factorial screen before another capacity sweep:

- AdamW with modest weight decay;
- training-only dropout in the readout/message path;
- residual message updates and LayerNorm if TypeScript parity remains simple;
- an inner validation group for early stopping;
- gradient clipping; and
- L1 versus Huber loss.

Use the exact same frozen family folds and seeds. Stop any configuration that is already at least 0.02 MAE worse after two paired folds.

### 4. Class-balanced learning and specialist heads

Carbon is only 449 rows and has MAE 1.456. Test square-root inverse-frequency sampling or a shared trunk with element/transition-class heads. Do not use full inverse-frequency weighting; tiny classes would dominate training.

Also carry source quality into the loss. Traceable experimental pairs, software-assigned sites, and unresolved DataWarrior labels should not automatically receive identical trust. Preserve replicates and use their disagreement as label uncertainty rather than averaging away the evidence.

The in-progress carbon locator is valuable end-to-end work, but it does not solve the regression weakness by itself. Judge carbon experiments on the subset the product can actually locate as well as on all carbon labels.

### 5. Cross-fitted diverse ensemble

If the pair and shell models win independently, keep four runtime members but make them structurally diverse:

- two acid-only/site-shell members; and
- two acid/base-pair members.

Alternatively, retain a small forest contribution if its weight wins nested grouped validation. Require a paired, molecular-family-clustered confidence interval excluding zero before calling the blend better.

### 6. Clean pretraining and auxiliary physics

Before commercial teacher labels, pretrain on structures or clearly licensed physical targets:

- masked atom, charge, and bond reconstruction;
- local graph-context prediction around the eventual ionization site;
- contrastive learning across equivalent SMILES, Kekule forms, and allowed tautomers;
- deterministic RDKit descriptor auxiliary tasks; and
- quantum auxiliary targets such as partial charges, bond orders, or orbital/energy descriptors from an openly reusable corpus.

[Uni-pKa](https://pubs.acs.org/doi/10.1021/jacsau.4c00271) is a useful reference for microstate-free-energy learning and self-supervised atom/charge/3D tasks. Borrow the self-supervised ideas without importing its weak teacher-labelled target as experimental truth.

[QMugs](https://pmc.ncbi.nlm.nih.gov/articles/PMC9174255/) provides quantum-mechanical properties for roughly 665,000 drug-like molecules and about two million conformers under a CC BY 4.0 release. It is a defensible candidate for representation pretraining or auxiliary supervision, followed by experimental pKa fine-tuning. A practical goal is to distill any 3D/QM benefit into the existing 2D runtime representation rather than shipping a quantum engine.

D2A also contains gas-phase acidity and anion-solvation information. If its downstream rights are clarified, a multitask decomposition closer to

```text
gas-phase deprotonation energy + solvent stabilization -> solution pKa
```

is more chemically grounded than treating solvent identity as an arbitrary categorical label.

Claude's `qm_microstate.py` is an important negative result: B3LYP/6-31+G** with electrostatic continuum solvent badly under-stabilized glycine's zwitterion and would have selected the wrong model. Do not turn that level of theory into a gate. Better-solvation or cluster-continuum QM is a separate research project, not a parameter tweak.

### 7. Joint site detection and pKa learning

All current headline MAEs assume the correct ionizing atom is supplied. The product must locate the site first. A stronger end-to-end system should add a site-existence/transition-class head trained with:

- positive changed atoms from explicit acid/base pairs;
- chemically plausible hard-negative atoms in the same molecule;
- censored handling for records where only the strongest site is known; and
- invariant labels across atom ordering, equivalent protomers, and tautomers.

This may improve the user-visible answer even if oracle-site MAE stays unchanged. Report site precision/recall and full-pipeline pKa accuracy separately.

## Evaluation reset required before model selection

### The 398-row set is now development data

[`external_eval.py`](packages/rdkit-adapter/vendor/pka-model/external_eval.py) explicitly states that this figure settles retraining decisions and documents its use to reject H160. The atom-index remapping bug from the earlier audit has been repaired, but repeated model selection means the set is no longer “never used for fold selection” in the statistical sense. Rename it a development/external-check set and reserve a new final test.

Before using any new external source, deduplicate it against pKaCHU, D2A, Dwar-iBond, QupKake experimental data, all calibration material, and all pretraining structures by normalized molecular family—not only raw SMILES.

### Current folds leak molecular families

A HetAtomTautomer-family audit found 287 protonation/tautomer families, covering 590 rows, split across the current stable scaffold folds. The stable scaffold hash is reproducible, but it is not balanced: fold sizes range from approximately 1,637 to 4,314 because a single benzene scaffold contains 2,617 labels.

Build one frozen assignment that:

- groups protonation states, tautomers, resonance-normalized forms, equivalent SMILES, and all solvent measurements for a molecule family;
- keeps large scaffolds intact while balancing total rows and key site classes across folds;
- carries source and publication identifiers for leave-one-source-out checks;
- creates a distinct calibration partition for ensemble weights and intervals; and
- never changes when rows are added or removed.

Use paired, molecular-family-clustered bootstrap intervals. A per-row standard error treats highly related measurements as independent and will overstate certainty.

### Fresh final test

SAMPL6/8 and euroSAMPL are useful components only if their families are removed from every training and pretraining source. Because pKaLearn and other public compilations contain some of these molecules, “we did not load the SAMPL CSV” is not enough. A publication-time or source-held-out set of newly curated experimental values would be even stronger.

## Staged experiment matrix for Claude

| Stage | Experiment | Promotion rule |
|---:|---|---|
| 0 | Freeze balanced protonation/tautomer-family folds; audit source and benchmark overlap | Mandatory prerequisite |
| 1 | Current baseline vs `+distance shells` vs `+acid/base pair` vs `+both` | Promote if overall MAE improves at least 0.01 or a predeclared target class at least 0.05 on 4 of 5 paired folds |
| 2 | AdamW, dropout, early stopping, residual/normalization, L1 vs Huber | Stop candidates at least 0.02 worse after the first two frozen folds |
| 3 | Square-root class balancing and element/transition heads | Require carbon MAE improvement at least 0.10 with overall regression below 0.01 |
| 4 | Diverse four-member ensemble or inner-CV forest blend | Require clustered paired 95% confidence interval to exclude zero |
| 5 | Structure-only or QM-auxiliary pretraining | Require at least 0.02 overall gain in nested CV and on the fresh external test |
| 6 | Solvent-aware D2A multitask model | Require at least 0.05 carbon/neutral-acid gain with no aqueous or source-held-out regression |
| 7 | ChemAxon pseudo-label pretraining | Research-only last arm; remove benchmark overlap and disclose inherited predictor signal |
| 8 | Quantile heads plus conformalization | Judge coverage and interval width, not point MAE |

### Final shipping gates

Do not ship a new “more accurate” model unless it achieves all applicable gates:

- at least 0.02 absolute MAE improvement on a fresh locked microscopic-pKa test, or at least 0.10 on a predeclared weak class;
- molecular-family-clustered 95% confidence interval for the paired improvement excludes zero;
- no critical site class or source worsens by more than 0.05 MAE;
- macroscopic validation worsens by no more than 0.03;
- site-detection precision/recall does not regress;
- protonation/tautomer representation invariance does not regress;
- calibrated interval coverage does not regress; and
- artifact size and desktop inference latency remain inside a declared budget.

## Dataset and licensing recommendations

| Resource | What it can add | Recommendation |
|---|---|---|
| [pKaCHU](https://zenodo.org/records/20089807) | Explicit acid/base pairs, citations, replicates | Already contributes 4,419 rows. Exploit its pair and provenance fields; do not describe it as a new corpus lever. CC BY 4.0. |
| [D2A-pKa](https://zenodo.org/records/15277342) | Multi-solvent pKa, gas-phase acidity, solvation targets | Already contributes 624 aqueous rows; conditionally use 4,445 nonaqueous rows with solvent-aware heads after author/license clarification. |
| QupKake experimental subset / [Machine-learning-meets-pKa](https://github.com/czodrowskilab/Machine-learning-meets-pKa) | 4,022 current experimental labels | Keep, but record the upstream dataset's CC BY 4.0 rather than QupKake's BSD software license. Continue disclosing Marvin-derived site assignments. |
| Dwar-iBond | 3,031 current paired labels | Retain for research while resolving original citations and downstream reuse terms; use source-aware weighting and sensitivity tests. |
| [pKaLearn](https://github.com/MoitessierLab/pKaLearn) | Strong feature and architecture ideas | Use as an MIT code/design donor. Do not ingest all labels or weights without row-level provenance and benchmark-overlap audit. |
| [G-pKa](https://zenodo.org/records/15257975) | Tautomer-aware pairs and QM features | Contact the authors; the public record does not appear to contain all advertised artifacts. High value if complete and clearly licensed. |
| [QMugs](https://pmc.ncbi.nlm.nih.gov/articles/PMC9174255/) | Large open QM auxiliary corpus | Strong clean-pretraining candidate; CC BY 4.0. |
| [IUPAC Dissociation Constants](https://github.com/IUPAC/Dissociation-Constants) | Broad, condition-rich research evaluation | CC BY-NC: use for research analysis unless separate permission covers redistributed commercial-compatible weights. |
| QupKake 1.55M ChemAxon-labelled corpus | Broad pseudo-labelled chemical space | Last research arm only. Obtain written clearance before distributing weights and disclose teacher provenance. |
| SAMPL/euroSAMPL | High-quality challenge measurements | Reserve as never-train tests after exhaustive family-overlap removal. |

The root `NOTICE` and method contract currently need a data-license correction for the 4,022 QupKake experimental rows: the upstream dataset is CC BY 4.0; QupKake's BSD grant is a software license. Dwar-iBond remains unresolved. These are provenance corrections, not merely paperwork—the license and experimental/computational origin must follow the model artifact.

## The end-to-end chemistry remains a separate P0

At the start of this review, direct RDKit probes still showed that equivalent drawings could produce different state graphs, and that independent transition bits could create nonphysical combinations. Examples included neutral versus zwitterionic glycine, same-atom acid/basic transitions, and spectator fragments changing whole-molecule descriptors. Claude now has uncommitted edits targeting several of these paths; rerun the probes after those edits settle before treating them as fixed.

A better site regressor cannot repair an invalid thermodynamic graph. The long-term first-class architecture should be:

```text
submitted drawing
  -> canonical atom-mapped molecular family
  -> chemically valid protomer/tautomer states
  -> explicit single-proton transition graph
  -> learned scalar free energy per state
     or edge energies projected onto consistent node energies
  -> partition functions
  -> microscopic pKas, macroscopic pKas, populations, and charge curves
```

This enforces cycle closure and makes macro-pKa a consequence of one state ensemble rather than a set of independent atom scores. It also unlocks the analytical capabilities that could genuinely distinguish ChemDraft:

- dominant microspecies versus pH;
- species-distribution and average-charge curves;
- isoelectric points;
- tautomer contributions;
- explicit microscopic transition structures;
- condition- and solvent-aware estimates; and
- uncertainty at both state-transition and macroscopic levels.

## What Claude should do next

1. Stop widening the current model and stop pruning labels by apparent product reachability.
2. Freeze the family-aware benchmark and demote the 398-row set to development status.
3. Modify the training loader to consume the mapped conjugate base and build the four-way Stage 1 comparison.
4. Add distance-to-site shells and the pKaLearn-style parity-safe chemistry features.
5. Run the small regularization/class-balance screen on identical folds and seeds.
6. Build a diverse four-member ensemble only from independently winning models.
7. Use structure/QM self-supervision next; test ChemAxon pseudo-labels last and separately.
8. Keep repairing and measuring the full site/state pipeline, because oracle-site MAE is not product accuracy.

## Verification performed

- Re-read the current GNN feature, loader, architecture, split, training, inference, external-evaluation, calibration, and build-history code.
- Recomputed corpus pair counts and reviewed current model/external/macro/Hammett artifacts.
- Audited errors by pKa range, ionizing element, and source.
- Audited current scaffold assignments for protonation/tautomer-family leakage and imbalance.
- Reviewed Claude's supplied proposal and current negative experiments (`carbon_prune.py` and `qm_microstate.py`).
- Re-ran the focused RDKit-backed pKa suites: **330 of 330 tests passed**.

Green tests show that the in-progress implementation is internally consistent with its current fixtures. They do not prove a new model is more accurate, that the 398-row set is blind, or that all chemically equivalent drawings produce the same end-to-end result.

## Bottom line

The branch can still gain predictive power. The best near-term chance is **paired acid/base learning plus explicit site-relative chemistry**, evaluated on frozen molecular-family splits and followed by modest regularization, class balancing, and a genuinely diverse ensemble. Clean self-supervised or QM-auxiliary pretraining is the next escalation. ChemAxon-labelled pretraining is a potentially informative but legally and scientifically encumbered last experiment—not the foundation of an open first-in-class predictor.
