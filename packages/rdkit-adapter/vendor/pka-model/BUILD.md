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
| `calibration.json` | 2,031 | `a361085c2ed1dd274f630f5266a94a2b6411cd915d815bad937f24aaf6666abc` |
| `consensus-calibration.json` | 615 | `f440fe2b9e4eb1a26dcd2f2ec1724bcc2a4a6225aada4616f99cd664e4f9ec8a` |
| `coupling.json` | 1,406 | `e2288dd3f3f6bbc71b306dd441500a0d1507ca478501b4d10a428c105c57f40a` |
| `external-validation.json` | 445 | `a97a7e5036e15dd9f3615335b393489dfcf6ab412186fefdbeecbb3f46c5ae7b` |
| `hammett-sigma.json` | 2,833 | `3f1bbd785d8fd7189f898240d2b0ce1d98efd24d9749e27b291d1f97d8ee6bf0` |
| `site-pka-forest.json` | 6,027,550 | `3bf2cba69596ff7f0e9b4b35e73dc7ac40780e93266c3202666a5933c35bfa04` |

**Manifest:** `1e857f7c15de1a2855d4404e868f1e9c3f8e78e6ec7437d17d3f5808e87732fd`

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
