# Vendored pKa artifacts

The files here decide every pKa the app reports. They are generated, not hand-written — regenerate with:

```
PYTHON=/path/to/python ./run_all.sh <dwar-ibond-labels.json> <qupkake-data-dir>
```

and then run `python3 macro_validate.py` for the macroscopic yardstick.

## Pinned artifacts

Five of these are loaded at RUNTIME. `site-pka-forest.json` is NOT among them any more and is not pinned: the network replaced it, and the forest stays committed only as the baseline the comparison is made against.

Five of these are loaded at RUNTIME; `external-validation.json` is read by the contract so its figure
cannot go stale. Everything else in this directory is a build input or a test fixture and is excluded
from the pin deliberately: fixtures gate the build, they do not produce a number.

| file | bytes | sha256 |
|---|---:|---|
| `calibration.json` | 2,031 | `a361085c2ed1dd274f630f5266a94a2b6411cd915d815bad937f24aaf6666abc` |
| `consensus-calibration.json` | 645 | `4ae25e83d82b639d4c27371154fd6571aad135a485fc208f2ee4e1032f1cd62d` |
| `coupling.json` | 1,404 | `1bc2015011408924f2fee6cc17785032766bf64be9d8fa3ac4c22bd1a607bcac` |
| `edge-variance.json` | 1,933 | `9ea690378841c9cb7f6103c164a3c96f4b46809df7a722d2fe549aaa2afb84e8` |
| `external-validation.json` | 458 | `37981664695db5486231d884cb2ee8394640ac0c60a6e93fd20852040decaeb8` |
| `hammett-sigma.json` | 2,833 | `3f1bbd785d8fd7189f898240d2b0ce1d98efd24d9749e27b291d1f97d8ee6bf0` |
| `interval-calibration.json` | 2,164 | `b6134a801bd1aed1e18d355f9b8c36dab4a91acfd9b0239d6da01fe5076c481a` |
| `site-pka-gnn.json` | 4,468,866 | `79061c4d3b4e11753c865088e5bb38d0c7e689e6e394af4fdf99c0dcfcfca688` |

**Manifest:** `e52766f5cf959549f8ad849e31a97fbc6f827af8af12242ad389db87237ec233`

The manifest is sha256 over the lines `${filename}  ${sha256hex}\n` with filenames sorted, so one
constant covers the set and a failure can still name which file moved.

**When you regenerate any of these, update this table, the manifest, and
`PINNED_PKA_MODEL_SHA256` in `packages/rdkit-adapter/src/methods.ts` in the same change.**
`methods.test.ts` checks all three against each other — the prose here, the constant in the source,
and the bytes on disk — so no two can drift apart without failing. That is the same three-witness
arrangement the RDKit wasm pin uses, and it exists because these artifacts previously appeared in no
run fingerprint at all: two builds could produce different numbers and report identical provenance.

## What is in each

| file | what it decides |
|---|---|
| `site-pka-gnn.json` | the trained message-passing ensemble — every per-site value |
| `calibration.json` | how tree disagreement maps to a reported interval |
| `consensus-calibration.json` | how the model and the Hammett relationship are weighted against each other |
| `coupling.json` | `W`, the electrostatic term across acid/base site pairs |
| `edge-variance.json` | how much each rung is believed when the microstate ladder is solved |
| `interval-calibration.json` | how ensemble disagreement becomes the reported interval |
| `hammett-sigma.json` | rho and every sigma for the four series |
| `external-validation.json` | the held-out figure the contract quotes |

## Training data

Not vendored — the corpus is rebuilt from its two upstream sources by `run_all.sh`. Both are named,
with their licences and obligations, in the method contract's `datasets` and in
`docs/architecture/dependency-inventory.md`.

## A measured improvement, measured again, and rejected

`capacity_sweep.py` measured what the network's size is worth, one scaffold-grouped held-out fold per
configuration:

| configuration | MAE | RMSE | params |
|---|---|---|---|
| predict the mean | 2.4262 | | |
| baseline `H96 L3 E60` | 0.8190 | 1.3476 | 106,561 |
| **wider `H160 L3 E60`** | **0.7650** | **1.2673** | 290,241 |
| deeper `H96 L5 E60` | 0.8099 | 1.3298 | 163,201 |
| longer `H96 L3 E150` | 0.7759 | 1.2852 | 106,561 |
| big `H160 L5 E150` | 0.7777 | 1.2922 | 446,081 |

Width is the axis that pays; depth buys almost nothing, and all three together are *worse* than width
alone, so the big configuration is overfitting rather than short of capacity.

**Then `HIDDEN = 160` was cross-validated properly, and then measured on data it had never seen, and the
second measurement reversed the first.**

| measure | shipped `H96` | `H160` |
|---|---|---|
| cvMAE (5 scaffold folds, 4 members) | 0.7281 | **0.7156** |
| **external, 398 held-out rows** | **1.1286** | 1.1691 |
| curated 16 molecules | 0.295 | **0.246** |
| curated zwitterions | **0.165** | 0.232 |
| `macro_validate` zwitterionic | **0.130** | 0.22 |
| `macro_validate` azole | 0.212 | **0.15** |
| SAMPL6 matched | 0.491 | **0.480** |
| SAMPL6 within one log unit | **94%** | 90% |
| SAMPL6 extra steps | 49 | 49 |
| artifact | **4.5 MB** | 12.2 MB |

Better on every scaffold-grouped fold and **worse on data it has never seen** — 1.1286 to 1.1691, a 3.6%
regression on the only figure in this directory not measured against the training corpus. That is the
signature of overfitting which scaffold grouping is supposed to prevent and evidently does not fully.
Add a 40% regression on zwitterions and 2.7x the bytes to parse at startup, and it is a clear no.

**Rejected, and the rejection is the point.** Two of the three figures that favoured it —
cross-validation and the curated macroscopic set — are measured on molecules related to the training
corpus. The external set is not, and it is the one that decides. Nothing else here would have caught it:
shipping on the cvMAE would have shipped a worse model under a better-looking number.

`HIDDEN` stays 96. To re-examine the question, edit one line, run `run_all.sh`, and read
`external-validation.json` before anything else.

## Regenerating the external figure

`external-validation.json` is the only artifact here whose input is not vendored. The Novartis and
literature sets ship with QupKake (`Shualdon/QupKake`, BSD-3-Clause) in `data/` at the repository
**root** — *not* `qupkake/data/`, which holds only a cookiecutter template README, and which this
directory pointed at until it was actually fetched. Three files, about 10 MB:

```bash
mkdir -p qupkake-data && cd qupkake-data
for f in novartis_qupkake_pka.sdf literature_qupkake_pka.sdf exp_training_data.sdf; do
  curl -sSL -o "$f" "https://raw.githubusercontent.com/Shualdon/QupKake/main/data/$f"
done
```

Then `python3 external_eval.py <that-dir> .`. Against the shipped model it reproduces 1.1286 over 398
rows byte for byte, which is the check that the environment and the data are the ones the figure was
measured with.

## Applying a retrained model

```bash
./run_all.sh <dwar-labels.json> <qupkake-data-dir> [pkachu.csv] [D2A-pKa.csv]
pnpm vitest run packages/rdkit-adapter/src/methods.test.ts   # names the moved file, prints the digest
```

Then update `PINNED_PKA_MODEL_SHA256`, the per-file rows above, and the figures the contract quotes.
Two gates to read before believing any candidate: `external-validation.json`, which overruled
cross-validation on the width question above, and `macroscopicFold.real.test.ts` — in particular "the
cycle defect as a corpus gate", which caught a corpus that improved every per-site number while
destroying the macroscopic ones.
