# ChemDraft pKa Prediction System: Code Review and Recommendations

**Review date:** 2026-08-03  
**Worktree:** `chemdraft-analyzers`  
**Reviewed commit:** `4e1527b8` (`fix: the enumeration was building a species that does not exist`)  
**Review mode:** Read-only code, model, validation, dataset, dependency, and literature assessment

## Executive conclusion

The branch is not yet a first-in-class pKa predictor. It has unusually strong reporting and provenance architecture, but the underlying chemistry-state model can generate impossible species, changes its answer based on how a molecule is drawn, and has an invalid external-validation path.

The highest-priority change is therefore not a larger random forest or additional tuning. ChemDraft first needs a representation-invariant, atom-mapped protonation and tautomer state graph. Model improvements and larger datasets should be built on top of that corrected scientific foundation.

Until those changes are complete, the current pKa feature should be described as experimental, and the macroscopic/consensus accuracy claims should be suppressed or clearly qualified.

## Current architecture

The current user-facing path is approximately:

```text
submitted structure
  -> Dimorphite SMARTS site scan
  -> random-forest site prediction
  -> optional Hammett estimate and consensus
  -> independent binary site enumeration
  -> microscopic and macroscopic pKa report
```

Important entry points include:

- [`packages/rdkit-adapter/src/analysis.ts`](packages/rdkit-adapter/src/analysis.ts)
- [`packages/rdkit-adapter/src/ionization.ts`](packages/rdkit-adapter/src/ionization.ts)
- [`packages/rdkit-adapter/src/pkaModel.ts`](packages/rdkit-adapter/src/pkaModel.ts)
- [`packages/rdkit-adapter/src/protonation.ts`](packages/rdkit-adapter/src/protonation.ts)
- [`packages/analysis-core/src/results.ts`](packages/analysis-core/src/results.ts)
- [`packages/analysis-core/src/report.ts`](packages/analysis-core/src/report.ts)

## Confirmed high-priority findings

### P0-1: Predictions depend on how the same compound is drawn

Direct RDKit-backed probes produced the following results:

| Drawing | Result |
|---|---|
| Neutral glycine, `NCC(=O)O` | Two sites; macro pKas approximately 2.125 and 9.070 |
| Zwitterionic glycine, `[NH3+]CC(=O)[O-]` | `not-applicable`; zero sites |
| Protonated-amine/neutral-acid glycine | Only the carboxyl transition |
| Neutral-amine/deprotonated-acid glycine | Only the amine transition |
| Acetic acid | Predicted |
| Acetate | No tabulated site; not predicted |

The scanner operates on the submitted protonation form rather than first constructing the complete protonation/tautomer family. Relevant paths are [`analysis.ts`](packages/rdkit-adapter/src/analysis.ts) and the site scan beginning in [`ionization.ts`](packages/rdkit-adapter/src/ionization.ts).

This violates a basic pKa requirement: equivalent drawings of the same molecular family must lead to the same state graph and equilibrium predictions.

### P0-2: Independent site bits generate impossible state ladders

The current scorer can emit acidic and basic transitions for the same physical atom. The macroscopic layer then treats every emitted transition as an independent Boolean variable.

Direct reproductions included:

- Acetamide emitted one nitrogen as separate acidic and basic sites, produced four microstates, two macro pKas, and a false zwitterion classification.
- Urea emitted four transition records over two physical nitrogen atoms and enumerated 16 microstates.
- Pyridinium produced acidic and basic entries on the same ring nitrogen.
- Aniline and imidazole were also incorrectly flagged as zwitterionic under portions of this state model.

The independent transition emission is in [`ionization.ts`](packages/rdkit-adapter/src/ionization.ts), while binary enumeration occurs in [`protonation.ts`](packages/rdkit-adapter/src/protonation.ts).

A physical atom may participate in several protonation levels, but those levels are mutually constrained. They cannot be represented as unrelated on/off switches.

### P0-3: Counterions and metals alter predictions without triggering the declared domain guard

Direct results were:

| Structure | Predicted pKa |
|---|---:|
| Acetic acid | 4.5030 |
| Sodium plus acetic acid | 4.6164 |
| Iron plus acetic acid | 4.5747 |

All returned `ok` without the promised unsupported-metal warning. The metal check only examines atoms inside a SMARTS match, while whole-molecule mass, TPSA, logP, charge, and heavy-atom descriptors include the counterion or metal.

