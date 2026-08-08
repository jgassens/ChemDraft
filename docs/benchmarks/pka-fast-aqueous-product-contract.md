# pKa fast aqueous baseline: frozen product contract

**Freeze date:** 2026-08-08

**Code snapshot:** `chemdraft-analyzers` at `029041d38ad4e4f3e6b1dc95892341976899e9e1`

**Disposition:** frozen baseline. The structured audit found a mixed failure mechanism, so general
feature, optimizer, loss, capacity, and pretraining exploration remains paused. The current runtime has
not yet implemented the audit's proposed abstention boundary.

This record identifies the system that exists now. It deliberately separates three different tasks:

1. **oracle-site microscopic valuation** — the correct acid state, ionizing atom, and direction are
   supplied;
2. **end-to-end macroscopic prediction** — the product receives only a molecular structure and must
   choose the state, find events, value them, and fold the microstate ladder; and
3. **post-hoc matched valuation** — measured and predicted macroscopic values are paired after prediction
   by the closest one-to-one assignment. This is useful diagnostically, but it is not an ordinary
   end-to-end error because it forgives ordering and reports extra events separately.

The competitor comparison belongs in the separate benchmark report. None of the figures here should be
compared to another tool until the task, common rows, site handling, and omissions are aligned.

Companion evidence: [competitor benchmark](./pka-fast-aqueous-competitor-benchmark.md) and
[structured error audit](./pka-fast-aqueous-error-audit.md).

## Frozen identity

| Field | Frozen value |
|---|---|
| Public method id | `dimorphite.ionizable-sites` |
| Method-contract version | `2.6.0` |
| Site engine | `dimorphite-site-table` `2.0.2`; 46 SMARTS entries |
| Shipped value model | acid-state, site-centred message-passing ensemble |
| Architecture | 4 members; 30 atom features; 5 bond features; hidden width 96; 3 message-passing layers; 60 epochs |
| Conjugate-base input | no |
| Shell/radial features | no |
| Per-site estimate | arithmetic mean of the four member predictions |
| Interval | carbon-versus-other empirical 68% absolute-error quantile, interpolated from ensemble disagreement |
| Optional second estimator | literature Hammett relationship for the narrow supported series; inverse-error weighted with the GNN |
| RDKit runtime | MinimalLib WASM `2026.03.3`, SHA-256 `66dab556e9d55708ce67afbf71e9853ed5fda217a9330961722f838f38836bf0` |
| pKa runtime-artifact manifest | SHA-256 `81cf1fca8155b5702c85d4d7561bf07778458b8a768846b62c6ef2bee196218c` |

The model architecture and embedded training metadata are in
[`site-pka-gnn.json`](../../packages/rdkit-adapter/vendor/pka-model/site-pka-gnn.json). The method id,
method version, site-engine version, interpretation declaration, and applicability prose are in
[`ionization.ts`](../../packages/rdkit-adapter/src/ionization.ts). The runtime manifest rule and RDKit pin
are in [`methods.ts`](../../packages/rdkit-adapter/src/methods.ts), with a three-way byte/prose/source
check in [`methods.test.ts`](../../packages/rdkit-adapter/src/methods.test.ts).

### Runtime artifact hashes

| Artifact | SHA-256 |
|---|---|
| `site-pka-gnn.json` | `79061c4d3b4e11753c865088e5bb38d0c7e689e6e394af4fdf99c0dcfcfca688` |
| `interval-calibration.json` | `2bf20919222ec71fb6a6564cc1e0405b14f595ddfd030670ffe6872067108444` |
| `consensus-calibration.json` | `4ae25e83d82b639d4c27371154fd6571aad135a485fc208f2ee4e1032f1cd62d` |
| `hammett-sigma.json` | `3f1bbd785d8fd7189f898240d2b0ce1d98efd24d9749e27b291d1f97d8ee6bf0` |
| `coupling.json` | `1bc2015011408924f2fee6cc17785032766bf64be9d8fa3ac4c22bd1a607bcac` |
| `edge-variance.json` | `b11d3385bab3f412349f2e271ccbde555638dbbc217cae0b33e69e502aa10f42` |
| `calibration.json` | `a361085c2ed1dd274f630f5266a94a2b6411cd915d815bad937f24aaf6666abc` |
| `external-validation.json` | `37981664695db5486231d884cb2ee8394640ac0c60a6e93fd20852040decaeb8` |

