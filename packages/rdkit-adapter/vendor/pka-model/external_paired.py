"""Two models on the SAME external rows, paired, with a molecular-family-clustered interval.

`external_eval.py` reports one model's MAE and a per-row standard error. Neither is the quantity a
shipping decision needs. Codex's gate is explicit: "molecular-family-clustered 95% confidence interval
for the paired improvement excludes zero", and:

  - **Unpaired is far too blunt here.** The shipped model's per-row SE on this set is 0.0792, so an
    unpaired comparison cannot see a 0.02 effect at all. The two models score the SAME 398 molecules, and
    differencing row by row removes the molecule-to-molecule variance that dominates that 0.0792.
  - **Per-row bootstrap would overstate certainty.** These sets contain protonation and tautomer
    relatives, so rows are not independent draws. Resampling FAMILIES rather than rows is what makes the
    interval honest, and it is the same discipline the cross-validation comparisons use.

A row is kept only if BOTH models produced a number for it, so the difference is always like-for-like.

    python3 external_paired.py <dataset-dir> <out.json> --a <model-a> --b <model-b>

Reports MAE for each, the paired difference b - a (negative means b is better), and the clustered
interval. Also splits by ionizing element, because a gate asks whether any site class got worse.
"""
import collections
import json
import sys

import numpy as np
from rdkit import RDLogger

from external_eval import sdf_sites, SETS
from parity_features import family_key, kekulized_with_site

RDLogger.DisableLog("rdApp.*")

BOOTSTRAP = 10000
SEED = 0


def score(model_path, dataset_dir):
    """{(smiles, site): (absolute error, element, family)} for every row this model can answer."""
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
            from rdkit import Chem
            key = (Chem.MolToSmiles(mol), site)
            out[key] = (abs(value - observed),
                        mol.GetAtomWithIdx(site).GetSymbol(),
                        family_key(mol) or key[0])
    return out


def clustered_ci(diff, families):
    """Bootstrap the paired difference by resampling FAMILIES, not rows."""
    groups = collections.defaultdict(list)
    for i, family in enumerate(families):
        groups[family].append(i)
    buckets = [np.array(v) for v in groups.values()]
    rng = np.random.default_rng(SEED)
    means = np.empty(BOOTSTRAP)
    for b in range(BOOTSTRAP):
        picked = rng.integers(0, len(buckets), len(buckets))
        means[b] = diff[np.concatenate([buckets[i] for i in picked])].mean()
    return float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))


def main(dataset_dir, out_path, model_a, model_b):
    a = score(model_a, dataset_dir)
    b = score(model_b, dataset_dir)
    shared = sorted(set(a) & set(b))
    print(f"model a answered {len(a)}, model b answered {len(b)}, shared {len(shared)}", flush=True)

    errors_a = np.array([a[k][0] for k in shared])
    errors_b = np.array([b[k][0] for k in shared])
    elements = [a[k][1] for k in shared]
    families = [a[k][2] for k in shared]
    diff = errors_b - errors_a
    low, high = clustered_ci(diff, families)

    print(f"   a {errors_a.mean():.4f}   b {errors_b.mean():.4f}   "
          f"paired b-a {diff.mean():+.4f}  95% CI [{low:+.4f}, {high:+.4f}]"
          f"   {'EXCLUDES zero' if low > 0 or high < 0 else 'spans zero'}", flush=True)

    by_element = {}
    for element in sorted(set(elements)):
        mask = np.array([e == element for e in elements])
        if mask.sum() < 2:
            continue
        el_low, el_high = clustered_ci(diff[mask], [f for f, m in zip(families, mask) if m])
        by_element[element] = {
            "n": int(mask.sum()),
            "a": round(float(errors_a[mask].mean()), 4),
            "b": round(float(errors_b[mask].mean()), 4),
            "paired": round(float(diff[mask].mean()), 4),
            "ci": [round(el_low, 4), round(el_high, 4)],
        }
        print(f"   {element}: n={int(mask.sum()):<4d} a {errors_a[mask].mean():.4f}  "
              f"b {errors_b[mask].mean():.4f}  paired {diff[mask].mean():+.4f} "
              f"[{el_low:+.4f}, {el_high:+.4f}]", flush=True)

    json.dump({
        "measurement": "paired on shared external rows, molecular-family-clustered bootstrap",
        "modelA": model_a, "modelB": model_b,
        "shared": len(shared), "families": len(set(families)),
        "maeA": round(float(errors_a.mean()), 4), "maeB": round(float(errors_b.mean()), 4),
        "rmseA": round(float(np.sqrt((errors_a ** 2).mean())), 4),
        "rmseB": round(float(np.sqrt((errors_b ** 2).mean())), 4),
        "paired": round(float(diff.mean()), 4),
        "ci95": [round(low, 4), round(high, 4)],
        "excludesZero": bool(low > 0 or high < 0),
        "byElement": by_element,
    }, open(out_path, "w"), indent=1)
    print(f"   wrote {out_path}", flush=True)


if __name__ == "__main__":
    argv = sys.argv
    main(argv[1], argv[2], argv[argv.index("--a") + 1], argv[argv.index("--b") + 1])
