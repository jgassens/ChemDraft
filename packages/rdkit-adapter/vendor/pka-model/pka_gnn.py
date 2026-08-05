"""A site-centred message-passing network, to replace the random forest.

**Why.** The forest hit a wall that was measured rather than argued. Adding the IUPAC weak-base labels
— clean data, 2,509 of 2,510 sites independently verified — made every held-out figure worse, because
a 60-tree forest has no room for them. Growing it recovers the accuracy and destroys the artifact:
1.114 cvMAE at 60 trees and 10 MB, 1.054 at 300 trees and 208 MB. `pkaModel.ts` already named this
wall from the design side ("a GNN would score better and could not ship"); the data reached it from
the other.

**"Could not ship" was about the RUNTIME, not the weights.** The objection is that inference must run
in-process in a TypeScript desktop app with no Python and no PyTorch. That rules out importing a
framework; it does not rule out a network. This model is roughly 150k parameters — about 1 MB of
float32, SIX TIMES SMALLER than the forest it replaces — and its inference is gather, scatter, matmul
and ReLU, which is a few hundred lines of TypeScript. `pkaGnn.ts` is that, and `parity-fixture.json`
pins the two against each other exactly as it does for the forest.

**Every op here is chosen to be portable.** No batch norm, no dropout at inference, no attention, no
framework-specific kernels. A layer is:

    m_v  = sum over neighbours u of  W_msg @ [h_u ; e_uv]
    h_v' = ReLU(W_upd @ [h_v ; m_v] + b)

and the readout concatenates the SITE atom's final embedding with a sum over all atoms. That is
reimplementable without judgement calls, which is the property that matters: a feature or an operation
that means something different at inference than it did in training is worse than one that does not
exist.

**Features reuse what is already parity-tested.** Element, charge, hydrogen count, degree and bond
order come straight from the graph both sides already share. Aromaticity comes from `aromaticity.py`
and ring membership from the same leaf-pruning rule `pkaModel.ts` uses — the two hard cases, both
already written twice and checked against each other. Nothing new has to be trusted.

    python3 pka_gnn.py <labels.json> <out-dir>
"""
import json
import math
import sys

import numpy as np
import torch
import torch.nn as nn
from rdkit import Chem, RDLogger

import aromaticity
from parity_features import kekulized, scaffold_of

RDLogger.DisableLog("rdApp.*")

torch.manual_seed(0)
np.random.seed(0)

# The one-hot element order. Fixed, and shared with the TypeScript: reordering it silently rebinds
# every weight in the first layer.
ELEMENTS = ["N", "O", "C", "S", "P", "F", "Cl", "Br", "I"]
ATOM_FEATURES = len(ELEMENTS) + 1 + 6 + 6 + 5 + 2 + 1   # element, other, charge, H, degree, flags, site
BOND_FEATURES = 5                     # aromatic, then order 1/2/3 for non-aromatic bonds, in-ring

# An ENSEMBLE, because the pipeline downstream is built on disagreement.
#
# The forest gave an interval for free: its trees disagree, and `predictSitePkaWithSpread` returned
# that spread. Everything above depends on it -- the confidence ring in the figure, the rule that keeps
# a rung out of a titration curve when its interval spans half the aqueous range, and the weighting
# that combines the model with the Hammett relationship. A single network has no such quantity.
#
# Independent seeds reproduce the same semantics exactly: several models, the mean is the estimate and
# the spread is the disagreement, and the existing calibration pipeline reads it unchanged. Smaller
# members keep the whole ensemble near the artifact size of the single forest it replaces.
ENSEMBLE = 4
# 96, and that is a measured choice rather than a default. One scaffold-grouped held-out fold, one
# member per configuration, so the ranking is comparable and the absolute numbers are not the published
# cvMAE (no ensemble averaging, one fold):
#
#     configuration                  MAE    RMSE     params  minutes
#     predict the mean            2.4262
#     baseline  H96  L3  E60      0.8190  1.3476    106,561      3.0
#     wider     H160 L3  E60      0.7650  1.2673    290,241      6.0
#     deeper    H96  L5  E60      0.8099  1.3298    163,201      3.6
#     longer    H96  L3  E150     0.7759  1.2852    106,561      6.2
#     big       H160 L5  E150     0.7777  1.2922    446,081      9.1
#
# WIDTH is the axis that pays: 6.6% for 2.7x the parameters. Depth buys almost nothing, a longer
# schedule buys half of what width does, and combining all three is WORSE than width alone -- 0.7777
# against 0.7650 -- so the big configuration is overfitting rather than short of capacity.
#
# Reproduce with `capacity_sweep.py`. The single-fold figure OVERSTATES it: cross-validated properly at
# HIDDEN = 160, five folds and four members, cvMAE is 0.7156 against 0.7281 -- 1.7%, not 6.6%, because
# most of what extra width buys a four-member ensemble was already buying. End to end it is mixed: the
# curated macroscopic set improves 17% (0.295 -> 0.246) and SAMPL6's matched figure 2% (0.491 -> 0.480),
# zwitterions REGRESS 40% (0.165 -> 0.232), over-detection is untouched at 49 extra steps, and the
# artifact goes 4.5 MB to 12.2 MB. See BUILD.md for the full table and how to apply it.
HIDDEN = 96
LAYERS = 3
EPOCHS = 60
BATCH = 64
LEARNING_RATE = 1e-3


