# Native RDKit stereo oracle (dev-only)

The **independent external judge** for the 3D-spin → flatten validation corpus
(`docs/architecture/3d-spin-flatten.md`, Phase 1C). It uses **native/Python RDKit**
— a different engine and a different code path from our own flatten/wedge math — to
confirm that a flattened 2D depiction encodes the same chirality the 3D conformer
actually has. Without an independent judge, OpenChemLib could generate a conformer
*and* partially validate its own output (the "correlated failure" the roadmap warns
about).

## This is not the product engine

| Role | Engine | Ships? |
|---|---|---|
| Product v1 candidate | OpenChemLib JS | yes (lazy core adapter) |
| Product fallback | custom single-thread RDKit-WASM | maybe (spike pending) |
| **Dev oracle (this)** | **native/Python RDKit (isolated venv)** | **never** |
| Later desktop high-fidelity | native RDKit sidecar | only if needed |

Stock `@rdkit/rdkit` WASM is **not** this and is **not** a 3D engine — that published
build exposes no conformer/MMFF/UFF surface (2D only). This oracle is the full
native RDKit, run only on a developer's machine.

## Setup (isolated, reversible)

```bash
tools/rdkit-oracle/setup.sh        # creates ./.venv-rdkit-oracle (gitignored)
# teardown:
rm -rf .venv-rdkit-oracle
```

`rdkit` is pinned in `requirements-rdkit-oracle.txt` so the judge can't drift. Only
the requirements file + this bridge are committed — never the venv.

## Contract & guardrails

- `oracle.py` reads **one JSON request from stdin**, writes **one JSON object to
  stdout**. No file-system access, no shell, no network.
- It builds molecules **from the request** (throwaway copies) and runs
  `AssignStereochemistryFrom3D` only on those copies — it can never overwrite a
  caller's product molecule's stereo.
- `client.ts` is **dev/test tooling**, never imported by app runtime. It spawns the
  bridge with a fixed argument array (no shell interpolation).
- If the venv is absent, `isOracleAvailable()` is false and harnesses **skip**
  rather than fail (CI without RDKit still passes).

## Operations

`perceiveFrom3D` — CIP descriptors from 3D coordinates (`AssignStereochemistryFrom3D`).
`perceiveFrom2D` — CIP descriptors from 2D coordinates + wedge/hash bond flags (the
depiction path, via RDKit's molblock wedge perception). The corpus cross-check asks
both and asserts they agree at every center the flatten *encoded*.
