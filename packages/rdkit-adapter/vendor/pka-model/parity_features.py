"""Feature extraction restricted to what the TypeScript app can reproduce EXACTLY.

RDKit MinimalLib's `get_json()` is Kekule-ised and carries no per-atom aromaticity flag and no ring
membership. Ring membership is recoverable in TS by pruning degree-1 atoms until none remain; atom
aromaticity is not. So aromaticity features are dropped rather than approximated — a feature the two
sides compute differently is worse than one neither has, because the model would be fed a number that
means something else at inference time than it did in training.
"""
import json, sys
import numpy as np
from rdkit import Chem, RDLogger

RDLogger.DisableLog("rdApp.*")
ELEMENTS = ["N", "O", "C", "S", "P", "F", "Cl", "Br", "I"]


def in_ring_by_pruning(mol):
    """Ring membership the way TS will compute it: prune leaves until none remain."""
    n = mol.GetNumAtoms()
    deg = [0] * n
    adj = [[] for _ in range(n)]
    for b in mol.GetBonds():
        i, j = b.GetBeginAtomIdx(), b.GetEndAtomIdx()
        adj[i].append(j); adj[j].append(i); deg[i] += 1; deg[j] += 1
    alive = [True] * n
    changed = True
    while changed:
        changed = False
        for i in range(n):
            if alive[i] and deg[i] <= 1:
                alive[i] = False; changed = True
                for j in adj[i]:
                    if alive[j]: deg[j] -= 1
    return alive


def site_features(mol, idx, ring):
    atom = mol.GetAtomWithIdx(idx)
    nbrs = list(atom.GetNeighbors())
    shell1 = [n.GetSymbol() for n in nbrs]
    shell2 = []
    for n in nbrs:
        shell2 += [m.GetSymbol() for m in n.GetNeighbors() if m.GetIdx() != idx]

    f = []
    f += [1.0 if atom.GetSymbol() == e else 0.0 for e in ELEMENTS]
    f += [float(atom.GetFormalCharge()),
          1.0 if ring[idx] else 0.0,
          float(atom.GetTotalNumHs()),
          float(atom.GetDegree()),
          float(sum(b.GetBondTypeAsDouble() for b in atom.GetBonds()) + atom.GetTotalNumHs())]
    f += [float(shell1.count(e)) for e in ELEMENTS]
    f += [float(shell2.count(e)) for e in ELEMENTS]
    f += [float(sum(1 for n in nbrs if n.GetFormalCharge() != 0)),
          float(sum(1 for n in nbrs if ring[n.GetIdx()])),
          float(sum(1 for b in atom.GetBonds() if b.GetBondTypeAsDouble() == 2.0)),
          float(sum(1 for b in atom.GetBonds() if b.GetBondTypeAsDouble() == 3.0))]
    from rdkit.Chem import Descriptors, rdMolDescriptors
    # Descriptors come from the SANITISED (aromatic) form, because that is what get_descriptors()
    # reports in the app; only the per-atom/bond features read the kekulised graph.
    mol = Chem.MolFromSmiles(Chem.MolToSmiles(mol)) or mol
    f += [Descriptors.MolWt(mol) / 100.0,
          rdMolDescriptors.CalcTPSA(mol) / 100.0,
          Descriptors.MolLogP(mol),
          float(rdMolDescriptors.CalcNumHBD(mol)),
          float(rdMolDescriptors.CalcNumHBA(mol)),
          float(rdMolDescriptors.CalcNumRings(mol)),
          float(rdMolDescriptors.CalcNumAromaticRings(mol)),
          float(Chem.GetFormalCharge(mol)),
          float(mol.GetNumHeavyAtoms()) / 10.0]
    return f


FEATURE_NAMES = ([f"elem_{e}" for e in ELEMENTS]
    + ["charge", "in_ring", "n_hydrogens", "degree", "valence"]
    + [f"nbr1_{e}" for e in ELEMENTS] + [f"nbr2_{e}" for e in ELEMENTS]
    + ["nbr_charged", "nbr_in_ring", "double_bonds", "triple_bonds"]
    + ["mw_100", "tpsa_100", "clogp", "hbd", "hba", "rings", "aromatic_rings", "net_charge", "heavy_10"])


def kekulized(smiles):
    """Parse the way the TypeScript side sees the molecule.

    MinimalLib's `get_json()` is KEKULE-ised: an aromatic C=N is bond order 2 there, while RDKit in
    Python reports 1.5 for the same bond. Without kekulising here, `double_bonds` and `valence` mean
    different things in training and at inference — caught by the parity fixture, which is what it is
    for.
    """
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None
    try:
        Chem.Kekulize(mol, clearAromaticFlags=True)
    except Exception:
        return None
    return mol


def build(path):
    data = json.load(open(path))
    X, y, groups, keep = [], [], [], []
    for row in data:
        mol = kekulized(row["acid"])
        if mol is None or row["acidAtomIdx"] >= mol.GetNumAtoms():
            continue
        ring = in_ring_by_pruning(mol)
        X.append(site_features(mol, row["acidAtomIdx"], ring))
        y.append(row["pKa"])
        groups.append(Chem.MolToSmiles(mol))
        keep.append(row)
    return np.array(X, float), np.array(y, float), groups, keep


if __name__ == "__main__":
    X, y, g, keep = build(sys.argv[1])
    assert X.shape[1] == len(FEATURE_NAMES), (X.shape[1], len(FEATURE_NAMES))
    np.save(sys.argv[2] + ".X.npy", X); np.save(sys.argv[2] + ".y.npy", y)
    json.dump({"featureNames": FEATURE_NAMES, "groups": g, "rows": keep}, open(sys.argv[2] + ".meta.json", "w"))
    print(f"samples {X.shape[0]}  features {X.shape[1]}")