These hashes and the manifest are independently reproduced by the pin test. The table of record is
[`vendor/pka-model/BUILD.md`](../../packages/rdkit-adapter/vendor/pka-model/BUILD.md).

## Input interpretation and output meaning

### Effective default path

The effective product path is:

```text
structure as supplied
  -> parse and sanitize once with pinned RDKit
  -> retain source result and source-domain checks
  -> largest organic fragment when a separate derived answer is permitted
  -> reference protomer
  -> canonical tautomer when the loaded RDKit artifact can produce one
  -> enumerate acidic and basic reaction events
  -> value microscopic acid -> conjugate-base rungs
  -> reconcile the microstate graph and report macroscopic values
```

`reference-protomer` removes formal charges one atom at a time only when RDKit still accepts the
molecule. `reference-tautomer` is RDKit MolStandardize's deterministic canonical representative, not a
free-energy-weighted tautomer population. The latter stacks on the former. An explicit caller override
wins and suppresses the automatic substitution. See
[`analysis.ts`](../../packages/rdkit-adapter/src/analysis.ts) and
[`interpretations.ts`](../../packages/rdkit-adapter/src/interpretations.ts).

There is a contract inconsistency to preserve as an audit finding: `ionizationContract()` declares
`defaultInterpretationId: "reference-protomer"`, while the actual dispatcher requests
`derive("reference-tautomer") ?? derive("reference-protomer")`. Therefore, the effective default is the
canonical tautomer stacked on the reference protomer whenever that derivation changes the molecule.

There is also an unresolved atom-correspondence limitation. `referenceTautomerTransformation()` records
an identity atom mapping, although RDKit canonical tautomerization can renumber atoms. Until that path is
proved or repaired, a site on a rewritten canonical tautomer must not be described as having a verified
exact mapping back to the atom index in the user's drawing.

### Meaning of a value

- A per-site value is a **microscopic acidity for one reaction rung**: one proton leaves one named atom
  at the named charge state.
- An `acidic` site describes the supplied atom losing a proton. A `basic` site is valued by constructing
  its protonated state and predicting that conjugate acid's acidity.
- The reported macroscopic values are a weighted least-squares reconciliation of all generated
  microstate rungs followed by `pKa(n) = log10(Z(n)/Z(n-1))`.
- Results describe aqueous, approximately room-temperature behavior. They are not estimates for DMSO,
  acetonitrile, mixed solvents, or gas phase.
- A source containing multiple components is declined as a source pKa input. The run may additionally
  show a separately disclosed largest-organic-fragment result; counterions are not silently absorbed
  into a source claim.

## Training evidence

The frozen GNN contains 12,096 unique per-site labels. The source counts below sum exactly to that
number.

| Training source | Rows | Value/site provenance | Terms recorded by the product contract |
|---|---:|---|---|
| Dwar-iBond as distributed by Uni-pKa | 3,031 | experimental acid/base pairs; site diffed from the pair | unresolved for the dataset; Apache-2.0 covers Uni-pKa code, not automatically the data |
| QupKake experimental training set | 4,022 | measured values; site index assigned by ChemAxon Marvin | CC-BY-4.0 upstream data |
| pKaCHU, Zenodo 20089807 | 4,419 | experimental acid/base pairs; site diffed from the pair | CC-BY-4.0 |
| D2A-pKa, Zenodo 15277342, neat-water rows only | 624 | experimental acid/base pairs | CC-BY-4.0 |

