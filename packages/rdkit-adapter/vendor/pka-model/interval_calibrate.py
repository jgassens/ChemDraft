"""Turn the ensemble's disagreement into an interval that means what it says.

The reported interval was the ensemble's standard deviation times one constant, and that constant was
chosen so the interval covers 68% of errors ACROSS THE WHOLE CORPUS. It does. Conditionally it is wrong
in both directions, which is the way that matters, because a reader looks at one molecule and not at a
corpus:

    decile of reported interval      claimed    actual coverage
    1  (most confident)               0.160          50.1%
    5                                 0.616          66.2%
    10 (least confident)              2.810          85.6%

Too tight exactly where a reader trusts it most, too wide where they would already discount it. No
single multiplier can fix that, because the relationship is CONCAVE: doubling the ensemble's
disagreement does not double the error. There is a floor -- members trained on one corpus share its
blind spots, so perfect agreement is not zero error -- and a ceiling effect at the top, where a wildly
disagreeing ensemble is merely saying "no idea" rather than being wrong by that much.

So the interval is calibrated NON-PARAMETRICALLY instead. Rows are split into equal-count bins by raw
ensemble deviation, and each bin reports the empirical quantile of |error| inside it. That is Mondrian
conformal prediction with the deviation as the taxonomy, and it is calibrated per bin by construction
rather than by a lucky choice of constant. Between bin centres TypeScript interpolates linearly; outside
the ends it clamps, which is the conservative direction at the top and the honest one at the bottom.

Monotonicity is enforced with a running maximum. Bins are noisy at the tails and a non-monotone interval
would say a MORE disagreeing ensemble deserves a TIGHTER interval, which is never what the data means.

**What this is honest about.** The quantile is measured on out-of-fold predictions over this corpus, so
it is not a memory of training, but it is still this corpus's difficulty. A molecule unlike anything in
it gets an interval calibrated on molecules that are not like it, and no interval mechanism built from
labelled data can do otherwise.

    python3 interval_calibrate.py gnn-oof.json interval-calibration.json [coverage]
"""
import json
import statistics as st
import sys

BINS = 12
DEFAULT_COVERAGE = 0.68


def quantile(values, q):
    """Empirical quantile, linearly interpolated. No numpy: this runs where run_all.sh runs."""
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = q * (len(ordered) - 1)
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def calibrate(rows, coverage):
    spreads = [r["spread"] for r in rows]
    errors = [abs(r["predicted"] - r["observed"]) for r in rows]
    order = sorted(range(len(rows)), key=lambda i: spreads[i])
    n = len(order)

    points, running = [], 0.0
    for k in range(BINS):
        chunk = order[k * n // BINS:(k + 1) * n // BINS]
        if not chunk:
            continue
        interval = quantile([errors[i] for i in chunk], coverage)
        # Never let a wider disagreement buy a tighter interval.
        running = max(running, interval)
        points.append({
            "spread": round(st.mean(spreads[i] for i in chunk), 6),
            "interval": round(running, 6),
            "samples": len(chunk),
            "rawQuantile": round(interval, 6),
            "coverage": round(sum(1 for i in chunk if errors[i] <= running) / len(chunk), 4),
        })
    return points


def main(oof_path, out_path, coverage=DEFAULT_COVERAGE):
    rows = [r for r in json.load(open(oof_path)) if "spread" in r]
    points = calibrate(rows, coverage)

    # Overall coverage under the interpolation TypeScript will actually perform.
    def interval_at(spread):
        if spread <= points[0]["spread"]:
            return points[0]["interval"]
        if spread >= points[-1]["spread"]:
            return points[-1]["interval"]
        for a, b in zip(points, points[1:]):
            if spread <= b["spread"]:
                t = (spread - a["spread"]) / (b["spread"] - a["spread"])
                return a["interval"] + t * (b["interval"] - a["interval"])
        return points[-1]["interval"]

    hits = sum(1 for r in rows if abs(r["predicted"] - r["observed"]) <= interval_at(r["spread"]))
    worst = max(abs(p["coverage"] - coverage) for p in points)
    # Quartiles OF THE CALIBRATED INTERVAL, which is what the figure's confidence ring compares
    # against. Taking them from the raw deviation instead would colour a ring by one scale and size it
    # by another.
    calibrated = sorted(interval_at(r["spread"]) for r in rows)
    quartiles = [round(quantile(calibrated, q), 4) for q in (0.25, 0.5, 0.75)]

    artifact = {
        "measurement": "empirical quantile of |error| within equal-count bins of the ensemble's raw "
                       "standard deviation, on out-of-fold predictions; linearly interpolated between "
                       "bin centres and clamped outside them",
        "targetCoverage": coverage,
        "samples": len(rows),
        "bins": BINS,
        "achievedCoverage": round(hits / len(rows), 4),
        "worstBinDeviation": round(worst, 4),
        "intervalQuartiles": quartiles,
        "points": points,
    }
    json.dump(artifact, open(out_path, "w"), indent=2)
    print(f"interval calibrated on {len(rows)} out-of-fold rows, target {coverage:.0%}")
    print(f"   achieved overall      {artifact['achievedCoverage']:.1%}")
    print(f"   worst bin deviation   {worst:.3f}")
    print(f"   interval quartiles    {quartiles}")
    print(f"   {'spread':>8s} {'interval':>9s} {'coverage':>9s}")
    for p in points:
        print(f"   {p['spread']:8.3f} {p['interval']:9.3f} {p['coverage']:8.1%}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2],
         float(sys.argv[3]) if len(sys.argv) > 3 else DEFAULT_COVERAGE)
