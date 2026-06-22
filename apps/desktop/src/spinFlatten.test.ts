import { beforeAll, describe, expect, it } from "vitest";

import { applyPatches, type ChemDraftDocument, type MoleculeObject, type ViewMatrix } from "@chemdraft/chem-core";
import { depictSmiles2D, ensureOclResources, oclConformerGenerator, type Depiction2D } from "@chemdraft/ocl-adapter";

import { createPhase4Document, flattenSpunMolecule } from "./documentWorkflow";
import { quatFromAxisAngle, quatToViewMatrix } from "./interaction/rotation3d";
import { bondDepthWeights, projectSpin, type ScreenPlacement } from "./interaction/spinOverlay";

const IDENTITY: ViewMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function molecule(id: string, atoms: MoleculeObject["atoms"], bonds: MoleculeObject["bonds"]): MoleculeObject {
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
    structure: "",
    atoms,
    bonds,
    superatoms: [],
    rGroups: []
  };
}

function documentWith(mol: MoleculeObject): ChemDraftDocument {
  const base = createPhase4Document("Spin Flatten Fixture");
  return applyPatches(base, [
    { op: "addObject", pageId: base.pages[0].id, object: mol },
    { op: "setSelection", pageId: base.pages[0].id, objectIds: [mol.id] }
  ]);
}

function moleculeOf(document: ChemDraftDocument, id: string): MoleculeObject {
  const found = document.pages[0].objects.find((object) => object.id === id);
  if (!found || found.type !== "molecule") throw new Error("molecule missing");
  return found;
}

/** Build a document-frame molecule + its OCL 3D conformer coords from a SMILES. */
async function conformerFromSmiles(smiles: string, id: string) {
  const dep: Depiction2D = depictSmiles2D(smiles);
  const mol = molecule(
    id,
    dep.atoms.map((atom, index) => ({ id: `a${index}`, element: atom.element, x: 50 + atom.x * 20, y: 50 + atom.y * 20, formalCharge: atom.charge })),
    dep.bonds.map((bond, index) => ({
      id: `b${index}`,
      fromAtomId: `a${bond.from}`,
      toAtomId: `a${bond.to}`,
      order: bond.order === "aromatic" || bond.order === "unknown" ? "single" : bond.order,
      ...(bond.wedge ? { display: { bondStyle: bond.wedge } } : {})
    }))
  );
  const conformer = await oclConformerGenerator.generate3DConformer({ molfile: dep.molfile }, { optimize: "auto" });
  return { mol, coords3d: conformer.mapping.coords3dByOriginalAtom, embedStatus: conformer.embed.status };
}

beforeAll(async () => {
  await ensureOclResources();
});

