"""Build the feature matrix and train the site-pKa forest.

This script was NOT vendored with the first model, and that omission is why a measurement error went
unnoticed for the whole of its life. The grouping decision lives here; with the script outside the
repository nobody could read it, and the number it produced (MAE 1.18) travelled into the method
contract, PLANS.md and several commit messages as though it had been checked.

GROUPING IS THE WHOLE MEASUREMENT.
----------------------------------
Folds are grouped by BEMIS-MURCKO SCAFFOLD. The first version grouped by canonical SMILES, which reads
like a scaffold split and is not one: it separates identical molecules and nothing else. On this
dataset that is 3,030 groups for 3,031 rows, so every congeneric series -- and Dwar-iBond is full of
them, the tetrazoles, the sulfonamides, the thioamides -- was split across folds, leaving each
held-out row with near-twins in training.

The cost of that, measured three ways on the same forest:

    canonical-SMILES folds   MAE 1.18   <- what was published
    Murcko-scaffold folds    MAE 1.62   <- honest
    external data (n=38)     MAE 1.24   <- Novartis + SAMPL, never seen

Do not weaken the grouping back. A split that cannot separate a series is not measuring
generalisation, and the resulting figure is the one a reader will quote.

Features are restricted to what RDKit MinimalLib can compute in the TypeScript app, so inference needs
no Python: per-atom properties from `get_json()`, a two-bond neighbourhood, and whole-molecule
descriptors from `get_descriptors()`. `parity_features.py` is the reference implementation and
`parity-fixture.json` pins it against the TypeScript port.

Deliberately uses NO Dimorphite data: the shipped method already has a site table, and the point of a
second opinion is that its agreement carries information. A model fed the table's own pKa would agree
with it by construction.

    python pka_train.py <labels.json> <out-prefix>
"""
import json
import sys

import numpy as np
from rdkit import Chem, RDLogger
from rdkit.Chem.Scaffolds import MurckoScaffold
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import GroupKFold

from parity_features import FEATURE_NAMES, in_ring_by_pruning, site_features

RDLogger.DisableLog("rdApp.*")

FOREST = dict(n_estimators=120, max_depth=12, min_samples_leaf=3, random_state=0, n_jobs=-1)


def scaffold_of(mol):
    """The molecule's Bemis-Murcko scaffold, or the molecule itself when it has no ring system.

    Falling back to the whole molecule is the conservative direction: an acyclic compound becomes its
    own group rather than joining one big "no scaffold" bucket that would put unrelated chain acids in
    the same fold.
    """
    try:
        scaffold = MurckoScaffold.MurckoScaffoldSmiles(mol=mol)
    except Exception:
        scaffold = ""
    return scaffold if scaffold else Chem.MolToSmiles(mol)


def build(path):
    rows = json.load(open(path))
    X, y, groups = [], [], []
    for row in rows:
        mol = Chem.MolFromSmiles(row["acid"])
        if mol is None or row["acidAtomIdx"] >= mol.GetNumAtoms():
            continue
        try:
            X.append(site_features(mol, row["acidAtomIdx"], in_ring_by_pruning(mol)))
        except Exception:
            continue
        y.append(row["pKa"])
        groups.append(scaffold_of(mol))
    return np.array(X, dtype=float), np.array(y, dtype=float), groups


def cross_validate(X, y, groups):
    predicted = np.zeros(len(y))
    for train, test in GroupKFold(n_splits=5).split(X, y, groups):
        predicted[test] = RandomForestRegressor(**FOREST).fit(X[train], y[train]).predict(X[test])
    error = np.abs(predicted - y)
    return float(error.mean()), float(np.sqrt((error ** 2).mean()))


def pack(forest):
    """scikit-learn's trees as plain arrays the TypeScript evaluator walks."""
    packed = []
    for estimator in forest.estimators_:
        tree = estimator.tree_
        packed.append({
            "f": [int(v) for v in tree.feature],
            "t": [round(float(v), 6) for v in tree.threshold],
            "l": [int(v) for v in tree.children_left],
            "r": [int(v) for v in tree.children_right],
            "v": [round(float(v), 5) for v in tree.value.ravel()],
        })
    return packed


if __name__ == "__main__":
    X, y, groups = build(sys.argv[1])
    assert X.shape[1] == len(FEATURE_NAMES), "feature/name mismatch"
    mae, rmse = cross_validate(X, y, groups)
    baseline = float(np.abs(y - y.mean()).mean())
    print(f"samples {X.shape[0]}  features {X.shape[1]}  scaffold groups {len(set(groups))}")
    print(f"Murcko-grouped 5-fold CV: MAE {mae:.4f}  RMSE {rmse:.4f}  (predicting the mean: {baseline:.4f})")

    forest = RandomForestRegressor(**FOREST).fit(X, y)
    json.dump({
        "featureNames": FEATURE_NAMES,
        "trees": pack(forest),
        "training": {
            "samples": int(X.shape[0]), "cvMae": round(mae, 4), "cvRmse": round(rmse, 4),
            "trees": FOREST["n_estimators"], "maxDepth": FOREST["max_depth"],
            "minSamplesLeaf": FOREST["min_samples_leaf"],
            "grouping": "Bemis-Murcko scaffold", "groups": len(set(groups)),
            "baselinePredictTheMean": round(baseline, 4),
        },
    }, open(f"{sys.argv[2]}/site-pka-forest.json", "w"))
    # The grouping travels with the features so the calibration run reuses the identical folds
    # rather than recomputing them and risking a different answer.
    np.save(f"{sys.argv[2]}/pka.X.npy", X)
    np.save(f"{sys.argv[2]}/pka.y.npy", y)
    json.dump({"featureNames": FEATURE_NAMES, "groups": groups},
              open(f"{sys.argv[2]}/pka.meta.json", "w"))
