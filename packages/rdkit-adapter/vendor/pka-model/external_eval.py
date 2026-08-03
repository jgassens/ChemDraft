"""Score the shipped forest against data it has never seen.

Every other figure in this directory is cross-validation on Dwar-iBond. This one is not, and it is the
only check that the fold grouping is honest -- it is what exposed the canonical-SMILES split, which had
been reporting MAE 1.18 for a model that scores 1.62 on real scaffold folds and 1.24 here.

The DATA IS NOT VENDORED, only this script. Novartis and SAMPL come from the Uni-pKa repository
(dptech-corp/Uni-pKa, Apache-2.0, `dataset/`), and the training labels are derived from the same
source; the repository ships model weights rather than anyone's dataset. Point this at a checkout:

    python external_eval.py <uni-pka>/dataset <out-dir>

Only rows with exactly one microstate on each side are usable, because only those name the atom that
ionised. That is most of why n is small -- and n=38 has a standard error near 0.2, so this measures the
LEVEL of the error, not a difference between two models. Do not quote it as a comparison.
"""
import csv
import json
import sys

import numpy as np
from rdkit import Chem, RDLogger

from parity_features import full_features, kekulized

RDLogger.DisableLog("rdApp.*")

# (file, column holding the microstate transition)
SETS = [("novartis_acid.tsv", 3), ("novartis_base.tsv", 3),
        ("sampl6.tsv", 1), ("sampl7.tsv", 1), ("sampl8.tsv", 1)]


def signature(mol):
    return [(a.GetSymbol(), a.GetFormalCharge(), a.GetTotalNumHs()) for a in mol.GetAtoms()]


def single_site_rows(path, column):
    """Rows whose acid and base differ at exactly one atom — the only ones that name a site."""
    out = []
    for row in list(csv.reader(open(path), delimiter="\t"))[1:]:
        if len(row) <= column:
            continue
        field = row[column]
        if field.count(">>") != 1:
            continue
        acids, bases = [side.split(",") for side in field.split(">>")]
        if len(acids) != 1 or len(bases) != 1:
            continue
        acid, base = Chem.MolFromSmiles(acids[0].strip()), Chem.MolFromSmiles(bases[0].strip())
        if acid is None or base is None or acid.GetNumAtoms() != base.GetNumAtoms():
            continue
        sa, sb = signature(acid), signature(base)
        if [x[0] for x in sa] != [x[0] for x in sb]:
            continue
        differ = [i for i in range(len(sa)) if sa[i] != sb[i]]
        if len(differ) != 1:
            continue
        try:
            pka = float(row[2])
        except ValueError:
            continue
        out.append((acids[0].strip(), differ[0], pka))
    return out


def evaluate(forest_path, dataset_dir):
    forest = json.load(open(forest_path))
    trees = forest["trees"]

    def predict(features):
        votes = []
        for tree in trees:
            node = 0
            while tree["f"][node] >= 0:
                node = tree["l"][node] if features[tree["f"][node]] <= tree["t"][node] else tree["r"][node]
            votes.append(tree["v"][node])
        return float(np.mean(votes))

    per_set, all_errors = {}, []
    for name, column in SETS:
        rows = single_site_rows(f"{dataset_dir}/{name}", column)
        errors = []
        for smiles, atom, observed in rows:
            mol = kekulized(smiles)
            if mol is None or atom >= mol.GetNumAtoms():
                continue
            try:
                errors.append(abs(predict(full_features(mol, atom)) - observed))
            except Exception:
                continue
        if errors:
            per_set[name] = {"n": len(errors), "mae": round(float(np.mean(errors)), 4)}
            all_errors += errors
    return per_set, all_errors


if __name__ == "__main__":
    per_set, errors = evaluate("site-pka-forest.json", sys.argv[1])
    summary = {
        "measurement": "held-out external data, never used in training or fold selection",
        "source": "Uni-pKa (dptech-corp/Uni-pKa, Apache-2.0), dataset/ — Novartis and SAMPL6/7/8",
        "note": "single-microstate rows only; n is small and its standard error is near 0.2, so this "
                "measures the level of the error and cannot resolve a difference between two models",
        "perSet": per_set,
        "samples": len(errors),
        "mae": round(float(np.mean(errors)), 4),
        "standardError": round(float(np.std(errors) / np.sqrt(len(errors))), 4),
    }
    out = sys.argv[2] if len(sys.argv) > 2 else "."
    json.dump(summary, open(f"{out}/external-validation.json", "w"), indent=1)
    print(json.dumps(summary, indent=1))
