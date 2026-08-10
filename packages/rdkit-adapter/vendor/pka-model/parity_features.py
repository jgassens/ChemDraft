"""Feature extraction restricted to what the TypeScript app can reproduce EXACTLY.

RDKit MinimalLib's `get_json()` is Kekule-ised and carries no per-atom aromaticity flag and no ring
membership. Anything the two sides would compute differently is worse than a feature neither has: the
model would be fed a number that means something else at inference than it did in training, and answer
confidently anyway.

Ring membership is recoverable by pruning degree-1 atoms. Aromaticity was originally dropped for this
reason, and is now BACK -- not RDKit's flag, which cannot be reproduced, but a Huckel count computed
from Kekule bond orders in `aromaticity.py`, which can. `local_environment.py` adds context measured
outward from the site rather than over the whole molecule.

The three blocks, in order, are the 92 features the model is trained on:

    1-45   site and molecule (below)
    46-48  aromaticity      (aromaticity.py)
    49-92  local environment (local_environment.py)
"""
import json, sys
import numpy as np
from rdkit import Chem, RDLogger

import aromaticity
import local_environment
from rdkit.Chem.Scaffolds import MurckoScaffold

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


def scaffold_of(mol):
    """Bemis-Murcko scaffold, or the molecule itself when it has no ring system.

    The fold grouping. Falling back to the whole molecule is the conservative direction: an acyclic
    compound becomes its own group rather than joining one "no scaffold" bucket that would put
    unrelated chain acids in the same fold.
    """
    try:
        scaffold = MurckoScaffold.MurckoScaffoldSmiles(mol=mol)
    except Exception:
        scaffold = ""
    return scaffold if scaffold else Chem.MolToSmiles(mol)


def full_features(mol, idx):
    """Every feature the model uses, in the order it was trained on."""
    f = list(site_features(mol, idx, in_ring_by_pruning(mol)))
    aromatic, pyrrole = aromaticity.site_flags(mol)
    neighbours = [n.GetIdx() for n in mol.GetAtomWithIdx(idx).GetNeighbors()]
    f += [1.0 if aromatic[idx] else 0.0,
          float(sum(1 for j in neighbours if aromatic[j])),
          # Pyrrole-type: aromatic, carries a hydrogen, no double bond of its own. Separates
          # imidazole's N-H (14.4) from tetrazole's (4.9), which the rest of the vector cannot.
          1.0 if pyrrole[idx] else 0.0]
    atoms, bonds, adj = aromaticity.kekule_graph(mol)
    return f + local_environment.local_features(atoms, bonds, adj, aromatic, idx)


BASE_FEATURE_NAMES = ([f"elem_{e}" for e in ELEMENTS]
    + ["charge", "in_ring", "n_hydrogens", "degree", "valence"]
    + [f"nbr1_{e}" for e in ELEMENTS] + [f"nbr2_{e}" for e in ELEMENTS]
    + ["nbr_charged", "nbr_in_ring", "double_bonds", "triple_bonds"]
    + ["mw_100", "tpsa_100", "clogp", "hbd", "hba", "rings", "aromatic_rings", "net_charge", "heavy_10"])

FEATURE_NAMES = (BASE_FEATURE_NAMES
    + ["is_aromatic", "nbr_aromatic", "pyrrole_type"]
    + local_environment.FEATURE_NAMES)


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


def written_smiles_with_site(mol, idx):
    """Write `mol` to SMILES and carry `idx` to the atom it still refers to. `(None, None)` on failure.

    An atom index does NOT survive `MolToSmiles`. RDKit writes atoms in its own traversal order, and it
    DROPS explicit hydrogens -- so a molecule read with `removeHs=False`, indexed, and then written out
    has every index past the first hydrogen shifted. That is not hypothetical: it silently mis-sited
    1,462 of the 5,286 QupKake training labels, putting a "basic" pKa on a carbon 1,137 times and an
    "acidic" one on an atom with no hydrogen 325 times. The offsets are a scattered permutation
    (-1: 349, -2: 259, -3: 150, -4: 72), which is exactly the signature of "some hydrogens before the
    site were dropped" rather than a constant shift.

    `_smilesAtomOutputOrder` is the permutation RDKit actually used: `order[i]` is the original index of
    the i-th atom written. An atom missing from it was not written at all, which is the honest reason to
    drop a row rather than guess at it.
    """
    try:
        smiles = Chem.MolToSmiles(mol)
    except Exception:
        return None, None
    if not mol.HasProp("_smilesAtomOutputOrder"):
        return None, None
    raw = mol.GetProp("_smilesAtomOutputOrder")
    try:
        order = [int(token) for token in raw.strip("[]").split(",") if token.strip() != ""]
    except ValueError:
        return None, None
    if idx not in order:
        return None, None
    return smiles, order.index(idx)


def kekulized_with_site(mol, idx):
    """Re-parse `mol` the way inference sees it, carrying `idx` with it. `(None, None)` on failure.

    The pairing is the point: every caller that re-parses a molecule and keeps using an old atom index
    is reading features off the wrong atom. Both callers here had that bug.
    """
    smiles, moved = written_smiles_with_site(mol, idx)
    if smiles is None:
        return None, None
    out = kekulized(smiles)
    if out is None or moved >= out.GetNumAtoms():
        return None, None
    return out, moved


def build(path):
    data = json.load(open(path))
    X, y, groups, keep = [], [], [], []
    for row in data:
        mol = kekulized(row["acid"])
        if mol is None or row["acidAtomIdx"] >= mol.GetNumAtoms():
            continue
        ring = in_ring_by_pruning(mol)
        X.append(full_features(mol, row["acidAtomIdx"]))
        y.append(row["pKa"])
        groups.append(scaffold_of(mol))
        keep.append(row)
    return np.array(X, float), np.array(y, float), groups, keep


