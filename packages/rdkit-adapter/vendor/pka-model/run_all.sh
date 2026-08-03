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

LABELS="${1:?usage: ./run_all.sh <labels.json> <uni-pka-dataset-dir>}"
DATASET="${2:?usage: ./run_all.sh <labels.json> <uni-pka-dataset-dir>}"
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

echo "==> training (also emits the feature matrix and the parity fixture)"
"$PYTHON" pka_train.py ./merged-labels.json .

echo "==> interval calibration"
"$PYTHON" pka_calibrate.py ./pka .

echo "==> consensus with the Hammett relationship"
"$PYTHON" consensus_calibrate.py ./merged-labels.json . >/dev/null

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

echo
echo "done. Now: pnpm vitest run packages/rdkit-adapter/src"
