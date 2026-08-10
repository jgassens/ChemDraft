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

**THE TAXONOMY IS TWO-WAY: CARBON ACIDS ARE CALIBRATED SEPARATELY.** Deviation alone was the whole
taxonomy, and conditioned on the ionizing element it under-covered carbon by nine points:

    ionizing atom      n      coverage at a claimed 68%    mean |error|   mean interval
    N               6789                        68.1%             0.726           0.788
    O               4669                        68.5%             0.663           0.704
    S                189                        73.0%             0.669           0.851
    C                449                        59.2%             1.456           1.112

A carbon site is harder than a nitrogen at the SAME ensemble deviation, so pooling them hands carbon an
interval calibrated on molecules that are not like it -- the exact failure this file's last paragraph
warns about, occurring inside the corpus rather than outside it. Mondrian conformal prediction permits
any partition as the taxonomy, so carbon gets its own curve.

Measured on HELD-OUT folds -- two folds split by a hash of the acid SMILES, each calibrated on one half
and scored on the other, so none of this is the quantile remembering its own rows:

    taxonomy                    overall      N       O       C       S
    deviation only (before)       68.0%   68.1%   68.5%   59.2%   73.0%
    one curve per element         68.4%   68.1%   68.4%   71.0%   73.0%
    carbon vs everything else     67.7%   67.6%   67.7%   67.5%   71.4%

Per-element was tried first and OVERSHOOTS: it keeps 12 bins, which is 37 carbon rows per bin, and the
quantile of 37 numbers is noisy enough to land carbon at 71% -- wider than asked, which costs a reader
precision for nothing. The two-way split with four carbon bins lands at 67.5% and leaves N and O inside
noise of where they were. Sulfur stays pooled: at 189 rows its own curve would be noisier than the
2-point over-coverage it already carries, and over-coverage is the safe direction.

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
# Carbon carries 449 of 12,096 rows, so its bin count is set by how coarse a quantile of that many rows
# can be. Swept, reading both the per-bin calibration and coverage on HELD-OUT folds:
#
#     carbonBins   rows/bin   worst bin deviation   held-out coverage
#              3        149                0.0067               65.3%
#              4        112                0.0014               67.5%
#              5         89                0.0058               67.0%
#              6         74                0.0043               67.3%
#              8         56                0.0700               67.9%
#             12         37                0.1358               71.0%
#
# Four is best on both. Past six the bins are too small for the quantile to sit on target -- at 56 rows
# a single row moves a bin's coverage by 1.8 points, and the monotone running maximum then pins a
# neighbouring bin above target (75% at eight bins), which is over-wide rather than wrong but is still
# not what the artifact claims. The pooled non-carbon curve keeps twelve: it has 11,647 rows.
CARBON_BINS = 4
DEFAULT_COVERAGE = 0.68
# The taxonomy. `carbon` is looked up when the ionizing atom is a carbon; `other` for everything else,
# INCLUDING a site whose element the artifact does not record, which is the conservative direction
# because the pooled curve is the one the whole corpus agreed on.
CARBON_STRATUM = "carbon"
OTHER_STRATUM = "other"


def stratum_of(element):
    return CARBON_STRATUM if element == "C" else OTHER_STRATUM


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


