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
| `calibration.json` | 2,033 | `97e22ad18533a8751fa46ca8dd00b4e4923bde517f7016032c99d8093031de01` |
| `consensus-calibration.json` | 612 | `4a77156b7521f6b5961bd1c6d37e5362ac7bb832f58eaeadbcf7aa3b1f8b9035` |
| `coupling.json` | 1,406 | `e8510371ceb9e6c3ded4b55395743b41f398f9ceba6654e802ffc7fa433d7fa4` |
| `external-validation.json` | 445 | `781574f901ece3214ad2602fc46ba8171452866d70237065eda65115c3576c64` |
| `hammett-sigma.json` | 2,833 | `3f1bbd785d8fd7189f898240d2b0ce1d98efd24d9749e27b291d1f97d8ee6bf0` |
| `site-pka-forest.json` | 5,776,765 | `3b23f40af468e32243b1457c6b757e1592216bffb0e988df449f4944aee84bc2` |

**Manifest:** `4196aad4ecfb3ed008bf5042c943462e2011f37892cd5e80516d8632511fe884`

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
