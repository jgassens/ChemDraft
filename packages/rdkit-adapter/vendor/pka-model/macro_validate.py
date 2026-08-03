"""Macroscopic pKa accuracy, measured against tabulated titration values.

Everything the site model predicts is MICROSCOPIC: one atom, one proton. A titration curve is not --
it reports macroscopic constants, which are what reference tables list. `protonation.ts` folds the
microstate ladder into those, and this script is the yardstick for that fold.

It exists because the earlier version of this measurement lived in a throwaway script, so the figure
quoted in PLANS.md could not be reproduced or re-checked -- the same way `pka_train.py` went unvendored
long enough for a broken cross-validation grouping to survive unnoticed. Every number this project
publishes should be regenerable by running something in this directory.

    python3 macro_validate.py

Reference values are the standard tabulated macroscopic constants (CRC, 25 C, dilute aqueous). Where a
molecule has more sites than tabulated values, only the tabulated ones are compared -- the extra
predictions are reported but not scored, because there is nothing to score them against.
"""

import sys

import numpy as np

from coupling_fit import conjugated_pairs, distances, load_forest, macroscopic, sites_of
from parity_features import kekulized

# (name, SMILES, tabulated macroscopic pKa, class)
#
# "independent" means the ionizable groups are the same kind -- two carboxyls, two amines -- so the
# only interaction is electrostatic. "zwitterionic" means the molecule carries an acid AND a base, and
# so passes through a neutral form the microscopic labels never contain. "azole" means two ring
# nitrogens sharing one proton between them, where the enumeration must not build the ylide.
SET = [
    ("piperazine", "C1CNCCN1", [5.35, 9.73], "independent"),
    ("ethylenediamine", "NCCN", [6.85, 9.93], "independent"),
    ("1,3-diaminopropane", "NCCCN", [8.64, 10.62], "independent"),
    ("oxalic acid", "OC(=O)C(=O)O", [1.25, 4.14], "independent"),
    ("malonic acid", "OC(=O)CC(=O)O", [2.83, 5.69], "independent"),
    ("succinic acid", "OC(=O)CCC(=O)O", [4.21, 5.64], "independent"),
    ("glutaric acid", "OC(=O)CCCC(=O)O", [4.34, 5.41], "independent"),
    ("adipic acid", "OC(=O)CCCCC(=O)O", [4.43, 5.41], "independent"),
    ("phthalic acid", "OC(=O)c1ccccc1C(=O)O", [2.89, 5.51], "independent"),
    ("glycine", "NCC(=O)O", [2.35, 9.60], "zwitterionic"),
    ("alanine", "CC(N)C(=O)O", [2.34, 9.69], "zwitterionic"),
    ("aspartic acid", "NC(CC(=O)O)C(=O)O", [1.99, 3.90, 9.90], "zwitterionic"),
    ("histidine", "NC(Cc1c[nH]cn1)C(=O)O", [1.85, 6.00, 9.25], "zwitterionic"),
    ("imidazole", "c1c[nH]cn1", [6.95, 14.4], "azole"),
    ("pyrazole", "c1cc[nH]n1", [2.49, 14.2], "azole"),
]

W = 6.0


def run(drop_tautomer_states=True, w=W):
    predict = load_forest()
    rows = []
    for name, smiles, observed, kind in SET:
        mol = kekulized(smiles)
        sites = sites_of(mol)
        got = macroscopic(mol, sites, predict, w, distances(mol), 1.0, drop_tautomer_states)
        n = min(len(got), len(observed))
        errors = [abs(got[i] - observed[i]) for i in range(n)]
        rows.append((name, kind, got, observed, errors, len(conjugated_pairs(mol, sites))))
    return rows


# The three columns PLANS.md publishes, each regenerable here rather than quoted from an old run.
# "raw" is the fold with neither correction: no electrostatic coupling (W = 0) and the ylide microstates
# left in. Each column then adds one thing.
VARIANTS = [
    ("raw ladder", dict(w=0.0, drop_tautomer_states=False)),
    ("+ coupling", dict(w=W, drop_tautomer_states=False)),
    ("+ tautomer exclusion", dict(w=W, drop_tautomer_states=True)),
]


def main():
    both = {name: run(**kwargs) for name, kwargs in VARIANTS}

    final = both["+ tautomer exclusion"]
    print(f"{'molecule':20s} {'class':13s} {'predicted':>22s} {'tabulated':>20s} {'MAE':>6s}")
    for name, kind, got, observed, errors, pairs in final:
        p = "/".join(f"{v:.2f}" for v in got)
        o = "/".join(f"{v:.2f}" for v in observed)
        mark = " *" if pairs else "  "
        print(f"{name:20s} {kind:13s} {p:>22s} {o:>20s} {np.mean(errors):>6.2f}{mark}")
    print("  * has a tautomer-related site pair, whose ylide microstates are excluded")

    print()
    header = f"{'':30s} {'values':>6s}" + "".join(f" {n:>22s}" for n, _ in VARIANTS)
    print(header)
    for kind in ("independent", "zwitterionic", "azole", "ALL"):
        picked = [r for r in final if kind in ("ALL", r[1])]
        n = sum(len(r[4]) for r in picked)
        line = f"{kind:30s} {n:>6d}"
        for name, _ in VARIANTS:
            rows = [r for r in both[name] if kind in ("ALL", r[1])]
            errors = [e for r in rows for e in r[4]]
            line += f" {np.mean(errors):>22.2f}"
        print(line)

    # The fold must not silently lose a titration step for the molecules it excludes states from.
    for name, kind, got, observed, errors, pairs in final:
        if len(got) < len(observed):
            print(f"WARNING: {name} predicts {len(got)} values against {len(observed)} tabulated")
    return 0


if __name__ == "__main__":
    sys.exit(main())
