"""Does reading the CONJUGATE BASE help? A paired A/B where the only difference is the model.

**The observation.** 8,074 of the 12,096 training rows carry an explicit acid-to-conjugate-base structure
pair, and `pka_gnn.load` reads `acid`, `acidAtomIdx` and `pKa` -- it throws the base away. Deprotonation IS
the charge redistribution between those two graphs, so an acid-only network has to infer the product state
it was never shown. Giving it both should be strictly more informative.

**Both arms run through this file.** `--mode acid-only` reproduces the shipped architecture and `--mode pair`
adds the base; folds, features, seeds, optimiser, schedule, epochs and loss are byte-identical between them.
Comparing against `pka_gnn.py` instead would confound the model with everything else that differs.

**The base is CONSTRUCTED, never read from the corpus, and that is the important design decision.** At
inference nothing hands the runtime a base structure -- `protonation.ts` builds every microstate itself --
so a model trained on recorded bases and served on constructed ones carries exactly the train/serve skew the
parity fixture exists to catch, and no cross-validation can see it. `parity_features.deprotonated` is
therefore used for every row, and the 8,051-of-8,056 agreement with the recorded bases is what licenses
that: the recorded pairs become a test of the constructor rather than an input to the model.

Construction also covers the 4,022 QupKake rows that record no base at all, so the pair arm sees the whole
corpus and needs no acid-only auxiliary head.

**Readout.** With a shared encoder run over both graphs:

    site state in the acid, site state in the base, their difference,
    pooled acid, pooled base, their difference

Six blocks of HIDDEN rather than two. The difference terms are the point -- they are the response to
deprotonation, which is what a pKa measures.

    python3 pka_gnn_pair.py <labels.json> <folds.json> <out-dir> --mode pair|acid-only

Writes `<out-dir>/<mode>-oof.json`, keyed so `pk-compare.py` can pair the two arms row by row.
"""
import collections
import json
import math
import sys
import time

import numpy as np
import torch
import torch.nn as nn
from rdkit import RDLogger

import aromaticity
import pka_gnn
from pka_gnn import (BATCH, EPOCHS, ELEMENTS, HIDDEN, LAYERS, LEARNING_RATE, featurise, one_hot)
from parity_features import deprotonated, kekulized

RDLogger.DisableLog("rdApp.*")

torch.manual_seed(0)
np.random.seed(0)

# --- reproducibility, measured rather than assumed -------------------------------------------------
#
# Repeat training on this project was irreproducible: four runs of one configuration returned 0.7107,
# 0.7095, 0.7060 and 0.7032, and a paired confidence interval across two of them "significantly" excluded
# zero against a true effect of zero. Two explanations were proposed and BOTH WERE WRONG.
#
#   "MPS index_add_ does not accumulate deterministically" -- true but not the whole story. CPU diverges
#   as well, so the effect is not device-specific and blaming MPS would have left it in place.
#
#   "numpy is never reseeded per training, so the batch order drifts" -- a real defect, fixed below, but
#   not the cause: `np.random.seed(0)` runs at import, so two separate invocations consume identical
#   draws. Tested directly, reseeding leaves 60-epoch runs at +2.44306993 against +2.43308496.
#
# The cause is FLOATING-POINT REDUCTION ORDER. Multi-threaded CPU reductions sum partial results in
# completion order, and MPS atomics do the same on the GPU. Each step differs by about 1e-8, and training
# amplifies that chaotically: identical at epoch 4, diverging in the third decimal by epoch 20.
#
#   device  threads  60 epochs  reproducible
#   mps        8      27.5 s     no
#   mps        1      24.1 s     no          <- atomics, so threads are not the only source
#   cpu        8       8.8 s     no
#   cpu        1       5.7 s     BIT-EXACT
#
# So one thread on the CPU is both the only reproducible configuration and 4.4x faster than the MPS
# default -- these molecules are 16 to 28 atoms, far too small to repay either GPU dispatch or thread
# setup. `determinism_probe.py` reproduces the whole table.
torch.set_num_threads(1)


