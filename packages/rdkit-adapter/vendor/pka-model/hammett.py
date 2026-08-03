"""Hammett LFER, written against the same graph view the TypeScript gets.

No aromaticity flags (RDKit's JSON is Kekule-ised and carries none), no SMILES writer, no ring
perception beyond what is reimplementable in a few lines. Every step here has a line-for-line
counterpart in `hammett.ts`; a fixture pins the two together.
"""
import json, sys
from collections import deque
from rdkit import Chem, RDLogger
RDLogger.DisableLog("rdApp.*")

# Substituent -> (sigma_meta, sigma_para), keyed by the shell signature below.
# Values: Hansch, Leo & Taft, Chem. Rev. 91 (1991) 165-195.
_t = json.load(open(__file__.rsplit("/", 1)[0] + "/hammett-sigma.json"))
SIGMA = {k: (v[0], v[1]) for k, v in _t["sigma"].items()}
SIGMA_PARA_MINUS = {k: v[0] for k, v in _t["sigmaParaMinus"].items()}
NAMES = {k: v[2] for k, v in _t["sigma"].items()}
# pKa0, rho, and which equilibrium the series describes. The two basic series report the CONJUGATE
# ACID's pKa -- the anilinium and the pyridinium -- which is the number a chemist means. Constants from
# Jaffe (1953) and Perrin; none fitted here.
SERIES = {"benzoic": (4.20, 1.00, "acidic"), "phenol": (9.95, 2.23, "acidic"),
          "anilinium": (4.60, 2.89, "basic"), "pyridinium": (5.25, 5.90, "basic")}


def graph_of(smiles):
    """The same {atoms, bonds} view `pkaModel.ts` builds from RDKit's JSON."""
    mol = Chem.MolFromSmiles(smiles)
    if mol is None: return None, None
    mol_k = Chem.Mol(mol); Chem.Kekulize(mol_k, clearAromaticFlags=True)
    atoms = [{"element": a.GetSymbol(), "charge": a.GetFormalCharge(), "hydrogens": a.GetTotalNumHs()}
             for a in mol_k.GetAtoms()]
    bonds = [{"atoms": (b.GetBeginAtomIdx(), b.GetEndAtomIdx()), "order": int(b.GetBondTypeAsDouble())}
             for b in mol_k.GetBonds()]
    return {"atoms": atoms, "bonds": bonds}, mol


def adjacency(g):
    adj = [[] for _ in g["atoms"]]
    for b in g["bonds"]:
        adj[b["atoms"][0]].append(b["atoms"][1]); adj[b["atoms"][1]].append(b["atoms"][0])
    return adj


def bond_order(g, i, j):
    for b in g["bonds"]:
        if set(b["atoms"]) == {i, j}: return b["order"]
    return 0


def carbon_six_cycle(g, adj, ipso):
    """A six-membered all-carbon ring through `ipso`, chosen deterministically.

    Note what this does NOT check: bond orders. RDKit picks one Kekule structure out of several, and
    for naphthalene the one it picks leaves the substituted ring with two internal double bonds rather
    than three -- and the Python and WASM bindings do not always pick the same one. Any test that reads
    the alternation pattern is therefore a coin flip. Ring identity is decided here on connectivity
    alone, which every Kekule form agrees on, and the aromaticity question is asked separately below.
    """
    cycles = [sorted(c) for c in six_cycles(adj, ipso)
              if all(g["atoms"][i]["element"] == "C" and g["atoms"][i]["charge"] == 0 for i in c)]
    if not cycles: return None
    keep = sorted(cycles)[0]
    for c in six_cycles(adj, ipso):
        if sorted(c) == keep: return c
    return None


def is_benzene(g, adj, cycle):
    """Every ring atom sp2, with no double bond leaving the ring.

    Kekule-independent: it asks whether each atom has three connections and a valence of four, not
    where the double bonds happen to have been drawn. The exocyclic clause is what keeps
    p-benzoquinone out -- its carbonyl carbons are sp2 with a valence of four and would otherwise read
    as a benzene ring, earning a quinol a phenol's reaction constant.
    """
    ring = set(cycle)
    for i in cycle:
        a = g["atoms"][i]
        if len(adj[i]) + a["hydrogens"] != 3: return False
        if sum(bond_order(g, i, j) for j in adj[i]) + a["hydrogens"] != 4: return False
        if any(bond_order(g, i, j) == 2 and j not in ring for j in adj[i]): return False
    return True


