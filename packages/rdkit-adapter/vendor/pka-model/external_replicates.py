"""Compare two ARCHITECTURES on the external set when each training run is only a draw.

Why this file rather than one more `external_paired.py` call: comparing a candidate against the shipped
artifact treats the shipped artifact as the architecture's true score. It is not -- it is one run, and on
this hardware training is not reproducible. The three acid-only replicates here score 1.1596, 1.1201 and
1.1657 while the shipped artifact scores 1.1311, so the shipped number sits at the FAVOURABLE end of its
own architecture's distribution. Every past comparison against it inherited that bias.

Two analyses, because they answer different questions:

  RUN LEVEL -- treat each training run as one observation. Answers "if I train this architecture once,
  what do I get?", which is the question a release actually faces. Weak, because n is the replicate count.

  POOLED -- average predictions across an architecture's replicates, then pair row by row with a
  family-clustered interval. Answers "is this architecture better once run noise is averaged away?"
  Much more powerful, and it is the fair architecture comparison, but it describes a 12-member ensemble
  rather than the 4-member one that would ship.

    python3 external_replicates.py <dataset-dir> <out.json> --a a1.json,a2.json --b b1.json,b2.json
"""
import collections
import json
import sys

import numpy as np
from rdkit import Chem, RDLogger

from external_eval import sdf_sites, SETS
from parity_features import family_key, kekulized_with_site

RDLogger.DisableLog("rdApp.*")

BOOTSTRAP = 10000


def predictions(model_path, dataset_dir):
    """{(canonical smiles, site): (predicted, observed, element, family)}."""
    import gnn_infer
    members, interval_at = gnn_infer.load_ensemble(model_path)
    out = {}
    for name in SETS:
        for acid, atom, observed in sdf_sites(f"{dataset_dir}/{name}"):
            mol, site = kekulized_with_site(acid, atom)
            if mol is None:
                continue
            try:
                value = gnn_infer.predict_site(members, interval_at, mol, site)[0]
            except Exception:
                continue
            out[(Chem.MolToSmiles(mol), site)] = (
                value, observed, mol.GetAtomWithIdx(site).GetSymbol(), family_key(mol) or "")
    return out


def clustered_ci(diff, families):
    groups = collections.defaultdict(list)
    for i, f in enumerate(families):
        groups[f].append(i)
    buckets = [np.array(v) for v in groups.values()]
    rng = np.random.default_rng(0)
    means = np.empty(BOOTSTRAP)
    for b in range(BOOTSTRAP):
        picked = rng.integers(0, len(buckets), len(buckets))
        means[b] = diff[np.concatenate([buckets[i] for i in picked])].mean()
    return float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))