Evidence: [`pkaModel.ts`](../../packages/rdkit-adapter/src/pkaModel.ts), the dataset declarations in
[`ionization.ts`](../../packages/rdkit-adapter/src/ionization.ts), and the committed merged corpus
[`merged-labels.json`](../../packages/rdkit-adapter/vendor/pka-model/merged-labels.json) (12,096 rows;
SHA-256 `ee0ae569d62dbb401bbaa18049e7980ebce10baee7be0548da8bce1bae268123`).

The training values are experimental, but not every site annotation is. In particular, all 4,022
QupKake-training site indices inherit Marvin's assignment. This distinction is part of the product
contract and must remain visible during the error audit.

## Accuracy record

### A. Frozen GNN: oracle-site, old scaffold split

The site and reaction direction are supplied. These figures measure value regression only; they do not
measure whether the product finds the correct event.

| Measure | Value |
|---|---:|
| Rows | 12,096 |
| Split | five folds, labelled `Bemis-Murcko scaffold` in the artifact |
| Scaffold groups | 4,626 |
| MAE | 0.7281 pKa units |
| RMSE | 1.1917 |
| Median absolute error | 0.4299 |
| 90th / 95th / 99th percentile absolute error | 1.7094 / 2.3500 / 4.5318 |
| Largest absolute error | 15.0394 |
| Absolute error >1 / >2 / >3 / >5 | 2,727 / 914 / 359 / 91 |

Percentiles use NumPy's default linear quantile interpolation. The row-level evidence is committed as
[`gnn-oof.json`](../../packages/rdkit-adapter/vendor/pka-model/gnn-oof.json), 1,638,838 bytes, SHA-256
`ebda612175b9c5ccfae2e8c388bd9257741e729b178b225bb5682e935e03576e`.

This is the OOF series embedded in the shipped artifact's metadata. It predates the later stable and
molecular-family-aware split work. The old grouping allows protomer/tautomer relatives to cross folds,
so 0.7281 is a frozen historical product figure, not the preferred estimate of novel-family
generalization. Later deterministic family-split experiments are research candidates and do not change
this baseline's identity.

The same committed OOF rows show that the mixture is not uniform across ionizing-site elements. This is
a secondary row-aligned recomputation, not artifact metadata:

| Ionizing-site element | Rows | MAE | RMSE | >2 | >5 |
|---|---:|---:|---:|---:|---:|
| N | 6,789 | 0.7264 | 1.1281 | 498 | 37 |
| O | 4,669 | 0.6630 | 1.1160 | 307 | 25 |
| S | 189 | 0.6693 | 0.9665 | 9 | 0 |
| C | 449 | 1.4559 | 2.3809 | 100 | 29 |

Carbon-site valuation is therefore a separate high-risk applicability stratum: its OOF RMSE is more
than twice the oxygen- or nitrogen-site RMSE, even though the locator now attempts activated carbon
acids.

### B. Novartis and Literature development sets: oracle-site GNN

`external_eval.py` supplies each row's QupKake/Marvin site index and direction directly to the GNN. It
does not execute ChemDraft site discovery, canonical-state routing, Hammett consensus, or macroscopic
folding. The sets have also selected model variants repeatedly, so they are development data, not a
blind final test.

| Set | Rows scored | MAE | RMSE | >3 | >5 | Max absolute error |
|---|---:|---:|---:|---:|---:|---:|
| Novartis | 276 | 1.1930 | 1.8527 | 25 | 8 | 10.7286 |
| Literature | 122 | 0.9830 | 2.1304 | 10 | 9 | 9.7365 |
| Combined | 398 | 1.1286 | 1.9420 | 35 | 17 | 10.7286 |

Combined tail detail: median absolute error 0.6210; 90th percentile 2.6124; 95th percentile 4.4897;
137/398 errors exceed 1, 53 exceed 2, and mean signed error is +0.1536. The low MAE relative to RMSE is
the defining weakness of this frozen baseline: a minority of severe failures dominates squared error.

Known overlap was recomputed by the first block of the standard InChIKey, the same protonation- and
tautomer-insensitive family key used by the family-split tooling:

- 39/398 benchmark rows (35 molecular families) share a molecular skeleton family with training;
- 6 are Novartis rows and 33 are Literature rows;
- the 359 non-overlap rows score MAE 1.1632 and RMSE 1.9182;
- the overlap rows score MAE 0.8104. Their RMSE is nevertheless 2.1488 because two overlap rows are
  catastrophic, which is another reason not to use MAE alone.

The committed summary is
[`external-validation.json`](../../packages/rdkit-adapter/vendor/pka-model/external-validation.json).
The additional RMSE, tails, intervals, and family overlap were recomputed on 2026-08-08 with
[`external_eval.py`](../../packages/rdkit-adapter/vendor/pka-model/external_eval.py), its shared
`family_key`, the frozen model, and these exact non-vendored inputs:

| Input | SHA-256 |
|---|---|
| `novartis_qupkake_pka.sdf` | `dd54fd8e6d2d66d10bd9514e302341b0cda061f60cdceaf87a5e0379d30dd026` |
| `literature_qupkake_pka.sdf` | `9e5199e472f765dcccc7b49d13a19b542b6a381cb5064d5810a35b0e00f3ed0b` |

Python evaluation used RDKit 2026.03.5, PyTorch 2.13.0, and NumPy 2.5.1. It reproduced the committed MAE
to four decimals. The shipped runtime uses RDKit MinimalLib 2026.03.3 and a parity fixture rather than
PyTorch; this environment difference belongs in any interpretation of finer-grained tails.

### C. End-to-end SAMPL6 macroscopic task

The current product path was re-run from SMILES on all 24 SAMPL6 molecules on 2026-08-08. All 24
produced an answer. The benchmark has 31 measured macroscopic values, no training-family skeleton
overlap, and one shared Bemis-Murcko scaffold. Its measurements are UV-metric and potentiometric at
25 C and ionic strength 0.15 M NaCl. Evidence and exact inputs are in
[`sampl6-benchmark.json`](../../packages/rdkit-adapter/vendor/pka-model/sampl6-benchmark.json) and
[`sampl6.real.test.ts`](../../packages/rdkit-adapter/src/sampl6.real.test.ts).

| Reading | Values | MAE | RMSE/tail | Event-count result |
|---|---:|---:|---|---|
| Titration-order pairing of raw product output | 31 | 2.270 | 52% within 1; 65% within 2; worst 8.33 | exact raw count on 2/24 molecules |
| Greedy closest one-to-one post-hoc matching | 31 | 0.499 | RMSE 0.60 and worst 1.35 are the current contract's recorded values; rerun gives 27/31 (87%) within 1 and 31/31 within 2 | 39 unmatched predicted steps, 18 inside the assay's 2-12 window |
| Titration-order pairing after restricting predictions to pH 2-12 | 31 | 1.777 | 61% within 1; 74% within 2 | exact count on 12/24 molecules |

The 0.499 value is not a substitute for end-to-end error. It answers, "did at least one generated value
land near each measurement?" while counting the extra generated values separately. The raw 2.270 and
the event counts are the product-facing failure signal. The `ionizationContract()` prose currently says
90% within one for the post-hoc matched reading; the executable rerun is 87%, so the prose is stale.

### D. Interval behavior

| Evaluation | Target | Observed coverage | Interval detail |
|---|---:|---:|---|
| OOF oracle-site calibration corpus | 68% | 67.57% | quartiles 0.4920 / 0.6662 / 0.9750 |
| OOF carbon sites (n=449) | 68% | 67.04% | separate four-bin carbon curve |
| OOF N / O / S | 68% | 67.40% / 67.66% / 72.49% | pooled non-carbon curve; S n=189 |
| External 398-row development set | 68% | 57.29% | median half-width 0.7585; 90th percentile 1.3740 |

The interval is an empirical held-out absolute-error quantile, not a standard deviation. OOF coverage
is close to target partly by construction. The 10-point external undercoverage is a frozen limitation:
the displayed interval is not calibrated for this shifted benchmark distribution. Evidence:
[`interval-calibration.json`](../../packages/rdkit-adapter/vendor/pka-model/interval-calibration.json)
and [`pkaGnn.ts`](../../packages/rdkit-adapter/src/pkaGnn.ts).

