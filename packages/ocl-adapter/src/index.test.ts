import { beforeAll, describe, expect, it } from "vitest";
import * as OCL from "openchemlib";

import { moleculeToMolfileV2000 } from "@chemdraft/chem-core";
import type { MoleculeObject } from "@chemdraft/chem-core";

import { depictSmiles2D, ensureOclResources, oclConformerGenerator } from "./index";

/** Minimal V2000 atom-block y-coordinate reader, to pin the depiction's y convention. */
function molfileAtomYs(molfile: string, count: number): number[] {
  const lines = molfile.split(/\r?\n/);
  const countsIdx = lines.findIndex((l) => /\bV2000\b/.test(l));
  const ys: number[] = [];
  for (let i = 0; i < count; i++) {
    const parts = lines[countsIdx + 1 + i].trim().split(/\s+/);
    ys.push(Number.parseFloat(parts[1]));
  }
  return ys;
}

/** Mint a molfile (the adapter's input) from SMILES. Does not need torsion resources. */
function molfileFromSmiles(smiles: string): string {
  return OCL.Molecule.fromSmiles(smiles).toMolfile();
}

beforeAll(async () => {
  await ensureOclResources();
});

describe("ocl-adapter — capability + contract shape", () => {
  it("declares the engine and capability", () => {
    expect(oclConformerGenerator.engineName).toBe("openchemlib");
    expect(oclConformerGenerator.canGenerate3DConformer).toBe(true);
  });
});

describe("ocl-adapter — 3D conformer of a chiral molecule", () => {
  it("embeds a real 3D conformer, MMFF94-converges, and maps every original atom", async () => {
    const molfile = molfileFromSmiles("C[C@H](F)Cl"); // 4 heavy atoms
    const result = await oclConformerGenerator.generate3DConformer(
      { molfile, originalAtomCount: 4 },
      { seed: 42, optimize: "auto" }
    );

    expect(result.embed.status).toBe("ok");
    expect(result.originalAtomCount).toBe(4);
    expect(result.engine.name).toBe("openchemlib");
    expect(result.forceField?.name).toBe("MMFF94");
    expect(result.forceField?.status).toBe("converged");
    expect(result.forceField?.returnCode).toBe(0);

    // Hydrogens were saturated (CH3 + the stereocenter H).
    expect(result.hydrogens.added).toBe(true);
    expect(result.generatedAtomCount).toBeGreaterThanOrEqual(4);

    // Every original atom located in the conformer by map number.
    expect(result.mapping.originalToEngineAtom).toHaveLength(4);
    expect(result.mapping.originalToEngineAtom.every((idx) => idx >= 0)).toBe(true);
    expect(result.mapping.coords3dByOriginalAtom).toHaveLength(12);

    // It is genuinely 3D (non-zero z-spread across original atoms).
    const zs = [0, 1, 2, 3].map((i) => result.mapping.coords3dByOriginalAtom[i * 3 + 2]);
    expect(Math.max(...zs) - Math.min(...zs)).toBeGreaterThan(0.1);

    // Every coordinate is finite.
    expect(Array.from(result.mapping.coords3dByOriginalAtom).every(Number.isFinite)).toBe(true);
  });

  it("produces a consistent inverse atom map (original<->engine round-trips)", async () => {
    const molfile = molfileFromSmiles("C[C@H](F)Cl");
    const { mapping } = await oclConformerGenerator.generate3DConformer({ molfile });
    for (let original = 0; original < mapping.originalToEngineAtom.length; original++) {
      const engine = mapping.originalToEngineAtom[original];
      expect(mapping.engineToOriginalAtom[engine]).toBe(original);
    }
    // Generated hydrogens map back to -1 (no original atom).
    for (const engineH of mapping.generatedHydrogenEngineAtoms) {
      expect(mapping.engineToOriginalAtom[engineH]).toBe(-1);
    }
  });
});

describe("ocl-adapter — depictSmiles2D", () => {
  it("lays out a chiral SMILES with a wedge bond and atom-aligned coordinates", () => {
    const dep = depictSmiles2D("C[C@H](F)Cl");
    expect(dep.atoms).toHaveLength(4);
    expect(dep.molfile).toContain("V2000");
    const wedge = dep.bonds.find((b) => b.wedge !== null);
    expect(wedge?.wedge).toBe("wedge");
  });

  it("emits y-up coordinates that match its own molfile (no mirror flip)", () => {
    // Regression guard for the OCL screen-down vs molfile y-up convention bug:
    // the depiction's y must equal the molfile's y, or the wedge reads as the
    // mirror enantiomer (caught originally only via the RDKit oracle).
    const dep = depictSmiles2D("C[C@H](F)Cl");
    const molfileYs = molfileAtomYs(dep.molfile, dep.atoms.length);
    dep.atoms.forEach((a, i) => expect(a.y).toBeCloseTo(molfileYs[i], 3));
  });
});

