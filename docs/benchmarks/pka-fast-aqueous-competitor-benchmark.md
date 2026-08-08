# Fast aqueous pKa baseline: competitor benchmark record

**Evidence snapshot:** 2026-08-08

**ChemDraft source snapshot:** `029041d38ad4e4f3e6b1dc95892341976899e9e1`

**Shipped model artifact:** `packages/rdkit-adapter/vendor/pka-model/site-pka-gnn.json`

**Model SHA-256:** `79061c4d3b4e11753c865088e5bb38d0c7e689e6e394af4fdf99c0dcfcfca688`

This is the competitor record for the frozen **fast aqueous baseline**. It records what was actually
measured, what the cited papers measured, and why the numbers below are not a defensible leaderboard.
The [companion product contract](./pka-fast-aqueous-product-contract.md) owns the user-facing scope,
intervals, applicability, and current end-to-end behavior.

The molecule-level disposition evidence is in the
[structured error audit](./pka-fast-aqueous-error-audit.md).

> **The central task mismatch:** ChemDraft's 398-row external evaluation is an
> **oracle-site, value-only** test. It reads a Marvin-assigned atom index and acid/basic type from the
> QupKake SDF, derives an acid form when necessary, and asks the regressor for the value at that supplied
> site. QupKake's headline result runs its own tautomer search, site enumeration, and value model.
> Baltruschat's RF and several other published numbers instead concern one-pKa predictions on a
> Marvin-prefiltered monoprotic corpus. OPERA and Epik omit rows under tool-specific rules. These are
> different tasks and different row sets.

## Benchmark-set lineage and exact row accounting

The local scoring path is [`external_eval.py`](../../packages/rdkit-adapter/vendor/pka-model/external_eval.py).
The SDFs are not vendored; the script reads QupKake's copies of data originating with Baltruschat and
Czodrowski.

| Record | Novartis rows | Literature rows | Total | Meaning |
|---|---:|---:|---:|---|
| Baltruschat source benchmark | 280 | 123 | 403 | Original monoprotic sets reported in the 2020 paper. The literature set is also called `AvLiLuMoVe`. |
| QupKake release SDFs inspected locally | 280 | 122 | 402 | QupKake's redistributed literature file contains 122 readable records, one fewer than the source benchmark; the identity/reason for that one-row loss has not been established here. |
| ChemDraft committed baseline summary | **276** | **122** | **398** | Four basic Novartis records cannot be converted to the required acid form and are not scored. All 122 QupKake literature records are scored. |
| Later paired candidate experiment | — | — | **397** | Common support between two ChemDraft artifacts, covering 390 families. One additional row is lost only for that paired experiment. It does **not** replace the 398-row baseline record. |

The four ChemDraft omissions are zero-based Novartis source indices **70, 87, 113, and 127**. Each is
labelled basic in the SDF and `protonated()` returns no constructible acid state.

The largest possible exact intersection between ChemDraft and a competitor is therefore 276 Novartis
rows and 122 literature rows. No row-level competitor prediction bundle is committed, so a paired
common-row MAE/RMSE has **not** been calculated for any competitor. Published aggregate values must not
be described as exact head-to-head results.

The 398 rows are also **development data, not a blind held-out test**. They have repeatedly selected or
rejected model variants. A current family audit using the first block of the standard InChIKey finds
**39/398 rows (35 molecular families; 6 Novartis and 33 literature) with a training-family overlap**. The
`"held-out external data, never used in training or fold selection"` wording in
[`external-validation.json`](../../packages/rdkit-adapter/vendor/pka-model/external-validation.json)
describes an earlier intention and is no longer a valid statistical claim. The rows were not fitted as
training labels in that evaluation, but the set has influenced model choice.

Finally, these datasets contain one experimental pKa selected after monoprotic filtering. Attaching a
predictor-generated atom index does not turn that experimental observation into a directly measured
microscopic acid/conjugate-base state pair.

## Published accuracy, with the task retained in every row

This table is an evidence index, **not a ranking**. Each metric remains attached to its published task,
row count, omissions, and aggregation rule.