def one_hot(value, size):
    vector = [0.0] * size
    if 0 <= value < size:
        vector[value] = 1.0
    return vector


def ring_membership(adjacency):
    """Leaf pruning, the same rule `pkaModel.ts` uses. Trivially identical in both languages."""
    degree = [len(neighbours) for neighbours in adjacency]
    alive = [True] * len(adjacency)
    changed = True
    while changed:
        changed = False
        for i in range(len(adjacency)):
            if alive[i] and degree[i] < 2:
                alive[i] = False
                changed = True
                for j in adjacency[i]:
                    if alive[j]:
                        degree[j] -= 1
    return alive


def featurise(mol, site):
    """Atom features, bond features and the edge list, from a KEKULISED molecule."""
    n = mol.GetNumAtoms()
    adjacency = [[] for _ in range(n)]
    for bond in mol.GetBonds():
        adjacency[bond.GetBeginAtomIdx()].append(bond.GetEndAtomIdx())
        adjacency[bond.GetEndAtomIdx()].append(bond.GetBeginAtomIdx())
    adjacency_of = adjacency

    arom_flags = aromaticity.aromatic_atoms(mol)
    edges, edge_features = [], []
    for bond in mol.GetBonds():
        a, b = bond.GetBeginAtomIdx(), bond.GetEndAtomIdx()
        order = int(bond.GetBondTypeAsDouble())
        # Bond-in-ring from the SHARED cycle walk, never RDKit's ring perception. `bond.IsInRing()` has
        # no TypeScript counterpart, and the naive substitute — both atoms are in a ring — is wrong for
        # biphenyl's central bond, which joins two ring atoms and lies in none.
        in_ring = any(a in cycle and b in cycle
                      for cycle in aromaticity.cycles_through(adjacency_of, a))
        # An AROMATIC bond carries no usable order, and saying otherwise is not Kekule-invariant:
        # RDKit here and MinimalLib in the browser choose different Kekule structures for the same
        # ring, so the same bond is order 1 in one and 2 in the other. The parity fixture caught this
        # on a quinolinium, 4.91 against 4.28 — a whole feature channel disagreeing, not float noise.
        # An aromatic bond is therefore flagged and its order withheld; a non-aromatic order IS
        # invariant and is kept. Aromaticity per ATOM is what `aromatic_atoms` already guarantees.
        aromatic_bond = arom_flags[a] and arom_flags[b] and in_ring
        feature = ([1.0] if aromatic_bond else [0.0]) \
            + ([0.0, 0.0, 0.0] if aromatic_bond else one_hot(order - 1, 3)) \
            + [1.0 if in_ring else 0.0]
        # Both directions: messages flow each way.
        edges.append((a, b)); edge_features.append(feature)
        edges.append((b, a)); edge_features.append(feature)

    aromatic = arom_flags
    in_ring = ring_membership(adjacency)

    atoms = []
    for i, atom in enumerate(mol.GetAtoms()):
        symbol = atom.GetSymbol()
        index = ELEMENTS.index(symbol) if symbol in ELEMENTS else -1
        atoms.append(
            one_hot(index, len(ELEMENTS))
            + [1.0 if index < 0 else 0.0]
            + one_hot(atom.GetFormalCharge() + 2, 6)
            + one_hot(atom.GetTotalNumHs(), 6)
            + one_hot(len(adjacency[i]), 5)
            + [1.0 if aromatic[i] else 0.0, 1.0 if in_ring[i] else 0.0]
            + [1.0 if i == site else 0.0]
        )
    return np.array(atoms, dtype=np.float32), np.array(edge_features, dtype=np.float32), edges


class SitePkaNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.embed = nn.Linear(ATOM_FEATURES, HIDDEN)
        self.message = nn.ModuleList(
            [nn.Linear(HIDDEN + BOND_FEATURES, HIDDEN) for _ in range(LAYERS)]
        )
        self.update = nn.ModuleList([nn.Linear(HIDDEN * 2, HIDDEN) for _ in range(LAYERS)])
        self.readout = nn.Sequential(
            nn.Linear(HIDDEN * 2, HIDDEN), nn.ReLU(), nn.Linear(HIDDEN, 1)
        )

    def forward(self, atoms, bonds, src, dst, graph_of_atom, site_index, graphs):
        h = torch.relu(self.embed(atoms))
        for layer in range(LAYERS):
            carried = torch.cat([h[src], bonds], dim=1)
            messages = torch.relu(self.message[layer](carried))
            gathered = torch.zeros_like(h).index_add_(0, dst, messages)
            h = torch.relu(self.update[layer](torch.cat([h, gathered], dim=1)))
        pooled = torch.zeros(graphs, HIDDEN, device=h.device).index_add_(0, graph_of_atom, h)
        return self.readout(torch.cat([h[site_index], pooled], dim=1)).squeeze(-1)


def load(path):
    rows, skipped = [], 0
    for row in json.load(open(path)):
        mol = kekulized(row["acid"])
        if mol is None or row["acidAtomIdx"] >= mol.GetNumAtoms():
            skipped += 1
            continue
        atoms, bonds, edges = featurise(mol, row["acidAtomIdx"])
        rows.append({
            "atoms": atoms, "bonds": bonds, "edges": edges,
            "site": row["acidAtomIdx"], "y": float(row["pKa"]),
            "scaffold": scaffold_of(mol), "acid": row["acid"],
        })
    print(f"   featurised {len(rows)} rows, skipped {skipped}")
    return rows


def collate(batch, device):
    atoms, bonds, src, dst, graph_of_atom, sites, ys = [], [], [], [], [], [], []
    offset = 0
    for index, row in enumerate(batch):
        atoms.append(row["atoms"])
        graph_of_atom += [index] * len(row["atoms"])
        if len(row["edges"]) > 0:
            bonds.append(row["bonds"])
            for a, b in row["edges"]:
                src.append(a + offset); dst.append(b + offset)
        sites.append(row["site"] + offset)
        ys.append(row["y"])
        offset += len(row["atoms"])
    t = lambda x, dtype=torch.long: torch.tensor(x, dtype=dtype, device=device)
    return (
        torch.tensor(np.concatenate(atoms), device=device),
        torch.tensor(np.concatenate(bonds), device=device) if bonds
        else torch.zeros(0, BOND_FEATURES, device=device),
        t(src), t(dst), t(graph_of_atom), t(sites),
        len(batch), t(ys, torch.float32),
    )


def train_once(train_rows, device, epochs=EPOCHS, seed=0):
    torch.manual_seed(seed)
    model = SitePkaNet().to(device)
    optimiser = torch.optim.Adam(model.parameters(), lr=LEARNING_RATE)
    schedule = torch.optim.lr_scheduler.OneCycleLR(
        optimiser, max_lr=LEARNING_RATE * 3,
        total_steps=epochs * max(1, math.ceil(len(train_rows) / BATCH)),
    )
    order = np.arange(len(train_rows))
    for _ in range(epochs):
        np.random.shuffle(order)
        model.train()
        for start in range(0, len(order), BATCH):
            batch = [train_rows[i] for i in order[start:start + BATCH]]
            atoms, bonds, src, dst, graph_of_atom, sites, graphs, ys = collate(batch, device)
            optimiser.zero_grad()
            # L1: the published metric is MAE, and it is far less sensitive to the handful of extreme
            # labels than a squared loss would be.
            loss = nn.functional.l1_loss(
                model(atoms, bonds, src, dst, graph_of_atom, sites, graphs), ys
            )
            loss.backward()
            optimiser.step()
            schedule.step()
    return model


@torch.no_grad()
def predict(model, rows, device):
    model.eval()
    out = []
    for start in range(0, len(rows), 256):
        batch = rows[start:start + 256]
        atoms, bonds, src, dst, graph_of_atom, sites, graphs, _ = collate(batch, device)
        out.append(model(atoms, bonds, src, dst, graph_of_atom, sites, graphs).cpu().numpy())
    return np.concatenate(out) if out else np.zeros(0)


