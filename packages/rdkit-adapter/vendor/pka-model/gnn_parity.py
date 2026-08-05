"""Emit the fixture that holds `pkaGnn.ts` to what PyTorch computes.

This file exists because the fixture did not have one. It was produced by hand once, which meant that
every later change to inference — the interval calibration was the one that exposed it — left the
fixture pinning arithmetic nothing regenerated. A fixture nobody can rebuild stops being a check and
becomes a number to edit until the test passes.

Emitted from the ROUNDED weights that ship, not the training-time tensors, so what is pinned is what
TypeScript will actually read. The molecules deliberately cover the cases where the two sides could
disagree rather than the chemistry that matters most:

  - a carboxylic acid and a phenol, the ordinary path
  - fused and single heteroaromatics, where the Kekule structure RDKit-python picks differs from
    MinimalLib's and a per-BOND feature would diverge (this has been shipped wrong five times)
  - a charged site, exercising the charge one-hot's offset
  - biphenyl, whose central bond joins two ring atoms and lies in no ring

    python3 gnn_parity.py site-pka-gnn.json gnn-parity-fixture.json
"""
import json
import sys

from rdkit import RDLogger

from gnn_infer import load_ensemble, predict_site
from parity_features import kekulized

RDLogger.DisableLog("rdApp.*")

CASES = [
    ("CC(=O)O", 2),                      # carboxyl oxygen
    ("Oc1ccccc1", 0),                    # phenol
    ("c1ccncc1", 3),                     # pyridine nitrogen
    ("c1cc[nH]c1", 3),                   # pyrrole-type nitrogen
    ("c1c[nH]cn1", 3),                   # imidazole, two ring nitrogens
    ("c1ccc2[nH]ccc2c1", 4),             # indole, fused
    ("c1ccc2ncccc2c1", 4),               # quinoline, fused with a basic nitrogen
    ("C[NH3+]", 1),                      # charged site
    ("c1ccc(-c2ccccc2)cc1", 0),          # biphenyl: ring atoms, non-ring bond
    ("NC(=O)N", 0),                      # urea
    ("CS(=O)(=O)N", 4),                  # sulfonamide
    ("OC(=O)c1ccccc1", 1),               # benzoic acid
]


def main(model_path, out_path):
    members, interval_at = load_ensemble(model_path)
    out = []
    for smiles, site in CASES:
        mol = kekulized(smiles)
        if mol is None or site >= mol.GetNumAtoms():
            raise SystemExit(f"unusable parity case: {smiles} at {site}")
        value, spread = predict_site(members, interval_at, mol, site)
        out.append({
            "smiles": smiles,
            "site": site,
            "prediction": round(value, 6),
            "spread": round(spread, 6),
        })
    json.dump(out, open(out_path, "w"), indent=1)
    print(f"wrote {len(out)} parity cases")
    for row in out:
        print(f"   {row['smiles']:24s} @{row['site']:<3d} {row['prediction']:9.4f} "
              f"+/- {row['spread']:.4f}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
