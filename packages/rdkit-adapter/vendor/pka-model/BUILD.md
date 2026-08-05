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
| `external-validation.json` | 443 | `011ae99537605834a3acc8f074308a16e033fe23dbc1a01157ab4a695f2df418` |
| `hammett-sigma.json` | 2,833 | `3f1bbd785d8fd7189f898240d2b0ce1d98efd24d9749e27b291d1f97d8ee6bf0` |
| `interval-calibration.json` | 2,164 | `b6134a801bd1aed1e18d355f9b8c36dab4a91acfd9b0239d6da01fe5076c481a` |
| `site-pka-gnn.json` | 4,468,866 | `79061c4d3b4e11753c865088e5bb38d0c7e689e6e394af4fdf99c0dcfcfca688` |

**Manifest:** `13757541703304372bf2aaf0ccba19e14bf62bbc98e9bd92878e6aa5cfa18ac5`

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

## A measured improvement that is not applied here

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

Width is worth 6.6% for 2.7x the parameters. Depth buys almost nothing, a longer schedule buys half of
what width does, and all three together are *worse* than width alone — so the big configuration is
overfitting rather than short of capacity, which is what says this is an optimum and not "bigger is
better".

**It is not applied because one artifact cannot be regenerated here.** `external-validation.json` is the
only figure in this directory not measured on the training corpus, and it needs the Novartis and
literature SDFs that ship with QupKake (`Shualdon/QupKake`, BSD-3-Clause, `qupkake/data/`). Those are not
vendored and are not on the machine this was measured on. Shipping a wider model without regenerating it
would leave the contract quoting a held-out figure belonging to a different model — precisely the silent
wrong-provenance failure the manifest above exists to prevent.

To apply it, in a checkout that has the QupKake data:

```bash
# 1. one line
sed -i '' 's/^HIDDEN = 96$/HIDDEN = 160/' pka_gnn.py

# 2. every dependent artifact, in order
./run_all.sh <dwar-labels.json> <qupkake>/qupkake/data [pkachu.csv] [D2A-pKa.csv]

# 3. the manifest moves; the test names which file and prints the new digest
pnpm vitest run packages/rdkit-adapter/src/methods.test.ts
```

Then update `PINNED_PKA_MODEL_SHA256`, the per-file rows above, and the figures the contract quotes.
The gate to check before believing the result is `macroscopicFold.real.test.ts` — in particular "the
cycle defect as a corpus gate", which is what caught the last candidate that improved every per-site
number while destroying the macroscopic ones.