def six_cycles(adj, start):
    """Every 6-cycle through `start`, as an ordered atom list."""
    out, seen = [], set()
    def walk(path):
        if len(path) == 6:
            if start in adj[path[-1]]:
                key = frozenset(path)
                if key not in seen: seen.add(key); out.append(list(path))
            return
        for nxt in adj[path[-1]]:
            if nxt not in path and (len(path) < 5 or start in adj[nxt] or True):
                walk(path + [nxt])
    walk([start])
    return out


def is_fused(adj, cycle):
    """Cut the ring's own bonds; if any two ring atoms remain connected, the ring is fused or bridged.

    Biphenyl survives this (only the ipso carbon reaches the second ring, so no two ring atoms end up
    in one component); naphthalene does not (its bridgeheads stay joined through the other ring).

    The search has to start from EVERY ring atom, not just one. Starting only at ring[0] means never
    starting at a bridgehead, and 2-naphthol then passes the test -- it happened to decline anyway, for
    the unrelated reason that its fused ring has no sigma constant, which is luck rather than a check.
    """
    ringset = set(cycle)
    cut = {(cycle[k], cycle[(k + 1) % 6]) for k in range(6)}
    cut |= {(b, a) for a, b in cut}
    for start in cycle:
        seen, q = {start}, deque([start])
        while q:
            i = q.popleft()
            for j in adj[i]:
                if (i, j) in cut or j in seen: continue
                if j in ringset: return True
                seen.add(j); q.append(j)
    return False


def shell_key(g, adj, ring, ipso_group, attach):
    """A parity-safe identity for the branch hanging off `attach`.

    Not a SMILES -- there is no writer on the TypeScript side. Instead, BFS shells outward from the
    attachment atom, each shell a sorted list of (element, charge, H count, degree). Keeping shell 0
    distinct is what separates -NHC(=O)CH3 from -C(=O)NHCH3, which have identical atom multisets and
    quite different sigma.
    """
    blocked = set(ring) | set(ipso_group)
    shells, frontier, seen = [], [attach], set(blocked) | {attach}
    while frontier and len(shells) < 4:
        shells.append(sorted(
            f"{g['atoms'][i]['element']}{g['atoms'][i]['charge']:+d}h{g['atoms'][i]['hydrogens']}"
            f"d{len(adj[i])}" for i in frontier))
        nxt = []
        for i in frontier:
            for j in adj[i]:
                if j not in seen: seen.add(j); nxt.append(j)
        frontier = nxt
    return "|".join(",".join(s) for s in shells)


def nitrogen_series(smiles, g, adj, idx):
    """Aniline and pyridine-type nitrogens, both reporting their conjugate acid's pKa.

    The ring must be AROMATIC. Without that check cyclohexylammonium reads as an anilinium and
    N-ethylpiperidinium as a pyridinium, which measured MAE 0.45 and 1.78; with it, 0.219 and 0.271.
    """
    import aromaticity
    from rdkit import Chem
    mol = Chem.MolFromSmiles(smiles)
    if mol is None: return None, "unparsable"
    arom = aromaticity.aromatic_atoms(mol)
    atom = g["atoms"][idx]
    # Charge-agnostic on purpose. The training labels carry the ACID microstate, so their aniline and
    # pyridine sites are cations; the app sees the neutral form it was drawn as. Both name the same
    # equilibrium and both give the same sigma sum, so both are accepted and the value returned is the
    # conjugate acid's either way.
    if atom["charge"] not in (0, 1): return None, "site nitrogen carries an unexpected charge"

    if atom["hydrogens"] >= 1 and len(adj[idx]) == 1:
        ipso = adj[idx][0]
        if g["atoms"][ipso]["element"] == "C" and arom[ipso]:
            ring = carbon_six_cycle(g, adj, ipso)
            if ring and all(arom[j] for j in ring):
                return sum_over_ring(g, adj, "anilinium", ipso, ring, {idx})

    # Neutral pyridine has no hydrogen on the ring nitrogen; its conjugate acid has one. Both are the
    # same equilibrium seen from opposite sides, and the training labels only ever carry the cation.
    if arom[idx] and ((atom["charge"] == 0 and atom["hydrogens"] == 0) or
                      (atom["charge"] == 1 and atom["hydrogens"] == 1)):
        for c in six_cycles(adj, idx):
            if len(c) != 6 or not all(arom[j] for j in c): continue
            if sum(1 for j in c if g["atoms"][j]["element"] == "N") != 1: continue
            # The ipso nitrogen may be charged (a pyridinium); the rest of the ring may not.
            if not all(g["atoms"][j]["element"] in ("C", "N") for j in c): continue
            if any(g["atoms"][j]["charge"] != 0 for j in c if j != idx): continue
            return sum_over_ring(g, adj, "pyridinium", idx, c, {idx})

    return None, "not an aniline or a pyridine-type nitrogen"