def cross_validate(rows, device, folds=5):
    """Bemis-Murcko scaffold groups held out, the same split the forest is judged on.

    The ensemble is trained INSIDE the fold, so the reported figure is the ensemble's, and the spread
    it reports is measured on data no member saw. Calibrating a spread on rows the models were fitted
    to would make it look far tighter than it is.
    """
    scaffolds = sorted({row["scaffold"] for row in rows})
    assignment = {s: i % folds for i, s in enumerate(scaffolds)}
    errors, spreads = [], []
    # Out-of-fold predictions, saved so the consensus calibration can use them. Fitting the weighting
    # against in-sample predictions would make the network look better than it is exactly where it is
    # being compared with a relationship that was never fitted here at all.
    oof = [None] * len(rows)
    index_of = {id(row): i for i, row in enumerate(rows)}
    for fold in range(folds):
        train = [r for r in rows if assignment[r["scaffold"]] != fold]
        test = [r for r in rows if assignment[r["scaffold"]] == fold]
        if not test:
            continue
        members = [train_once(train, device, seed=seed) for seed in range(ENSEMBLE)]
        stacked = np.stack([predict(m, test, device) for m in members])
        error = np.abs(stacked.mean(axis=0) - np.array([r["y"] for r in test]))
        errors.append(error)
        spreads.append(stacked.std(axis=0))
        for row, value, spread in zip(test, stacked.mean(axis=0), stacked.std(axis=0)):
            oof[index_of[id(row)]] = (float(value), float(spread))
        print(f"   fold {fold}: n={len(test)} MAE {error.mean():.4f}")
    return np.concatenate(errors), np.concatenate(spreads), oof


def round6(value):
    """Six decimals. float32 carries about seven significant digits, so the rest is noise that only
    makes the artifact bigger -- and both sides then read the SAME number. Unlike a decision
    threshold, a network weight has no cliff to round off."""
    if isinstance(value, list):
        return [round6(v) for v in value]
    return round(value, 6)


def export(members, path, training):
    """Weights as plain nested lists, in the order `pkaGnn.ts` reads them."""
    weights = [
        {name: round6(tensor.detach().cpu().numpy().tolist())
         for name, tensor in model.state_dict().items()}
        for model in members
    ]
    json.dump({
        "architecture": {
            "elements": ELEMENTS, "atomFeatures": ATOM_FEATURES, "bondFeatures": BOND_FEATURES,
            "hidden": HIDDEN, "layers": LAYERS, "ensemble": len(members),
        },
        "members": weights,
        "training": training,
    }, open(path, "w"))
    parameters = sum(t.numel() for t in members[0].state_dict().values()) * len(members)
    import os
    print(f"   wrote {path}: {parameters:,} parameters, {os.path.getsize(path) / 1e6:.1f} MB")


def main(labels_path, out_dir):
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    print(f"device {device}")
    rows = load(labels_path)
    print("== scaffold-grouped cross-validation ==")
    errors, spreads, oof = cross_validate(rows, device)
    mae = float(errors.mean())
    # Does the ensemble's disagreement track its actual error? The forest's tree variance managed
    # r = 0.52, and that number is what the interval mechanism rests on.
    correlation = float(np.corrcoef(spreads, errors)[0, 1])
    multiplier = float(np.percentile(errors / np.maximum(spreads, 1e-6), 68))
    print(f"   spread vs error r = {correlation:.3f}")
    baseline = float(np.abs(np.array([r["y"] for r in rows]) - np.mean([r["y"] for r in rows])).mean())
    print(f"   MAE {mae:.4f}   RMSE {float(np.sqrt((errors ** 2).mean())):.4f}   "
          f"(predicting the mean: {baseline:.4f})")
    json.dump(
        [{"acid": row["acid"], "acidAtomIdx": row["site"], "observed": row["y"],
          "predicted": round(pair[0], 4), "spread": round(pair[1], 4)}
         for row, pair in zip(rows, oof) if pair is not None],
        open(f"{out_dir}/gnn-oof.json", "w"),
    )
    print("== final fit on everything ==")
    members = [train_once(rows, device, seed=seed) for seed in range(ENSEMBLE)]
    export(members, f"{out_dir}/site-pka-gnn.json", {
        "spreadCorrelation": round(correlation, 4),
        "spreadMultiplier": round(multiplier, 4),
        "intervalQuartiles": [round(float(np.percentile(spreads, q)), 4) for q in (25, 50, 75)],
        "ensemble": ENSEMBLE,
        "samples": len(rows), "cvMae": round(mae, 4),
        "grouping": "Bemis-Murcko scaffold", "groups": len({r["scaffold"] for r in rows}),
        "baselinePredictTheMean": round(baseline, 4),
        "hidden": HIDDEN, "layers": LAYERS, "epochs": EPOCHS,
    })


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else ".")
