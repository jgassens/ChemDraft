#!/usr/bin/env python3
"""
Dev-only native-RDKit stereo oracle for the 3D spin -> flatten corpus.

THIS IS NOT APP RUNTIME. It is the independent external judge for the Phase 1C
corpus (docs/architecture/3d-spin-flatten.md): RDKit, a different engine and a
different code path from our flatten/wedge math, confirms that a flattened 2D
depiction encodes the same chirality the 3D conformer actually has. It never
ships and is never the product engine.

Contract (guardrails, by design):
  * Reads ONE JSON request object from stdin, writes ONE JSON object to stdout.
  * No file-system access, no shell, no network. Pure stdin -> stdout.
  * Operates only on molecules it builds itself from the request (throwaway
    copies). It can never mutate a caller's molecule. `AssignStereochemistryFrom3D`
    is called only on a fresh, locally-built RWMol -> the "never overwrite the
    product molecule's stereo" guarantee holds structurally.

Request JSON:
  {
    "engineInfo": false,                      # optional; if true, just report version
    "requests": [
      {
        "id": "single-center-pos",
        "op": "perceiveFrom3D" | "perceiveFrom2D",
        "atoms": [ { "element": "C", "x": 0.0, "y": 0.0, "z": 0.0 }, ... ],
        "bonds": [ { "from": 0, "to": 1, "order": "single",
                     "wedge": "up" | "down" | null } ]   # wedge only used by 2D
      }
    ]
  }

Response JSON:
  {
    "engine": { "name": "rdkit", "version": "2026.03.3" },
    "results": [
      { "id": "...", "op": "...", "centers": { "1": "R", ... }, "error": null }
    ]
  }
`centers` maps ATOM INDEX (0-based, matching the request's atom order) -> CIP code.
"""

import sys
import json

from rdkit import Chem
from rdkit.Chem import AllChem  # noqa: F401  (ensures full toolkit is importable)
from rdkit.Chem import rdCIPLabeler
from rdkit import rdBase
from rdkit import RDLogger

# Keep the stdio channel clean: RDKit logs to stderr by default; a stdin->stdout
# JSON bridge must stay silent so callers never see interleaved diagnostics.
RDLogger.DisableLog("rdApp.*")

_ORDER = {"single": 1, "double": 2, "triple": 3, "aromatic": 4, "unknown": 1}
_WEDGE = {"up": 1, "down": 6, None: 0}


def _atom_line(element: str, x: float, y: float, z: float) -> str:
    # V2000 atom line: three F10.4 coordinates, a space, then the left-justified symbol.
    return f"{x:>10.4f}{y:>10.4f}{z:>10.4f} {element:<3} 0  0  0  0  0  0  0  0  0  0  0  0"


def _bond_line(a1: int, a2: int, order: int, stereo: int) -> str:
    # 1-indexed atoms; stereo 1 = wedge up, 6 = hash down, 0 = none.
    return f"{a1:>3}{a2:>3}{order:>3}{stereo:>3}  0  0  0"


def _build_molblock(atoms, bonds, use_wedges: bool) -> str:
    n_atoms = len(atoms)
    n_bonds = len(bonds)
    chiral_flag = 1 if use_wedges else 0
    lines = ["oracle", "  rdkit-oracle", ""]
    lines.append(
        f"{n_atoms:>3}{n_bonds:>3}  0  0  {chiral_flag:>1}  0  0  0  0  0999 V2000"
    )
    for a in atoms:
        lines.append(
            _atom_line(
                str(a["element"]),
                float(a.get("x", 0.0)),
                float(a.get("y", 0.0)),
                float(a.get("z", 0.0)),
            )
        )
    for b in bonds:
        order = _ORDER.get(str(b.get("order", "single")), 1)
        stereo = _WEDGE.get(b.get("wedge")) if use_wedges else 0
        if stereo is None:
            stereo = 0
        # V2000 atoms are 1-indexed; wedge begins at the first atom (our narrow end).
        lines.append(_bond_line(int(b["from"]) + 1, int(b["to"]) + 1, order, stereo))
    lines.append("M  END")
    return "\n".join(lines) + "\n"


def _cip_codes(mol) -> dict:
    rdCIPLabeler.AssignCIPLabels(mol)
    out = {}
    for atom in mol.GetAtoms():
        if atom.HasProp("_CIPCode"):
            out[str(atom.GetIdx())] = atom.GetProp("_CIPCode")
    return out


def _perceive_from_3d(atoms, bonds) -> dict:
    molblock = _build_molblock(atoms, bonds, use_wedges=False)
    mol = Chem.MolFromMolBlock(molblock, removeHs=False, sanitize=True)
    if mol is None:
        raise ValueError("RDKit could not parse the 3D molblock")
    work = Chem.Mol(mol)  # explicit throwaway copy
    Chem.AssignStereochemistryFrom3D(work)  # derive chirality from geometry on the copy
    return _cip_codes(work)


def _perceive_from_2d(atoms, bonds) -> dict:
    molblock = _build_molblock(atoms, bonds, use_wedges=True)
    # MolFromMolBlock perceives chirality from 2D coordinates + wedge stereo flags.
    mol = Chem.MolFromMolBlock(molblock, removeHs=False, sanitize=True)
    if mol is None:
        raise ValueError("RDKit could not parse the 2D+wedge molblock")
    work = Chem.Mol(mol)
    Chem.AssignStereochemistry(work, cleanIt=True, force=True)
    return _cip_codes(work)


def _handle(request: dict) -> dict:
    rid = request.get("id")
    op = request.get("op")
    try:
        atoms = request["atoms"]
        bonds = request.get("bonds", [])
        if op == "perceiveFrom3D":
            centers = _perceive_from_3d(atoms, bonds)
        elif op == "perceiveFrom2D":
            centers = _perceive_from_2d(atoms, bonds)
        else:
            raise ValueError(f"unknown op: {op!r}")
        return {"id": rid, "op": op, "centers": centers, "error": None}
    except Exception as exc:  # never crash the batch; report per-request
        return {"id": rid, "op": op, "centers": {}, "error": f"{type(exc).__name__}: {exc}"}


def main() -> None:
    raw = sys.stdin.read()
    payload = json.loads(raw) if raw.strip() else {}
    engine = {"name": "rdkit", "version": rdBase.rdkitVersion}
    if payload.get("engineInfo"):
        json.dump({"engine": engine, "results": []}, sys.stdout)
        return
    requests = payload.get("requests", [])
    results = [_handle(req) for req in requests]
    json.dump({"engine": engine, "results": results}, sys.stdout)


if __name__ == "__main__":
    main()
