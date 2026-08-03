"""Measure what the forest's tree disagreement is actually worth, out of fold.

GROUPING IS THE WHOLE MEASUREMENT. Folds are grouped by BEMIS-MURCKO SCAFFOLD, not by canonical
SMILES. Grouping on canonical SMILES looks like a scaffold split and is not one: it separates
identical molecules and nothing else, giving 3,030 groups for 3,031 rows, so a congeneric series is
split across folds and every held-out row keeps near-twins in training. That reported MAE 1.18 for a
model that scores 1.62 on real scaffold folds and 1.24 against external data. Murcko gives 1,167
groups. Do not weaken this back.


Produces `calibration.json` (the four figures the app displays) and `calibration-pairs.json` (the
3,031 pairs they were computed from, which a test recomputes the summary from).

Out-of-fold and scaffold-grouped, both deliberately: a forest asked about its own training rows agrees
with itself, and an ungrouped split lets a scaffold sit on both sides. Either would make the interval
look far better than it is.

    python pka_calibrate.py <features-prefix> <out-dir>
"""
import json, sys
import numpy as np
from sklearn.ensemble import RandomForestRegressor
from rdkit.Chem.Scaffolds import MurckoScaffold
from sklearn.model_selection import GroupKFold

from pka_train import FOREST  # one definition of the forest's shape, so the two cannot drift

SPREAD_MULTIPLIER = 1.5


def main(prefix, out):
    X = np.load(f"{prefix}.X.npy")
    y = np.load(f"{prefix}.y.npy")
    groups = json.load(open(f"{prefix}.meta.json"))["groups"]  # Murcko scaffolds; see the header

    sd = np.zeros(len(y))
    pred = np.zeros(len(y))
    for train, test in GroupKFold(n_splits=5).split(X, y, groups):
        forest = RandomForestRegressor(**FOREST).fit(X[train], y[train])
        # Per-tree votes: their mean is the prediction, their spread is the signal being calibrated.
        votes = np.stack([tree.predict(X[test]) for tree in forest.estimators_])
        pred[test] = votes.mean(0)
        sd[test] = votes.std(0)  # ddof=0, matching the TypeScript evaluator

    err = np.abs(pred - y)
    bins = np.digitize(sd, np.quantile(sd, [0.25, 0.5, 0.75]))
    summary = {
        "measurement": "Murcko-scaffold-grouped 5-fold cross-validation; every pair is out-of-fold",
        "grouping": "Bemis-Murcko scaffold",
        "groups": len(set(groups)),
        "samples": int(len(y)),
        "correlation": round(float(np.corrcoef(sd, err)[0, 1]), 4),
        "quartileMae": [round(float(err[bins == b].mean()), 4) for b in range(4)],
        "coverage": {m: round(float((err <= m * sd).mean()), 4) for m in (1.0, 1.5, 2.0)},
        "spreadMultiplier": SPREAD_MULTIPLIER,
        "intervalQuartiles": [round(float(v) * SPREAD_MULTIPLIER, 3)
                              for v in np.quantile(sd, [0.25, 0.5, 0.75])],
        "baselinePredictTheMean": round(float(np.abs(y - y.mean()).mean()), 4),
    }
    json.dump(summary, open(f"{out}/calibration.json", "w"), indent=1)
    json.dump(
        {
            "note": "Out-of-fold (tree disagreement, absolute error) pairs behind calibration.json.",
            "pairs": [[round(float(a), 4), round(float(b), 4)] for a, b in zip(sd, err)],
        },
        open(f"{out}/calibration-pairs.json", "w"),
    )
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
