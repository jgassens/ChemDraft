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
import hashlib
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
    # Conjugation per ATOM, never per bond: which bond of a ring carries the double bond depends on the
    # Kekule structure chosen, and this model has shipped that bug four times.
    double_bonded = set()
    for bond in mol.GetBonds():
        if bond.GetBondTypeAsDouble() >= 2.0:
            double_bonded.add(bond.GetBeginAtomIdx())
            double_bonded.add(bond.GetEndAtomIdx())
    conjugated = lambda i: arom[i] or i in double_bonded
    neighbours = {a.GetIdx(): {n.GetIdx() for n in a.GetNeighbors()} for a in mol.GetAtoms()}

    out = set()
    for a in range(len(sites)):
        for b in range(a + 1, len(sites)):
            ia, _ka = sites[a]
            ib, _kb = sites[b]
            shared_ring = arom[ia] and arom[ib] and any(ia in r and ib in r for r in rings)
            # Two heteroatoms on one conjugated centre: urea's nitrogens across a carbonyl, an azole's
            # across a ring carbon. Moving the proton between them gives the same compound back.
            shared_centre = any(
                conjugated(n) and n in neighbours.get(ib, set()) for n in neighbours.get(ia, set())
            )
            if shared_ring or shared_centre: out.add((a, b))
    return out


def assert_one_rung_per_atom(sites):
    """Fail loudly if an atom carries more than one rung. The boolean fold below requires it.

    `protonation.ts` no longer represents a site as a boolean. Each ionizable ATOM there carries an
    ordered LADDER of contiguous charge levels, because an atom that both loses and gains a proton is
    one variable with two rungs and not two independent switches -- represented as switches, the
    enumeration could set both and describe a nitrogen that was -1 and +1 at once.

    This script keeps the boolean form, and that is SAFE ONLY WHILE EVERY ATOM HAS ONE RUNG, in which
    case a level index and a boolean are the same number. Every molecule in the fitting set and in
    `macro_validate.SET` satisfies that today -- `sites_of` returns after its first match per atom, so
    it cannot emit two -- which is why TypeScript and Python still reproduce each other exactly
    (glycine 1.56/10.00, ethylenediamine 6.60/9.67, succinic 3.81/5.79, imidazole 6.91/13.61).

    The guard exists because the failure would otherwise be silent and expensive: an amphoteric
    molecule entering the fitting set would have W fitted against a state space the shipped code does
    not use, and nothing would say so. If this ever fires, port this fold to levels rather than
    relaxing it.
    """
    seen = set()
    for atom, _kind in sites:
        if atom in seen:
            raise AssertionError(
                f"atom {atom} carries more than one rung, so this boolean fold no longer mirrors "
                "protonation.ts. Port `macroscopic` to ladder levels (mixed radix) before using it."
            )
        seen.add(atom)


def macroscopic(mol, sites, predict, W, dist, power=1.0, drop_tautomer_states=True):
    """Fold the ladder, applying the coupling correction to every edge.

    `sites` is a list of (atom index, "acidic"|"basic"), at most one per atom -- see
    `assert_one_rung_per_atom`, which is what keeps this a faithful mirror of `protonation.ts`.
    """
    assert_one_rung_per_atom(sites)
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
        # Basic unless the lone pair is spoken for. Kept in step with `acceptsAProton` in
        # ionization.ts, which is what these labels will be scored against.
        #
        # Pyrrole-type is decided by BONDING, not by whether the third substituent is a hydrogen:
        # N-methylpyrrole's nitrogen is exactly as unavailable as pyrrole's.
        in_ring = atom.IsInRing()
        own_double = any(b.GetBondTypeAsDouble() > 1.0 for b in atom.GetBonds())
        ring_nbrs_with_double = sum(
            1 for nb in atom.GetNeighbors()
            if nb.IsInRing() and any(
                b.GetBondTypeAsDouble() > 1.0 and b.GetOtherAtom(nb).IsInRing() for b in nb.GetBonds()))
        pyrrole = in_ring and not own_double and ring_nbrs_with_double >= 2
        if pyrrole: continue
        # An UNACTIVATED amide's lone pair is in the carbonyl: one carbonyl neighbour and nothing
        # else but saturated carbon.
        if not own_double:
            carbonyls, activated = 0, False
            for nb in atom.GetNeighbors():
                if nb.GetSymbol() != "C" or nb.GetIsAromatic(): activated = True; break
                dbl = [b for b in nb.GetBonds() if b.GetBondTypeAsDouble() == 2.0]
                het = [b for b in dbl if b.GetOtherAtom(nb).GetSymbol() in ("O", "S")]
                if het:
                    carbonyls += 1
                    for x in nb.GetNeighbors():
                        if x.GetIdx() == i or x.GetSymbol() in ("O", "S", "C"): continue
                        if x.GetSymbol() == "N" and not any(
                            b.GetBondTypeAsDouble() > 1.0 for b in x.GetBonds()): continue
                        activated = True
                elif dbl: activated = True
            if carbonyls == 1 and not activated: continue
        if len(atom.GetNeighbors()) + hs < 4:
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