The system needs an interpretation-level domain check before prediction. At minimum, a covalently connected metal-bearing component should decline. Disconnected salts need an explicit parent/counterion policy, with the selected interpretation shown to the user.

### P0-4: The claimed external MAE can be calculated at the wrong atom

[`external_eval.py`](packages/rdkit-adapter/vendor/pka-model/external_eval.py) reads a site index from an SDF record, converts the molecule to canonical SMILES, reparses it, and then reuses the original atom index. RDKit canonicalization can reorder atoms.

Consequently, the committed 398-row external MAE of 1.2414 is not trustworthy until the evaluator preserves atom maps or remaps the site through graph isomorphism and regenerates the artifact.

This atom-identity weakness also appears in portions of the QupKake deduplication path, which combine canonical SMILES with indices originating in a pre-canonical molecule.

### P1-1: Headline accuracy measures an oracle-site model rather than the shipped feature

Training cross-validation and external evaluation receive the correct acid microstate and site index in advance. They do not measure:

- site-detection precision and recall;
- acidic-versus-basic transition classification;
- charged/protomer representation invariance;
- validity and completeness of generated microstates;
- macroscopic pKa assignment;
- salt and counterion handling; or
- the behavior of the complete user-facing pipeline.

Therefore, the current MAE values cannot describe the accuracy of the feature a user actually receives.

### P1-2: Training and runtime do not use identical feature conventions

Training uses RDKit's default TPSA convention, which excludes sulfur and phosphorus contributions. One runtime path explicitly enables sulfur and phosphorus, while other runtime microstate paths use the default. A sulfur-containing fixture changed by approximately 0.07 pKa solely because of this mismatch.

Training, calibration, testing, and production inference need one shared, versioned feature implementation. Parity tests must invoke the exact production path rather than a similar descriptor call.

### P1-3: The deployed site locator cannot reach important training chemistry

The training corpus contains approximately 2,001 carbon-centered labels out of 8,317 total labels, but the deployed 41-entry Dimorphite-derived locator has no carbon-centered ionization target.

The model has therefore learned a substantial class of chemistry that its production site generator cannot invoke. This is another reason that simply enlarging or retuning the forest will not solve the end-to-end problem.

### P1-4: Dataset and model provenance is materially inaccurate

The implementation states that the model contains:

- 3,031 Dwar-iBond labels; and
- 5,286 QupKake labels.

The user-facing contract instead describes all 8,317 labels as Dwar-iBond and omits QupKake, including its ChemAxon-derived site annotations. It also contains stale external-validation descriptions and record counts.