describe("flattenSpunMolecule — commit mechanics", () => {
  it("commits an achiral flatten: geometry + molfile rewritten, graph preserved", () => {
    // Butane-ish chain with hand-authored 3D coords (no stereo → no wedges).
    const mol = molecule(
      "mol_chain",
      [
        { id: "a0", element: "C", x: 100, y: 100, formalCharge: 0 },
        { id: "a1", element: "C", x: 130, y: 100, formalCharge: 0 },
        { id: "a2", element: "C", x: 160, y: 100, formalCharge: 0 },
        { id: "a3", element: "C", x: 190, y: 100, formalCharge: 0 }
      ],
      [
        { id: "b0", fromAtomId: "a0", toAtomId: "a1", order: "single" },
        { id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "double" },
        { id: "b2", fromAtomId: "a2", toAtomId: "a3", order: "single" }
      ]
    );
    const document = documentWith(mol);
    // A non-planar zig-zag conformer so the projection is non-degenerate.
    const coords3d = [0, 0, 0, 1, 0.4, 0.3, 2, 0, -0.3, 3, 0.4, 0.3];
    const outcome = flattenSpunMolecule(document, "mol_chain", coords3d, IDENTITY);

    expect(outcome.status).toBe("committed");
    const next = moleculeOf(outcome.document, "mol_chain");
    expect(next.atoms).toHaveLength(4);
    expect(next.bonds.map((b) => b.order)).toEqual(["single", "double", "single"]);
    expect(next.structureFormat).toBe("molfile-v2000");
    expect(next.structure).toContain("V2000");
    // Coordinates actually changed (a flatten happened).
    expect(next.atoms.map((a) => `${a.x.toFixed(2)},${a.y.toFixed(2)}`)).not.toEqual(
      mol.atoms.map((a) => `${a.x.toFixed(2)},${a.y.toFixed(2)}`)
    );
  });

  it("refuses without touching the document when the conformer length is wrong", () => {
    const mol = molecule(
      "mol_bad",
      [
        { id: "a0", element: "C", x: 100, y: 100, formalCharge: 0 },
        { id: "a1", element: "C", x: 130, y: 100, formalCharge: 0 }
      ],
      [{ id: "b0", fromAtomId: "a0", toAtomId: "a1", order: "single" }]
    );
    const document = documentWith(mol);
    const outcome = flattenSpunMolecule(document, "mol_bad", [0, 0, 0], IDENTITY); // wrong length
    expect(outcome.status).toBe("refused");
    expect(outcome.document).toBe(document); // identical reference — untouched
  });
});