def preferred_device():
    """CPU, deliberately, and not because MPS is unavailable. See the note above."""
    return torch.device("cpu")

# --- site-relative chemistry (Codex recommendation 2) ----------------------------------------------
#
# The encoder has three message-passing layers, so its learned receptive field is three bonds, and the
# readout sees one GLOBAL sum. That says which atoms exist and only weakly where they sit relative to
# the ionising atom -- yet pKaLearn reports chemically relevant effects reaching about seven bonds.
#
# Everything added here is computable identically in TypeScript from the graph `pkaGnn.ts` already
# builds, which is the constraint that decides what is in and what is out:
#   IN  -- BFS distance to the site (pure graph walk), Pauling electronegativity (static table),
#          smallest-ring size (the SHARED cycle walk `featurise` already uses for bond-in-ring).
#   OUT -- RDKit hybridisation and its generic conjugation flag. Neither has a TypeScript counterpart,
#          and `aromaticity.py` exists precisely because trusting RDKit perception across the two
#          runtimes has already shipped wrong answers.
DISTANCE_BUCKETS = 8          # 0..6 bonds, then 7-or-more; pKaLearn's ~7-bond horizon
RING_SIZE_BUCKETS = 6         # 3,4,5,6,7,8+
SHELLS = ((0, 1), (2, 3), (4, 5), (6, DISTANCE_BUCKETS - 1))

# Pauling electronegativity. A static table, so both runtimes read the same number.
ELECTRONEGATIVITY = {
    "H": 2.20, "C": 2.55, "N": 3.04, "O": 3.44, "F": 3.98,
    "P": 2.19, "S": 2.58, "Cl": 3.16, "Br": 2.96, "I": 2.66,
}


def distances_from(adjacency, site):
    """BFS hop count to `site`, clipped at DISTANCE_BUCKETS - 1. Unreachable atoms take the clip."""
    far = DISTANCE_BUCKETS - 1
    out = [far] * len(adjacency)
    if site >= len(adjacency):
        return out
    out[site] = 0
    frontier = [site]
    depth = 0
    while frontier and depth < far:
        depth += 1
        nxt = []
        for node in frontier:
            for neighbour in adjacency[node]:
                if out[neighbour] > depth:
                    out[neighbour] = depth
                    nxt.append(neighbour)
        frontier = nxt
    return out


def smallest_ring_sizes(adjacency):
    """Size of the smallest cycle through each atom, from the shared cycle walk. 0 when acyclic."""
    out = [0] * len(adjacency)
    for i in range(len(adjacency)):
        cycles = aromaticity.cycles_through(adjacency, i)
        if cycles:
            out[i] = min(len(cycle) for cycle in cycles)
    return out


def featurise_shells(mol, site):
    """`featurise`, plus site-relative distance, electronegativity and ring size.

    Bonds gain |electronegativity difference| -- directed bond polarisation reduced to the one quantity
    a static table can supply on both sides of the parity boundary.
    """
    atoms, bonds, edges = featurise(mol, site)
    n = mol.GetNumAtoms()
    adjacency = [[] for _ in range(n)]
    for bond in mol.GetBonds():
        adjacency[bond.GetBeginAtomIdx()].append(bond.GetEndAtomIdx())
        adjacency[bond.GetEndAtomIdx()].append(bond.GetBeginAtomIdx())

    distance = distances_from(adjacency, site)
    ring_size = smallest_ring_sizes(adjacency)
    extra = []
    for i, atom in enumerate(mol.GetAtoms()):
        chi = ELECTRONEGATIVITY.get(atom.GetSymbol(), 2.20)
        extra.append(
            one_hot(distance[i], DISTANCE_BUCKETS)
            + one_hot(max(0, min(ring_size[i] - 3, RING_SIZE_BUCKETS - 1)) if ring_size[i] else -1,
                      RING_SIZE_BUCKETS)
            + [chi / 4.0]
        )
    atoms = np.concatenate([atoms, np.array(extra, dtype=np.float32)], axis=1)

    # `edges` is already both directions with the feature duplicated, so walk it rather than the bonds.
    polar = []
    for u, v in edges:
        a = ELECTRONEGATIVITY.get(mol.GetAtomWithIdx(u).GetSymbol(), 2.20)
        b = ELECTRONEGATIVITY.get(mol.GetAtomWithIdx(v).GetSymbol(), 2.20)
        polar.append([abs(a - b) / 2.0])
    bonds = np.concatenate([bonds, np.array(polar, dtype=np.float32)], axis=1) if len(edges) else bonds
    return atoms, bonds, edges, distance