Dwar-iBond needs a new provenance and reuse audit. The DataWarrior author has stated that original literature references were lost, and a software license does not automatically establish a license for an associated dataset: [DataWarrior source discussion](https://openmolecules.org/forum/pdf.php?th=96).

The pKa artifacts and datasets are also absent from [`docs/architecture/dependency-inventory.md`](docs/architecture/dependency-inventory.md).

### P1-5: Prediction artifacts are absent from run fingerprints

The random forest, Hammett constants, consensus calibration, interval calibration, and macroscopic coupling values all affect numerical results. Nevertheless, run and cache fingerprints currently record RDKit and optional IsoSpec artifacts but not the pKa artifacts.

Two builds can therefore generate different pKas while presenting the same method version and run fingerprint. Every executable model/data artifact needs a checksum in the method environment and cache identity, followed by a method-version increment.

### P1-6: Macroscopic validation and uncertainty are not sufficiently reproducible

The macroscopic validation currently uses 15 hand-entered compounds and 32 values, with generic source descriptions. The fitting script and committed coupling artifact do not fully reproduce one another, and the standard regeneration script does not refit the coupling value.

The current tree-spread interval is also not a calibrated prediction interval. Consensus weights and claimed disagreement/error relationships were evaluated on overlapping calibration material rather than an untouched nested calibration set.

### P2: Reporting cannot yet express the state-level scientific result

The core result exposes an unlabeled macro-pKa array, microstate count, inconsistency measure, and a zwitterion Boolean. It cannot express:

- the structure and charge of each microstate;
- the specific proton-transfer edge associated with each microscopic pKa;
- tautomer relationships;
- dominant species versus pH;
- population or charge-state curves;
- per-transition applicability and uncertainty; or
- the exact dataset/model artifacts responsible for an estimate.

These should become first-class analysis outputs rather than prose reconstructed after prediction.

## Recommended scientific architecture

ChemDraft should replace the current independent-site enumeration with the following model:

```text
submitted drawing
  -> canonical molecular family
  -> atom-mapped, chemically valid protonation/tautomer states
  -> explicit single-proton transition graph
  -> state or edge free-energy prediction
  -> thermodynamic reconciliation
  -> microscopic pKas, macroscopic pKas, populations, and dominant species
```

### State model requirements

- Generate protonation and tautomer states independently of the submitted protomer.
- Preserve atom mapping through every transformation.
- Represent a microscopic pKa as an edge between explicit protonated and deprotonated structures.
- Deduplicate resonance- and symmetry-equivalent states.
- Record transformations in the existing interpretation ledger.
- Organize states by total proton count and formal charge.
- Decline if required portions of the state graph cannot be constructed or validated.
- Treat salts, disconnected components, and metals through explicit interpretation/domain policies.

### Thermodynamic model requirements

The preferred learned object is a scalar free energy for each state. A second acceptable approach is to predict edge free energies and project them onto consistent node energies through weighted least squares.

Either approach should enforce:

- thermodynamic cycle closure;
- symmetry equivalence;
- tautomer-equivalent-state constraints;
- consistency between microscopic and macroscopic predictions; and
- one common state ensemble for pKa, species populations, charge curves, and dominant structures.

This architecture would naturally support valuable analytical capabilities beyond a single pKa number:

- dominant microspecies versus pH;
- complete species-distribution curves;
- average molecular charge versus pH;
- isoelectric points;
- tautomer contributions;
- buffer regions;
- site-specific and macro-level uncertainty; and
- solvent- and condition-specific predictions where supported.

## Recommended datasets

The guiding rule should be: a public download is not necessarily redistributable training data, and a paper's license is not automatically the database's license.

| Priority | Resource | Coverage and reuse status | Recommended use |
|---:|---|---|---|
| 1 | [pKaCHU](https://zenodo.org/records/20089807) and the [T5pKa paper](https://doi.org/10.1021/acs.jcim.6c00556) | 9,000 experimentally derived aqueous values represented as explicit protonated-to-deprotonated pairs; 2,118 Murcko scaffolds; CC BY 4.0 | Best immediate training addition. Preserve replicate measurements and citations instead of training only on supplied averages. Retrain from clean experimental data rather than automatically adopting checkpoints containing calculated-label pretraining. |
| 2 | [D2A-pKa](https://zenodo.org/records/15277342) and its [paper](https://doi.org/10.1021/jacs.5c07357) | 8,241 experimental values across eight solvents, with reaction and solvent SMILES; CC BY 4.0 | Build a distinct solvent-aware neutral-acid contract. Do not silently use it for unsupported bases or as an aqueous fallback. |
| 3 | [pKaLearn](https://github.com/MoitessierLab/pKaLearn) and its [paper](https://doi.org/10.1038/s42004-026-01983-y) | Approximately 13,000 site-associated values; MIT repository and artifacts; iterative polyprotic design | Strong open comparator and architecture donor. Audit the row-level provenance of its upstream data before adopting weights. |
| 4 | [G-pKa](https://zenodo.org/records/15257975) and its [paper](https://doi.org/10.1021/acs.jcim.6c00255) | 6,379 experimental pKas, more than 39,000 conformer/tautomer structures, and QM-derived features; Zenodo record says CC BY 4.0 | Scientifically valuable for tautomer-dependent equilibria. The currently published record appears incomplete, so obtain the full graph/checkpoint artifacts from the authors before integration. |
| 5 | [SAMPL6](https://github.com/samplchallenges/SAMPL6), [SAMPL7](https://github.com/samplchallenges/SAMPL7), [SAMPL8](https://github.com/samplchallenges/SAMPL8), and [euroSAMPL1](https://radar4chem.radar-service.eu/radar/en/dataset/dfqzn3tat216pyzy) | Small, well-characterized challenge sets with permissive or CC BY reuse terms | Freeze as never-train external benchmarks. Version corrected or remeasured values explicitly. |
| 6 | [IUPAC aqueous pKa dataset](https://zenodo.org/records/21533589) | More than 24,000 rows and 10,000 structures, with unusually rich method, temperature, pressure, cosolvent, reliability, and source metadata; CC BY-NC 4.0 | Excellent research, overlap analysis, and condition-aware error corpus. Do not bundle it or train a generally redistributable Apache model without permission. |
| 7 | [IUPAC dipolar non-hydrogen-bond-donor solvent dataset](https://zenodo.org/records/19518593) | More than 9,500 values for nearly 5,000 neutral acids across seven solvents; CC BY-NC 4.0 | Research foundation for a later nonaqueous predictor. Never pool directly with aqueous values. |
| 8 | [pKaHub](https://github.com/keserulab/pkahub) and its [paper](https://doi.org/10.1021/acs.jcim.6c00107) | More than 90,000 reported aqueous values and more than 31,000 molecules; bulk database has no explicit data license | Lookup or internal benchmark only pending written reuse terms. Its proposed microspecies assignments are computational, not measured microscopic labels. |
| 9 | [Tautobase](https://github.com/WahlOya/Tautobase) | 1,680 tautomer pairs with measured or estimated preferences; no explicit repository license | Tautomer-invariance diagnostics only unless reuse permission is clarified. It is not a primary pKa corpus. |

### Corpus requirements

Every retained observation should carry:

- source dataset and original record ID;
- original literature citation;
- license and redistribution status;
- experimental or computational origin;
- solvent, temperature, ionic strength, and measurement method;
- macro/micro designation;
- measured, curator-assigned, or computationally reconstructed site identity;
- explicit protonated and deprotonated structures;
- atom mapping and molecular-family identifier;
- replicate values and disagreement; and
- checksums for source and normalized records.

An explicit structure pair should not automatically be described as an experimentally resolved microscopic equilibrium. The provenance must distinguish a measured microscopic assignment from a curator or software reconstruction.

## Recommended dependencies and model comparisons

### Chemprop v2

[Chemprop v2](https://github.com/chemprop/chemprop) is MIT licensed and supports reaction-plus-solvent multicomponent message-passing. It is a strong offline training framework for explicit acid/base pairs.

It should not introduce Python and PyTorch into the core desktop runtime. Train offline, then export or distill a compact versioned inference artifact if the resulting accuracy, license, and performance are acceptable.

### pKaLearn-style site-centered graph network

[pKaLearn](https://github.com/MoitessierLab/pKaLearn) is the most actionable open comparator for a site-centered graph model. Its design suggests testing:

- a chemically local radius of roughly seven bonds;
- directed bond polarization and electronegativity features;
- explicit ring size and hydrogen count; and
- a task-specific conjugation definition rather than relying uncritically on RDKit's generic conjugation flag.

### Uni-pKa and free-energy models

[Uni-pKa](https://github.com/dptech-corp/Uni-pKa) is a useful architectural reference for microstate free energies and thermodynamic consistency. Its approach should inform the state/free-energy design even if ChemDraft does not adopt its complete model or runtime.

### Optional physics-assisted path

[xTB](https://github.com/grimme-lab/xtb) plus [LightGBM](https://github.com/microsoft/LightGBM) could support a slower, optional sidecar for carbon acids or difficult out-of-domain structures. This should be a separately named method with its own domain, licensing, performance, and uncertainty contract.

### Required baseline comparison

Three deliberately different models should be evaluated on identical leakage-free splits:

1. the existing random forest and Hammett methods as transparent baselines;
2. a Chemprop reaction-pair model; and
3. a pKaLearn-style site-centered graph network.

They should only be ensembled if a frozen validation set demonstrates genuinely complementary errors. Hammett should remain an independently reported specialist method unless separate held-out calibration proves that combining it improves both accuracy and calibration.

## Uncertainty, domain, and validation strategy

### Data splitting and leakage control

Use several simultaneous identity checks:

- atom-mapped protonated/deprotonated pair;
- tautomer/protomer-normalized molecular family;
- parent InChIKey;
- Bemis-Murcko scaffold;
- source dataset; and
- publication or temporal origin where available.

Required evaluations include nested grouped cross-validation, leave-one-source-out testing, and frozen external challenge sets. The final interval-calibration set must not also be used to select model hyperparameters or consensus weights.

### Calibrated uncertainty

Replace tree spread with conformal calibration on an untouched grouped calibration set. Where enough data exist, calibrate separately by site class, charge transition, and solvent.

Display several distinct signals rather than one generic `±` number:

- calibrated prediction interval;
- distance to the nearest supported training chemistry;
- number and diversity of relevant training examples;
- disagreement among experimental replicates;
- disagreement among generated tautomers;
- disagreement among independently trained model families; and
- explicit out-of-domain or unsupported status.

### End-to-end acceptance gates

A first-class release should report at least:

- protonation/tautomer state-generation precision and recall;
- correct identification of proton-transfer edges;
- representation invariance across protomers, tautomers, atom ordering, Kekule forms, explicit hydrogens, and salts;
- microscopic pKa MAE/RMSE and calibrated coverage;
- macroscopic pKa matching accuracy;
- species-population or charge-curve accuracy where reference data exist;
- performance stratified by functional class, charge, molecular size, source, and applicability domain; and
- explicit decline rates and reasons.

## Proposed implementation sequence

### Phase 0: Correct unsafe behavior and claims

1. Mark the current predictor experimental.
2. Suppress or qualify macroscopic and consensus accuracy claims.
3. Fix atom mapping in external validation and regenerate its results.
4. Unify training and production descriptor implementations.
5. Apply interpretation-level metal and component domain checks.
6. Prevent duplicated same-atom transitions and invalid independent states.
7. Correct dataset counts, licenses, citations, and provenance.
8. Hash and fingerprint every model, data, calibration, and constants artifact.
9. Split Dimorphite location, random-forest regression, Hammett LFER, consensus, and macroscopic computation into separately versioned components or one explicit composite contract.

### Phase 1: Build the reproducible corpus

1. Implement the row-level corpus registry.
2. Ingest pKaCHU first.
3. Audit and either repair or quarantine Dwar-iBond and QupKake records.
4. Detect overlaps across all training, calibration, and benchmark sources.
5. Pin the Python/RDKit/NumPy/scikit-learn training environment.
6. Add source fetch/checksum scripts where redistribution permits.
7. Preserve measurements, conditions, citations, and replicates rather than only normalized averages.

### Phase 2: Replace the state engine

1. Create atom-mapped protomer/tautomer graph contracts in `analysis-core`.
2. Implement chemically valid state enumeration in the RDKit adapter.
3. Deduplicate symmetry-, resonance-, and tautomer-equivalent states.
4. Validate every state and single-proton transition.
5. Add invariant end-to-end fixtures for glycine, acetate/acetic acid, pyridine/pyridinium, aniline, amides, urea, azoles, salts, metals, carbon acids, and reordered atoms.

### Phase 3: Train and compare models

1. Retain the forest as a baseline.
2. Train a pKaCHU reaction-pair Chemprop model.
3. Train a pKaLearn-style site-centered graph model.
4. Evaluate state-energy and edge-energy formulations.
5. Enforce or reconcile thermodynamic cycles.
6. Add condition inputs only where supported by an explicitly separate dataset and method contract.

### Phase 4: Calibrate and validate

1. Lock never-train SAMPL/euroSAMPL benchmarks.
2. Run molecular-family, scaffold, source, and temporal leakage audits.
3. Calibrate conformal intervals on untouched grouped data.
4. Measure the complete state-generation-to-reporting pipeline.
5. Establish release thresholds by chemistry class and domain, not only a global MAE.

### Phase 5: Deliver first-class analytical outputs

Expose:

- explicit microstate structures and charge states;
- mapped microscopic transitions;
- macroscopic pKas with step identities;
- species-distribution and average-charge curves versus pH;
- dominant states and isoelectric point where defined;
- solvent, temperature, and measurement convention;
- calibrated intervals and applicability evidence; and
- complete model, dataset, artifact, and transformation provenance.

## Verification performed during this review

- Focused pKa suites: **281 of 281 tests passed**.
- Analysis result/report suites: **56 of 56 tests passed**.
- Total focused passing tests: **337**.
- Direct real-RDKit probes covered glycine protomers, acetic acid/acetate, sodium and iron components, acetamide, urea, sulfonamide, imide, aniline, pyridine/pyridinium, imidazole, and descriptor-convention differences.
- Static inspection covered training, calibration, external validation, coupling, provenance, fingerprints, result contracts, reports, and dependency inventory.

The green tests demonstrate component-level regression coverage, but they do not currently exercise the highest-impact end-to-end scientific failures described above.

## Recommended near-term product claim

The most defensible target claim is:

> Trained on explicitly licensed, reaction-pair aqueous data; evaluated on frozen blind-challenge sets; representation-, condition-, provenance-, applicability-, and tautomer-aware.

That is a substantially stronger and more scientifically meaningful standard than increasing the size of the present forest while retaining the current state-generation and validation assumptions.
