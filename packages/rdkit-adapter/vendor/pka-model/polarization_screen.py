"""Does bond polarization pick out the atoms worth asking about? Measured, not argued.

The proposal under test: rather than a hand-written pattern list, enumerate every proton-bearing atom and
keep the ones whose attached bonds are polarized enough, on the reasoning that polarization proxies how
well the atom can carry the resulting negative charge. Structurally this is stronger than a pattern list,
which can only find what someone thought to write down -- the app's total blindness to oximes is exactly a
missing pattern. The question here is only whether the DESCRIPTOR separates sites from non-sites.

**The measurement that matters is WITHIN element.** The app already knows an atom's element, and
electronegativity is mostly a restatement of it -- oxygen scores high whether it is a carboxyl or an ether.
So a pooled AUC would flatter the descriptor by crediting it for information already in hand. What has to
be shown is that polarization separates ACIDIC oxygens from ordinary ones.

**Negatives are presumptive, and that caps how much the numbers can carry.** The corpus records only what
someone measured, so an unlabelled O-H is not proven unionizable. Every AUC here is therefore a lower bound
on the descriptor and an upper bound on nothing. It is still decisive for the question asked, because a
descriptor that cannot separate under generous labelling will not separate under strict labelling.

    python3 polarization_screen.py merged-labels.json
"""
import collections
import json
import sys

import numpy as np
from rdkit import Chem, RDLogger
from rdkit.Chem import rdPartialCharges

RDLogger.DisableLog("rdApp.*")

# Pauling. The same static table `pka_gnn_pair.featurise_shells` uses, and the reason it was chosen there:
# a table computes identically in Python and TypeScript, which an iterative charge model does not.
CHI = {"H": 2.20, "C": 2.55, "N": 3.04, "O": 3.44, "F": 3.98, "P": 2.19, "S": 2.58,
       "Cl": 3.16, "Br": 2.96, "I": 2.66, "Se": 2.55, "As": 2.18, "B": 2.04, "Si": 1.90}


def auc(scores, labels):
    """Rank-based AUC. 0.5 is a coin flip; below 0.5 means the descriptor is ordered backwards."""
    scores, labels = np.asarray(scores, float), np.asarray(labels, bool)
    if labels.all() or not labels.any():
        return float("nan")
    order = np.argsort(scores)
    ranks = np.empty(len(scores))
    ranks[order] = np.arange(1, len(scores) + 1)
    pos = ranks[labels].sum()
    n1, n0 = int(labels.sum()), int((~labels).sum())
    return float((pos - n1 * (n1 + 1) / 2) / (n1 * n0))


def descriptors(mol, idx):
    atom = mol.GetAtomWithIdx(idx)
    chi_self = CHI.get(atom.GetSymbol(), 2.2)
    heavy = [b for b in atom.GetBonds()
             if b.GetOtherAtom(atom).GetSymbol() != "H"]
    dchi = [abs(chi_self - CHI.get(b.GetOtherAtom(atom).GetSymbol(), 2.2)) for b in heavy]
    # Signed: positive when the NEIGHBOUR is more electronegative, i.e. pulling density away from this
    # atom, which is the direction that should stabilise a negative charge left behind.
    pull = [CHI.get(b.GetOtherAtom(atom).GetSymbol(), 2.2) - chi_self for b in heavy]
    return {
        "chiSelf": chi_self,
        "sumAbsDchi": float(sum(dchi)),
        "maxAbsDchi": float(max(dchi)) if dchi else 0.0,
        "sumPull": float(sum(pull)),
        "maxPull": float(max(pull)) if pull else 0.0,
        "xhPolar": chi_self - CHI["H"],
        "gasteiger": float(atom.GetDoubleProp("_GasteigerCharge")),
    }


def main(labels_path):
    rows = json.load(open(labels_path))
    sites = collections.defaultdict(set)
    for r in rows:
        sites[r["acid"]].add(r["acidAtomIdx"])

    records = []
    for smiles, labelled in sites.items():
        mol = Chem.MolFromSmiles(smiles)
        if mol is None:
            continue
        try:
            rdPartialCharges.ComputeGasteigerCharges(mol)
        except Exception:
            continue
        for atom in mol.GetAtoms():
            if atom.GetTotalNumHs() == 0:            # only protons can be removed
                continue
            d = descriptors(mol, atom.GetIdx())
            if not np.isfinite(d["gasteiger"]):
                continue
            d["element"] = atom.GetSymbol()
            d["isSite"] = atom.GetIdx() in labelled
            records.append(d)

    n = len(records)
    pos = sum(r["isSite"] for r in records)
    print(f"{n:,} proton-bearing atoms across {len(sites):,} molecules")
    print(f"   labelled sites among them: {pos:,} ({100*pos/n:.1f}%)\n")

    KEYS = ["chiSelf", "sumAbsDchi", "maxAbsDchi", "sumPull", "maxPull", "xhPolar", "gasteiger"]
    labels = [r["isSite"] for r in records]
    print("POOLED across all elements (flattering: element identity is already known to the app)")
    print(f"   {'descriptor':14s} {'AUC':>7s}")
    for key in KEYS:
        print(f"   {key:14s} {auc([r[key] for r in records], labels):7.3f}")

    print("\nWITHIN element -- the question that actually matters")
    for element in ("O", "N", "C", "S"):
        subset = [r for r in records if r["element"] == element]
        p = sum(r["isSite"] for r in subset)
        if p < 20 or p == len(subset):
            continue
        line = f"   {element}  n={len(subset):6,d}  sites={p:5,d}  "
        sub_labels = [r["isSite"] for r in subset]
        line += "  ".join(f"{k}={auc([r[k] for r in subset], sub_labels):.3f}"
                          for k in ("sumAbsDchi", "maxPull", "gasteiger"))
        print(line)

    # The concrete question: can any threshold catch the oximes without flagging every alcohol?
    print("\nOXIME vs ALCOHOL -- the family the pattern list misses entirely")
    for smiles, idx, label in [("C/C=N/O", 3, "acetaldoxime O   (pKa 11.9)"),
                               ("CCO", 2, "ethanol O        (pKa 16.0)"),
                               ("CC(C)=NO", 4, "acetone oxime O  (pKa 12.4)"),
                               ("CC(=O)O", 3, "acetic acid O    (pKa  4.8)"),
                               ("Oc1ccccc1", 0, "phenol O         (pKa 10.0)"),
                               ("CC", 0, "ethane C         (pKa ~50)"),
                               ("C[N+](=O)[O-]", 0, "nitromethane C   (pKa 10.2)")]:
        mol = Chem.MolFromSmiles(smiles)
        rdPartialCharges.ComputeGasteigerCharges(mol)
        d = descriptors(mol, idx)
        print(f"   {label}  sumAbsDchi {d['sumAbsDchi']:.2f}   maxPull {d['maxPull']:+.2f}"
              f"   gasteiger {d['gasteiger']:+.4f}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "merged-labels.json")
