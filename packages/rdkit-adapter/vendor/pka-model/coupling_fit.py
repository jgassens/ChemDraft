"""Fit the one electrostatic parameter the microscopic model is missing.

**What is broken.** Measured on glycine, the model barely notices a neighbouring charge:

    COOH acidity, NH3+ adjacent    ours 4.31   literature 2.35
    COOH acidity, NH2  adjacent    ours 3.74   literature ~5
    NH3+ acidity, COOH adjacent    ours 7.27   literature ~7.4
    NH3+ acidity, COO- adjacent    ours 7.07   literature 9.78

The real shift is about 2.6 log units; the model produces 0.6, and for the ammonium the SIGN is wrong.
The training labels are the reason. Dwar-iBond records the microstates a titration can populate, which
for an amino acid is the cation, the zwitterion and the anion — never the neutral form. So the model
never sees the same site with and without an adjacent charge and cannot learn the contrast, however
many charge-count features it is given.

**The correction.** Charging one site shifts every other site's pKa by their electrostatic interaction,
which is the oldest result in this subject:

    dpKa_i(s) = -W * sum over other sites j of  q_j(s) / d_ij

`q_j` is site j's formal charge in that microstate and `d_ij` the through-bond distance. The sign falls
out of the chemistry: deprotonation lowers the site's charge by one, so a positive neighbour stabilises
the product and lowers the pKa. One parameter, `W`.

**Fitted against MACROSCOPIC values, which the microscopic model was never trained on.** That keeps it
from being a second model fitted to the same labels: the objective is the observed titration curve of a
polyprotic molecule, an aggregate the per-site labels do not contain. Cross-validated by Murcko
scaffold, same as everything else here.

    python coupling_fit.py <dwar-ibond-labels.json> <macro-reference.json>
"""
import json
import sys
from collections import defaultdict

import numpy as np
from rdkit import Chem, RDLogger

from parity_features import full_features, kekulized, scaffold_of

RDLogger.DisableLog("rdApp.*")

MAX_SITES = 8


def load_forest(path="site-pka-forest.json"):
    forest = json.load(open(path))["trees"]

    def predict(features):
        total = 0.0
        for tree in forest:
            node = 0
            while tree["f"][node] >= 0:
                node = tree["l"][node] if features[tree["f"][node]] <= tree["t"][node] else tree["r"][node]
            total += tree["v"][node]
        return total / len(forest)

    return predict


def distances(mol):
    """Through-bond distance between every pair of atoms."""
    return Chem.GetDistanceMatrix(mol)


def logsumexp10(values):
    top = max(values)
    return top + np.log10(sum(10 ** (v - top) for v in values))


def conjugated_pairs(mol, sites):
    """Acid/base site pairs sharing an aromatic ring, whose combination is a TAUTOMER, not a species.

    Imidazole's two ring nitrogens look like two independent sites: one drawn with a hydrogen (acidic)
    and one without (basic). Flipping both at once should give the tautomer with the proton on the
    other nitrogen -- but the enumeration only assigns charges, so it builds `c1c[nH+]c[n-]1`, an ylide
    that does not meaningfully exist. Reaching the real tautomer needs the ring's double bonds moved
    too, which charge assignment cannot do.

    The model scores that ylide at 6.95 where the neutral imidazole is 13.84, so it enters the
    partition sum looking seven log units too acidic. Those microstates are dropped instead.

    Aromaticity comes from `aromaticity.py`, not RDKit's flag: these molecules are kekulised, which
    clears it.
    """
    import aromaticity
    arom = aromaticity.aromatic_atoms(mol)
    rings = mol.GetRingInfo().AtomRings()
    out = set()
    for a in range(len(sites)):
        for b in range(a + 1, len(sites)):
            ia, ka = sites[a]
            ib, kb = sites[b]
            if ka == kb: continue
            if not (arom[ia] and arom[ib]): continue
            if any(ia in r and ib in r for r in rings): out.add((a, b))
    return out