### E. Hammett-supported subset

On the 342 labelled OOF sites where the current Hammett relationship applies, the GNN alone has MAE
0.5086, Hammett has MAE 0.2594, and the inverse-error-weighted consensus has MAE 0.2394. Its interval
covers 89.47% on that same subset. The benzoic-acid component is partly circular because those constants
define the relationship; this is a narrow supported-domain correction, not general pKa accuracy.
Evidence: [`consensus-calibration.json`](../../packages/rdkit-adapter/vendor/pka-model/consensus-calibration.json).

### F. End-to-end assigned-event error audit

The frozen product path was run from structure alone on all 402 locally available Novartis and
Literature records. The QupKake/Marvin atom was used only afterward to score whether the assigned event
was reproduced; it was never supplied to `analyzeStructure`. Of 402 inputs, 352 assigned events were
reproduced, 33 were not, and 17 had indeterminate atom/event correspondence. On the 352 exact
comparisons, MAE was 1.0443, RMSE 1.8168, 38/24/12 errors exceeded 2/3/5 units, and nominal 68%
intervals covered 57.10%.

| Marvin-assigned stratum | Inputs | Event reproduced / not / unknown | Exact-event MAE | RMSE |
|---|---:|---:|---:|---:|
| N acidic | 57 | 50 / 3 / 4 | 1.8719 | 2.9781 |
| N basic | 261 | 243 / 13 / 5 | 0.8721 | 1.3566 |
| O acidic | 70 | 59 / 4 / 7 | 1.0523 | 2.1437 |
| O basic | 10 | 0 / 9 / 1 | unavailable | unavailable |
| S basic | 4 | 0 / 4 / 0 | unavailable | unavailable |

The 71 registered failures split into 38 bad numerical values on exactly generated assigned events and
33 assigned-event nonreproductions. Acidic failures were value-heavy (21 versus 7); basic failures were
event-heavy (17 versus 26). The site label is another predictor's assignment, not experimental event
truth, so this is evidence of disagreement—not proof that either locator chose the chemically correct
atom. Full per-record evidence is in the
[structured error audit](./pka-fast-aqueous-error-audit.md).

## Applicability and abstention

### Declared pre-audit runtime envelope

- Drug-like aqueous organic acids and bases composed of H, C, N, O, S, P, F, Cl, Br, and I.
- Microscopic events that one of the 46 site patterns or the activated-carbon rule generates.
- Polyprotic molecules with up to eight ionizable sites for macroscopic folding.
- Activated carbon acids are attempted when a carbon has a nitro group or at least two accepted
  carbanion stabilizers. Carbon is represented in training but remains a high-error class.
- Benzoic acids, phenols, anilines, and pyridines meeting the Hammett method's narrow structural rules
  may receive a second estimate.

### Audit-informed evidence boundary

This is measured evidence, not behavior the frozen runtime already enforces:

- N-basic events are the best-demonstrated external stratum, but their RMSE is still 1.3566 and interval
  coverage is 57.61%, so the result remains qualified rather than broadly validated.
- O-acidic and especially N-acidic values have severe tails (RMSE 2.1437 and 2.9781 respectively).
- The product reproduced none of the 10 Marvin-assigned O-basic or four S-basic events. Those strata
  require an explicit abstention/flag until experimental event truth and a validated locator exist.
- Ten rewritten-state records still lack proven atom correspondence, and seven more match only through
  an approximate resonance-equivalence rule. Those records require state/event review rather than a
  confident numerical answer.
- A deployable abstention rule must be specified prospectively and tested on new molecular families;
  these development-set strata must not be converted directly into a tuned threshold.

### Declined, withheld, or explicitly weak

- Non-aqueous solvent systems are out of scope.
- A metal-bearing or metal-adjacent site is reported unassessed rather than valued; the training corpus
  contains no metal-bearing structure.
