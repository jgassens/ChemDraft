"""Per-atom aromaticity computed from the KEKULE graph, so TypeScript can reproduce it exactly.

RDKit's own `GetIsAromatic()` cannot be used as a model feature: MinimalLib's `get_json()` is
Kekule-ised and carries no aromaticity flag, so a feature trained on RDKit's answer would mean
something different at inference time. That is why aromaticity was dropped from the feature set
originally. This computes it instead, by a rule that reads only bond orders and atom counts:

  pi = 2 x (double bonds inside the ring)
     + 2 x (ring heteroatoms with no ring double bond, whose lone pair joins the system)

aromatic when every ring atom is sp2, none carries a double bond leaving the ring, and pi is 4n+2.

Benzene: 3 ring double bonds -> 6. Pyridine: 3 -> 6, its nitrogen contributing none (lone pair in
plane). Pyrrole and imidazole: 2 double bonds -> 4, plus the N-H lone pair -> 6. Cyclohexene has sp3
atoms and is rejected; p-benzoquinone has exocyclic C=O and is rejected.
"""
from rdkit import Chem

MAX_RING = 8


def kekule_graph(mol):
    k = Chem.Mol(mol)
    Chem.Kekulize(k, clearAromaticFlags=True)
    atoms = [{"el": a.GetSymbol(), "chg": a.GetFormalCharge(), "h": a.GetTotalNumHs()} for a in k.GetAtoms()]
    bonds = {}
    adj = [[] for _ in atoms]
    for b in k.GetBonds():
        i, j = b.GetBeginAtomIdx(), b.GetEndAtomIdx()
        bonds[(i, j)] = bonds[(j, i)] = int(b.GetBondTypeAsDouble())
        adj[i].append(j); adj[j].append(i)
    return atoms, bonds, adj


def cycles_through(adj, start, limit=MAX_RING):
    """Every simple cycle through `start` up to `limit` atoms."""
    out, seen = [], set()
    def walk(path):
        last = path[-1]
        for nxt in adj[last]:
            if nxt == start and len(path) >= 3:
                key = frozenset(path)
                if key not in seen:
                    seen.add(key); out.append(list(path))
            elif nxt not in path and len(path) < limit:
                walk(path + [nxt])
    walk([start])
    return out


def ring_is_aromatic(atoms, bonds, adj, cycle):
    """Huckel count done PER ATOM, which is what makes it Kekule-invariant.

    Counting double bonds *inside* the ring is not invariant: in a fused system the shared bond belongs
    to whichever ring the Kekule assignment gave it, so naphthalene's two rings can come out with three
    and two internal doubles respectively -- and RDKit in Python and MinimalLib in the browser do not
    always choose the same assignment. Counting each atom's own contribution removes the choice:

        sp2 ring atom carrying any double bond      -> 1 electron
        ring heteroatom with a lone pair, no double -> 2 electrons

    Benzene 6, pyridine 6, pyrrole 4+2, imidazole 4+2, tetrazole 4+2, naphthalene 6 either way.

    The exocyclic clause rejects a double bond to a TERMINAL heteroatom. That is what disqualifies
    p-benzoquinone, whose carbonyls drain the ring. It must not reject a double bond to a fused
    partner, of either element: quinoline's benzo ring has a fusion atom whose double bond points at
    the ring NITROGEN, and rejecting on "the partner is not carbon" declared that ring non-aromatic.
    Python happened to rescue it through a ten-membered perimeter cycle and TypeScript did not, so the
    two disagreed on every fused heteroaromatic -- quinoline, quinoxaline, purine, benzothiazole,
    benzimidazole. Degree is the discriminator: a carbonyl oxygen has one neighbour, a fused ring atom
    has two or more.
    """
    ring = set(cycle)
    pi = 0
    for i in cycle:
        a = atoms[i]
        own_double = any(bonds.get((i, j), 1) > 1 for j in adj[i])
        if len(adj[i]) + a["h"] >= 4 and not own_double:
            return False   # sp3 centre: not part of a flat system
        if any(bonds.get((i, j), 1) > 1 and j not in ring and atoms[j]["el"] != "C" and len(adj[j]) == 1
               for j in adj[i]):
            return False   # a TERMINAL =O / =S draining the ring, not a fused partner
        if own_double:
            pi += 1
        elif a["el"] in ("N", "O", "S"):
            pi += 2
        else:
            return False   # a ring atom that is neither sp2 nor a donor breaks conjugation
    return pi % 4 == 2


def aromatic_atoms(mol):
    atoms, bonds, adj = kekule_graph(mol)
    flags = [False] * len(atoms)
    for i in range(len(atoms)):
        if flags[i]:
            continue
        for cycle in cycles_through(adj, i):
            if ring_is_aromatic(atoms, bonds, adj, cycle):
                for j in cycle:
                    flags[j] = True
                break
    return flags


def site_flags(mol):
    """(aromatic, pyrrole_type) per atom, both read off the KEKULE graph.

    Computing the pyrrole test on the sanitised molecule silently disables it: RDKit reports an
    aromatic bond as order 1.5 there, so "has no multiple bond of its own" is false for every aromatic
    atom and the flag is always zero. It has to be read from the same Kekule view the model will see.
    """
    atoms, bonds, adj = kekule_graph(mol)
    aromatic = aromatic_atoms(mol)
    pyrrole = []
    for i, a in enumerate(atoms):
        own_double = any(bonds.get((i, j), 1) > 1 for j in adj[i])
        pyrrole.append(bool(aromatic[i] and a["h"] > 0 and not own_double))
    return aromatic, pyrrole
