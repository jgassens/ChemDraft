"""Freeze one family-aware, balanced fold assignment, and write it to disk so every arm reads the same one.

**Why this file exists.** `cross_validate` used to assign folds inline, which made the split an accident of
whichever corpus and code version happened to be in the tree. Two problems followed, both measured:

  1. **The split moved when the corpus did.** Assignment was `i % folds` over the sorted scaffold list, so a
     scaffold's fold depended on how many scaffolds sorted before it. Pruning 100 rows moved 96.3% of the
     survivors to a different held-out fold, and a prune measured 0.0402 BETTER that way and 0.0278 WORSE
     under a stable split -- a 0.068 swing from the partition alone, against a retrain noise floor of
     0.0017. Hashing the group fixed that.

  2. **Hashing the SCAFFOLD still leaked molecular families.** `scaffold_of` keeps formal charge, so
     pyridine and pyridinium are different groups and can land in different folds: train on one, test on
     the other, and the answer has leaked. 642 InChIKey-skeleton families spanning 1,344 rows were split
     that way. Stripping charge first (`neutral_scaffold`) closes 273 of them; the rest are tautomers whose
     ring bond orders differ, which the union pass below closes.

**How.** Every row contributes a `family_key` (protonation/tautomer-insensitive) and a `neutral_scaffold`
(substituent-coarse). Any two scaffolds observed inside one family are UNIONED into a single group, so a
family can never straddle a fold while scaffold coarseness is kept -- 4,613 scaffolds become 3,905 groups
and split families go to zero.

**Balance is bin-packed rather than hashed, and that is a deliberate trade.** One genuine group -- benzene --
holds 2,617 of 12,096 rows, 21.6% of the corpus. No hash can balance that while keeping the group intact,
and hashing gave fold sizes of 1,719 to 4,215. Largest-first bin packing gets them near even by putting the
benzene group alone against the rest. The cost is that assignment is a function of the group SIZE ORDER
rather than of each group in isolation, so adding rows can in principle reshuffle. In practice it only
reshuffles small groups near the tail, where the ordering is close; the large groups that decide balance are
far apart in size. Stability where it matters, balance where it is achievable, and the frozen file means a
comparison is never at the mercy of either.

    python3 pka_folds.py merged-labels.json folds.json [folds]

The written file is keyed by `acid\tacidAtomIdx\tpKa`, so a consumer looks up a row rather than trusting
row order.
"""
import collections
import json
import sys

from rdkit import Chem, RDLogger

from parity_features import family_key, kekulized, neutral_scaffold, scaffold_of

RDLogger.DisableLog("rdApp.*")

DEFAULT_FOLDS = 5


def row_key(row):
    return f"{row['acid']}\t{row['acidAtomIdx']}\t{float(row['pKa'])}"


class Union:
    """Smallest union-find that does the job; groups are named by their smallest member."""

    def __init__(self):
        self.parent = {}

    def find(self, x):
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            # Name the merged group by the lexicographically smaller root, so the group id does not
            # depend on the order rows were read in.
            low, high = sorted((ra, rb))
            self.parent[high] = low


def assign(rows, folds=DEFAULT_FOLDS):
    records, skipped = [], 0
    for row in rows:
        mol = kekulized(row["acid"])
        if mol is None or row["acidAtomIdx"] >= mol.GetNumAtoms():
            skipped += 1
            continue
        records.append({
            "key": row_key(row),
            "family": family_key(mol),
            "scaffold": neutral_scaffold(mol) or scaffold_of(mol),
        })

    union = Union()
    families = collections.defaultdict(set)
    for record in records:
        union.find(record["scaffold"])
        if record["family"]:
            families[record["family"]].add(record["scaffold"])
    for scaffolds in families.values():
        ordered = sorted(scaffolds)
        for other in ordered[1:]:
            union.union(ordered[0], other)

    for record in records:
        record["group"] = union.find(record["scaffold"])

    sizes = collections.Counter(record["group"] for record in records)
    # Largest first, name as the tie-break so the order is total and reproducible.
    order = sorted(sizes.items(), key=lambda kv: (-kv[1], kv[0]))
    load = [0] * folds
    fold_of_group = {}
    for group, n in order:
        target = min(range(folds), key=lambda f: (load[f], f))
        fold_of_group[group] = target
        load[target] += n

    assignment = {record["key"]: fold_of_group[record["group"]] for record in records}
    split = sum(
        1 for scaffolds in families.values()
        if len({fold_of_group[union.find(s)] for s in scaffolds}) > 1
    )
    return assignment, {
        "rows": len(records),
        "skipped": skipped,
        "scaffolds": len(sizes) if not families else len({r["scaffold"] for r in records}),
        "groups": len(sizes),
        "families": len(families),
        "familiesSplitAcrossFolds": split,
        "foldSizes": load,
        "largestGroup": order[0][1] if order else 0,
    }


def main(labels_path, out_path, folds=DEFAULT_FOLDS):
    rows = json.load(open(labels_path))
    assignment, summary = assign(rows, folds)
    json.dump({
        "measurement": "molecular-family-aware groups (Bemis-Murcko scaffold of the charge-stripped "
                       "molecule, unioned wherever one InChIKey-skeleton family spans several scaffolds), "
                       "bin-packed largest-first into equal-row folds",
        "folds": folds,
        "summary": summary,
        "assignment": assignment,
    }, open(out_path, "w"))
    print(f"froze {summary['rows']} rows into {folds} folds  (skipped {summary['skipped']})")
    print(f"   scaffolds {summary['scaffolds']} -> groups {summary['groups']}")
    print(f"   families {summary['families']}, split across folds {summary['familiesSplitAcrossFolds']}")
    print(f"   fold sizes {summary['foldSizes']}   largest group {summary['largestGroup']}")
    if summary["familiesSplitAcrossFolds"]:
        raise SystemExit("a molecular family straddles a fold; the union pass is wrong")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else DEFAULT_FOLDS)
