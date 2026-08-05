#!/usr/bin/env bash
#
# Regenerate every shipped pKa artifact, in order, from one feature-code version.
#
# The scripts below were run by hand until now, and nothing proved the forest, the calibration, the
# consensus figures and the parity fixture all came from the same `parity_features.py`. That is the
# same train/serve skew the parity fixture guards against, one level up: the fixture can only pin the
# TypeScript against whatever Python last wrote it. Running them separately is how the forest and the
# fixture end up minutes and one edit apart.
#
#   ./run_all.sh <dwar-ibond-labels.json> <qupkake-data-dir>
#
# Labels come from two sources and are merged here. `pka_labels.py` extracts the Dwar-iBond set, where
# the site is derived from the DATA by diffing an acid/base microstate pair. `qupkake_labels.py` adds
# the QupKake experimental set, whose values are measurements but whose SITE INDEX is ChemAxon's Marvin
# — that file explains what is checked before a row is accepted. Neither dataset is vendored.
#
# Regenerates, and all of these are committed:
#   site-pka-forest.json        the model
#   parity-fixture.json         Python/TypeScript parity, emitted from the packed trees
#   calibration.json            interval calibration + per-class breakdown
#   calibration-pairs.json      the evidence a test recomputes the summary from
#   consensus-calibration.json  what pairing with the Hammett relationship is worth
#   external-validation.json    the only figure not measured on the training set
#
# Afterwards run `pnpm vitest run packages/rdkit-adapter/src` — the parity fixture is what proves the
# TypeScript still computes what was just trained. A green suite here is the actual acceptance gate.
set -euo pipefail

LABELS="${1:?usage: ./run_all.sh <dwar-labels.json> <qupkake-data-dir> [pkachu.csv] [D2A-pKa.csv] [iupac.csv]}"
DATASET="${2:?usage: ./run_all.sh <dwar-labels.json> <qupkake-data-dir> [pkachu.csv] [D2A-pKa.csv] [iupac.csv]}"
# Optional third source. Omitted, the corpus is just the first two and everything below still runs.
PKACHU="${3:-}"
# Optional fourth source. AQUEOUS ROWS ONLY -- see d2a_labels.py; the file is eight solvents deep.
D2A="${4:-}"
# Optional fifth source. CC BY-NC 4.0 -- see iupac_labels.py; neat water and 20-30 C only.
IUPAC="${5:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${PYTHON:-python3}"
cd "$HERE"

echo "==> merging label sources"
"$PYTHON" qupkake_labels.py "$DATASET/exp_training_data.sdf" "$LABELS" ./qupkake-labels.json
"$PYTHON" - "$LABELS" ./qupkake-labels.json ./merged-labels.json <<'MERGE'
import json, sys
base = json.load(open(sys.argv[1]))
extra = json.load(open(sys.argv[2]))
json.dump(base + extra, open(sys.argv[3], "w"))
print(f"   {len(base)} + {len(extra)} = {len(base) + len(extra)} labels")
MERGE

# pKaCHU last, so it deduplicates against BOTH earlier sources rather than only the first. Nearly half
# of it is already covered by them -- 94% of the overlapping values are identical to the stored
# precision, so those are one measurement arriving twice rather than two measurements.
if [ -n "$PKACHU" ]; then
  "$PYTHON" pkachu_labels.py "$PKACHU" ./merged-labels.json ./pkachu-labels.json
  "$PYTHON" - ./merged-labels.json ./pkachu-labels.json <<'MERGE'
import json, sys
base = json.load(open(sys.argv[1]))
extra = json.load(open(sys.argv[2]))
json.dump(base + extra, open(sys.argv[1], "w"))
print(f"   {len(base)} + {len(extra)} = {len(base) + len(extra)} labels")
MERGE
fi

if [ -n "$D2A" ]; then
  "$PYTHON" d2a_labels.py "$D2A" ./merged-labels.json ./d2a-labels.json
  "$PYTHON" - ./merged-labels.json ./d2a-labels.json <<'MERGE'
