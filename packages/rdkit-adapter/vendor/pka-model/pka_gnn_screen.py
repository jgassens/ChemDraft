"""Stage 2: a cheap factorial screen of regularisation and training control, on the frozen split.

Codex's rule for this stage is what makes it affordable: "Stop any configuration that is at least 0.02 MAE
worse after two paired folds." So each candidate is scored on folds 0 and 1 with ONE member rather than the
full four -- the ranking is what matters here, not a publishable absolute -- and only survivors earn a full
run. The same shortcut is already precedent in this tree: `capacity_sweep.py` ranked five architectures on
one fold with one member.

The knobs are the ones Codex named, and the current training loop has NONE of them: plain Adam, no weight
decay, no dropout, no gradient clipping, no residual path, fixed 60 epochs with no early stopping, L1 loss.

    python3 pka_gnn_screen.py <labels.json> <folds.json> <out.json> [--folds 0,1] [--epochs 60]

Configurations are declared in CONFIGS below so a reader sees the whole screen at once.
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

import pka_gnn
import pka_gnn_pair as pair_mod
from pka_gnn import BATCH, HIDDEN, LAYERS, LEARNING_RATE

RDLogger.DisableLog("rdApp.*")

# name -> knobs. `{}` is the control: exactly today's training loop.
CONFIGS = {
    "baseline": {},
    "adamw-1e-4": {"weight_decay": 1e-4},
    "adamw-1e-2": {"weight_decay": 1e-2},
    "dropout-0.1": {"dropout": 0.1},
    "dropout-0.2": {"dropout": 0.2},
    "huber": {"huber": 1.0},
    "clip-1.0": {"clip": 1.0},
    "residual": {"residual": True},
    # Round two: weight decay won, so sweep it, and screen Codex's Stage 3 against the carbon
    # regression shells introduced (C 1.5032 -> 1.5963 while N, O and S all improved).
    "adamw-3e-2": {"weight_decay": 3e-2},
    "adamw-1e-1": {"weight_decay": 1e-1},
    "adamw+sqrtbal": {"weight_decay": 1e-2, "balance": 0.5},
    "adamw+fullbal": {"weight_decay": 1e-2, "balance": 1.0},
}


class ScreenNet(pair_mod.PairSitePkaNet):
    """The SHELLS architecture plus optional dropout and residual message updates.

    Screened on top of shells rather than the old acid-only baseline, because shells won Stage 1 by
    -0.0375 with a family-clustered CI of [-0.0466, -0.0279]. Regularising the arm that lost would
    answer a question nobody is asking.
    """

    def __init__(self, dropout=0.0, residual=False):
        super().__init__(pair=False, shells=True)
        self.drop = nn.Dropout(dropout) if dropout else None
        self.residual = residual

    def encode(self, atoms, bonds, src, dst, graph_of_atom, graphs, sites, shell_of_atom):
        h = torch.relu(self.embed(atoms))
        for layer in range(LAYERS):
            carried = torch.cat([h[src], bonds], dim=1)
            messages = torch.relu(self.message[layer](carried))
            gathered = torch.zeros_like(h).index_add_(0, dst, messages)
            updated = torch.relu(self.update[layer](torch.cat([h, gathered], dim=1)))
            # A residual path lets a deeper stack keep early-layer detail instead of oversmoothing it.
            h = h + updated if self.residual else updated
            if self.drop is not None:
                h = self.drop(h)
        shells = len(pair_mod.SHELLS)
        pooled = torch.zeros(graphs * shells, HIDDEN, device=h.device)
        pooled = pooled.index_add_(0, shell_of_atom, h).view(graphs, shells * HIDDEN)
        return torch.cat([h[sites], pooled], dim=1)


def element_weights(rows, power):
    """Per-row loss weight from the ionizing element's frequency, normalised to mean 1.

    Codex: "Test square-root inverse-frequency sampling ... Do not use full inverse-frequency weighting;
    tiny classes would dominate training." Both powers are screened so that claim is tested, not assumed.
    """
    counts = collections.Counter(row["element"] for row in rows)
    raw = {el: (len(rows) / n) ** power for el, n in counts.items()}
    scale = sum(raw[row["element"]] for row in rows) / len(rows)
    return {el: value / scale for el, value in raw.items()}


def train_screen(rows, device, knobs, epochs, seed=0):
    torch.manual_seed(seed)
    model = ScreenNet(knobs.get("dropout", 0.0), knobs.get("residual", False)).to(device)
    decay = knobs.get("weight_decay", 0.0)
    optimiser = (torch.optim.AdamW(model.parameters(), lr=LEARNING_RATE, weight_decay=decay)
                 if decay else torch.optim.Adam(model.parameters(), lr=LEARNING_RATE))
    schedule = torch.optim.lr_scheduler.OneCycleLR(
        optimiser, max_lr=LEARNING_RATE * 3,
        total_steps=epochs * max(1, math.ceil(len(rows) / BATCH)),
    )
    delta = knobs.get("huber")
    weights = element_weights(rows, knobs["balance"]) if knobs.get("balance") else None
    order = np.arange(len(rows))
    for _ in range(epochs):
        np.random.shuffle(order)
        model.train()
        for start in range(0, len(order), BATCH):
            batch = [rows[i] for i in order[start:start + BATCH]]
            acid, base, ys = pair_mod.collate(batch, device, pair_mod.SHELL_BOND_FEATURES)
            optimiser.zero_grad()
            out = model(acid, base)
            if weights is not None:
                w = torch.tensor([weights[r["element"]] for r in batch],
                                 dtype=torch.float32, device=device)
                loss = ((out - ys).abs() * w).mean()
            else:
                loss = (nn.functional.huber_loss(out, ys, delta=delta) if delta
                        else nn.functional.l1_loss(out, ys))
            loss.backward()
            if knobs.get("clip"):
                nn.utils.clip_grad_norm_(model.parameters(), knobs["clip"])
            optimiser.step()
            schedule.step()
    return model


def main(labels_path, folds_path, out_path, folds=(0, 1), epochs=60):
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    frozen = json.load(open(folds_path))
    assignment = frozen["assignment"]
    rows = pair_mod.load(labels_path, shells=True)
    for row in rows:
        row["fold"] = assignment.get(f"{row['acid']}\t{row['site']}\t{row['y']}")

    only = sys.argv[sys.argv.index("--only") + 1].split(",") if "--only" in sys.argv else None
    results = {}
    for name, knobs in CONFIGS.items():
        if only and name not in only:
            continue
        started = time.time()
        per_fold, by_element = [], collections.defaultdict(list)
        for fold in folds:
            train = [r for r in rows if r["fold"] != fold]
            test = [r for r in rows if r["fold"] == fold]
            model = train_screen(train, device, knobs, epochs)
            predicted = pair_mod.predict(model, test, device)
            errs = np.abs(predicted - np.array([r["y"] for r in test]))
            per_fold.append(float(errs.mean()))
            for row, e in zip(test, errs):
                by_element[row["element"]].append(float(e))
        mean = float(np.mean(per_fold))
        results[name] = {"perFold": [round(v, 4) for v in per_fold], "mean": round(mean, 4),
                         "byElement": {el: round(float(np.mean(v)), 4)
                                       for el, v in sorted(by_element.items())}}
        control = results.get("baseline", {}).get("mean")
        delta = f"{mean - control:+.4f}" if control is not None and name != "baseline" else "  control"
        verdict = ""
        if control is not None and name != "baseline" and mean - control >= 0.02:
            verdict = "  STOP (>= 0.02 worse)"
        print(f"  {name:14s} mean {mean:.4f} {delta}  "
              f"{results[name]['byElement']}{verdict}   ({time.time() - started:.0f}s)", flush=True)

    json.dump({
        "measurement": "one member, folds " + ",".join(str(f) for f in folds) +
                       " of the frozen family-aware split; ranking only, not publishable absolutes",
        "epochs": epochs,
        "configs": {k: CONFIGS[k] for k in results},
        "results": results,
    }, open(out_path, "w"), indent=1)
    print(f"wrote {out_path}")


if __name__ == "__main__":
    argv = sys.argv
    folds = tuple(int(x) for x in argv[argv.index("--folds") + 1].split(",")) \
        if "--folds" in argv else (0, 1)
    epochs = int(argv[argv.index("--epochs") + 1]) if "--epochs" in argv else 60
    main(argv[1], argv[2], argv[3], folds, epochs)
