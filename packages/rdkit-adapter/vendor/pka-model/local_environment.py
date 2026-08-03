"""Context features measured OUTWARD FROM THE SITE, not over the whole molecule.

The nine whole-molecule descriptors are the model's only sense of context, and on a monofunctional
molecule they double as a description of the site itself -- which is what the model learned. Give it a
polyfunctional molecule and they describe somebody else's functional group: histidine's imidazole
predicts 7.18 against a measured 13.10, while bare imidazole predicts 14.68 against 14.40. Same site,
same local environment, different molecule.

These count the same kinds of thing inside a topological radius, so context stays available but
belongs to this site. Everything here is a graph count on the Kekule view, so TypeScript can
reproduce it exactly.
"""
from collections import deque

RADII = (1, 2, 3, 4, 6)
HALOGENS = {"F", "Cl", "Br", "I"}


def distances_from(adj, start):
    d = {start: 0}
    q = deque([start])
    while q:
        i = q.popleft()
        for j in adj[i]:
            if j not in d:
                d[j] = d[i] + 1
                q.append(j)
    return d


def local_features(atoms, bonds, adj, aromatic, site):
    """Counts within each radius, plus how far the nearest other ionizable-ish atom is."""
    d = distances_from(adj, site)
    out = []
    for r in RADII:
        near = [i for i, dist in d.items() if 0 < dist <= r]
        out += [
            float(len(near)),
            float(sum(1 for i in near if atoms[i]["el"] in ("N", "O", "S"))),
            float(sum(1 for i in near if atoms[i]["el"] in HALOGENS)),
            float(sum(1 for i in near if atoms[i]["chg"] > 0)),
            float(sum(1 for i in near if atoms[i]["chg"] < 0)),
            float(sum(1 for i in near if atoms[i]["h"] > 0 and atoms[i]["el"] in ("N", "O", "S"))),
            float(sum(1 for i in near if aromatic[i])),
            float(sum(1 for i in near
                      for j in adj[i] if j in d and d[j] <= r and bonds.get((i, j), 1) > 1)) / 2.0,
        ]
    # How far away the rest of the molecule's polar chemistry sits. A carboxyl four bonds off is a
    # different situation from one bonded directly, and the whole-molecule descriptors cannot say which.
    polar = [dist for i, dist in d.items() if dist > 0 and atoms[i]["el"] in ("N", "O", "S")]
    charged = [dist for i, dist in d.items() if dist > 0 and atoms[i]["chg"] != 0]
    out += [
        float(min(polar)) if polar else 12.0,
        float(min(charged)) if charged else 12.0,
        float(max(d.values())),          # how big the molecule is, as seen from here
        float(len(atoms) - len(d)),      # atoms in other fragments
    ]
    return out


FEATURE_NAMES = [f"r{r}_{k}" for r in RADII for k in
                 ("heavy", "polar", "halogen", "cation", "anion", "donor", "aromatic", "unsat")] + [
    "dist_nearest_polar", "dist_nearest_charge", "eccentricity", "other_fragment_atoms"]
