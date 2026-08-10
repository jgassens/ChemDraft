# Vendored pKa artifacts

The files here decide every pKa the app reports. They are generated, not hand-written — regenerate with:

```
PYTHON=/path/to/python ./run_all.sh <dwar-ibond-labels.json> <qupkake-data-dir>
```

and then run `python3 macro_validate.py` for the macroscopic yardstick.

### Regeneration is reproducible — as of the determinism back-port, and not before it

`pka_gnn.py` writes `site-pka-gnn.json`, the weights the app ships, and until now two runs of the same
command produced **different weights**. Seeds were not the cause: multi-threaded CPU reductions sum
partial results in completion order, and MPS atomics do the same on the GPU, so each step differs by
about 1e-8 and training amplifies that chaotically. The script also never reseeded numpy per ensemble
member, so every member inherited wherever the previous one left the global stream — and because
`main()` runs the full cross-validation *before* the exported fit, roughly 1,200 shuffles preceded the
weights that ship.

`pka_gnn_pair.py` was fixed for all three months ago; the file that actually produces the artifact was
not. It now is: `torch.set_num_threads(1)`, `preferred_device()` returning CPU, and `np.random.seed(seed)`
per member. Verified by hashing the trained state dict of two ensemble members across separate
processes:

| configuration | run 1 | run 2 |
| --- | --- | --- |
| cpu / 1 thread / per-member reseed (**now**) | `5d61cfdf` `05309b2d` | `5d61cfdf` `05309b2d` |
| mps / 8 threads / no reseed (**before**) | `8a8e3f16` `10d96449` | `de9652ab` `38256751` |

CPU at one thread is also **~4.4x faster** than the MPS default here — these molecules are 16 to 28
atoms, far too small to repay GPU dispatch or thread setup. `determinism_probe.py` reproduces the
underlying device/thread table.

**What this does not do:** it makes FUTURE runs reproducible. The committed `site-pka-gnn.json` was
trained before the fix and cannot be regenerated bit-for-bit; a rebuild produces a different, and from
here on a stable, artifact.

## Pinned artifacts

Five of these are loaded at RUNTIME. `site-pka-forest.json` is NOT among them any more and is not pinned: the network replaced it, and the forest stays committed only as the baseline the comparison is made against.

Five of these are loaded at RUNTIME; `external-validation.json` is read by the contract so its figure
cannot go stale. Everything else in this directory is a build input or a test fixture and is excluded
from the pin deliberately: fixtures gate the build, they do not produce a number.

| file | bytes | sha256 |
|---|---:|---|
| `calibration.json` | 2,033 | `3d64b8fef63d948ef1412b695c15f3422d30fd1e9e27190fa13d5679ef9b5a16` |
| `consensus-calibration.json` | 645 | `4093caf1b36a26dd2d54ebe5426653f8c659035709ff08c4a861a94f39bfaf2b` |
| `coupling.json` | 1,402 | `796b5647a0d1b8a49b535ab70bbcd2430ab6ce8997ed50473580a3fed5e775ae` |
| `edge-variance.json` | 1,932 | `b211b75f6ba82d6750d91e876a338a7c760bd63aa22562aff007e1cfa374d568` |
| `external-validation.json` | 545 | `c376b56ac96eb8044a7534fd5e5f03630478d3fc63873086312a25b6a810f446` |
| `hammett-sigma.json` | 2,833 | `3f1bbd785d8fd7189f898240d2b0ce1d98efd24d9749e27b291d1f97d8ee6bf0` |
| `interval-calibration.json` | 5,000 | `98e1b08af34b18522cfe5e81ef037ca3e4a206fee41fe7247b8f21c7cead4c18` |
| `site-pka-gnn.json` | 4,469,996 | `100f90cbe4d63222f12fc69cebef57800fd7584d440eea1fd9dd16f39714578b` |

**Manifest:** `3c3dbeceaa66d62c7860ce81c47cd8a81a5ef0f4ad069c4eee4be3def016ce4a`

The manifest moved without the MODEL moving. `site-pka-gnn.json` is byte-identical at
`79061c4d…`; what changed is `external-validation.json`, which gained a per-set RMSE so the contract can
state this method against published competitor tables that report RMSE. The manifest covers every runtime
artifact precisely so that a measurement record cannot drift out from under a published figure unnoticed —
this is that guard firing, not a retrain.

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
| SAMPL6 within one log unit | **87%** | 90% |
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

## The fold split changed, and the committed artifacts predate it

`cross_validate` assigned folds by `i % folds` over the sorted scaffold list, which makes a scaffold's
fold depend on **how many scaffolds sort before it** — so changing the corpus reshuffles the split. It
now hashes the scaffold string instead, so each group's fold is independent of every other and a corpus
experiment compares like with like.

This was found the hard way. Testing a prune of 100 labels, 47 scaffold groups disappeared and **96.3% of
the 11,996 surviving rows landed in a different held-out fold**; the prune measured 0.0402 *better* on its
target metric under the old split and 0.0278 *worse* under the stable one. A 0.068 swing from the
partition alone, against a retrain noise floor of 0.0017 overall. See `carbon_prune.py`.

**Every figure quoted above and in the method contract was measured under the OLD split, and the
committed artifacts were trained under it.** Nothing recomputes them, so nothing is inconsistent today —
but the next `run_all.sh` will produce a model cross-validated on the stable split, where the full corpus
scores **cvMAE 0.7356** rather than 0.7281.

**That 0.0075 is a partition artifact and not a regression, and the external set proves it rather than
asserting it.** The same full corpus trained under each split scores, on the 398 held-out rows:

| split | cvMAE | external MAE |
|---|---|---|
| old, `i % folds` (shipped) | 0.7281 | 1.1286 |
| stable, hashed scaffold | 0.7356 | **1.1287** |

Paired over the same rows the external difference is +0.0001, t = 0.00, 197 rows worse against 201
better — statistically indistinguishable. So the stable split reports a slightly harder number for the
same real-world accuracy, which is what a split that cannot be reshuffled by the corpus costs. Update the
figures on the next regeneration and read the cvMAE change as a change of yardstick.

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
