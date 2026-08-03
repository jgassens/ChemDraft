"""Score the shipped forest against data it has never seen.

Every other figure in this directory is cross-validation on Dwar-iBond. This one is not, and it is the
only check that the fold grouping is honest -- it is what exposed the canonical-SMILES split, which had
been reporting MAE 1.18 for a model that scores 1.62 on real scaffold folds and 1.24 here.

The DATA IS NOT VENDORED, only this script. The Novartis and literature sets ship with QupKake
(Shualdon/QupKake, BSD-3-Clause, `qupkake/data/`), which took them from Baltruschat & Czodrowski's
Machine-learning-meets-pKa. The repository ships model weights rather than anyone's dataset. Point this
at a checkout:

    python external_eval.py <qupkake>/qupkake/data <out-dir>

An earlier version of this script used the Uni-pKa Novartis and SAMPL TSVs and could only use rows with
one microstate per side -- 38 of them, with a standard error near 0.2, enough to say the error's LEVEL
and nothing about a difference between models. These sets carry an explicit site index, so 398 rows are
usable and the figure can carry a comparison. It is also a harder test: the shipped model scores 1.42
here against 1.10 on that smaller subset, which was the easier slice rather than the better model.
"""
import json
import sys

import numpy as np
from rdkit import Chem, RDLogger

from parity_features import full_features, kekulized

RDLogger.DisableLog("rdApp.*")

SETS = ["novartis_qupkake_pka.sdf", "literature_qupkake_pka.sdf"]


def sdf_sites(path):
    """(acid-form molecule, site index, measured pKa) for every usable record.

    A basic record names the neutral base, so its acid microstate is built by protonating the site --
    the same construction the app uses, and the same one `qupkake_labels.py` validates.
    """
    from qupkake_labels import protonated
    out = []
    for mol in Chem.SDMolSupplier(path, removeHs=False):
        if mol is None:
            continue
        try:
            idx = int(mol.GetProp("idx"))
            kind = mol.GetProp("pka_type")
            pka = float(mol.GetProp("pka"))
        except Exception:
            continue
        if idx >= mol.GetNumAtoms():
            continue
        acid = mol if kind == "acidic" else protonated(mol, idx)
        if acid is None:
            continue
        out.append((acid, idx, pka))
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
    for name in SETS:
        errors = []
        for acid, atom, observed in sdf_sites(f"{dataset_dir}/{name}"):
            mol = kekulized(Chem.MolToSmiles(acid))
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
        "source": "QupKake (Shualdon/QupKake, BSD-3-Clause), qupkake/data/ — Novartis and literature "
                  "sets, originally from Baltruschat & Czodrowski",
        "perSet": per_set,
        "samples": len(errors),
        "mae": round(float(np.mean(errors)), 4),
        "standardError": round(float(np.std(errors) / np.sqrt(len(errors))), 4),
    }
    out = sys.argv[2] if len(sys.argv) > 2 else "."
    json.dump(summary, open(f"{out}/external-validation.json", "w"), indent=1)
    print(json.dumps(summary, indent=1))
