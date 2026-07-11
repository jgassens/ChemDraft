import { beforeAll, describe, expect, it } from "vitest";
import * as OCL from "openchemlib";

import { moleculeToMolfileV2000 } from "@chemdraft/chem-core";
import type { MoleculeObject } from "@chemdraft/chem-core";

import {
  depictSmiles2D,
  ensureOclResources,
  generate3DConformerProgressive,
  oclConformerGenerator,
  perceiveStereoCentersFromMolfile,
  relayoutMolfile2D
} from "./index";

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

describe("ocl-adapter — relayoutMolfile2D (3D Cleanup engine)", () => {
  /** Decalin (two fused cyclohexanes) with deliberately mangled coordinates: every atom collapsed
   *  near the origin, the shape a distorted drawing session can produce. */
  function mangledDecalinMolfile(): string {
    const mol = OCL.Molecule.fromSmiles("C1CCC2CCCCC2C1");
    mol.inventCoordinates();
    for (let i = 0; i < mol.getAllAtoms(); i++) {
      mol.setAtomX(i, (i % 3) * 0.1);
      mol.setAtomY(i, (i % 2) * 0.1);
    }
    return mol.toMolfile();
  }

  it("untangles a mangled fused-ring system into a uniform, non-overlapping layout", () => {
    const dep = relayoutMolfile2D(mangledDecalinMolfile());
    expect(dep.atoms).toHaveLength(10);

    const lengths = dep.bonds.map((bond) => {
      const from = dep.atoms[bond.from];
      const to = dep.atoms[bond.to];
      return Math.hypot(to.x - from.x, to.y - from.y);
    });
    const mean = lengths.reduce((sum, value) => sum + value, 0) / lengths.length;
    lengths.forEach((length) => expect(Math.abs(length - mean) / mean).toBeLessThan(0.05));

    for (let a = 0; a < dep.atoms.length; a++) {
      for (let b = a + 1; b < dep.atoms.length; b++) {
        const distance = Math.hypot(dep.atoms[b].x - dep.atoms[a].x, dep.atoms[b].y - dep.atoms[a].y);
        expect(distance, `atoms ${a}/${b} overlap`).toBeGreaterThan(mean * 0.5);
      }
    }
  });

  it("preserves atom order, elements, and tetrahedral stereo through the re-layout", () => {
    // Start from a laid-out chiral depiction, whose molfile carries the wedge.
    const source = depictSmiles2D("C[C@H](N)C(=O)O");
    const before = perceiveStereoCentersFromMolfile(source.molfile);

    const relaid = relayoutMolfile2D(source.molfile);
    expect(relaid.atoms.map((atom) => atom.element)).toEqual(source.atoms.map((atom) => atom.element));
    expect(relaid.bonds.some((bond) => bond.wedge !== null)).toBe(true);

    const after = perceiveStereoCentersFromMolfile(relaid.molfile);
    expect(after.map((entry) => entry.descriptor)).toEqual(before.map((entry) => entry.descriptor));
    expect(after.map((entry) => entry.isStereoCenter)).toEqual(before.map((entry) => entry.isStereoCenter));
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

describe("ocl-adapter — progressive (embed-first) generation", () => {
  it("embedded stage is immediately usable and refineFromEmbedded() matches the one-shot API", async () => {
    const molfile = molfileFromSmiles("C[C@H](F)CC(=O)O");
    const { embedded, refineFromEmbedded } = await generate3DConformerProgressive(
      { molfile },
      { seed: 7, optimize: "auto" }
    );

    // Stage 1: a real, fully-mapped conformer before any force field ran.
    expect(embedded.embed.status).toBe("ok");
    expect(embedded.forceField).toEqual({ name: "MMFF94", status: "not-run" });
    expect(embedded.mapping.originalToEngineAtom.every((idx) => idx >= 0)).toBe(true);
    expect([...embedded.mapping.coords3dByOriginalAtom].every(Number.isFinite)).toBe(true);
    const flat3d = new Set([...embedded.mapping.coords3dByOriginalAtom].filter((_, i) => i % 3 === 2));
    expect(flat3d.size).toBeGreaterThan(1); // genuinely 3D, not a flat layout

    // Stage 2: refinement on the same conformer reports MMFF94 and keeps the mapping.
    expect(refineFromEmbedded).toBeDefined();
    const refined = refineFromEmbedded!();
    expect(refined.forceField?.name).toBe("MMFF94");
    expect(["converged", "not-converged"]).toContain(refined.forceField?.status);
    expect(refined.mapping.originalToEngineAtom).toEqual(embedded.mapping.originalToEngineAtom);

    // Parity with the one-shot API under the same seed: identical refined coordinates.
    const oneShot = await oclConformerGenerator.generate3DConformer({ molfile }, { seed: 7, optimize: "auto" });
    expect([...oneShot.mapping.coords3dByOriginalAtom]).toEqual([...refined.mapping.coords3dByOriginalAtom]);
  });

  it("optimize:'none' yields no refine stage; a capped refine still reports a force field run", async () => {
    const molfile = molfileFromSmiles("CCCCCCCC");
    const none = await generate3DConformerProgressive({ molfile }, { optimize: "none" });
    expect(none.refineFromEmbedded).toBeUndefined();
    expect(none.embedded.forceField).toEqual({ name: "none", status: "not-run" });

    const capped = await generate3DConformerProgressive({ molfile }, { optimize: "auto", maxMinimiseIterations: 50 });
    const refined = capped.refineFromEmbedded!();
    expect(refined.forceField?.name).toBe("MMFF94");
    expect(refined.forceField?.returnCode).toBeDefined();
  });

  it("refineFromEmbedded is re-runnable from the pristine embed (different caps from one embed)", async () => {
    // The worker derives Fast/Balanced/Quality from a SINGLE embed; refining again at a
    // different cap must restart from the embedded coordinates, not the relaxed ones.
    const molfile = molfileFromSmiles("c1ccc2ccccc2c1"); // naphthalene — strained raw embed
    const { refineFromEmbedded } = await generate3DConformerProgressive(
      { molfile },
      { seed: 7, optimize: "auto" }
    );
    expect(refineFromEmbedded).toBeDefined();

    const low = refineFromEmbedded!(20);
    const high = refineFromEmbedded!(800);
    // A second pass at the SAME cap reproduces the SAME geometry (proves it restarts
    // from the embed each time rather than continuing from the previous minimisation).
    const lowAgain = refineFromEmbedded!(20);
    expect([...lowAgain.mapping.coords3dByOriginalAtom]).toEqual([...low.mapping.coords3dByOriginalAtom]);
    // More iterations changes the geometry (otherwise the cap is doing nothing).
    expect([...high.mapping.coords3dByOriginalAtom]).not.toEqual([...low.mapping.coords3dByOriginalAtom]);
    expect(high.mapping.originalToEngineAtom).toEqual(low.mapping.originalToEngineAtom);
  });
});

describe("ocl-adapter — perceiveStereoCentersFromMolfile", () => {
  it("flags the true tetrahedral stereocenter (and only it) with a CIP descriptor", () => {
    // C[C@H](F)Cl — the second carbon is the lone stereocenter; CH3/F/Cl are not.
    const { molfile } = depictSmiles2D("C[C@H](F)Cl");
    const perceived = perceiveStereoCentersFromMolfile(molfile);
    const centers = perceived.filter((atom) => atom.isStereoCenter);
    expect(centers).toHaveLength(1);
    expect(["R", "S"]).toContain(centers[0]?.descriptor);
  });

  it("reports no stereocenters for an achiral molecule", () => {
    const { molfile } = depictSmiles2D("OCCO"); // ethylene glycol — no chiral atom
    const perceived = perceiveStereoCentersFromMolfile(molfile);
    expect(perceived.some((atom) => atom.isStereoCenter)).toBe(false);
  });

  it("does NOT treat a wedge on a non-chiral atom as a stereocenter (graphic projection bond)", () => {
    // FC(F)CO: the wedged carbon carries two identical F substituents, so it is not chiral even
    // with an explicit wedge bond drawn on it — exactly the graphic-wedge case to ignore.
    const mol = OCL.Molecule.fromSmiles("FC(F)CO");
    mol.setBondType(0, OCL.Molecule.cBondTypeUp); // draw a wedge on a non-stereocenter bond
    const perceived = perceiveStereoCentersFromMolfile(mol.toMolfile());
    expect(perceived.some((atom) => atom.isStereoCenter)).toBe(false);
  });
});