SHELL_ATOM_FEATURES = pka_gnn.ATOM_FEATURES + DISTANCE_BUCKETS + RING_SIZE_BUCKETS + 1
SHELL_BOND_FEATURES = pka_gnn.BOND_FEATURES + 1


# --- data ------------------------------------------------------------------------------------------

def load(labels_path, shells):
    """Featurise the acid and its constructed conjugate base, sharing one atom indexing."""
    rows, skipped, no_base = [], 0, 0
    describe = (lambda m, s: featurise_shells(m, s)) if shells \
        else (lambda m, s: featurise(m, s) + ([0] * m.GetNumAtoms(),))
    for row in json.load(open(labels_path)):
        acid = kekulized(row["acid"])
        if acid is None or row["acidAtomIdx"] >= acid.GetNumAtoms():
            skipped += 1
            continue
        site = row["acidAtomIdx"]
        atoms, bonds, edges, distance = describe(acid, site)

        # `deprotonated` edits an RWMol, so atom order -- and therefore `site` -- is preserved.
        base = deprotonated(acid, site)
        if base is None:
            # 18 of 12,096: the labelled atom carries no removable hydrogen, or the edit will not
            # sanitise. Pair the acid with ITSELF so the difference channels are exactly zero rather
            # than dropping a row the acid-only arm would keep -- the arms must see the same corpus.
            no_base += 1
            base_parts = (atoms, bonds, edges, distance)
        else:
            base_parts = describe(base, site)

        rows.append({
            "atoms": atoms, "bonds": bonds, "edges": edges, "distance": distance,
            "base_atoms": base_parts[0], "base_bonds": base_parts[1],
            "base_edges": base_parts[2], "base_distance": base_parts[3],
            "site": site, "y": float(row["pKa"]), "acid": row["acid"],
            "element": acid.GetAtomWithIdx(site).GetSymbol(),
        })
    print(f"   featurised {len(rows)} rows, skipped {skipped}, "
          f"{no_base} without a constructible base", flush=True)
    return rows


def collate_half(batch, device, prefix, bond_features):
    """One graph batch. `prefix` selects the acid ("") or the base ("base_")."""
    atoms, bonds, src, dst, graph_of_atom, sites, shell_of_atom = [], [], [], [], [], [], []
    offset = 0
    for index, row in enumerate(batch):
        a = row[f"{prefix}atoms"]
        atoms.append(a)
        graph_of_atom += [index] * len(a)
        # Which radial shell each atom pools into. One scatter target per (graph, shell), so the
        # readout receives position rather than one undifferentiated global sum.
        for d in row[f"{prefix}distance"]:
            shell = next((s for s, (lo, hi) in enumerate(SHELLS) if lo <= d <= hi), len(SHELLS) - 1)
            shell_of_atom.append(index * len(SHELLS) + shell)
        edges = row[f"{prefix}edges"]
        if len(edges) > 0:
            bonds.append(row[f"{prefix}bonds"])
            for u, v in edges:
                src.append(u + offset)
                dst.append(v + offset)
        sites.append(row["site"] + offset)
        offset += len(a)
    t = lambda x, dtype=torch.long: torch.tensor(x, dtype=dtype, device=device)
    return (
        torch.tensor(np.concatenate(atoms), device=device),
        torch.tensor(np.concatenate(bonds), device=device) if bonds
        else torch.zeros(0, bond_features, device=device),
        t(src), t(dst), t(graph_of_atom), t(sites), len(batch), t(shell_of_atom),
    )


