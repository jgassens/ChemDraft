import { beforeAll, describe, expect, it } from "vitest";

import { applyPatches, type ChemDraftDocument, type MoleculeObject, type ViewMatrix } from "@chemdraft/chem-core";
import { depictSmiles2D, ensureOclResources, oclConformerGenerator, type Depiction2D } from "@chemdraft/ocl-adapter";

import { createPhase4Document, flattenSpunMolecule } from "./documentWorkflow";

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
  });
});
