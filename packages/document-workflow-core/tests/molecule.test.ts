import { describe, expect, it } from "vitest";
import { createEmptyDocument, type MoleculeObject } from "@chemdraft/chem-core";
import { testMoleculeFromSmiles } from "@chemdraft/layout-engine/testing";
import { applyMoleculeTargetBondLength, createSmilesMolecule, insertSmilesMolecule, type PastedStructureDepiction } from "../src/index";

describe("molecule sizing uses the nominal length only for projections", () => {
  it.each([undefined, "perspective"])("resizes a molecule with projection %s", projection => {
    const document = createEmptyDocument();
    const object = createSmilesMolecule(document, { x: 200, y: 200 }, {
      atoms: [0, 1, 2].map(x => ({ element: "C", x, y: 0, charge: 0 })),
      bonds: [{ from: 0, to: 1, order: "single", wedge: null }, { from: 1, to: 2, order: "single", wedge: null }]
    }, "CCC", undefined, { bondLengthPx: 12 });
    // Real measured bonds disagree with the nominal style. Imports must continue
    // using their measured median; projections alone retain foreshortening.
    object.style = { ...object.style, bondLengthPx: 24, ...(projection ? { projection } : {}) };
    document.pages[0]!.objects = [object];
    const resized = applyMoleculeTargetBondLength(document, [object.id], 36).pages[0]!.objects[0] as MoleculeObject;
    const first = resized.atoms[0]!, second = resized.atoms[1]!;
    expect(Math.hypot(first.x - second.x, first.y - second.y)).toBeCloseTo(projection ? 18 : 36, 9);
    expect(resized.style.bondLengthPx).toBe(36);
    expect(resized.style.projection).toBe(projection);
    expect(object.style.bondLengthPx).toBe(24);
  });
});

function depiction(smiles: string): PastedStructureDepiction {
  const graph = testMoleculeFromSmiles(smiles);
  return {
    atoms: graph.atoms.map((atom, index) => ({
      element: atom.element, charge: atom.formalCharge,
      x: Math.cos(index * 1.1), y: Math.sin(index * 1.1)
    })),
    bonds: graph.bonds.map((bond) => ({
      from: graph.atoms.findIndex((atom) => atom.id === bond.fromAtomId),
      to: graph.atoms.findIndex((atom) => atom.id === bond.toAtomId),
      order: bond.order, wedge: null
    }))
  };
}

describe("shared molecule construction double-bond defaults", () => {
  it.each([
    "CC=O", "CC(=O)C", "CC=NC", "CC(=S)C", "CS(=O)C", "CS(=O)(=O)C",
    "O=P(c1ccccc1)(c1ccccc1)c1ccccc1", "CN=O"
  ])("leaves C=X and terminal heteroatom doubles automatic in every builder: %s", (smiles) => {
    const document = createEmptyDocument();
    const input = depiction(smiles);
    const before = structuredClone(input);
    const point = { x: 200, y: 200 };
    const source = { objectIdPrefix: "name", styleSource: "name", warningCode: "name.generated", warningMessage: "Generated from name." };
    const objects = [
      createSmilesMolecule(document, point, input, smiles),
      createSmilesMolecule(document, point, input, smiles, source),
      insertSmilesMolecule(document, point, input, smiles).pages[0].objects[0]
    ];
    for (const object of objects) {
      expect(object.type).toBe("molecule");
      const molecule = object as MoleculeObject;
      const doubles = molecule.bonds.filter((bond) => bond.order === "double");
      expect(doubles.length).toBeGreaterThan(0);
      for (const bond of doubles) expect(bond.display).toBeUndefined();
      expect(molecule.atoms.map((atom) => [atom.element, atom.formalCharge]))
        .toEqual(input.atoms.map((atom) => [atom.element, atom.charge]));
      expect(molecule.bonds.map((bond) => [bond.fromAtomId, bond.toAtomId, bond.order]))
        .toEqual(input.bonds.map((bond) => [`a${bond.from}`, `a${bond.to}`, bond.order]));
    }
    expect(input).toEqual(before);
    expect(document.pages[0].objects).toEqual([]);
  });

  it.each(["CC=CC", "CN=NC", "N1=CC=CC=C1", "C1=CCCCC1"])("retains explicit side defaults for %s", (smiles) => {
    const object = createSmilesMolecule(createEmptyDocument(), { x: 200, y: 200 }, depiction(smiles), smiles) as MoleculeObject;
    const doubles = object.bonds.filter((bond) => bond.order === "double");
    expect(doubles.length).toBeGreaterThan(0);
    for (const bond of doubles) expect(["left", "right"]).toContain(bond.display?.doubleBondSide);
  });

  it("preserves wedge displays on automatic bonds and explicit sides on existing molecules", () => {
    const document = createEmptyDocument();
    const input = depiction("CC=O");
    input.bonds = input.bonds.map((bond) => bond.order === "double" ? { ...bond, wedge: "hashed" } : bond);
    const molecule = createSmilesMolecule(document, { x: 200, y: 200 }, input, "CC=O") as MoleculeObject;
    expect(molecule.bonds[1].display).toEqual({ bondStyle: "hashed" });
    const existing: MoleculeObject = { ...molecule, bonds: molecule.bonds.map((bond) => bond.order === "double"
      ? { ...bond, display: { doubleBondSide: "right" } } : bond) };
    document.pages[0].objects = [existing];
    const next = insertSmilesMolecule(document, { x: 400, y: 200 }, depiction("CS(=O)C"), "CS(=O)C");
    expect(next.pages[0].objects[0]).toEqual(existing);
    const inserted = next.pages[0].objects[1] as MoleculeObject;
    expect(inserted.bonds.find((bond) => bond.order === "double")?.display).toBeUndefined();
  });
});
