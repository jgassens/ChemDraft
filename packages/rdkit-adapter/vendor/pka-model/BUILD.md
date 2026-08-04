# Vendored pKa artifacts

The files here decide every pKa the app reports. They are generated, not hand-written — regenerate with:

```
PYTHON=/path/to/python ./run_all.sh <dwar-ibond-labels.json> <qupkake-data-dir>
```

and then run `python3 macro_validate.py` for the macroscopic yardstick.

## Pinned artifacts

Five of these are loaded at RUNTIME; `external-validation.json` is read by the contract so its figure
cannot go stale. Everything else in this directory is a build input or a test fixture and is excluded
from the pin deliberately: fixtures gate the build, they do not produce a number.

| file | bytes | sha256 |
|---|---:|---|
| `calibration.json` | 1,793 | `89cc2246d68166a3e1b0549554a3af01cdb9edc437ed6f87541bc5bd35a3227b` |
| `consensus-calibration.json` | 612 | `1892f17ab1800ba672926689f467c59914647dc93a7e4c35856fcddaef3846b1` |
| `coupling.json` | 1,119 | `a054f749b30f8b3636ade37eac26842bbe321bd79c81906e0a6007e34d3b970e` |
| `external-validation.json` | 445 | `2d8cb8cd06110c5ec915e95db698bdc19ec6954c8ccb9ab34265abb7747f27b0` |
| `hammett-sigma.json` | 2,833 | `3f1bbd785d8fd7189f898240d2b0ce1d98efd24d9749e27b291d1f97d8ee6bf0` |
| `site-pka-forest.json` | 3,642,881 | `9fbef9a6dbd30c936b7f85ddd2ad6d79f80e5b8bc791d03ffaf21e9462aaade3` |

**Manifest:** `68ea7c7335ac644060112526c858ad665444b04921efeff85cc7874ed8bde8b9`

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
| `site-pka-forest.json` | the trained random forest — every per-site value |
| `calibration.json` | how tree disagreement maps to a reported interval |
| `consensus-calibration.json` | how the model and the Hammett relationship are weighted against each other |
| `coupling.json` | `W`, the electrostatic term across acid/base site pairs |
| `hammett-sigma.json` | rho and every sigma for the four series |
| `external-validation.json` | the held-out figure the contract quotes |

## Training data

Not vendored — the corpus is rebuilt from its two upstream sources by `run_all.sh`. Both are named,
with their licences and obligations, in the method contract's `datasets` and in
`docs/architecture/dependency-inventory.md`.
