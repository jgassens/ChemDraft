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

from parity_features import kekulized, FEATURE_NAMES, full_features, scaffold_of

RDLogger.DisableLog("rdApp.*")

# Swept against Murcko-grouped folds after the feature set grew from 45 to 92. The old shape was
# tuned for the smaller vector and left ~0.14 MAE on the table; `max_features` below 1.0 matters most,
# since with 92 correlated features every tree otherwise splits on the same handful.
FOREST = dict(n_estimators=60, max_depth=20, min_samples_leaf=1, max_features=0.4,
              random_state=0, n_jobs=-1)


def build(path):
    rows = json.load(open(path))
    X, y, groups, kept = [], [], [], []
    for row in rows:
        # kekulized(), not MolFromSmiles: RDKit reports an aromatic bond as order 1.5 while
        # MinimalLib's get_json() gives the Kekule 2, so parsing plainly here would train
        # `double_bonds` and `valence` to mean something the TypeScript side never computes.
        mol = kekulized(row["acid"])
        if mol is None or row["acidAtomIdx"] >= mol.GetNumAtoms():
            continue
        try:
            X.append(full_features(mol, row["acidAtomIdx"]))
        except Exception:
            continue
        y.append(row["pKa"])
        groups.append(scaffold_of(mol))
        kept.append(row)
    return np.array(X, dtype=float), np.array(y, dtype=float), groups, kept


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


def walk(tree, features):
    """Evaluate one PACKED tree, exactly as the TypeScript does.

    Deliberately not `forest.predict`. The packed export rounds thresholds to 6 decimals, and a feature
    sitting on one of those boundaries can take the other branch — a 0.005 prediction difference that
    the parity test correctly refused to accept. Pinning scikit-learn's in-memory answer would test
    something we do not ship; this tests the artifact.
    """
    node = 0
    while tree["f"][node] >= 0:
        node = tree["l"][node] if features[tree["f"][node]] <= tree["t"][node] else tree["r"][node]
    return tree["v"][node]


def emit_fixture(X, keep, out_path, count=10):
    """Pin a handful of real sites: features, prediction, and tree disagreement, from the packed trees.

    This is the test the whole port rests on. A feature computed even slightly differently in TypeScript
    feeds the forest a number that means something else and it answers confidently anyway.
    """
    forest = RandomForestRegressor(**FOREST).fit(X, np.array([r["pKa"] for r in keep], float))
    packed = pack(forest)
    step = max(1, len(keep) // count)
    fixture = []
    for i in range(0, len(keep), step):
        if len(fixture) >= count:
            break
        votes = np.array([walk(t, X[i]) for t in packed])
        fixture.append({"acid": keep[i]["acid"], "atomIdx": keep[i]["acidAtomIdx"],
                        "features": [round(float(v), 6) for v in X[i]],
                        "prediction": round(float(votes.mean()), 5),
                        "treeDisagreement": round(float(votes.std()), 5)})
    json.dump(fixture, open(out_path, "w"), indent=1)
    return fixture


if __name__ == "__main__":
    X, y, groups, rows_kept = build(sys.argv[1])
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
            "minSamplesLeaf": FOREST["min_samples_leaf"], "maxFeatures": FOREST["max_features"],
            "grouping": "Bemis-Murcko scaffold", "groups": len(set(groups)),
            "baselinePredictTheMean": round(baseline, 4),
        },
    }, open(f"{sys.argv[2]}/site-pka-forest.json", "w"))
    # The grouping travels with the features so the calibration run reuses the identical folds
    # rather than recomputing them and risking a different answer.
    np.save(f"{sys.argv[2]}/pka.X.npy", X)
    np.save(f"{sys.argv[2]}/pka.y.npy", y)
    json.dump({"featureNames": FEATURE_NAMES, "groups": groups, "rows": rows_kept},
              open(f"{sys.argv[2]}/pka.meta.json", "w"))
    print(f"fixture entries {len(emit_fixture(X, rows_kept, f'{sys.argv[2]}/parity-fixture.json'))}")
