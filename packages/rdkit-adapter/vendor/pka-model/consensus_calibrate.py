"""Measure what combining the MODEL with the Hammett relationship is worth.

Generated rather than hand-written for the same reason `pka_train.py` is vendored: these figures reach
the method contract, and a number nobody can regenerate is a number nobody can check.

Folds are Murcko-scaffold-grouped, matching `pka_train.py`. Under the earlier canonical-SMILES grouping
this reported the consensus BEATING the relationship alone; on honest folds it does not, and the
contract now says so.

    python consensus_calibrate.py <labels.json> <out-dir>
"""
import json
import sys

import numpy as np
from rdkit import Chem, RDLogger
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import GroupKFold

import hammett
from parity_features import kekulized, full_features
from pka_train import FOREST, scaffold_of

RDLogger.DisableLog("rdApp.*")


def main(labels_path, out_dir):
    rows = json.load(open(labels_path))
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
    X = np.array(X, dtype=float)
    y = np.array(y, dtype=float)

    # Out-of-fold NETWORK predictions, written by `pka_gnn.py` during its own cross-validation. Read
    # rather than recomputed: refitting an ensemble per fold here would cost a second full training
    # run and, worse, could silently use a different split from the one the published MAE came from.
    saved = {(r["acid"], r["acidAtomIdx"]): r for r in json.load(open("gnn-oof.json"))}
    oof = np.zeros(len(y))
    sd = np.zeros(len(y))
    have = np.zeros(len(y), dtype=bool)
    for i, row in enumerate(kept):
        entry = saved.get((row["acid"], row["acidAtomIdx"]))
        if entry is None:
            continue
        oof[i], sd[i], have[i] = entry["predicted"], entry["spread"], True
    if have.sum() < len(y) * 0.9:
        raise SystemExit(
            f"only {have.sum()} of {len(y)} sites have an out-of-fold prediction; "
            "run pka_gnn.py against the same labels first"
        )
    model_mae = float(np.abs(oof[have] - y[have]).mean())

    both = [(i, e["pKa"], e["series"])
            for i, row in enumerate(kept) if have[i]
            for e, _ in [hammett.estimate(row["acid"], row["acidAtomIdx"])] if e]
    idx = np.array([b[0] for b in both])
    ham = np.array([b[1] for b in both])
    phenol = np.array([b[2] for b in both]) == "phenol"
    observed, model_here = y[idx], oof[idx]
    span = np.abs(model_here - ham)

    hammett_mae = float(np.abs(ham - observed).mean())
    # Inverse of each method's own measured error. Not a tuned knob: it is the standard rule, and the
    # optimum measured across a sweep was flat around it.
    weight = (1 / model_mae) / ((1 / model_mae) + (1 / hammett_mae))
    combined = (1 - weight) * ham + weight * model_here
    error = np.abs(combined - observed)
    spread = np.maximum(span, np.minimum(hammett_mae, 1.5 * sd[idx]))

    summary = {
        "measurement": "out-of-fold NETWORK predictions vs the literature Hammett relationship, on the sites where both apply",
        "grouping": "Bemis-Murcko scaffold",
        "samples": int(len(idx)),
        "phenolSamples": int(phenol.sum()),
        "benzoicSamples": int((~phenol).sum()),
        "forestWeight": round(float(weight), 4),
        "forestWeightRule": "inverse of each method's own measured MAE",
        "hammettMae": round(hammett_mae, 4),
        # The 68th percentile of |error|, which is what "interval" means everywhere else here since
        # `interval_calibrate.py` -- the model's spread is a calibrated 68% quantile, and a Hammett
        # site reporting its MAE instead was quietly claiming a different thing on the same axis. Its
        # MAE covers 74.6%, so the interval was too wide by six points rather than wrong, but two
        # numbers on one axis have to mean one thing.
        "hammettInterval68": round(float(np.percentile(np.abs(ham - observed), 68)), 4),
        "hammettMaePhenol": round(float(np.abs(ham - observed)[phenol].mean()), 4),
        "hammettMaeBenzoic": round(float(np.abs(ham - observed)[~phenol].mean()), 4),
        "forestMaeHere": round(float(np.abs(model_here - observed).mean()), 4),
        "meanMae": round(float(np.abs((model_here + ham) / 2 - observed).mean()), 4),
        "consensusMae": round(float(error.mean()), 4),
        "consensusMaePhenol": round(float(error[phenol].mean()), 4),
        "coverage": round(float((error <= spread).mean()), 4),
        "disagreementCorrelation": round(float(np.corrcoef(span, np.abs(model_here - observed))[0, 1]), 4),
        "medianHalfWidth": round(float(np.median(spread)), 4),
        "modelHalfWidthHere": round(float(np.median(1.5 * sd[idx])), 4),
    }
    json.dump(summary, open(f"{out_dir}/consensus-calibration.json", "w"), indent=1)
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