def sum_over_ring(g, adj, series, ipso, ring, ipso_group):
    """Walk the ring from `ipso` and sum sigma. Shared by all four series."""
    if is_fused(adj, ring): return None, "ring is fused"
    k = ring.index(ipso); order = ring[k:] + ring[:k]
    total, detail = 0.0, []
    for pos, a in enumerate(order):
        if pos == 0: continue
        branches = [j for j in adj[a] if j not in ring and j not in ipso_group]
        if not branches: continue
        dist = min(pos, 6 - pos)
        if dist == 1: return None, "ortho substituent"
        for b in branches:
            key = shell_key(g, adj, ring, ipso_group, b)
            if key not in SIGMA: return None, f"no sigma constant for {key}"
            # sigma-minus only where the product anion conjugates into the substituent: the phenolate.
            s = (SIGMA_PARA_MINUS[key] if dist == 3 and series == "phenol" and key in SIGMA_PARA_MINUS
                 else SIGMA[key][0 if dist == 2 else 1])
            total += s; detail.append((("meta" if dist == 2 else "para"), key, s))
    pka0, rho, transition = SERIES[series]
    return {"pKa": pka0 - rho * total, "series": series, "transition": transition,
            "sigmaSum": total, "substituents": detail}, None


def estimate(smiles, site_idx):
    g, _ = graph_of(smiles)
    if g is None or site_idx >= len(g["atoms"]): return None, "unparsable"
    adj = adjacency(g)
    atom = g["atoms"][site_idx]
    if atom["element"] == "N": return nitrogen_series(smiles, g, adj, site_idx)
    if atom["element"] != "O": return None, "site is neither an oxygen nor a nitrogen"
    if atom["charge"] != 0 or atom["hydrogens"] != 1: return None, "site oxygen is not a neutral -OH"
    if any(bond_order(g, site_idx, j) != 1 for j in adj[site_idx]): return None, "site oxygen is not singly bonded"

    group = ipso = ipso_group = ring = None
    for n in adj[site_idx]:
        if g["atoms"][n]["element"] != "C": continue
        r = carbon_six_cycle(g, adj, n)
        if r is not None:
            group, ipso, ipso_group, ring = "phenol", n, {site_idx}, r
            break
        others = [m for m in adj[n] if m != site_idx]
        carbonyl = [m for m in others if g["atoms"][m]["element"] == "O" and bond_order(g, n, m) == 2]
        aryl = [(m, carbon_six_cycle(g, adj, m)) for m in others if g["atoms"][m]["element"] == "C"]
        aryl = [(m, r2) for m, r2 in aryl if r2 is not None]
        if len(others) == 2 and len(carbonyl) == 1 and len(aryl) == 1:
            group, ipso, ipso_group, ring = "benzoic", aryl[0][0], {site_idx, n, carbonyl[0]}, aryl[0][1]
            break
    if group is None: return None, "not a benzoic acid or phenol"
    # Fused FIRST, then aromaticity. Both orders are safe, but only this one gives the same answer
    # whichever Kekule structure the engine handed over. The oxygen series additionally require a
    # CARBOCYCLIC aromatic ring, which the nitrogen series do not.
    if is_fused(adj, ring): return None, "ring is fused"
    if not is_benzene(g, adj, ring): return None, "ring is not benzene"
    return sum_over_ring(g, adj, group, ipso, ring, ipso_group)