| Tool and version | Task and site handling used for the reported metric | Novartis rows | Novartis MAE | Novartis RMSE | Literature rows | Literature MAE | Literature RMSE | Exact common-row comparison to ChemDraft? |
|---|---|---:|---:|---:|---:|---:|---:|---|
| **ChemDraft fast aqueous baseline**, artifact hash above | Value at the externally supplied QupKake SDF `idx`; that index is a Marvin assignment. Basic records are first converted to an acid form. This is oracle-site/value-only, not locator or product end-to-end performance. | 276 | 1.193 | 1.853 | 122 | 0.983 | 2.130 | Baseline row set; no competitor predictions paired to it. |
| **QupKake**, 2024 paper/code snapshot; no paper semantic version | Own GFN2-xTB tautomer search, GNN/QM site enumeration, then micro-pKa value prediction. The headline uses QupKake's own selected site. | 280 | 0.55 | 0.79 | Not stated with the metric; 122 in inspected release SDF | 0.39 | 0.54 | No. Different site/task workflow and four additional Novartis rows. |
| **ChemAxon Marvin 20.1.0** | Whole-molecule pKa calculation on the Marvin-prefiltered one-pKa benchmark. Marvin also supplied the site annotation later carried by the QupKake SDF. | 280 | 0.856 | 1.166 | 123 | 0.566 | 0.865 | No. Published aggregates only. |
| **Baltruschat RF**, 2020, seed 24, 1,000 trees, 4,096-bit FCFP6/radius 3 | One macroscopic pKa for structures prefiltered by Marvin to no more than one pKa in the 2–12 window. It is not a site locator and is explicitly limited to monoprotic structures. | 280 | 1.147 | 1.513 | 123 | 0.532 | 0.785 | No. Published aggregates only. |
| **pkasolver-light v0.3** (also spelled `lite` in the repository) | Distributed experimental-only GNN plus Dimorphite-DL state enumeration. The benchmark sets are monoprotic; reported values are medians over 50 train/validation repetitions, with 90% intervals in the paper. | 280 | 0.86 | 1.13 | 123 | 0.56 | 0.82 | No. Different state-generation workflow and aggregation. |
| **pkasolver-epic v0.3 research model** | Epik-generated pretraining followed by experimental fine-tuning; same sequential-state framework. The trained model is not distributed because of Epik's license. | 280 | 0.71 | 0.93 | 123 | 0.52 | 0.82 | No. Non-distributed model and different workflow. |
| **Epik Classic**, Pan/Mayr comparison; exact Epik release not reported | Commercial protonation-state/site workflow. For Novartis, 26/280 molecules whose predicted protonation center differed from the benchmark annotation were removed before scoring. | **254** | 0.83 | 1.16 | 123 | 0.58 | 0.92 | No. Site-disagreement omissions make coverage materially different. |
| **MolGpKa**, 2021 paper/repository snapshot; no formal release number | Separate acidic/basic site-value models using a fixed SMARTS vocabulary of ionizable groups. The comparison is site-specific, but it is not evidence of a complete reaction-event workflow. Mayr reports medians and 90% intervals. | 280 | 0.87 | 1.27 | 123 | 0.49 | 1.00 | No. Different site templates and aggregation. |
| **OPERA 2.5** | Whole-molecule QSAR pKa output. Rows for which OPERA returned zero or two pKa values were omitted: 31 Novartis and 6 literature molecules. | **249** | 2.274 | 3.059 | **117** | 1.737 | 2.182 | No. Lowest coverage in this table and a tool-specific omission rule. |

