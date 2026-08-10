"""Is repeat training reproducible, and if not, what actually breaks it?

`pka_gnn_pair.py` carries a note blaming this project's irreproducible training on MPS `index_add_`, which
does not accumulate deterministically. A second review disputes that and points at RNG bookkeeping instead:
`train_once` calls `torch.manual_seed(seed)` but never reseeds numpy, while `np.random.shuffle(order)` draws
the batch order from numpy's GLOBAL generator -- so member 2 continues the sequence member 1 left off.

That reading of the code is correct. Whether it explains the observed wobble is a different question, and
the two explanations make opposite predictions:

  RNG bookkeeping -- deterministic WITHIN a process run. `np.random.seed(0)` executes at import, so two
  separate invocations consume the same draws in the same order and must agree bit for bit, on any device.

  MPS atomics -- nondeterministic ACROSS runs regardless of seeding, and absent on CPU.

One experiment separates them: run the identical training twice in two separate processes, on each device.
Same result twice on CPU but not on MPS indicts the device. Differences on BOTH indicts something else
entirely. Identical on both means the wobble came from somewhere neither explanation names.

    python3 determinism_probe.py merged-labels.json <cpu|mps> [--reseed]

Prints a checksum of the trained model's predictions. Compare across invocations.
"""
import hashlib
import json
import sys
import time

import numpy as np
import torch

import pka_gnn
import pka_gnn_pair as pair_mod

ROWS = 800          # enough to exercise many batches, small enough to run in seconds
EPOCHS = 4          # overridable with --epochs


def main(labels_path, device_name, reseed):
    if "--threads" in sys.argv:
        # CPU reductions are split across threads and summed in completion order, so the thread count is
        # itself a source of reduction-order variance. One thread removes that particular one.
        torch.set_num_threads(int(sys.argv[sys.argv.index("--threads") + 1]))
    device = torch.device(device_name)
    rows = pair_mod.load(labels_path, shells=True)[:ROWS]

    if reseed:
        # The disputed one-line fix: restore numpy's generator before each training so a run does not
        # depend on how many draws happened earlier in the same process.
        np.random.seed(0)

    epochs = int(sys.argv[sys.argv.index("--epochs") + 1]) if "--epochs" in sys.argv else EPOCHS
    started = time.time()
    model = pair_mod.train_once(rows, device, pair=False, shells=True, epochs=epochs, seed=0)
    predicted = pair_mod.predict(model, rows, device)
    elapsed = time.time() - started

    digest = hashlib.sha1(np.round(predicted, 6).tobytes()).hexdigest()[:16]
    print(f"device {device_name:4s} thr {torch.get_num_threads():2d}  epochs {epochs:3d}  reseed {bool(reseed)!s:5s}  "
          f"{elapsed:6.1f}s  mean {predicted.mean():+.8f}  "
          f"sd {predicted.std():.8f}  sha {digest}", flush=True)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], "--reseed" in sys.argv)