SWEEP = (0.0, 1.0, 2.0, 3.0, 4.0, 6.0, 8.0, 10.0, 12.0)


def fit(reference, predict, limit):
    """Sweep W on the whole set and on each half of a scaffold split, and write `coupling.json`.

    This used to be a printout that somebody transcribed by hand, and `run_all.sh` never called it --
    so the shipped W stayed fitted to a corpus that had since been corrected and retrained under it.
    It is now part of the pipeline and writes the artifact itself.
    """
    halves = {0: {}, 1: {}}
    for smiles, observed in reference.items():
        mol = kekulized(smiles)
        if mol is None: continue
        # md5, NOT the builtin hash: Python salts string hashing per process, so `hash()` here put a
        # molecule in a different half on every run and the published split could not be reproduced.
        digest = hashlib.md5(scaffold_of(mol).encode()).hexdigest()
        halves[int(digest, 16) % 2][smiles] = observed

    sweep, best = {}, {}
    print(f"{'W':>6} {'halfA':>8} {'halfB':>8} {'all':>8}")
    for W in SWEEP:
        a, na, _ = evaluate(halves[0], predict, W, limit)
        h, nb, _ = evaluate(halves[1], predict, W, limit)
        c, nc, _ = evaluate(reference, predict, W, limit)
        sweep[W] = (a, h, c, na, nb, nc)
        print(f"{W:>6.1f} {a:>8.3f} {h:>8.3f} {c:>8.3f}")
    for name, i in (("halfA", 0), ("halfB", 1), ("all", 2)):
        best[name] = min(SWEEP, key=lambda W: sweep[W][i])

    W = best["all"]
    flat = [w for w in SWEEP if sweep[w][2] <= sweep[W][2] + 0.02]
    artifact = {
        "measurement": "fitted against observed MACROSCOPIC pKa, an aggregate the microscopic training "
                       "labels do not contain",
        "source": "Dwar-iBond rows grouped by parent molecule; polyprotic molecules whose ladder "
                  "produced exactly as many steps as were observed",
        "form": "dpKa_i = -W * sum over OTHER sites j of q_j / d_ij, with d the through-bond distance",
        "W": W,
        "flatRegion": [min(flat), max(flat)],
        "fitMae": round(sweep[W][2], 4),
        "fitMaeUncorrected": round(sweep[0.0][2], 4),
        "molecules": sweep[W][5],
        "scaffoldSplit": {
            "halfA": {"n": sweep[best["halfA"]][3], "bestW": best["halfA"],
                      "mae": round(sweep[best["halfA"]][0], 4), "maeAtZero": round(sweep[0.0][0], 4)},
            "halfB": {"n": sweep[best["halfB"]][4], "bestW": best["halfB"],
                      "mae": round(sweep[best["halfB"]][1], 4), "maeAtZero": round(sweep[0.0][1], 4)},
        },
        "appliesTo": "acid/base site pairs only",
        "note": "THE EFFECT HAS COLLAPSED. Fitted against the Dwar-iBond-only corpus this term was "
                "worth 1.36 log units on zwitterions and both scaffold halves independently chose "
                f"W = 7. Refitted after pKaCHU was added it is worth {round(sweep[0.0][2] - sweep[W][2], 3)}, "
                f"the halves choose {best['halfA']} and {best['halfB']} against {W} for the whole set, "
                "and the old W = 6 is now WORSE than no correction at all. The reason is that the "
                "correction was never really physics the model could not learn -- it was physics the "
                "LABELS did not contain. Dwar-iBond records only microstates a titration populates, "
                "never an amino acid's neutral form; pKaCHU does, so the model learns the contrast "
                "directly and the hand-fitted term has almost nothing left to add.",
    }
    json.dump(artifact, open("coupling.json", "w"), indent=1)
    print(f"\n   wrote coupling.json: W = {W}, worth "
          f"{sweep[0.0][2] - sweep[W][2]:.3f} log units against no correction")
    return artifact


if __name__ == "__main__":
    fit(json.load(open(sys.argv[2])), load_forest(), int(sys.argv[3]) if len(sys.argv) > 3 else 400)
