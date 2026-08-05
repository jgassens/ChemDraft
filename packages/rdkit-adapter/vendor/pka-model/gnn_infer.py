"""Load the shipped ensemble and score sites with it, out of process from training.

`external_eval.py` and `consensus_calibrate.py` both judged the FOREST. They now judge what actually
ships. Keeping this in one place means the two cannot drift apart, and means neither has to know how
the network is built -- only how to ask it for a number.
"""
import json
import os

import numpy as np
import torch

import pka_gnn
from pka_gnn import SitePkaNet, featurise, collate

_HERE = os.path.dirname(os.path.abspath(__file__))


def load_interval_calibration(path=None):
    """The curve that turns an ensemble deviation into a reported interval.

    The same file `pkaGnn.ts` imports and the same interpolation `intervalFor` performs. It used to be
    one multiplier on both sides; the moment it stopped being that, the parity fixture failed, which is
    what it is for.
    """
    points = json.load(open(path or os.path.join(_HERE, "interval-calibration.json")))["points"]

    def at(deviation):
        if not np.isfinite(deviation) or deviation <= points[0]["spread"]:
            return points[0]["interval"]
        if deviation >= points[-1]["spread"]:
            return points[-1]["interval"]
        for below, above in zip(points, points[1:]):
            if deviation <= above["spread"]:
                span = above["spread"] - below["spread"]
                t = 0.0 if span == 0 else (deviation - below["spread"]) / span
                return below["interval"] + t * (above["interval"] - below["interval"])
        return points[-1]["interval"]

    return at


def load_ensemble(path="site-pka-gnn.json"):
    """The ensemble, plus the calibration that turns member disagreement into a reported interval.

    The artifact's OWN architecture decides the shape, not this module's constants. `pkaGnn.ts` has
    always read `architecture.hidden` off the file, so it loads any width; this side built
    `SitePkaNet()` from whatever `pka_gnn.HIDDEN` happened to be and threw a wall of size-mismatch
    errors the moment the two differed. That asymmetry meant a candidate model could only be scored by
    a checkout already edited to match it -- which is the one situation where a parity check is worth
    least.
    """
    artifact = json.load(open(path))
    architecture = artifact.get("architecture", {})
    pka_gnn.HIDDEN = architecture.get("hidden", pka_gnn.HIDDEN)
    pka_gnn.LAYERS = architecture.get("layers", pka_gnn.LAYERS)
    members = []
    for weights in artifact["members"]:
        model = SitePkaNet()
        model.load_state_dict({k: torch.tensor(v) for k, v in weights.items()})
        model.eval()
        members.append(model)
    return members, load_interval_calibration()


def predict_site(members, interval_at, mol, site):
    """(value, spread) for one site, exactly as `predictSitePka` returns in TypeScript."""
    atoms, bonds, edges = featurise(mol, site)
    rows = [{"atoms": atoms, "bonds": bonds, "edges": edges, "site": site, "y": 0.0}]
    a, b, s, d, g, si, n, _ = collate(rows, torch.device("cpu"))
    with torch.no_grad():
        votes = np.array([float(m(a, b, s, d, g, si, n)[0]) for m in members])
    return float(votes.mean()), float(interval_at(float(votes.std())))
