import { describe, expect, it } from "vitest";
import {
  applyPatches, createEmptyDocument, deserializeDocument, diffChemicalIdentity,
  MoleculeAtomSchema, MoleculeObjectSchema, moleculeToMolfileV2000, moleculeToMolfileV3000,
  normalizeAtomIsotope, serializeDocument, snapshotChemicalIdentity, type MoleculeObject
} from "./index";

function molecule(): MoleculeObject {
  return {
    id: "mol", type: "molecule", x: 0, y: 0, width: 40, height: 20, rotation: 0, style: {},
    structureFormat: "molfile-v2000", structure: "", superatoms: [], rGroups: [],
    atoms: [
      { id: "c", element: "C", isotope: 13, x: 0, y: 0, formalCharge: 0 },
      { id: "d", element: "D", x: 20, y: 0, formalCharge: 0 },
      { id: "t", element: "T", x: 40, y: 0, formalCharge: 0 }
    ],
    bonds: [
      { id: "cd", fromAtomId: "c", toAtomId: "d", order: "single" },
      { id: "ct", fromAtomId: "c", toAtomId: "t", order: "single" }
    ]
  };
}

describe("native isotope storage", () => {
  it.each([0, -1, 2.5, 1000, NaN])("rejects invalid mass number %s", (isotope) => {
    expect(MoleculeAtomSchema.safeParse({ ...molecule().atoms[0], isotope }).success).toBe(false);
  });

  it.each(["D", "T"])("rejects an isotope field on %s during object validation", (element) => {
    const mol = molecule();
    mol.atoms[0] = { ...mol.atoms[0]!, element, isotope: 2 };
    expect(MoleculeObjectSchema.safeParse(mol).success).toBe(false);
  });

  it("normalizes hydrogen-2/3 once and keeps all other atom fields", () => {
    for (const [isotope, element] of [[2, "D"], [3, "T"]] as const) {
      const atom = { id: "h", element: "H", isotope, x: 1, y: 2, formalCharge: 0 };
      expect(normalizeAtomIsotope(atom)).toEqual({
        id: "h", element, x: 1, y: 2, formalCharge: 0
      });
      expect(atom.isotope).toBe(isotope);
    }
    expect(normalizeAtomIsotope({ element: "H", isotope: 1 })).toEqual({ element: "H", isotope: 1 });
    expect(normalizeAtomIsotope({ element: "C", isotope: 13 })).toEqual({ element: "C", isotope: 13 });
  });

  it("keeps isotope fields through patches, serialization, reopening and later updates", () => {
    const original = molecule();
    original.atoms[1] = { ...original.atoms[1]!, element: "H", isotope: 2 };
    const added = applyPatches(createEmptyDocument(), [
      { op: "addObject", pageId: "page_001", object: original }
    ]);
    const reopened = deserializeDocument(serializeDocument(added));
    const saved = reopened.pages[0]!.objects[0] as MoleculeObject;
    expect(saved.atoms).toEqual(molecule().atoms);
    const updated = applyPatches(reopened, [{ op: "updateObject", objectId: "mol", changes: {
      atoms: saved.atoms.map((atom) => ({ ...atom, x: atom.x + 2 }))
    } }]);
    expect((deserializeDocument(serializeDocument(updated)).pages[0]!.objects[0] as MoleculeObject)
      .atoms.map(({ element, isotope }) => ({ element, isotope }))).toEqual([
      { element: "C", isotope: 13 }, { element: "D", isotope: undefined },
      { element: "T", isotope: undefined }
    ]);
  });

  it("detects lost and relocated isotopes without relying on cached metadata", () => {
    const before = molecule();
    const after = molecule();
    delete after.atoms[0]!.isotope;
    before.chemistry = { isotopeLabels: ["13C"], stereochemistry: [], warnings: [] };
    after.chemistry = before.chemistry;
    const diff = diffChemicalIdentity(snapshotChemicalIdentity(before), snapshotChemicalIdentity(after));
    expect(diff.verdict).toBe("changed");
    expect(diff.isotopeLabelsChanged).toBe(true);
    expect(snapshotChemicalIdentity(before).graph.isotopeLabels).toEqual(["13C", "2H", "3H"]);
    after.atoms[1]!.element = "H";
    expect(diffChemicalIdentity(snapshotChemicalIdentity(before), snapshotChemicalIdentity(after))
      .atomMultisetChanged).toBe(true);
  });

  it("writes at most eight isotope entries per V2000 line, and V3000 MASS properties", () => {
    const mol = molecule();
    mol.atoms = Array.from({ length: 10 }, (_, i) => ({ ...mol.atoms[0]!, id: `a${i}` }));
    mol.bonds = [];
    const options = { kekuleBondOrders: new Map<string, number>() };
    const lines = moleculeToMolfileV2000(mol, options).contents.split("\n")
      .filter((line) => line.startsWith("M  ISO"));
    expect(lines.map((line) => Number(line.slice(6, 9)))).toEqual([8, 2]);
    expect(moleculeToMolfileV3000(mol, options).contents.match(/MASS=13/g)).toHaveLength(10);
    expect(moleculeToMolfileV2000(molecule(), options).contents).toMatch(/ D /);
    expect(moleculeToMolfileV3000(molecule(), options).contents).toMatch(/ T /);
  });

  it("detects moving a label between chemically different sites with the same isotope multiset", () => {
    const before = molecule();
    before.atoms.push({ id: "c2", element: "C", x: 60, y: 0, formalCharge: 0 });
    before.bonds.push({ id: "cc", fromAtomId: "c", toAtomId: "c2", order: "single" });
    const after = structuredClone(before);
    delete after.atoms[0]!.isotope;
    after.atoms[3]!.isotope = 13;
    const diff = diffChemicalIdentity(snapshotChemicalIdentity(before), snapshotChemicalIdentity(after));
    expect(diff.isotopeLabelsChanged).toBe(false);
    expect(diff.atomMultisetChanged).toBe(false);
    expect(diff.connectivityChanged).toBe(true);
    expect(diff.verdict).toBe("changed");
  });
});