def main(dataset_dir, out_path, arm_a, arm_b):
    scored = {}
    for label, paths in (("A", arm_a), ("B", paths_b := arm_b)):
        for path in paths:
            scored[(label, path)] = predictions(path, dataset_dir)
            errs = [abs(v - o) for v, o, _, _ in scored[(label, path)].values()]
            print(f"   {label}  {path.split('/')[-1]:34s} n={len(errs)}  MAE {np.mean(errs):.4f}",
                  flush=True)

    shared = sorted(set.intersection(*[set(v) for v in scored.values()]))
    families = [scored[("A", arm_a[0])][k][3] or k[0] for k in shared]
    observed = np.array([scored[("A", arm_a[0])][k][1] for k in shared])
    elements = [scored[("A", arm_a[0])][k][2] for k in shared]
    print(f"\nshared rows {len(shared)}, families {len(set(families))}")

    # --- run level -------------------------------------------------------------------------------
    per_run = {label: [] for label in ("A", "B")}
    for (label, path), rows in scored.items():
        pred = np.array([rows[k][0] for k in shared])
        per_run[label].append(float(np.abs(pred - observed).mean()))
    a_runs, b_runs = per_run["A"], per_run["B"]
    a_mean, b_mean = float(np.mean(a_runs)), float(np.mean(b_runs))
    a_sd = float(np.std(a_runs, ddof=1)) if len(a_runs) > 1 else float("nan")
    b_sd = float(np.std(b_runs, ddof=1)) if len(b_runs) > 1 else float("nan")
    se = float(np.sqrt(a_sd ** 2 / len(a_runs) + b_sd ** 2 / len(b_runs)))
    print(f"\nRUN LEVEL")
    print(f"   A runs {[round(v, 4) for v in a_runs]}  mean {a_mean:.4f}  sd {a_sd:.4f}")
    print(f"   B runs {[round(v, 4) for v in b_runs]}  mean {b_mean:.4f}  sd {b_sd:.4f}")
    print(f"   difference B-A {b_mean - a_mean:+.4f}   SE {se:.4f}   "
          f"{abs(b_mean - a_mean) / se:.2f} SE   "
          f"{'resolvable' if abs(b_mean - a_mean) > 2 * se else 'NOT RESOLVABLE at n='
             f'{len(a_runs)}v{len(b_runs)}'}")

    # --- pooled ----------------------------------------------------------------------------------
    pooled = {}
    for label, paths in (("A", arm_a), ("B", arm_b)):
        stack = np.stack([[scored[(label, p)][k][0] for k in shared] for p in paths])
        pooled[label] = np.abs(stack.mean(axis=0) - observed)
    diff = pooled["B"] - pooled["A"]
    low, high = clustered_ci(diff, families)
    print(f"\nPOOLED across replicates ({len(arm_a)}x4 vs {len(arm_b)}x4 members)")
    print(f"   A {pooled['A'].mean():.4f}   B {pooled['B'].mean():.4f}   "
          f"paired B-A {diff.mean():+.4f}  95% CI [{low:+.4f}, {high:+.4f}]   "
          f"{'EXCLUDES zero' if low > 0 or high < 0 else 'spans zero'}")

    by_element = {}
    for element in sorted(set(elements)):
        mask = np.array([e == element for e in elements])
        if mask.sum() < 5:
            continue
        el_low, el_high = clustered_ci(diff[mask], [f for f, m in zip(families, mask) if m])
        by_element[element] = {"n": int(mask.sum()),
                               "a": round(float(pooled["A"][mask].mean()), 4),
                               "b": round(float(pooled["B"][mask].mean()), 4),
                               "paired": round(float(diff[mask].mean()), 4),
                               "ci": [round(el_low, 4), round(el_high, 4)]}
        print(f"   {element}: n={int(mask.sum()):<4d} A {pooled['A'][mask].mean():.4f}  "
              f"B {pooled['B'][mask].mean():.4f}  paired {diff[mask].mean():+.4f} "
              f"[{el_low:+.4f}, {el_high:+.4f}]")

    json.dump({
        "measurement": "external set, replicate-aware: run-level and replicate-pooled",
        "armA": arm_a, "armB": arm_b, "shared": len(shared),
        "runLevel": {"a": [round(v, 4) for v in a_runs], "b": [round(v, 4) for v in b_runs],
                     "aMean": round(a_mean, 4), "bMean": round(b_mean, 4),
                     "aSd": round(a_sd, 4), "bSd": round(b_sd, 4),
                     "difference": round(b_mean - a_mean, 4), "se": round(se, 4),
                     "resolvable": bool(abs(b_mean - a_mean) > 2 * se)},
        "pooled": {"a": round(float(pooled["A"].mean()), 4),
                   "b": round(float(pooled["B"].mean()), 4),
                   "paired": round(float(diff.mean()), 4),
                   "ci95": [round(low, 4), round(high, 4)],
                   "excludesZero": bool(low > 0 or high < 0),
                   "byElement": by_element},
    }, open(out_path, "w"), indent=1)
    print(f"\nwrote {out_path}")


if __name__ == "__main__":
    argv = sys.argv
    main(argv[1], argv[2],
         argv[argv.index("--a") + 1].split(","),
         argv[argv.index("--b") + 1].split(","))