def collate(batch, device, bond_features):
    ys = torch.tensor([row["y"] for row in batch], dtype=torch.float32, device=device)
    return (collate_half(batch, device, "", bond_features),
            collate_half(batch, device, "base_", bond_features), ys)


# --- model -----------------------------------------------------------------------------------------

class PairSitePkaNet(nn.Module):
    """The shipped encoder, optionally over both halves of the transition and with radial pooling.

    `pair` decides whether the conjugate base is read. `shells` decides whether the extra site-relative
    features are present AND whether the readout pools by radial shell instead of one global sum. Both
    default off, and with both off this is the shipped architecture exactly -- 106,561 parameters.
    """

    def __init__(self, pair, shells):
        super().__init__()
        self.pair, self.shells = pair, shells
        atom_features = SHELL_ATOM_FEATURES if shells else pka_gnn.ATOM_FEATURES
        bond_features = SHELL_BOND_FEATURES if shells else pka_gnn.BOND_FEATURES
        self.embed = nn.Linear(atom_features, HIDDEN)
        self.message = nn.ModuleList(
            [nn.Linear(HIDDEN + bond_features, HIDDEN) for _ in range(LAYERS)]
        )
        self.update = nn.ModuleList([nn.Linear(HIDDEN * 2, HIDDEN) for _ in range(LAYERS)])
        blocks = (1 + len(SHELLS)) if shells else 2      # site + shells, or site + one global sum
        width = HIDDEN * blocks * (3 if pair else 1)     # acid, base, difference
        self.readout = nn.Sequential(nn.Linear(width, HIDDEN), nn.ReLU(), nn.Linear(HIDDEN, 1))

    def encode(self, atoms, bonds, src, dst, graph_of_atom, graphs, sites, shell_of_atom):
        h = torch.relu(self.embed(atoms))
        for layer in range(LAYERS):
            carried = torch.cat([h[src], bonds], dim=1)
            messages = torch.relu(self.message[layer](carried))
            gathered = torch.zeros_like(h).index_add_(0, dst, messages)
            h = torch.relu(self.update[layer](torch.cat([h, gathered], dim=1)))
        if self.shells:
            pooled = torch.zeros(graphs * len(SHELLS), HIDDEN, device=h.device)
            pooled = pooled.index_add_(0, shell_of_atom, h).view(graphs, len(SHELLS) * HIDDEN)
        else:
            pooled = torch.zeros(graphs, HIDDEN, device=h.device).index_add_(0, graph_of_atom, h)
        return torch.cat([h[sites], pooled], dim=1)

    def forward(self, acid, base):
        a = self.encode(acid[0], acid[1], acid[2], acid[3], acid[4], acid[6], acid[5], acid[7])
        if not self.pair:
            return self.readout(a).squeeze(-1)
        b = self.encode(base[0], base[1], base[2], base[3], base[4], base[6], base[5], base[7])
        return self.readout(torch.cat([a, b, b - a], dim=1)).squeeze(-1)


# --- training --------------------------------------------------------------------------------------

def element_weights(rows, power):
    """Per-row loss weight from the ionizing element's frequency, normalised to mean 1."""
    counts = collections.Counter(row["element"] for row in rows)
    raw = {el: (len(rows) / n) ** power for el, n in counts.items()}
    scale = sum(raw[row["element"]] for row in rows) / len(rows)
    return {el: value / scale for el, value in raw.items()}