- Source multicomponent structures are out of domain; a disclosed largest-organic-fragment answer may be
  provided separately.
- A sulfonic acid receives no aqueous pKa number; the incompatible strong-acid labels are withheld.
- The acidic half of a plain, unactivated amine is withheld; its familiar basic/conjugate-acid value can
  still be reported.
- Macroscopic enumeration declines above eight ionizable sites rather than truncating `2^n` states.
- A group with no matching pattern can be missed silently. Absence of a reported site is not evidence
  that the molecule has no ionization event.
- Extreme pKa values, carbon acids, sulfur acids, zwitterions with several interacting sites, and
  unfamiliar families require special caution. The structured audit confirms that one aggregate MAE
  is not a sufficient applicability claim.

## Known contract/code inconsistencies and explicit unknowns

1. **Declared versus effective interpretation:** the contract says `reference-protomer`; runtime prefers
   `reference-tautomer` stacked on it.
2. **Canonical-tautomer atom mapping is unproved:** the transformation ledger records identity mapping,
   but RDKit may renumber atoms during the rewrite. Exact source-site correspondence is not presently a
   general product claim on that path. The audit proved identity record by record when possible, but ten
   rewritten benchmark states remained unresolved.
3. **Wrong model in `accuracyClaims`:** the first structured accuracy claim reads
   `PKA_MODEL_TRAINING.cvMae` from the retained random forest (about 1.02), while the shipped value model
   is the GNN with MAE 0.7281. Other prose reads the GNN. The structured field is not baseline evidence.
4. **External-set description is stale:** `external-validation.json` calls all 398 rows held out and
   never used in selection. The set has 39 training-family overlaps and has repeatedly selected model
   variants; it is development data.
5. **SAMPL6 prose is stale:** the contract's 90% within-one figure is 87% in the current executable
   rerun, and the favorable 0.499 result depends on post-hoc closest matching.
6. **The OOF split is historical:** the shipped 0.7281 series predates the stable, family-aware split and
   does not isolate all protomer/tautomer relatives.
7. **External interval transfer fails:** 57.29% coverage against the nominal 68% target.
8. **Site detection has no clean final precision estimate:** the training corpus is censored to recorded
   labels rather than exhaustively negative at every other atom, and 4,022 site labels come from another
   predictor. The current structured audit must classify events rather than turn every unlabelled atom
   into a false positive.
9. **No controlled cross-tool runtime ratio:** 2-11 ms measurements describe a known-site network
   forward pass, while same-day warm-WASM end-to-end runs varied materially. The benchmark report
   records both, but no exact speedup claim is permitted without same-input, same-hardware testing.
10. **Dwar-iBond downstream data terms remain unresolved.** This affects redistribution of weights even
   though it does not change numerical performance.

## Measured audit disposition

The disposition rule was fixed before the structured audit:

| Dominant severe-error mechanism | Disposition |
|---|---|
| Wrong or missing reaction events | Replace the separate locator with a joint reaction-event architecture |
| Tautomer/protomer or state inconsistencies | Complete a reaction-valid state layer before retraining |
| Disputed, incompatible, or duplicated labels | Narrow and recurate the corpus |
| Bad values for correct, supported events | A larger or differently trained regressor is justified |
| Different mechanisms dominate different families | Retain this baseline for the supported core and abstain elsewhere |

The measured outcome is the final row: 38 exact-event numerical failures versus 33 assigned-event
nonreproductions overall, with the direction reversing between acidic and basic strata. Therefore:

- retain this artifact unchanged as the fast aqueous baseline;
- specify and prospectively validate flags/abstentions before presenting the weak strata as supported;
- resolve the ten state mappings and obtain an experimental acid/base-pair event benchmark before
  replacing the locator with a joint event architecture; and
- permit only targeted value-model experiments on exactly generated, chemically adjudicated events.

General larger-model, feature, optimizer, loss, and pretraining exploration remains out of scope.

This document may be corrected when a number is found to be wrong, but any numerical or chemical change
to the frozen system creates a new product-contract version rather than silently rewriting this one.
