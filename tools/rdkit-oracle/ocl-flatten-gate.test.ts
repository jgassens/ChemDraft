/**
 * Phase 2 — the END-TO-END corpus gate: OpenChemLib conformer → flatten → RDKit.
 *
 * This chains the real v1 engine into the flatten and judges the whole pipeline
 * with the independent oracle. For a molecule of known chirality it asserts the CIP
 * descriptor is identical at THREE independent points, all read by RDKit:
 *   A. the OCL 2D depiction we start from (proves our depiction is faithful),
 *   B. the OCL-generated 3D conformer (proves OCL preserved the drawn stereo),
 *   C. the flatten's projected 2D wedge depiction (proves flatten preserved it).
 * If any link inverts or drops chirality, one of A/B/C diverges and the test fails.
 *
 * Skips when the RDKit venv is absent (CI without the oracle stays green).
 */

import { describe, expect, it } from "vitest";

import { flattenPerspectiveFrom3D, type MoleculeObject, type ViewMatrix } from "@chemdraft/chem-core";
import { depictSmiles2D, oclConformerGenerator, type Depiction2D } from "@chemdraft/ocl-adapter";

import { isOracleAvailable, runOracle, type OracleBond, type OracleResult } from "./client";

const IDENTITY: ViewMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const describeGate = isOracleAvailable() ? describe : describe.skip;

function depictionToMolecule(dep: Depiction2D, id: string): MoleculeObject {
  return {
    id,
    type: "molecule",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    style: {},
    structureFormat: "molfile-v2000",
    structure: dep.molfile,
    atoms: dep.atoms.map((a, i) => ({ id: `a${i}`, element: a.element, x: a.x, y: a.y, formalCharge: a.charge })),
    bonds: dep.bonds.map((b, i) => ({
      id: `b${i}`,
      fromAtomId: `a${b.from}`,
      toAtomId: `a${b.to}`,
      order: b.order === "aromatic" || b.order === "unknown" ? "single" : b.order,
      ...(b.wedge ? { display: { bondStyle: b.wedge } } : {})
    }))
  };
}

function oracleBondsFromMolecule(mol: MoleculeObject, withWedges: boolean): OracleBond[] {
  const index = new Map(mol.atoms.map((a, i) => [a.id, i]));
  return mol.bonds.map((b) => {
    const style = b.display?.bondStyle;
    const wedge: OracleBond["wedge"] =
      withWedges && style === "wedge" ? "up" : withWedges && style === "hashed" ? "down" : null;
    return {
      from: index.get(b.fromAtomId) as number,
      to: index.get(b.toAtomId) as number,
      order: b.order,
      wedge
    };
  });
}

interface GateCase {
  smiles: string;
  expectedCip: "R" | "S";
}

const CASES: GateCase[] = [
  { smiles: "C[C@H](F)Cl", expectedCip: "R" },
  { smiles: "C[C@@H](F)Cl", expectedCip: "S" }
];

describeGate("Phase 2 gate — OCL conformer → flatten → RDKit (3 independent CIP reads)", () => {
  for (const { smiles, expectedCip } of CASES) {
    it(`${smiles} stays ${expectedCip} through depiction, OCL 3D, and flatten`, async () => {
      const dep = depictSmiles2D(smiles);
      const mol2d = depictionToMolecule(dep, "gate");

      // The stereocenter is the narrow end of the wedge bond.
      const wedgeBond = dep.bonds.find((b) => b.wedge !== null);
      expect(wedgeBond, "OCL depiction should carry a wedge").toBeDefined();
      const centerIndex = (wedgeBond as Depiction2D["bonds"][number]).from;

      // OCL 3D conformer (coordinates aligned to the depiction's atom order).
      const conf = await oclConformerGenerator.generate3DConformer({ molfile: dep.molfile }, { optimize: "auto" });
      expect(conf.embed.status).toBe("ok");
      const coords3d = conf.mapping.coords3dByOriginalAtom;

      // Flatten the spun conformer (identity view → straight projection).
      const flat = flattenPerspectiveFrom3D(mol2d, coords3d, IDENTITY, { objectId: mol2d.id });
      expect(flat.status, flat.refusalReasons.join("; ")).toBe("committed");
      const projected = flat.mol2dProjected as MoleculeObject;

      // Three independent RDKit reads at the same atom index.
      const response = runOracle([
        {
          id: "A-depiction-2d",
          op: "perceiveFrom2D",
          atoms: dep.atoms.map((a) => ({ element: a.element, x: a.x, y: a.y, z: 0 })),
          bonds: oracleBondsFromMolecule(mol2d, true)
        },
        {
          id: "B-ocl-3d",
          op: "perceiveFrom3D",
          atoms: dep.atoms.map((a, i) => ({
            element: a.element,
            x: coords3d[i * 3],
            y: coords3d[i * 3 + 1],
            z: coords3d[i * 3 + 2]
          })),
          bonds: oracleBondsFromMolecule(mol2d, false)
        },
        {
          id: "C-flatten-2d",
          op: "perceiveFrom2D",
          atoms: projected.atoms.map((a) => ({ element: a.element, x: a.x, y: a.y, z: 0 })),
          bonds: oracleBondsFromMolecule(projected, true)
        }
      ]);

      const byId = new Map<string, OracleResult>(response.results.map((r) => [r.id, r]));
      const key = String(centerIndex);
      const cipA = byId.get("A-depiction-2d")?.centers[key];
      const cipB = byId.get("B-ocl-3d")?.centers[key];
      const cipC = byId.get("C-flatten-2d")?.centers[key];

      expect({ cipA, cipB, cipC }).toEqual({ cipA: expectedCip, cipB: expectedCip, cipC: expectedCip });
    });
  }
});