def train_once(train_rows, device, pair, shells, epochs=EPOCHS, seed=0,
               weight_decay=0.0, balance=0.0):
    torch.manual_seed(seed)
    # Seed numpy PER MEMBER too. It drives `np.random.shuffle(order)`, and seeding only torch left every
    # member continuing whatever draw the previous one stopped on -- so anything that changed how many
    # draws happened earlier (a screen with a different config list, a different fold count) silently
    # changed the batch order of every member after it, and two experiments stopped being comparable for
    # a reason nothing recorded. Seeding with `seed` rather than a constant keeps the members distinct,
    # which is the ensemble's whole purpose.
    np.random.seed(seed)
    model = PairSitePkaNet(pair, shells).to(device)
    optimiser = (torch.optim.AdamW(model.parameters(), lr=LEARNING_RATE, weight_decay=weight_decay)
                 if weight_decay else torch.optim.Adam(model.parameters(), lr=LEARNING_RATE))
    schedule = torch.optim.lr_scheduler.OneCycleLR(
        optimiser, max_lr=LEARNING_RATE * 3,
        total_steps=epochs * max(1, math.ceil(len(train_rows) / BATCH)),
    )
    weights = element_weights(train_rows, balance) if balance else None
    order = np.arange(len(train_rows))
    for _ in range(epochs):
        np.random.shuffle(order)
        model.train()
        for start in range(0, len(order), BATCH):
            batch = [train_rows[i] for i in order[start:start + BATCH]]
            acid, base, ys = collate(batch, device, model.message[0].in_features - HIDDEN)
            optimiser.zero_grad()
            out = model(acid, base)
            if weights is not None:
                w = torch.tensor([weights[r["element"]] for r in batch],
                                 dtype=torch.float32, device=device)
                loss = ((out - ys).abs() * w).mean()
            else:
                loss = nn.functional.l1_loss(out, ys)
            loss.backward()
            optimiser.step()
            schedule.step()
    return model


def predict(model, rows, device):
    model.eval()
    out = []
    bond_features = model.message[0].in_features - HIDDEN
    with torch.no_grad():
        for start in range(0, len(rows), 256):
            acid, base, _ = collate(rows[start:start + 256], device, bond_features)
            out.append(model(acid, base).cpu().numpy())
    return np.concatenate(out) if out else np.zeros(0)


def export_arm(members, path, mode, oof_paths):
    """Weights plus an architecture block that fully DESCRIBES the arm, so a reader needs no constants.

    `pka_gnn.export` hardcodes the shipped feature widths and pools globally, so it cannot describe this
    arm. Every number the runtime needs to rebuild the feature vector is written here instead --
    including the shell partition -- because `gnn_infer.py` used to build `SitePkaNet()` from whatever
    `pka_gnn.HIDDEN` happened to be and threw size mismatches the moment an artifact disagreed. An
    artifact that carries its own shape can be scored by a checkout that was never edited to match it.

    The training figures are DERIVED from the out-of-fold files rather than passed in, so the number in
    the artifact is the number that was measured.

    **Several out-of-fold files are accepted, and recording only one would now be dishonest.** Training on
    this hardware is not reproducible -- MPS `index_add_` does not accumulate deterministically, and four
    runs of one configuration returned 0.7107, 0.7095, 0.7060 and 0.7032. A lone `cvMae` therefore reports
    which run happened to be exported rather than what the configuration achieves, and a reader comparing
    two artifacts by that field would be comparing two draws from the same distribution. `cvMaeSd` and
    `cvReplicates` are what make the figure interpretable; with one replicate the sd is null and says so.
    """
    import os

    per_run, spreads = [], None
    for oof_path in oof_paths:
        rows = json.load(open(oof_path))
        per_run.append(np.array([abs(r["predicted"] - r["observed"]) for r in rows]))
        if spreads is None:
            spreads = np.array([r["spread"] for r in rows])
    errors = per_run[0]
    means = [float(e.mean()) for e in per_run]
    shells = "shells" in mode
    weights = [
        {name: pka_gnn.round6(tensor.detach().cpu().numpy().tolist())
         for name, tensor in model.state_dict().items()}
        for model in members
    ]
    json.dump({
        "architecture": {
            "elements": ELEMENTS,
            "atomFeatures": SHELL_ATOM_FEATURES if shells else pka_gnn.ATOM_FEATURES,
            "bondFeatures": SHELL_BOND_FEATURES if shells else pka_gnn.BOND_FEATURES,
            "hidden": HIDDEN, "layers": LAYERS, "ensemble": len(members),
            # The two flags the runtime branches on, and the partition it pools by. Absent means the
            # shipped acid-only architecture, so an older artifact still loads unchanged.
            "siteShells": shells,
            "readsConjugateBase": "pair" in mode,
            "distanceBuckets": DISTANCE_BUCKETS if shells else None,
            "ringSizeBuckets": RING_SIZE_BUCKETS if shells else None,
            "shellBounds": [list(s) for s in SHELLS] if shells else None,
            "electronegativity": ELECTRONEGATIVITY if shells else None,
        },
        "members": weights,
        "training": {
            "arm": mode,
            "samples": len(errors),
            "cvMae": round(float(np.mean(means)), 4),
            "cvMaeSd": round(float(np.std(means, ddof=1)), 4) if len(means) > 1 else None,
            "cvReplicates": len(means),
            "cvMaePerRun": [round(m, 4) for m in means],
            "cvRmse": round(float(np.sqrt((errors ** 2).mean())), 4),
            "spreadCorrelation": round(float(np.corrcoef(spreads, errors)[0, 1]), 4),
            "intervalQuartiles": [round(float(np.percentile(spreads, q)), 4) for q in (25, 50, 75)],
            "grouping": "frozen molecular-family-aware folds (pka_folds.py)",
            "hidden": HIDDEN, "layers": LAYERS, "epochs": EPOCHS, "ensemble": len(members),
        },
    }, open(path, "w"))
    count = sum(t.numel() for t in members[0].state_dict().values()) * len(members)
    print(f"   wrote {path}: {count:,} parameters, {os.path.getsize(path) / 1e6:.1f} MB", flush=True)


