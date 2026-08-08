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

    STRATIFIED, matching `intervalFor(deviation, element)`. Carbon reads its own curve because pooling it
    with nitrogen and oxygen under-covered it by nine points; `interval_calibrate.py` records the table.
    `element=None` reads the pooled curve, exactly as omitting the argument does in TypeScript.
    """
    artifact = json.load(open(path or os.path.join(_HERE, "interval-calibration.json")))
    strata = artifact.get("strata")
    pooled = artifact["points"]

    def at(deviation, element=None):
        if not strata or element is None:
            points = pooled
        else:
            points = strata.get("carbon" if element == "C" else "other", pooled)
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

    # An artifact that declares site shells is a DIFFERENT network -- wider readout, wider atom and bond
    # features, radial pooling instead of a global sum -- so it needs the class that was trained, not the
    # one this module used to hardcode. Absent means the original acid-only architecture.
    shells = bool(architecture.get("siteShells"))
    pair = bool(architecture.get("readsConjugateBase"))
    if shells:
        import pka_gnn_pair
        # The artifact carries the shape it pooled by. If this checkout disagrees, the readout would be
        # fed columns that mean something else and still return a plausible number, so refuse instead.
        declared = (architecture.get("distanceBuckets"), architecture.get("ringSizeBuckets"),
                    [list(s) for s in architecture.get("shellBounds") or []])
        here = (pka_gnn_pair.DISTANCE_BUCKETS, pka_gnn_pair.RING_SIZE_BUCKETS,
                [list(s) for s in pka_gnn_pair.SHELLS])
        if declared != here:
            raise SystemExit(f"artifact shell shape {declared} != this checkout's {here}")

    members = []
    for weights in artifact["members"]:
        if shells:
            import pka_gnn_pair
            model = pka_gnn_pair.PairSitePkaNet(pair, True)
        else:
            model = SitePkaNet()
        model.load_state_dict({k: torch.tensor(v) for k, v in weights.items()})
        model.eval()
        model.site_shells = shells
        model.reads_base = pair
        members.append(model)
    return members, load_interval_calibration()


def predict_site(members, interval_at, mol, site):
    """(value, spread) for one site, exactly as `predictSitePka` returns in TypeScript."""
    element = mol.GetAtomWithIdx(site).GetSymbol()
    if getattr(members[0], "site_shells", False):
        import pka_gnn_pair
        from parity_features import deprotonated
        atoms, bonds, edges, distance = pka_gnn_pair.featurise_shells(mol, site)
        base = deprotonated(mol, site) if getattr(members[0], "reads_base", False) else None
        parts = pka_gnn_pair.featurise_shells(base, site) if base is not None \
            else (atoms, bonds, edges, distance)
        rows = [{
            "atoms": atoms, "bonds": bonds, "edges": edges, "distance": distance,
            "base_atoms": parts[0], "base_bonds": parts[1],
            "base_edges": parts[2], "base_distance": parts[3],
            "site": site, "y": 0.0,
        }]
        acid, base_batch, _ = pka_gnn_pair.collate(
            rows, torch.device("cpu"), pka_gnn_pair.SHELL_BOND_FEATURES)
        with torch.no_grad():
            votes = np.array([float(m(acid, base_batch)[0]) for m in members])
        return float(votes.mean()), float(interval_at(float(votes.std()), element))

    atoms, bonds, edges = featurise(mol, site)
    rows = [{"atoms": atoms, "bonds": bonds, "edges": edges, "site": site, "y": 0.0}]
    a, b, s, d, g, si, n, _ = collate(rows, torch.device("cpu"))
    with torch.no_grad():
        votes = np.array([float(m(a, b, s, d, g, si, n)[0]) for m in members])
    return float(votes.mean()), float(interval_at(float(votes.std()), element))