import json, sys
base = json.load(open(sys.argv[1]))
extra = json.load(open(sys.argv[2]))
json.dump(base + extra, open(sys.argv[1], "w"))
print(f"   {len(base)} + {len(extra)} = {len(base) + len(extra)} labels")
MERGE
fi

# IUPAC last: it is the only source whose site has to be INFERRED rather than read, so it should see
# every other source's labels first and defer to them wherever they already cover a site.
#
# ON when the CSV is passed. It was off for the whole forest era -- the labels are clean and they fix
# the weak-base gap, but a 60-tree forest could not absorb them without giving up common-case accuracy.
# The network can: cross-validated MAE moves 0.7264 -> 0.7291 against a harder baseline, external
# 1.1308 -> 1.0797, and SAMPL6's right-step-count 9 -> 12 of 24.
if [ -n "$IUPAC" ]; then
  "$PYTHON" iupac_labels.py "$IUPAC" ./merged-labels.json ./iupac-labels.json
  "$PYTHON" - ./merged-labels.json ./iupac-labels.json <<'MERGE'
import json, sys
base = json.load(open(sys.argv[1]))
extra = json.load(open(sys.argv[2]))
json.dump(base + extra, open(sys.argv[1], "w"))
print(f"   {len(base)} + {len(extra)} = {len(base) + len(extra)} labels")
MERGE
fi

echo "==> training the network (also writes out-of-fold predictions for the consensus)"
"$PYTHON" pka_gnn.py ./merged-labels.json .

# The forest is still trained, and is no longer what ships. It stays as the transparent baseline the
# network is judged against -- a 29% improvement is a claim about two numbers, and both have to be
# regenerable from this script or the comparison rots.
echo "==> training the forest baseline (also emits the feature matrix and its parity fixture)"
"$PYTHON" pka_train.py ./merged-labels.json .

echo "==> interval calibration"
"$PYTHON" pka_calibrate.py ./pka .

# Must come after the network and before the coupling refit: the refit folds ladders, and the fold
# weights every rung by this. Fitted on the out-of-fold predictions the training step just wrote, so
# it re-derives itself whenever the model changes rather than staying pinned to a retired one.
echo "==> per-rung weighting for the macroscopic fold"
"$PYTHON" edge_variance_fit.py ./gnn-oof.json ./edge-variance.json

echo "==> consensus with the Hammett relationship"
"$PYTHON" consensus_calibrate.py ./merged-labels.json . >/dev/null

# The coupling refit. Left out of this script originally, so the shipped W stayed fitted to a corpus
# that had since been corrected and retrained under it -- and turned out to be actively harmful.
echo "==> electrostatic coupling refit"
"$PYTHON" coupling_fit.py "$LABELS" ./macro-reference.json 400

echo "==> external validation"
"$PYTHON" external_eval.py "$DATASET" . >/dev/null

# The check this script exists for: every artifact must name the same fold grouping. A mismatch means
# one of them was regenerated against different feature code, which is exactly the drift being closed.
"$PYTHON" - <<'CHECK'
import json, sys
forest = json.load(open("site-pka-forest.json"))
calib = json.load(open("calibration.json"))
consensus = json.load(open("consensus-calibration.json"))
groupings = {forest["training"]["grouping"], calib["grouping"], consensus["grouping"]}
if len(groupings) != 1:
    sys.exit(f"artifacts disagree on fold grouping: {groupings}")
if len(json.load(open("calibration-pairs.json"))["pairs"]) != calib["samples"]:
    sys.exit("calibration-pairs.json does not match calibration.json's sample count")
if len(json.load(open("parity-fixture.json"))[0]["features"]) != len(forest["featureNames"]):
    sys.exit("parity-fixture.json was written against a different feature set than the forest")
print(f"   consistent: {forest['training']['grouping']}, "
      f"{len(forest['featureNames'])} features, MAE {forest['training']['cvMae']}")
CHECK

# The macroscopic yardstick. Not a training step -- it consumes the forest and reports the fold's
# accuracy against tabulated titration constants, which is the figure PLANS.md publishes.
echo
echo "== macroscopic validation =="
"$PYTHON" macro_validate.py

echo
echo "done. Now: pnpm vitest run packages/rdkit-adapter/src"
