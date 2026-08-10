"""Forest out-of-fold predictions on the FROZEN family-aware split, for the ensemble-blend experiment.

Codex measured that a fixed 10% forest blend moves out-of-fold MAE 0.7281 -> 0.7249 and the 398-row
external check 1.1286 -> 1.1034, and warned that the apparent optimum near 30% is an artefact of choosing
the weight ON the external set. Testing that properly needs the forest's predictions on the same held-out
rows the network was scored on, and neither committed artifact supplies them:

  - `site-pka-forest.json` is fitted on ALL 12,096 rows, so its predictions are in-sample. Blending an
    in-sample forest with an out-of-fold network would flatter the blend by exactly the amount the forest
    has memorised.
  - `calibration-pairs.json` holds `(tree disagreement, absolute error)` pairs, not predictions, so the
    sign of the error is gone and rows cannot be realigned.

So the forest is refitted here, five times, on the frozen split -- the same partition the network arms
use, which is what makes the two prediction sets blendable row by row.

    python3 pka_forest_oof.py merged-labels.json folds.json out.json
"""
import json
import sys

import numpy as np
from rdkit import RDLogger
from sklearn.ensemble import RandomForestRegressor

import pka_train
from parity_features import build

RDLogger.DisableLog("rdApp.*")


def main(labels_path, folds_path, out_path):
    frozen = json.load(open(folds_path))
    assignment, n_folds = frozen["assignment"], frozen["folds"]

    # `build` is the shipped feature path, so this forest is the shipped forest -- not a re-imagining.
    X, y, _groups, kept = build(labels_path)
    print(f"features {X.shape}  rows kept {len(kept)}", flush=True)

    fold_of = np.array([
        assignment.get(f"{row['acid']}\t{row['acidAtomIdx']}\t{float(row['pKa'])}", -1)
        for row in kept
    ])
    missing = int((fold_of < 0).sum())
    if missing:
        raise SystemExit(f"{missing} feature rows are absent from the frozen split")

    predicted = np.zeros(len(y))
    for fold in range(n_folds):
        test = fold_of == fold
        train = ~test
        forest = RandomForestRegressor(**pka_train.FOREST).fit(X[train], y[train])
        predicted[test] = forest.predict(X[test])
        error = np.abs(predicted[test] - y[test])
        print(f"   fold {fold}: n={int(test.sum())} MAE {error.mean():.4f}", flush=True)

    mae = float(np.abs(predicted - y).mean())
    print(f"   forest OOF MAE {mae:.4f}   on the frozen family-aware split", flush=True)
    json.dump(
        [{"acid": row["acid"], "acidAtomIdx": row["acidAtomIdx"], "observed": float(row["pKa"]),
          "predicted": round(float(p), 4)}
         for row, p in zip(kept, predicted)],
        open(out_path, "w"),
    )
    print(f"   wrote {out_path}", flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
