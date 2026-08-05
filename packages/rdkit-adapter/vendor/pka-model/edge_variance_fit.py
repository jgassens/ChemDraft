"""Fit how wrong a predicted rung is likely to be, from how much the ensemble disagreed about it.

The macroscopic fold has to build microstates that do not exist in water -- glycine's neutral form is
the standing example, a species no titration can populate and so no corpus can label -- because
`pKa(n) = log10(Z(n)/Z(n-1))` sums over every microstate, populated or not. Those rungs are the ones
the model is most alone on, and until this fit they carried the same weight in the fold as a carboxyl
measured a thousand times.

**The signal had to be established before any of it was worth building.** On the 12,096 out-of-fold
predictions in `gnn-oof.json` -- each one held out of the fold that produced it, so none is a
memory -- the ensemble's spread tracks its own error:

    spread quintile     n      MAE    RMSE   > 2 log units
    0.01 - 0.11      2416    0.332   0.559       1.4%
    0.11 - 0.19      2419    0.501   0.798       2.7%
    0.19 - 0.28      2420    0.651   0.961       5.2%
    0.28 - 0.44      2421    0.843   1.263       8.8%
    0.44 - 3.68      2420    1.313   1.905      19.6%

Monotone, 4x in MAE and 14x in the rate of a two-log-unit miss, Spearman 0.42. The model knows which
of its own answers to distrust.

**Maximum likelihood, not least squares.** Regressing squared error on squared spread is the obvious
fit and it is the wrong one: the objective is dominated by the heavy tail, so it comes back
over-confident about nothing and under-confident about the easy rungs, missing by 1.69x on the tightest
decile. Gaussian MLE on the same two parameters -- minimising `sum log(sigma^2) + err^2/sigma^2` -- is
calibrated to within 1.31x everywhere, which is what a weight has to be to be worth using.

`floor` is what remains when the members agree completely. They are trained on one corpus and share its
blind spots, so zero disagreement is not zero error, and a weight of 1/0 would let a single confident
rung dictate every microstate around it.

**Fitted on the quantity the fold actually receives, which is not what the out-of-fold file stores.**
`cross_validate` writes the raw ensemble standard deviation; `predictSitePka` and `predict_site` both
return that TIMES `spreadMultiplier`, the factor that turns member disagreement into a reported
interval. Fitting on the raw number and applying the result to the scaled one inflates the spread term
by the square of the multiplier -- 2.25x at the current 1.5 -- which leaves the weighting far more
aggressive than the calibration behind it justifies. The multiplier is read from the model artifact
rather than assumed, so a recalibration cannot silently desynchronise the two.

    python3 edge_variance_fit.py gnn-oof.json site-pka-gnn.json edge-variance.json
"""
import json
import math
import statistics as st
import sys


def negative_log_likelihood(a, b, x, y):
    if a <= 1e-6 or b < 0:
        return float("inf")
    total = 0.0
    for xi, yi in zip(x, y):
        v = a + b * xi
        total += math.log(v) + yi / v
    return total


def fit(rows):
    """(floor, per_spread) by Gaussian MLE, via coarse-to-fine grid descent.

    Two parameters and a smooth objective, so a shrinking local grid finds the optimum without pulling
    in a solver. Deliberately dependency-free: this runs in the same place `run_all.sh` does.
    """
    x = [r["spread"] ** 2 for r in rows]
    y = [(r["predicted"] - r["observed"]) ** 2 for r in rows]
    a, b = 0.5, 4.0
    step_a, step_b = 0.4, 3.0
    for _ in range(40):
        best = (negative_log_likelihood(a, b, x, y), a, b)
        for da in (-step_a, 0.0, step_a):
            for db in (-step_b, 0.0, step_b):
                cost = negative_log_likelihood(a + da, b + db, x, y)
                if cost < best[0]:
                    best = (cost, a + da, b + db)
        _, a, b = best
        step_a *= 0.75
        step_b *= 0.75
    return a, b


def calibration(rows, a, b):
    """Predicted sigma against actual RMSE, decile by decile. The check that the fit is usable."""
    x = [r["spread"] ** 2 for r in rows]
    y = [(r["predicted"] - r["observed"]) ** 2 for r in rows]
    n = len(rows)
    order = sorted(range(n), key=lambda i: x[i])
    out = []
    for k in range(10):
        sel = order[k * n // 10:(k + 1) * n // 10]
        predicted = math.sqrt(a + b * st.mean(x[i] for i in sel))
        actual = math.sqrt(st.mean(y[i] for i in sel))
        out.append({
            "decile": k + 1,
            "meanSpread": round(st.mean(math.sqrt(x[i]) for i in sel), 4),
            "predictedSigma": round(predicted, 4),
            "actualRmse": round(actual, 4),
            "ratio": round(actual / predicted, 4),
        })
    return out


def spearman(rows):
    def ranked(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        out = [0.0] * len(v)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
                j += 1
            average = (i + j) / 2 + 1
            for k in range(i, j + 1):
                out[order[k]] = average
            i = j + 1
        return out

    s = ranked([r["spread"] for r in rows])
    e = ranked([abs(r["predicted"] - r["observed"]) for r in rows])
    ms, me = st.mean(s), st.mean(e)
    num = sum((si - ms) * (ei - me) for si, ei in zip(s, e))
    return num / math.sqrt(sum((si - ms) ** 2 for si in s) * sum((ei - me) ** 2 for ei in e))


def main(oof_path, model_path, out_path):
    multiplier = json.load(open(model_path))["training"]["spreadMultiplier"]
    rows = [dict(r, spread=r["spread"] * multiplier)
            for r in json.load(open(oof_path)) if "spread" in r]
    a, b = fit(rows)
    deciles = calibration(rows, a, b)
    worst = max(abs(math.log(d["ratio"])) for d in deciles)
    artifact = {
        "measurement": "Gaussian MLE of sigma^2 = floor + perSpread * spread^2 on out-of-fold "
                       "predictions; the fold weights each rung by 1/sigma^2. Spread is the REPORTED "
                       "interval -- the ensemble's standard deviation times spreadMultiplier -- "
                       "because that is what the fold is handed, not the raw deviation gnn-oof.json "
                       "stores",
        "samples": len(rows),
        "spreadMultiplier": multiplier,
        "floor": round(a, 4),
        "perSpread": round(b, 4),
        "unknownSpread": round(st.median(r["spread"] for r in rows), 4),
        "spearmanSpreadVersusError": round(spearman(rows), 4),
        "worstDecileMiscalibration": round(math.exp(worst), 4),
        "calibration": deciles,
    }
    json.dump(artifact, open(out_path, "w"), indent=2)
    print(f"sigma^2 = {a:.4f} + {b:.4f} * spread^2   on {len(rows)} out-of-fold rows")
    print(f"   Spearman spread vs |error|      {artifact['spearmanSpreadVersusError']:.4f}")
    print(f"   worst decile miscalibration     {artifact['worstDecileMiscalibration']:.2f}x")
    print(f"   weight range across the corpus  "
          f"{(a + b * max(r['spread'] for r in rows) ** 2) / a:.0f}x")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