def export_main(labels_path, out_path, mode, oof_paths, weight_decay, balance, seed_offset=0):
    """Fit the whole corpus and write the runtime artifact. No cross-validation -- that already ran.

    `seed_offset` produces an independent REPLICATE of the same configuration. This matters because the
    external check is a single number per artifact, and training here is not reproducible: four runs of
    one configuration spanned 0.0075 in cross-validated MAE, so one artifact's external score is one draw.
    Comparing two configurations by one artifact each is the mistake that was already made once on the
    cross-validation side. Distinct seeds also sample initialisation, which is what an ensemble member
    varies anyway.
    """
    device = preferred_device()
    print(f"device {device}   mode {mode}   wd {weight_decay}   balance {balance}   "
          f"seeds {seed_offset}..{seed_offset + pka_gnn.ENSEMBLE - 1}   EXPORT", flush=True)
    rows = load(labels_path, "shells" in mode)
    started = time.time()
    members = [train_once(rows, device, "pair" in mode, "shells" in mode, seed=seed,
                          weight_decay=weight_decay, balance=balance)
               for seed in range(seed_offset, seed_offset + pka_gnn.ENSEMBLE)]
    print(f"   fitted {pka_gnn.ENSEMBLE} members on {len(rows)} rows "
          f"({time.time() - started:.0f}s)", flush=True)
    export_arm(members, out_path, mode, oof_paths)


