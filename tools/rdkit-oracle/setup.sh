#!/usr/bin/env bash
# Create the isolated, dev-only native-RDKit oracle venv. NEVER shipped.
# Reversible: `rm -rf .venv-rdkit-oracle` removes it entirely.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
VENV="$ROOT/.venv-rdkit-oracle"

python3 -m venv "$VENV"
"$VENV/bin/python" -m pip install --upgrade pip
"$VENV/bin/python" -m pip install -r "$HERE/requirements-rdkit-oracle.txt"
"$VENV/bin/python" - <<'PY'
from rdkit import Chem
from rdkit.Chem import AllChem, rdDistGeom
m = Chem.AddHs(Chem.MolFromSmiles("C[C@H](F)Cl"))
p = rdDistGeom.ETKDGv3(); p.enforceChirality = True
assert AllChem.EmbedMolecule(m, p) == 0, "ETKDGv3 embed failed"
print("rdkit oracle ready:", Chem.rdBase.rdkitVersion)
PY
