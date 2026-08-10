"""Is 0.728 a data limit or a model limit?

One scaffold-grouped held-out fold per configuration, single member, so a five-way sweep costs about a
quarter of one full cross-validation. The ABSOLUTE numbers are not comparable to the published cvMAE
(one fold, one member, no ensemble averaging); the RANKING is what this is for.

Measured on the shipped 12,096-label corpus:

    configuration                  MAE    RMSE     params  minutes
    predict the mean            2.4262
    baseline  H96  L3  E60      0.8190  1.3476    106,561      3.0
    wider     H160 L3  E60      0.7650  1.2673    290,241      6.0
    deeper    H96  L5  E60      0.8099  1.3298    163,201      3.6
    longer    H96  L3  E150     0.7759  1.2852    106,561      6.2
    big       H160 L5  E150     0.7777  1.2922    446,081      9.1

Width is the axis that pays -- 6.6% for 2.7x the parameters. Depth buys almost nothing, a longer
schedule buys half of what width does, and combining all three is WORSE than width alone, so the big
configuration is overfitting rather than short of capacity. The answer to "is 0.73 a data limit or a
model limit" is: partly a model limit, and specifically a WIDTH one.

    python3 capacity_sweep.py <labels.json>
"""
import json
import math
import sys
import time

import numpy as np
import torch

import pka_gnn
from pka_gnn import load, train_once, predict

CONFIGS = [
    ("baseline  H96  L3  E60", 96, 3, 60),
    ("wider     H160 L3  E60", 160, 3, 60),
    ("deeper    H96  L5  E60", 96, 5, 60),
    ("longer    H96  L3  E150", 96, 3, 150),
    ("big       H160 L5  E150", 160, 5, 150),
]


def main(labels_path):
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    rows = load(labels_path)

    # One scaffold-grouped split, held fixed across configurations so they see identical data.
    scaffolds = sorted({r["scaffold"] for r in rows})
    rng = np.random.RandomState(0)
    rng.shuffle(scaffolds)
    held = set(scaffolds[: len(scaffolds) // 5])
    train = [r for r in rows if r["scaffold"] not in held]
    test = [r for r in rows if r["scaffold"] in held]
    print(f"device {device}   {len(train)} train / {len(test)} held out "
          f"({len(scaffolds)} scaffolds)\n")

    baseline = float(np.abs(np.array([r["y"] for r in test])
                            - np.mean([r["y"] for r in train])).mean())
    print(f"{'configuration':26s} {'MAE':>7s} {'RMSE':>7s} {'params':>10s} {'minutes':>8s}")
    print(f"{'predict the mean':26s} {baseline:7.4f}")

    for name, hidden, layers, epochs in CONFIGS:
        pka_gnn.HIDDEN, pka_gnn.LAYERS, pka_gnn.EPOCHS = hidden, layers, epochs
        started = time.monotonic()
        model = train_once(train, device, epochs=epochs, seed=0)
        got = np.array(predict(model, test, device))
        want = np.array([r["y"] for r in test])
        errors = np.abs(got - want)
        params = sum(p.numel() for p in model.parameters())
        print(f"{name:26s} {errors.mean():7.4f} {np.sqrt((errors ** 2).mean()):7.4f} "
              f"{params:10,d} {(time.monotonic() - started) / 60:8.1f}")


if __name__ == "__main__":
    main(sys.argv[1])