Primary metric sources are Abarbanel and Hutchison's
[QupKake paper](https://pubs.acs.org/doi/10.1021/acs.jctc.4c00328), Baltruschat and Czodrowski's
[Table 2 and methods](https://f1000research.com/articles/9-113), and Mayr et al.'s
[Table 1](https://www.frontiersin.org/journals/chemistry/articles/10.3389/fchem.2022.866585/full).
The originating QupKake article text gives MAE 0.55/0.39; a later cross-paper table reports 0.58/0.40.
This record uses the originating paper's own values rather than silently mixing the two.
Likewise, the originating Baltruschat paper reports literature RF RMSE 0.785, while Mayr's later
comparison table prints 0.76; this record retains the originating value.

QupKake also reports a useful controlled ablation: forcing its value model to use **Marvin's sites**
raises RMSE from 0.79 to 1.00 on Novartis and from 0.54 to 0.59 on the literature set. That result
quantifies how much site choice can change the apparent value-model score; it does not make
ChemDraft's oracle-site result equivalent to QupKake's pipeline.

### ChemDraft tail record on its own 398 rows

| Set | n | MAE | RMSE | Maximum absolute error | \|error\| > 2 | \|error\| > 3 | \|error\| > 5 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Novartis | 276 | 1.193 | 1.853 | 10.729 | 38 | 25 | 8 |
| Literature | 122 | 0.983 | 2.130 | 9.736 | 15 | 10 | 9 |
| Combined | 398 | 1.129 | 1.942 | 10.729 | 53 | 35 | 17 |

The cited competitor reports do not publish compatible row-level tail distributions, so no competitor
tail ranking is possible from the available evidence.

The RMSE and tail fields are **reconstructed oracle-site aggregates**, not fields silently copied from
the committed MAE-only `external-validation.json`, and not results of the separate end-to-end
structured audit. No raw oracle-site prediction series is committed. They were reproduced on
2026-08-08 from the frozen model and these hash-pinned, non-vendored inputs:

| Input | SHA-256 |
|---|---|
| `novartis_qupkake_pka.sdf` | `dd54fd8e6d2d66d10bd9514e302341b0cda061f60cdceaf87a5e0379d30dd026` |
| `literature_qupkake_pka.sdf` | `9e5199e472f765dcccc7b49d13a19b542b6a381cb5064d5810a35b0e00f3ed0b` |

The exact environment was Python 3.12.0, RDKit 2026.03.5, PyTorch 2.13.0, and NumPy 2.5.1. The
following command recomputes every field in the table directly through the same `sdf_sites`,
site-preserving reparse, ensemble loader, and `predict_site` functions as `external_eval.py`:

```bash
cd packages/rdkit-adapter/vendor/pka-model
PKA_DATA_DIR=/absolute/path/to/QupKake/data
python - "$PKA_DATA_DIR" <<'PY'
import json
import sys
from pathlib import Path
import numpy as np
from external_eval import SETS, sdf_sites
from gnn_infer import load_ensemble, predict_site
from parity_features import kekulized_with_site

members, multiplier = load_ensemble("site-pka-gnn.json")
dataset_dir = Path(sys.argv[1])
all_errors, out = [], {}
for name in SETS:
    errors = []
    path = str(dataset_dir / name)
    for acid, atom, observed in sdf_sites(path):
        mol, site = kekulized_with_site(acid, atom)
        if mol is None:
            continue
        try:
            predicted = predict_site(members, multiplier, mol, site)[0]
        except Exception:
            continue
        errors.append(abs(predicted - observed))
    values = np.asarray(errors, dtype=float)
    out[name] = {
        "n": len(errors),
        "mae": float(np.mean(values)),
        "rmse": float(np.sqrt(np.mean(values ** 2))),
        "maxAbsoluteError": float(np.max(values)),
        "errorGt2": int(np.sum(values > 2)),
        "errorGt3": int(np.sum(values > 3)),
        "errorGt5": int(np.sum(values > 5)),
    }
    all_errors.extend(errors)
values = np.asarray(all_errors, dtype=float)
out["combined"] = {
    "n": len(all_errors),
    "mae": float(np.mean(values)),
    "rmse": float(np.sqrt(np.mean(values ** 2))),
    "maxAbsoluteError": float(np.max(values)),
    "errorGt2": int(np.sum(values > 2)),
    "errorGt3": int(np.sum(values > 3)),
    "errorGt5": int(np.sum(values > 5)),
}
print(json.dumps(out, indent=2))
PY
```

## Tool, dependency, license, and runtime audit

Code licenses, data rights, commercial dependencies, and trained-weight provenance are different
questions. A permissive repository license must not be represented as automatically licensing the
labels used to train its weights.

| Tool | Exact version evidence | Site/state behavior relevant here | Code, data, and model-rights record | Published environment, hardware, and timing |
|---|---|---|---|---|
| **ChemDraft** | Source `029041d3`; model SHA-256 above; four-member ensemble, 96 hidden units, three message-passing layers; pinned RDKit WASM 2026.03.3. | The external accuracy script bypasses event location by supplying `idx`. The product path separately generates candidate events and must be audited separately. | Core repository is [Apache-2.0](../../LICENSE). That does not settle the model artifact: 4,022 QupKake experimental rows are CC BY 4.0; 3,031 Dwar-iBond rows have unresolved data terms; see [`pka-provenance.md`](../../pka-provenance.md). | Local timing record below. No controlled cross-tool run yet. |
| **QupKake** | 2024 JCTC paper and public repository snapshot; the paper does not pin a semantic release and the repository exposes no formal release for the paper edition. | Three-stage tautomer, site, and value workflow using GFN2-xTB plus GNNs. Own-site headline; Marvin-site ablation separately reported. | [Source code is BSD-3-Clause](https://raw.githubusercontent.com/hutchisonlab/QupKake/main/LICENSE). Requirements include Python >=3.9, PyTorch >=2.0, PyTorch Geometric >=2.3, Lightning >=2.0.2, RDKit >=2022.03.03, and xTB 6.4.1. The code license alone does not answer the redistribution/provenance question for ChemAxon-generated training labels or derived weights. | Paper: 280 Novartis molecules, 10 trials, 3.85 GHz AMD EPYC 9374F, 32-core shared-memory server. End-to-end means tautomer search, xTB features, model, Python overhead, and RDKit descriptors. 2.36 s/mol at 1 core; 1.40 at 2; 0.87 at 4; 0.67 at 8. |
| **Marvin** | Version 20.1.0 is explicit in Baltruschat Table 2. | Produces pKa values and atom/site assignments; also used to filter the benchmark to no more than one pKa from 2–12. | Proprietary ChemAxon software. The [calculator licensing documentation](https://docs.chemaxon.com/latest/calculators_licensing.html) confirms that batch `cxcalc` calculations require appropriate licensing. | Java/`cxcalc`; benchmark hardware and prediction timing were not reported. |
| **Baltruschat RF** | Paper model: seed 24, 1,000 estimators, FCFP6 4,096 bits/radius 3. | Whole-molecule, one-pKa regressor for the Marvin-filtered monoprotic domain. Data preparation used Marvin and, by default, OpenEye QUACPAC; the public scripts offer an RDKit `--no-openeye` path. | [Software is MIT; repository datasets are declared CC BY 4.0](https://github.com/czodrowskilab/Machine-learning-meets-pKa). Marvin and OpenEye remain separately licensed preprocessing dependencies. The repository requires retraining before prediction. | Public environment: Python >=3.7, NumPy >=1.18, scikit-learn >=0.22, RDKit >=2019.09.3, pandas >=0.25, XGBoost >=0.90. Training script defaults to 12 CPU processes. Published inference timing/hardware were not reported. |
| **pkasolver** | Paper/package release v0.3. | Dimorphite-DL identifies ionizable centers and enumerates protonation states; the GNN predicts steps connecting states. The authors state that distributed `light` is limited to monoprotic molecules. | [Code and distributed light model are MIT](https://github.com/mayrf/pkasolver). The authors do not distribute `pkasolver-epic` weights because of Epik's restrictive license; recreating them requires an active Epik license. | Python GNN stack; no inference timing or benchmark hardware reported in the cited paper. |
| **Epik Classic** | Pan/Mayr benchmark names Epik Classic but does not report an exact release number. This must not be relabeled as current Epik or Epik v7. | Commercial site/state enumeration and pKa prediction; 26 Novartis site disagreements were excluded. | Proprietary Schrödinger software under the [Schrödinger EULA](https://www.schrodinger.com/eula/). | Benchmark timing/hardware not reported. Current product documentation is not evidence of the historical benchmark's exact runtime or implementation. |
| **MolGpKa** | 2021 JCIM paper and public repository snapshot; no formal release number. | Separate acid/base GNNs centered on SMARTS-recognized ionizable groups. | [Repository code and weights are MIT](https://github.com/Xundrug/MolGpKa), but the paper says training used ACD/pKa values for 1.6 million ChEMBL compounds. The MIT code license is not, by itself, a grant over those proprietary calculated labels or derived-weight provenance. | Repository environment: Python 3.6, PyTorch >=1.4, PyTorch Geometric, RDKit, scikit-learn 0.21.3, NumPy 1.18.1, pandas 0.25.3. No published comparison timing/hardware. |
| **OPERA** | Version 2.5 in Baltruschat Table 2. | Whole-molecule open QSAR application. Returning zero or two pKa values caused 37 benchmark omissions. | [MIT-licensed source](https://github.com/kmansouri/OPERA); public Windows/Linux GUI and CLI. OPERA describes its models/data as open, but any redistribution should still preserve the included source/data notices rather than infer data rights from the MIT code file alone. | No prediction timing/hardware reported for the cited comparison. |

The MolGpKa model description and 1.6-million-label source are in the
[primary JCIM paper](https://pubs.acs.org/doi/10.1021/acs.jcim.1c00075). OPERA's pKa methodology is
described in its [2019 open QSAR paper](https://doi.org/10.1186/s13321-019-0384-1). Current vendor pages
are cited only for licensing/product status, never to backfill a historical benchmark version.

## Runtime record: what can and cannot be claimed

### ChemDraft local measurements

Hardware: MacBook Pro `MacBookPro18,3`, Apple M1 Pro, 10 cores (8 performance + 2 efficiency),
16 GB RAM, macOS 26.5.2 arm64. Runtime: Node 26.3.0, pnpm 10.12.1, Vitest 3.2.4, warm RDKit WASM
2026.03.3. The JavaScript tool versions were rechecked live with `node --version`, `pnpm --version`,
and `pnpm exec vitest --version` on the evidence date.

- **Known-site model-forward timing:** the protocol recorded in
  [`pka-experiment-ledger.md`](../../pka-experiment-ledger.md) used 25 timed repetitions after warm-up
  and gave 2.14 ms for acetic
  acid, 6.05 ms for caffeine, 6.19 ms for ibuprofen, and 9.99 ms for a piroxicam-like structure. This
  is the oracle-site model operation, not a product prediction.
- **End-to-end product-path timing:** an uncommitted 2026-08-08 SAMPL6 harness ran 24 molecules, three
  repetitions each, after WASM warm-up. A fresh current-HEAD run gave median 94.78 ms/molecule, mean
  155.43, and range 32.25–951.83. An earlier same-day run gave median 167.89, mean 297.04, and range
  48.63–1,836.98. The spread demonstrates system-load and molecule-complexity sensitivity; these
  figures should not be marketed to more precision than the protocol supports.

The end-to-end harness exercises `analyzeStructure`, not the 398-row oracle-site script. It uses a
different 24-molecule set and its accuracy depends on how generated titration steps are matched to
experimental targets, so its timing cannot be coupled to the Novartis/literature accuracy table.

### QupKake published measurement

QupKake's 2.36 s/molecule single-core figure is a published end-to-end timing on all 280 Novartis
molecules and includes the method's QM work. Its AMD server, molecule set, Python/xTB process model,
and output workflow differ from the ChemDraft local harness.

**Allowed claim:** ChemDraft's current local product path is typically sub-second on the recorded M1
Pro harness, while QupKake reports seconds per molecule for its more computationally intensive
workflow.

**Not allowed:** “200–1000x faster,” or any exact speedup factor. A controlled same-input,
same-hardware, same-thread, same-output benchmark has not been run.

## What the present evidence supports

- On their respective reported subsets, ChemDraft's aggregate MAE and RMSE are lower than OPERA 2.5's
  published values and higher than the other cited tools. Because OPERA omits 37 rows and no paired
  predictions exist, even that is an aggregate, not a molecule-paired superiority claim.
- ChemDraft's biggest measured deficiency is its error tail: combined MAE 1.129 but RMSE 1.942, with
  17/398 errors above five pKa units. Competitor aggregate tables do not reveal whether failures occur
  on the same molecules.
- QupKake's headline is stronger accuracy on a broader workflow than ChemDraft's oracle-site test, but
  it pays for QM calculations and carries a training-label/weight provenance question that its
  BSD-3-Clause code license does not answer.
- “Free,” “open source,” “commercial,” and “redistributable trained artifact” are not synonyms.
  Baltruschat RF, pkasolver-light, MolGpKa, QupKake, and OPERA all expose source, but their data,
  preprocessing dependencies, and weight provenance differ.

## Requirements for the next defensible benchmark

Before publishing a ranked comparison, the benchmark must produce a row-level manifest for every tool
and lock all of the following:

1. The same input representation, salt policy, tautomer/protomer starting state, aqueous target
   definition, and pH window.
2. The same original row IDs and exact intersection; omissions must count as failures or be reported as
   coverage, not silently removed.
3. Separate scores for oracle-site value prediction, site/event generation, and full end-to-end target
   matching.
4. For each molecule, whether the labeled event was generated, extra events, selected site, predicted
   value, interval, and runtime.
5. MAE, RMSE, median absolute error, 90th/95th/99th percentile error, maximum error, and counts above
   fixed thresholds.
6. Same hardware, thread count, warm-up, molecule order, repetitions, timeout policy, and whether model
   load/tautomer/QM overhead is included.
7. Exact software commit/release, model hash, dependency lock, code license, data license, and trained
   weight provenance.

Until that record exists, this document is the comparison boundary: it permits source-backed context,
but not a single ranked leaderboard or an exact speed/accuracy superiority claim.