def main(labels_path, folds_path, out_dir, mode, weight_decay=0.0, balance=0.0, tag=None):
    pair = "pair" in mode
    shells = "shells" in mode
    device = preferred_device()
    print(f"device {device}   mode {mode}   wd {weight_decay}   balance {balance}", flush=True)

    frozen = json.load(open(folds_path))
    assignment, n_folds = frozen["assignment"], frozen["folds"]
    rows = load(labels_path, shells)
    for row in rows:
        row["fold"] = assignment.get(f"{row['acid']}\t{row['site']}\t{row['y']}")
    missing = [r for r in rows if r["fold"] is None]
    if missing:
        raise SystemExit(f"{len(missing)} rows are not in the frozen split; regenerate pka_folds.py")

    oof = [None] * len(rows)
    errors = []
    for fold in range(n_folds):
        # Carry the row's position rather than looking it up later: `rows.index(row)` would compare
        # dicts and is quadratic besides.
        train = [r for r in rows if r["fold"] != fold]
        test_at = [i for i, r in enumerate(rows) if r["fold"] == fold]
        if not test_at:
            continue
        test = [rows[i] for i in test_at]
        started = time.time()
        members = [train_once(train, device, pair, shells, seed=seed,
                              weight_decay=weight_decay, balance=balance)
                   for seed in range(pka_gnn.ENSEMBLE)]
        stacked = np.stack([predict(m, test, device) for m in members])
        mean = stacked.mean(axis=0)
        spread = stacked.std(axis=0)
        for at, value, dev in zip(test_at, mean, spread):
            oof[at] = (float(value), float(dev))
        fold_errors = np.abs(mean - np.array([r["y"] for r in test]))
        errors.append(fold_errors)
        print(f"   fold {fold}: n={len(test)} MAE {fold_errors.mean():.4f} "
              f"({time.time() - started:.0f}s)", flush=True)

    every = np.concatenate(errors)
    print(f"   MAE {every.mean():.4f}   RMSE {float(np.sqrt((every ** 2).mean())):.4f}", flush=True)
    out = f"{out_dir}/{tag or mode}-oof.json"
    # Filter on the PAIRED entry, never by looking the row up again. `rows.index(row)` compares dicts
    # holding numpy arrays, which raises "truth value of an array is ambiguous" -- and it cost two
    # completed cross-validation runs their per-row output, because it sits after the training loop.
    json.dump(
        [{"acid": row["acid"], "acidAtomIdx": row["site"], "observed": row["y"],
          "predicted": round(value, 4), "spread": round(dev, 4), "element": row["element"]}
         for row, entry in zip(rows, oof) if entry is not None
         for value, dev in [entry]],
        open(out, "w"),
    )
    print(f"   wrote {out}", flush=True)


def check_argv(argv):
    """Refuse an option value that is really a run of options. THIS BUG COST FOUR RUNS THEIR MEANING.

    Three arms were launched as `--tag "shells-adamw-sqrtbal --wd 0.01 --balance 0.5"`, because zsh does
    not word-split an unquoted variable. `--wd` and `--balance` were never separate argv entries, so
    `"--wd" in argv` was false and both knobs silently stayed at zero. The runs printed `wd 0.0
    balance 0.0`, wrote files whose names contained the flags as literal text, and were reported as three
    distinct configurations. They were four replicates of one configuration, and the 0.0075 spread
    between them -- which was read as an effect -- is this hardware's training nondeterminism.

    Cheap to detect and worth detecting loudly: any value carrying whitespace, or beginning with a dash,
    is a mistake rather than a name.
    """
    for i, token in enumerate(argv[1:], start=1):
        if not token.startswith("--") or i + 1 >= len(argv):
            continue
        value = argv[i + 1]
        if value.startswith("--"):
            continue
        if any(c.isspace() for c in value):
            raise SystemExit(
                f"{token} was given {value!r}, which contains whitespace -- it has swallowed the "
                f"options that follow it. Pass each option as its own shell word."
            )


if __name__ == "__main__":
    check_argv(sys.argv)
    mode = sys.argv[sys.argv.index("--mode") + 1] if "--mode" in sys.argv else "pair"
    if mode not in ("acid-only", "pair", "shells", "pair+shells"):
        raise SystemExit("--mode must be acid-only, pair, shells or pair+shells")
    argv = sys.argv
    wd = float(argv[argv.index("--wd") + 1]) if "--wd" in argv else 0.0
    bal = float(argv[argv.index("--balance") + 1]) if "--balance" in argv else 0.0
    tag = argv[argv.index("--tag") + 1] if "--tag" in argv else None
    if "--export" in argv:
        # python3 pka_gnn_pair.py <labels> <artifact-out> --mode shells --export --oof a.json,b.json
        oofs = argv[argv.index("--oof") + 1].split(",")
        offset = int(argv[argv.index("--seed-offset") + 1]) if "--seed-offset" in argv else 0
        export_main(argv[1], argv[2], mode, oofs, wd, bal, offset)
    else:
        main(argv[1], argv[2], argv[3], mode, wd, bal, tag)