def calibrate(rows, coverage, bins=BINS):
    spreads = [r["spread"] for r in rows]
    errors = [abs(r["predicted"] - r["observed"]) for r in rows]
    order = sorted(range(len(rows)), key=lambda i: spreads[i])
    n = len(order)

    points, running = [], 0.0
    for k in range(bins):
        chunk = order[k * n // bins:(k + 1) * n // bins]
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


def lookup(points, spread):
    """The curve TypeScript's `intervalFor` interpolates. Kept here so both sides read one shape."""
    if spread <= points[0]["spread"]:
        return points[0]["interval"]
    if spread >= points[-1]["spread"]:
        return points[-1]["interval"]
    for a, b in zip(points, points[1:]):
        if spread <= b["spread"]:
            t = (spread - a["spread"]) / (b["spread"] - a["spread"])
            return a["interval"] + t * (b["interval"] - a["interval"])
    return points[-1]["interval"]


def main(oof_path, out_path, coverage=DEFAULT_COVERAGE):
    rows = [r for r in json.load(open(oof_path)) if "spread" in r]
    missing = [r for r in rows if "element" not in r]
    if missing:
        raise SystemExit(
            f"{len(missing)} out-of-fold rows carry no `element`. Re-run pka_gnn.py: the interval "
            "taxonomy needs the ionizing atom's element and this script does not import RDKit."
        )

    strata = {}
    for row in rows:
        strata.setdefault(stratum_of(row["element"]), []).append(row)
    curves = {
        key: calibrate(members, coverage, CARBON_BINS if key == CARBON_STRATUM else BINS)
        for key, members in strata.items()
    }
    # The pooled curve stays in the artifact. It is what a caller gets when the element is unknown, and
    # it is the figure's yardstick — a confidence ring coloured per stratum would compare one molecule's
    # carbon against another molecule's nitrogen and call the wider one less certain.
    pooled = calibrate(rows, coverage)

    def interval_at(row):
        return lookup(curves[stratum_of(row["element"])], row["spread"])

    hits = sum(1 for r in rows if abs(r["predicted"] - r["observed"]) <= interval_at(r))
    worst = max(abs(p["coverage"] - coverage) for c in curves.values() for p in c)
    # Quartiles OF THE CALIBRATED INTERVAL, which is what the figure's confidence ring compares
    # against. Taking them from the raw deviation instead would colour a ring by one scale and size it
    # by another. Read off the pooled curve, matching what the figure uses.
    calibrated = sorted(lookup(pooled, r["spread"]) for r in rows)
    quartiles = [round(quantile(calibrated, q), 4) for q in (0.25, 0.5, 0.75)]

    by_element = {}
    for row in rows:
        seen = by_element.setdefault(row["element"], [0, 0])
        seen[0] += 1
        seen[1] += 1 if abs(row["predicted"] - row["observed"]) <= interval_at(row) else 0

    artifact = {
        "measurement": "empirical quantile of |error| within equal-count bins of the ensemble's raw "
                       "standard deviation, on out-of-fold predictions, stratified into carbon and "
                       "non-carbon ionizing atoms; linearly interpolated between bin centres and "
                       "clamped outside them",
        "targetCoverage": coverage,
        "samples": len(rows),
        "bins": BINS,
        "carbonBins": CARBON_BINS,
        "achievedCoverage": round(hits / len(rows), 4),
        "worstBinDeviation": round(worst, 4),
        "intervalQuartiles": quartiles,
        "coverageByElement": {k: round(v[1] / v[0], 4) for k, v in sorted(by_element.items())},
        "samplesByElement": {k: v[0] for k, v in sorted(by_element.items())},
        # The taxonomy. `points` is the pooled fallback; `strata` is what a site with a known element
        # reads. Both ship because both are used.
        "points": pooled,
        "strata": {key: curves[key] for key in sorted(curves)},
    }
    json.dump(artifact, open(out_path, "w"), indent=2)
    print(f"interval calibrated on {len(rows)} out-of-fold rows, target {coverage:.0%}")
    print(f"   achieved overall      {artifact['achievedCoverage']:.1%}")
    print(f"   worst bin deviation   {worst:.3f}")
    print(f"   interval quartiles    {quartiles}")
    print(f"   coverage by element   {artifact['coverageByElement']}")
    for key in sorted(curves):
        print(f"   -- stratum {key} ({len(strata[key])} rows)")
        print(f"   {'spread':>8s} {'interval':>9s} {'coverage':>9s}")
        for p in curves[key]:
            print(f"   {p['spread']:8.3f} {p['interval']:9.3f} {p['coverage']:8.1%}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2],
         float(sys.argv[3]) if len(sys.argv) > 3 else DEFAULT_COVERAGE)