def deprotonated(mol, idx):
    """The conjugate base formed by removing a proton from `idx`, or None. Mirrors `protonated`.

    **Atom order is preserved**, which is the whole reason this edits an `RWMol` rather than round-tripping
    through SMILES: a pair model has to read the SAME site index in both graphs, and `MolToSmiles`
    permutes. `kekulized_with_site` exists for the cases where a re-parse is unavoidable; this is not one.

    KEKULISED on the way out, for the same reason `kekulized` exists. Sanitising the edited molecule can
    hand back an aromatic-flagged base while the acid it is paired with is kekulised, and then
    `int(bond.GetBondTypeAsDouble())` reads 1 for a bond that reads 2 on the other side of the pair --
    a silent feature skew between the two halves of one training example.

    **Verified against the corpus rather than assumed.** Of the 8,056 rows that both construct and carry a
    recorded `base`, this reproduces it on 8,051 (99.94%). Four of the five differences are rows whose
    RECORDED base had lost stereochemistry that this preserves; one is a genuine miss, an imidazolium
    whose deprotonation should re-aromatise. That is why training constructs the base for every row
    instead of reading the recorded one: inference has no recorded base to read, so consuming one during
    training would be the train/serve skew the parity fixture exists to catch.
    """
    atom = mol.GetAtomWithIdx(idx)
    if atom.GetTotalNumHs() < 1:
        return None
    edit = Chem.RWMol(mol)
    target = edit.GetAtomWithIdx(idx)
    target.SetFormalCharge(target.GetFormalCharge() - 1)
    target.SetNoImplicit(False)
    target.SetNumExplicitHs(max(0, atom.GetTotalNumHs() - 1))
    try:
        out = edit.GetMol()
        Chem.SanitizeMol(out)
        Chem.Kekulize(out, clearAromaticFlags=True)
    except Exception:
        return None
    after = out.GetAtomWithIdx(idx)
    if after.GetFormalCharge() != atom.GetFormalCharge() - 1:
        return None
    if after.GetTotalNumHs() != atom.GetTotalNumHs() - 1:
        return None
    return out


def family_key(mol):
    """A protonation- and tautomer-INSENSITIVE identity for one molecule, or None.

    The first block of the standard InChIKey is the skeleton hash: InChI's mobile-hydrogen layer means
    glycine, its zwitterion and its anion all reduce to the same block, as do keto and enol tautomers.
    That is exactly the equivalence a fold assignment has to respect -- putting glycine in one fold and
    its zwitterion in another leaks the answer.
    """
    try:
        key = Chem.MolToInchiKey(mol)
    except Exception:
        return None
    return key.split("-")[0] if key else None


def neutral_scaffold(mol):
    """Bemis-Murcko scaffold of the CHARGE-STRIPPED molecule, so a protomer pair shares one.

    `scaffold_of` keeps formal charges, so pyridine scaffolds to `C1=CC=NC=C1` and pyridinium to
    `C1=CC=[NH+]C=C1` -- two groups, two folds, one molecule. Stripping charge first merged 273 of the
    642 split families on its own; the union pass in `pka_folds.py` closes the rest, which are tautomers
    whose ring bond orders differ.
    """
    edit = Chem.RWMol(mol)
    for atom in edit.GetAtoms():
        if atom.GetFormalCharge() != 0:
            atom.SetFormalCharge(0)
            atom.SetNoImplicit(False)
            atom.SetNumExplicitHs(0)
    try:
        out = edit.GetMol()
        Chem.SanitizeMol(out)
    except Exception:
        return scaffold_of(mol)
    # Canonicalise the ring form: sanitisation can return `c1ccccc1` for one row and `C1=CC=CC=C1` for
    # another, which would split benzene into two groups that are the same scaffold.
    try:
        Chem.Kekulize(out, clearAromaticFlags=True)
    except Exception:
        pass
    return scaffold_of(out) or scaffold_of(mol)


if __name__ == "__main__":
    X, y, g, keep = build(sys.argv[1])
    assert X.shape[1] == len(FEATURE_NAMES), (X.shape[1], len(FEATURE_NAMES))
    np.save(sys.argv[2] + ".X.npy", X); np.save(sys.argv[2] + ".y.npy", y)
    json.dump({"featureNames": FEATURE_NAMES, "groups": g, "rows": keep}, open(sys.argv[2] + ".meta.json", "w"))
    print(f"samples {X.shape[0]}  features {X.shape[1]}")

# --- label plausibility, shared by every ingest -----------------------------------------------------

# The aqueous window. Water levels the strongest acids and bases it can hold: below about -2 and above
# about 16 a titration is no longer measuring an aqueous dissociation constant. A label claiming a value
# inside this window is claiming something a titration in water could actually observe.
AQUEOUS_WINDOW = (-2.0, 16.0)


def is_unactivated_amine(mol, idx):
    """A neutral amine whose every neighbour is a saturated carbon.

    Its N-H acidity is near 35 -- outside water entirely. Lives here rather than in one ingest because
    the defect it catches is not specific to a source: any upstream that assigns a transition direction
    can file a basic measurement against an acidic pair, and each ingest was carrying its own copy of
    everything else it shares already.

    Mirrors `isUnactivatedAmine` in `ionization.ts`, which applies the same rule at OUTPUT.
    """
    atom = mol.GetAtomWithIdx(idx)
    if atom.GetSymbol() != "N" or atom.GetFormalCharge() != 0 or atom.GetTotalNumHs() == 0:
        return False
    for neighbour in atom.GetNeighbors():
        if neighbour.GetSymbol() != "C":
            return False
        for bond in neighbour.GetBonds():
            if bond.GetBondTypeAsDouble() > 1.0:
                return False
    return True