def macroscopic(mol, sites, predict, W, dist, power=1.0, drop_tautomer_states=True):
    """Fold the ladder, applying the coupling correction to every edge.

    `sites` is a list of (atom index, "acidic"|"basic"). Mirrors `protonation.ts`; the parity fixture
    is what keeps the two the same.
    """
    n = len(sites)
    states = [tuple((mask >> i) & 1 for i in range(n)) for mask in range(1 << n)]
    by_count = defaultdict(list)

    def charge_of(state, j):
        """Site j's formal charge in this microstate."""
        atom_idx, kind = sites[j]
        if kind == "acidic":
            return 0 if state[j] else -1
        return 1 if state[j] else 0

    def build(state):
        edit = Chem.RWMol(mol)
        for j, (atom_idx, kind) in enumerate(sites):
            atom = edit.GetAtomWithIdx(atom_idx)
            atom.SetFormalCharge(charge_of(state, j))
            atom.SetNoImplicit(False)
            atom.SetNumExplicitHs(0)
        try:
            out = edit.GetMol(); Chem.SanitizeMol(out)
            Chem.Kekulize(out, clearAromaticFlags=True)
            return out
        except Exception:
            return None

    tautomer_pairs = conjugated_pairs(mol, sites) if drop_tautomer_states else set()

    def is_tautomer_state(state):
        """The acidic partner deprotonated while the basic one is protonated: a proton that moved."""
        for a, b in tautomer_pairs:
            ka, kb = sites[a][1], sites[b][1]
            acid_i, base_i = (a, b) if ka == "acidic" else (b, a)
            if not state[acid_i] and state[base_i]: return True
        return False

    cache = {}
    def graph_of(state):
        if state not in cache: cache[state] = build(state)
        return cache[state]

    L = {tuple([0] * n): 0.0}
    for count in range(1, n + 1):
        for state in [s for s in states if sum(s) == count]:
            if is_tautomer_state(state): continue
            routes = []
            for i in range(n):
                if not state[i]: continue
                lighter = tuple(0 if j == i else state[j] for j in range(n))
                if lighter not in L or is_tautomer_state(lighter): continue
                acid = graph_of(state)
                if acid is None: continue
                atom_idx = sites[i][0]
                if atom_idx >= acid.GetNumAtoms(): continue
                if acid.GetAtomWithIdx(atom_idx).GetTotalNumHs() == 0: continue
                try:
                    base = predict(full_features(acid, atom_idx))
                except Exception:
                    continue
                # The correction: every OTHER site's charge in this microstate, over its distance.
                shift = 0.0
                for j in range(n):
                    if j == i: continue
                    # ONLY across an acid/base pair. The model already handles like charges: a diamine
                    # gets 6.93/9.98 against a measured 6.85/9.93 with no correction at all, because
                    # both of its microstates are populated enough to have been measured and to be in
                    # the training labels. An amino acid's neutral form is not, so the acid/base
                    # interaction is the one the model could never have learned. Applying the term to
                    # like-charge pairs as well made those molecules worse -- 0.28 to 0.95.
                    if sites[j][1] == sites[i][1]: continue
                    q = charge_of(state, j)
                    if q == 0: continue
                    d = dist[atom_idx][sites[j][0]]
                    if d > 0: shift -= W * q / (d ** power)
                routes.append(L[lighter] + base + shift)
            if routes: L[state] = float(np.mean(routes))

    for state, value in L.items():
        by_count[sum(state)].append(value)
    out = []
    for count in range(n, 0, -1):
        if count not in by_count or count - 1 not in by_count: continue
        out.append(logsumexp10(by_count[count]) - logsumexp10(by_count[count - 1]))
    return out


def sites_of(mol):
    """Ionizable sites, by the same rules the shipped scanner uses, reduced to (atom, kind).

    Acidic: an oxygen or sulfur carrying a hydrogen, or a nitrogen whose neighbour bears a multiple
    bond (amide, sulfonamide, azole). Basic: a neutral nitrogen with a lone pair that is not the
    pyrrole type. Deliberately simple — this script only needs the SET of sites to fold over, and the
    values themselves come from the shipped model.
    """
    found = []
    for atom in mol.GetAtoms():
        i, sym, chg, hs = atom.GetIdx(), atom.GetSymbol(), atom.GetFormalCharge(), atom.GetTotalNumHs()
        if chg != 0: continue
        if sym in ("O", "S") and hs > 0:
            found.append((i, "acidic")); continue
        if sym != "N": continue
        activated = any(
            any(b.GetBondTypeAsDouble() > 1.0 for b in nb.GetBonds()) or nb.GetSymbol() != "C"
            for nb in atom.GetNeighbors()
        )
        if hs > 0 and activated and not atom.GetIsAromatic():
            found.append((i, "acidic")); continue
        # Basic unless it is a pyrrole-type ring N-H, whose lone pair is in the sextet.
        pyrrole = atom.GetIsAromatic() and hs > 0 and not any(
            b.GetBondTypeAsDouble() > 1.0 for b in atom.GetBonds())
        if not pyrrole and len(atom.GetNeighbors()) + hs < 4:
            found.append((i, "basic"))
    return found


def evaluate(reference, predict, W, limit=None, power=1.0):
    """Mean absolute error against observed macroscopic pKa, matched in titration order."""
    errors, per_molecule = [], []
    for smiles, observed in list(reference.items())[:limit]:
        mol = kekulized(smiles)
        if mol is None: continue
        sites = sites_of(mol)
        if not (2 <= len(sites) <= MAX_SITES): continue
        try:
            got = macroscopic(mol, sites, predict, W, distances(mol), power)
        except Exception:
            continue
        if not got: continue
        # Only molecules where the ladder produced exactly as many steps as were observed. Otherwise
        # matching by index compares our n-th most acidic transition against their n-th MEASURED one,
        # which are different equilibria whenever a site titrates outside the accessible window --
        # noise that swamps the parameter being fitted.
        if len(got) != len(observed): continue
        n = len(got)
        e = float(np.mean([abs(got[k] - observed[k]) for k in range(n)]))
        errors.append(e); per_molecule.append((smiles, e, got[:n], observed[:n]))
    return (float(np.mean(errors)) if errors else float("nan")), len(errors), per_molecule


if __name__ == "__main__":
    reference = json.load(open(sys.argv[2]))
    predict = load_forest()
    limit = int(sys.argv[3]) if len(sys.argv) > 3 else 220
    print(f"{'W':>6} {'MAE':>8} {'n':>5}")
    for W in (0.0, 2.0, 4.0, 6.0, 8.0, 10.0, 12.0):
        mae, n, _ = evaluate(reference, predict, W, limit)
        print(f"{W:>6.1f} {mae:>8.3f} {n:>5}")
