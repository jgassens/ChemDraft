"""Load the shipped ensemble and score sites with it, out of process from training.

`external_eval.py` and `consensus_calibrate.py` both judged the FOREST. They now judge what actually
ships. Keeping this in one place means the two cannot drift apart, and means neither has to know how
the network is built -- only how to ask it for a number.
"""
import json

import numpy as np
import torch

from pka_gnn import SitePkaNet, featurise, collate


def load_ensemble(path="site-pka-gnn.json"):
    """The ensemble, plus the multiplier that turns member disagreement into a reported interval."""
    artifact = json.load(open(path))
    members = []
    for weights in artifact["members"]:
        model = SitePkaNet()
        model.load_state_dict({k: torch.tensor(v) for k, v in weights.items()})
        model.eval()
        members.append(model)
    return members, artifact["training"]["spreadMultiplier"]


def predict_site(members, multiplier, mol, site):
    """(value, spread) for one site, exactly as `predictSitePka` returns in TypeScript."""
    atoms, bonds, edges = featurise(mol, site)
    rows = [{"atoms": atoms, "bonds": bonds, "edges": edges, "site": site, "y": 0.0}]
    a, b, s, d, g, si, n, _ = collate(rows, torch.device("cpu"))
    with torch.no_grad():
        votes = np.array([float(m(a, b, s, d, g, si, n)[0]) for m in members])
    return float(votes.mean()), float(votes.std() * multiplier)