describe("flattenSpunMolecule — perspective depth weights", () => {
  it("bakes normalized near/far bond weights from the final view depth", () => {
    const mol = molecule(
      "mol_depth",
      [
        { id: "a0", element: "C", x: 100, y: 100, formalCharge: 0 },
        { id: "a1", element: "C", x: 130, y: 110, formalCharge: 0 },
        { id: "a2", element: "C", x: 160, y: 100, formalCharge: 0 },
        { id: "a3", element: "C", x: 190, y: 110, formalCharge: 0 }
      ],
      [
        { id: "b0", fromAtomId: "a0", toAtomId: "a1", order: "single" },
        { id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" },
        { id: "b2", fromAtomId: "a2", toAtomId: "a3", order: "single" }
      ]
    );
    const document = documentWith(mol);
    // Identity view ⇒ depth = z. Bond mean depths: 0.5 / 1.5 / 2.5 → weights 0 / 0.5 / 1.
    const coords3d = [0, 0, 0, 1, 0.4, 1, 2, 0, 2, 3, 0.4, 3];
    const outcome = flattenSpunMolecule(document, "mol_depth", coords3d, IDENTITY);

    expect(outcome.status).toBe("committed");
    const next = moleculeOf(outcome.document, "mol_depth");
    expect(next.bonds.map((bond) => bond.display?.depthWeight)).toEqual([0, 0.5, 1]);
  });

  it("writes no weights for a planar view and clears stale ones from an earlier flatten", () => {
    const mol = molecule(
      "mol_flat",
      [
        { id: "a0", element: "C", x: 100, y: 100, formalCharge: 0 },
        { id: "a1", element: "C", x: 130, y: 110, formalCharge: 0 },
        { id: "a2", element: "C", x: 160, y: 100, formalCharge: 0 }
      ],
      [
        { id: "b0", fromAtomId: "a0", toAtomId: "a1", order: "single", display: { depthWeight: 0.8 } },
        { id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single", display: { depthWeight: 0.2 } }
      ]
    );
    const document = documentWith(mol);
    // All z = 0: no depth spread — stale weights must come off, not linger.
    const coords3d = [0, 0, 0, 1, 0.4, 0, 2, 0, 0];
    const outcome = flattenSpunMolecule(document, "mol_flat", coords3d, IDENTITY);

    expect(outcome.status).toBe("committed");
    const next = moleculeOf(outcome.document, "mol_flat");
    expect(next.bonds.every((bond) => bond.display?.depthWeight === undefined)).toBe(true);
  });
});

describe("flattenSpunMolecule — ScreenPlacement parity", () => {
  it("matches projectSpin atom coordinates and depth weights when placement is supplied", () => {
    const mol = molecule(
      "mol_place",
      [
        { id: "a0", element: "C", x: 100, y: 100, formalCharge: 0 },
        { id: "a1", element: "C", x: 130, y: 112, formalCharge: 0 },
        { id: "a2", element: "C", x: 160, y: 100, formalCharge: 0 },
        { id: "a3", element: "C", x: 190, y: 112, formalCharge: 0 }
      ],
      [
        { id: "b0", fromAtomId: "a0", toAtomId: "a1", order: "single" },
        { id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" },
        { id: "b2", fromAtomId: "a2", toAtomId: "a3", order: "single" }
      ]
    );
    const document = documentWith(mol);
    const coords3d = [0, 0, 0, 1, 0.4, 1, 2, 0, 2, 3, 0.4, 3];
    const quat = quatFromAxisAngle([0, 1, 0], Math.PI / 4);
    const viewMatrix = quatToViewMatrix(quat);
    const placement: ScreenPlacement = { centerX: 250, centerY: 180, scale: 34 };
    const bondPairs: [number, number][] = [[0, 1], [1, 2], [2, 3]];

    const outcome = flattenSpunMolecule(document, "mol_place", coords3d, viewMatrix, { placement });
    expect(outcome.status).toBe("committed");

    const next = moleculeOf(outcome.document, "mol_place");
    const expected = projectSpin(coords3d, bondPairs, quat, placement);
    for (let index = 0; index < next.atoms.length; index += 1) {
      expect(next.atoms[index].x).toBeCloseTo(expected.atoms[index].sx, 6);
      expect(next.atoms[index].y).toBeCloseTo(expected.atoms[index].sy, 6);
    }
    expect(next.bonds.map((bond) => bond.display?.depthWeight))
      .toEqual(bondDepthWeights(coords3d, bondPairs, viewMatrix));
  });

  it("keeps an edge-on placed flatten inside the placement envelope instead of inflating", () => {
    const mol = molecule(
      "mol_edge",
      [
        { id: "a0", element: "C", x: 100, y: 100, formalCharge: 0 },
        { id: "a1", element: "C", x: 130, y: 102, formalCharge: 0 },
        { id: "a2", element: "C", x: 160, y: 100, formalCharge: 0 },
        { id: "a3", element: "C", x: 190, y: 102, formalCharge: 0 }
      ],
      [
        { id: "b0", fromAtomId: "a0", toAtomId: "a1", order: "single" },
        { id: "b1", fromAtomId: "a1", toAtomId: "a2", order: "single" },
        { id: "b2", fromAtomId: "a2", toAtomId: "a3", order: "single" }
      ]
    );
    const document = documentWith(mol);
    const coords3d = [0, 0, 0, 1, 0.05, 0, 2, 0, 0, 3, 0.05, 0];
    const quat = quatFromAxisAngle([0, 1, 0], Math.PI / 2);
    const placement: ScreenPlacement = { centerX: 240, centerY: 160, scale: 40 };
    const outcome = flattenSpunMolecule(document, "mol_edge", coords3d, quatToViewMatrix(quat), { placement });
    expect(outcome.status).toBe("committed");

    const next = moleculeOf(outcome.document, "mol_edge");
    const xs = next.atoms.map((atom) => atom.x);
    const ys = next.atoms.map((atom) => atom.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(6);
    for (const atom of next.atoms) {
      expect(Number.isFinite(atom.x)).toBe(true);
      expect(Number.isFinite(atom.y)).toBe(true);
    }
  });
});

describe("flattenSpunMolecule — styrene keeps its double bonds in place", () => {
  it("flattens styrene with every double bond on its original atom pair", async () => {
    const { mol, coords3d, embedStatus } = await conformerFromSmiles("C=Cc1ccccc1", "mol_styrene");
    expect(embedStatus).toBe("ok");

    const inputDoubleBonds = mol.bonds.filter((b) => b.order === "double");
    // Vinyl C=C plus the ring's Kekulé double bonds — styrene has several.
    expect(inputDoubleBonds.length).toBeGreaterThanOrEqual(1);

    const document = documentWith(mol);
    const outcome = flattenSpunMolecule(document, "mol_styrene", coords3d, IDENTITY);
    expect(outcome.status, outcome.refusalReasons.join("; ")).toBe("committed");

    const next = moleculeOf(outcome.document, "mol_styrene");

    // Same number of atoms and bonds.
    expect(next.atoms.map((a) => a.id).sort()).toEqual(mol.atoms.map((a) => a.id).sort());
    expect(next.bonds.length).toBe(mol.bonds.length);

    // The bond-order multiset is preserved (no double bond gained, lost, or downgraded).
    const orderHistogram = (m: MoleculeObject) =>
      m.bonds.reduce<Record<string, number>>((acc, b) => ((acc[b.order] = (acc[b.order] ?? 0) + 1), acc), {});
    expect(orderHistogram(next)).toEqual(orderHistogram(mol));

    // EACH double bond is still a double bond between the SAME atom pair.
    const unorderedPair = (b: { fromAtomId: string; toAtomId: string }) => [b.fromAtomId, b.toAtomId].sort().join("=");
    const inputDoublePairs = new Set(inputDoubleBonds.map(unorderedPair));
    const outputDoublePairs = new Set(next.bonds.filter((b) => b.order === "double").map(unorderedPair));
    expect(outputDoublePairs).toEqual(inputDoublePairs);

    // The rewritten molfile encodes the same number of double bonds (V2000 order code 2).
    const molfileDoubleBondCount = next.structure
      .split("\n")
      .filter((line) => /^\s{1,3}\d{1,3}\s{1,3}\d{1,3}\s{1,3}2\b/.test(line)).length;
    expect(molfileDoubleBondCount).toBe(inputDoubleBonds.length);

    // Every double bond gets an explicit side recomputed from the flattened geometry
    // (so ring double bonds draw INSIDE the ring, not outside).
    for (const bond of next.bonds.filter((b) => b.order === "double")) {
      expect(bond.display?.doubleBondSide === "left" || bond.display?.doubleBondSide === "right").toBe(true);
    }
  });

  it("ring double bonds point toward the ring interior", async () => {
    const { mol, coords3d } = await conformerFromSmiles("c1ccccc1", "mol_benzene");
    const document = documentWith(mol);
    const outcome = flattenSpunMolecule(document, "mol_benzene", coords3d, IDENTITY);
    expect(outcome.status).toBe("committed");
    const next = moleculeOf(outcome.document, "mol_benzene");

    const ringCenter = {
      x: next.atoms.reduce((s, a) => s + a.x, 0) / next.atoms.length,
      y: next.atoms.reduce((s, a) => s + a.y, 0) / next.atoms.length
    };
    const atomById = new Map(next.atoms.map((a) => [a.id, a]));
    // For each ring double bond, the assigned side must be the one facing the centroid.
    for (const bond of next.bonds.filter((b) => b.order === "double")) {
      const from = atomById.get(bond.fromAtomId)!;
      const to = atomById.get(bond.toAtomId)!;
      const ux = to.x - from.x;
      const uy = to.y - from.y;
      const len = Math.hypot(ux, uy);
      const normal = { x: -uy / len, y: ux / len }; // "left" of from→to
      const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
      const towardCenter = (ringCenter.x - mid.x) * normal.x + (ringCenter.y - mid.y) * normal.y;
      const expectedSide = towardCenter >= 0 ? "left" : "right";
      expect(bond.display?.doubleBondSide).toBe(expectedSide);
    }
  });
});