describe("moleculeToMolfileV2000 — round-trips through the OCL parser", () => {
  function sampleChiralMolecule(): MoleculeObject {
    return {
      id: "m",
      type: "molecule",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      rotation: 0,
      style: {},
      structureFormat: "molfile-v2000",
      structure: "",
      atoms: [
        { id: "a0", element: "C", x: 0, y: 0, formalCharge: 0 },
        { id: "a1", element: "F", x: 0.87, y: 0.5, formalCharge: 0 },
        { id: "a2", element: "Cl", x: -0.87, y: 0.5, formalCharge: 0 },
        { id: "a3", element: "Br", x: 0, y: -1, formalCharge: 0 }
      ],
      bonds: [
        { id: "b1", fromAtomId: "a0", toAtomId: "a1", order: "single", display: { bondStyle: "wedge" } },
        { id: "b2", fromAtomId: "a0", toAtomId: "a2", order: "single" },
        { id: "b3", fromAtomId: "a0", toAtomId: "a3", order: "single" }
      ],
      superatoms: [],
      rGroups: []
    };
  }

  it("OCL parses the molfile with atom count, element order, and wedge preserved", () => {
    const molfile = moleculeToMolfileV2000(sampleChiralMolecule());
    const parsed = OCL.Molecule.fromMolfile(molfile);
    expect(parsed.getAllAtoms()).toBe(4);
    expect(parsed.getAtomLabel(0)).toBe("C");
    expect(parsed.getAtomLabel(1)).toBe("F");
    // A wedge survived: the molecule carries a stereo (up/down) bond.
    const up = OCL.Molecule.cBondTypeUp;
    const down = OCL.Molecule.cBondTypeDown;
    let hasStereoBond = false;
    for (let b = 0; b < parsed.getAllBonds(); b++) {
      const t = parsed.getBondType(b);
      if (t === up || t === down) hasStereoBond = true;
    }
    expect(hasStereoBond).toBe(true);
  });

  it("the written molfile feeds straight back into generate3DConformer", async () => {
    const molfile = moleculeToMolfileV2000(sampleChiralMolecule());
    const result = await oclConformerGenerator.generate3DConformer({ molfile });
    expect(result.embed.status).toBe("ok");
    expect(result.originalAtomCount).toBe(4);
    expect(result.mapping.originalToEngineAtom.every((idx) => idx >= 0)).toBe(true);
  });
});

describe("ocl-adapter — adversarial mapping", () => {
  it("multi-fragment input maps every heavy atom of every fragment", async () => {
    const molfile = molfileFromSmiles("CC.O"); // ethane + water → 3 heavy atoms
    const result = await oclConformerGenerator.generate3DConformer({ molfile });
    expect(result.originalAtomCount).toBe(3);
    expect(result.mapping.originalToEngineAtom.every((idx) => idx >= 0)).toBe(true);
  });

  it("an isotope label at a stereocenter is preserved through mapping", async () => {
    // Deuterated chiral center: the [2H] is an original atom and must be mapped.
    const molfile = molfileFromSmiles("[2H][C@](F)(Cl)Br");
    const result = await oclConformerGenerator.generate3DConformer({ molfile });
    expect(result.mapping.originalToEngineAtom.every((idx) => idx >= 0)).toBe(true);
    expect(result.warnings.find((w) => w.code === "ocl.unmapped-original-atoms")).toBeUndefined();
  });

  it("flags a caller atom-count mismatch rather than silently proceeding", async () => {
    const molfile = molfileFromSmiles("C[C@H](F)Cl");
    const result = await oclConformerGenerator.generate3DConformer({ molfile, originalAtomCount: 99 });
    expect(result.warnings.some((w) => w.code === "ocl.atom-count-mismatch")).toBe(true);
  });

  it("honours optimize:'none' (no force field run)", async () => {
    const molfile = molfileFromSmiles("C[C@H](F)Cl");
    const result = await oclConformerGenerator.generate3DConformer({ molfile }, { optimize: "none" });
    expect(result.forceField).toEqual({ name: "none", status: "not-run" });
    expect(result.embed.status).toBe("ok");
  });
});
